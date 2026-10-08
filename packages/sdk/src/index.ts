import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  BATCH_MAX_BYTES,
  EVENT_MAX_BYTES,
  ingestionReceiptSchema,
  type SecurityEvent,
  securityEventSchema,
} from "@sentinel/contracts";

type Input<E> = E extends SecurityEvent
  ? Omit<E, "schema_version" | "event_id" | "occurred_at" | "environment"> & {
      event_id?: string;
      occurred_at?: string;
    }
  : never;
export type EventInput = Input<SecurityEvent>;
export type SdkOptions = {
  endpoint: string;
  ingestionKey: string;
  environment: SecurityEvent["environment"];
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
  batchSize?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  flushIntervalMs?: number;
  maxAgeMs?: number;
};
type Item = { id: string; json: string; bytes: number; queuedAt: number };
type Dependencies = {
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
};
export class SentinelClient {
  private readonly endpoint: string;
  readonly #key: string;
  private readonly options: Required<
    Omit<SdkOptions, "endpoint" | "ingestionKey">
  >;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  #queue: Item[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private shutdown = new AbortController();
  private closing = false;
  private closed = false;
  private counters = {
    enqueued: 0,
    accepted: 0,
    duplicates: 0,
    invalid: 0,
    overflow: 0,
    terminal: 0,
    exhausted: 0,
    expired: 0,
    closed: 0,
    retries: 0,
    failures: 0,
    timeouts: 0,
  };

  constructor(options: SdkOptions, dependencies: Dependencies = {}) {
    const endpoint = new URL(options.endpoint);
    if (
      endpoint.pathname !== "/v1/ingest/events" ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password ||
      !(
        endpoint.protocol === "https:" ||
        (endpoint.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
      )
    )
      throw new Error("SDK requires HTTPS or loopback HTTP ingestion endpoint");
    if (
      !/^snt_ing_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(options.ingestionKey)
    )
      throw new Error("Invalid server ingestion credential");
    this.endpoint = endpoint.href;
    this.#key = options.ingestionKey;
    this.options = {
      environment: options.environment,
      maxBufferedEvents: options.maxBufferedEvents ?? 500,
      maxBufferedBytes: options.maxBufferedBytes ?? 2 * 1024 * 1024,
      batchSize: options.batchSize ?? 50,
      timeoutMs: options.timeoutMs ?? 2000,
      maxAttempts: options.maxAttempts ?? 3,
      flushIntervalMs: options.flushIntervalMs ?? 1000,
      maxAgeMs: options.maxAgeMs ?? 60_000,
    };
    for (const [name, value] of Object.entries(this.options)) {
      if (name === "environment") continue;
      const minimum = name === "flushIntervalMs" ? 0 : 1;
      const maximum =
        name === "batchSize"
          ? 100
          : name === "maxAttempts"
            ? 5
            : name === "timeoutMs"
              ? 10_000
              : name === "maxBufferedEvents"
                ? 10_000
                : name === "maxBufferedBytes"
                  ? 16 * 1024 * 1024
                  : 300_000;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < minimum ||
        value > maximum
      )
        throw new Error(`Invalid SDK option: ${name}`);
    }
    if (
      !securityEventSchema.options[0].shape.environment.safeParse(
        options.environment,
      ).success
    )
      throw new Error("Invalid SDK environment");
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    if (this.options.flushIntervalMs)
      this.timer = setInterval(() => {
        void this.flush();
      }, this.options.flushIntervalMs).unref();
  }

  // Never performs network I/O in the application's request path.
  track(input: EventInput): boolean {
    if (this.closing) {
      this.counters.closed++;
      return false;
    }
    try {
      const event = securityEventSchema.safeParse({
        ...input,
        schema_version: 1,
        event_id: input.event_id ?? randomUUID(),
        occurred_at: input.occurred_at ?? new Date(this.now()).toISOString(),
        environment: this.options.environment,
      });
      if (!event.success) {
        this.counters.invalid++;
        return false;
      }
      const json = JSON.stringify(event.data);
      const bytes = Buffer.byteLength(json);
      if (bytes > EVENT_MAX_BYTES) {
        this.counters.invalid++;
        return false;
      }
      if (
        this.#queue.length >= this.options.maxBufferedEvents ||
        this.bytes + bytes > this.options.maxBufferedBytes
      ) {
        this.counters.overflow++;
        return false;
      }
      this.#queue.push({
        id: event.data.event_id,
        json,
        bytes,
        queuedAt: this.now(),
      });
      this.bytes += bytes;
      this.counters.enqueued++;
      return true;
    } catch {
      this.counters.invalid++;
      return false;
    }
  }

  stats() {
    return {
      ...this.counters,
      bufferedEvents: this.#queue.length,
      bufferedBytes: this.bytes,
      flushing: Boolean(this.running),
    };
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drain()
      .catch(() => {
        this.counters.failures++;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private remove(count: number) {
    for (const item of this.#queue.splice(0, count)) this.bytes -= item.bytes;
  }

  private async drain() {
    // A flush handles a fixed snapshot; ongoing traffic cannot prolong it forever.
    let remaining = this.#queue.length;
    while (remaining > 0 && !this.shutdown.signal.aborted) {
      if (!this.#queue[0]) break;
      if (this.now() - this.#queue[0].queuedAt > this.options.maxAgeMs) {
        this.remove(1);
        this.counters.expired++;
        remaining--;
        continue;
      }
      const batch: Item[] = [];
      let bodyBytes = 13;
      for (const item of this.#queue.slice(
        0,
        Math.min(remaining, this.options.batchSize),
      )) {
        if (bodyBytes + item.bytes + 1 > BATCH_MAX_BYTES) break;
        batch.push(item);
        bodyBytes += item.bytes + 1;
      }
      const body = `{"events":[${batch.map((item) => item.json).join(",")}]}`;
      let acknowledged = false;
      let terminal = false;
      let expired = false;
      for (
        let attempt = 0;
        attempt < this.options.maxAttempts && !this.shutdown.signal.aborted;
        attempt++
      ) {
        if (this.now() - (batch[0]?.queuedAt ?? 0) > this.options.maxAgeMs) {
          expired = true;
          break;
        }
        let retryMs =
          Math.min(1000 * 2 ** attempt, 5000) * (0.5 + this.random() * 0.5);
        const timeout = AbortSignal.timeout(this.options.timeoutMs);
        const signal = AbortSignal.any([timeout, this.shutdown.signal]);
        try {
          const response = await this.fetcher(this.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#key}`,
              "content-type": "application/json",
            },
            body,
            signal,
            redirect: "error",
          });
          if (response.status === 202) {
            const receipt = ingestionReceiptSchema.safeParse(
              await readLimited(response),
            );
            if (receipt.success) {
              const expected = new Set(batch.map((item) => item.id));
              const returned = [
                ...receipt.data.accepted,
                ...receipt.data.duplicates,
              ];
              if (
                returned.length === expected.size &&
                new Set(returned).size === returned.length &&
                returned.every((id) => expected.has(id))
              ) {
                this.counters.accepted += receipt.data.accepted.length;
                this.counters.duplicates += receipt.data.duplicates.length;
                acknowledged = true;
                break;
              }
            }
          } else {
            await response.body?.cancel();
            if (![408, 429, 500, 502, 503, 504].includes(response.status)) {
              terminal = true;
              break;
            }
            const retry = response.headers.get("retry-after");
            if (retry) {
              const parsed = /^\d+$/.test(retry)
                ? Number(retry) * 1000
                : Date.parse(retry) - this.now();
              if (Number.isFinite(parsed))
                retryMs = Math.max(
                  retryMs,
                  Math.min(60_000, Math.max(0, parsed)),
                );
            }
          }
          this.counters.failures++;
        } catch {
          this.counters.failures++;
          if (timeout.aborted) this.counters.timeouts++;
        }
        if (
          attempt + 1 < this.options.maxAttempts &&
          !this.shutdown.signal.aborted
        ) {
          this.counters.retries++;
          try {
            await delay(retryMs, undefined, { signal: this.shutdown.signal });
          } catch {
            break;
          }
        }
      }
      if (this.shutdown.signal.aborted) break;
      if (!acknowledged)
        this.counters[
          expired ? "expired" : terminal ? "terminal" : "exhausted"
        ] += batch.length;
      this.remove(batch.length);
      remaining -= batch.length;
    }
  }

  async close(deadlineMs = 5000) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000)
      throw new Error("Invalid SDK close deadline");
    this.closing = true;
    clearInterval(this.timer);
    const deadline = setTimeout(() => this.shutdown.abort(), deadlineMs);
    try {
      await this.flush();
    } finally {
      clearTimeout(deadline);
      this.closed = true;
      this.counters.closed += this.#queue.length;
      this.remove(this.#queue.length);
    }
  }
}

async function readLimited(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing receipt");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) {
        await reader.cancel();
        throw new Error("Oversized receipt");
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}
