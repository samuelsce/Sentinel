import {
  BATCH_MAX_BYTES,
  EVENT_MAX_BYTES,
  eventBatchSchema,
  type IngestionReceipt,
  ingestionReceiptSchema,
  isEventWithinTimeWindow,
  type SecurityEvent,
} from "@sentinel/contracts";
import type { createDatabase } from "@sentinel/database";
import type { FastifyInstance } from "fastify";
import { transaction } from "./identity.js";
import { AccessError, secretHash } from "./security.js";

type Pool = ReturnType<typeof createDatabase>["pool"];
type Client = Pick<Pool, "query">;
type Scope = {
  id: string;
  organization_id: string;
  project_id: string;
  environment: SecurityEvent["environment"];
};
export const INGEST_REQUESTS_PER_MINUTE = 60;
export const INGEST_EVENTS_PER_MINUTE = 3000;
export const INGEST_MAX_BACKLOG = 10_000;

export class IngestionService {
  constructor(
    readonly pool: Pool,
    readonly now: () => Date = () => new Date(),
  ) {}

  private async scope(
    client: Client,
    key: string,
    lock = false,
  ): Promise<Scope> {
    if (!/^snt_ing_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(key))
      throw new AccessError(401);
    const result = await client.query<Scope>(
      `SELECT id,organization_id,project_id,environment FROM ingestion_keys WHERE key_hash=$1 AND revoked_at IS NULL${lock ? " FOR SHARE" : ""}`,
      [secretHash("ingestion", key)],
    );
    const scope = result.rows[0];
    if (!scope) throw new AccessError(401);
    return scope;
  }

  // Autocommit counts authenticated requests even if parsing/the batch later fails.
  async authorize(key: string) {
    const scope = await this.scope(this.pool, key);
    const start = new Date(Math.floor(this.now().getTime() / 60_000) * 60_000);
    const quota = await this.pool.query<{ requests: number }>(
      `INSERT INTO ingestion_quotas(project_id,window_start,requests,events) VALUES($1,$2,1,0)
      ON CONFLICT(project_id) DO UPDATE SET window_start=GREATEST(ingestion_quotas.window_start,EXCLUDED.window_start),
      requests=CASE WHEN ingestion_quotas.window_start<EXCLUDED.window_start THEN 1 ELSE LEAST(ingestion_quotas.requests+1,61) END,
      events=CASE WHEN ingestion_quotas.window_start<EXCLUDED.window_start THEN 0 ELSE ingestion_quotas.events END RETURNING requests`,
      [scope.project_id, start],
    );
    if ((quota.rows[0]?.requests ?? 61) > INGEST_REQUESTS_PER_MINUTE)
      throw new AccessError(429, 60);
  }

  async ingest(key: string, input: unknown): Promise<IngestionReceipt> {
    const parsed = eventBatchSchema.safeParse(input);
    if (!parsed.success) throw new AccessError(400);
    const unique = new Map<string, SecurityEvent>();
    // JSONB equality below ignores object key ordering, including within metadata.
    for (const event of parsed.data.events) {
      if (Buffer.byteLength(JSON.stringify(event)) > EVENT_MAX_BYTES)
        throw new AccessError(413);
      const id = event.event_id.toLowerCase();
      const old = unique.get(id);
      if (old && canonical(old) !== canonical(event))
        throw new AccessError(409);
      unique.set(id, event);
    }
    return transaction(this.pool, async (client) => {
      const scope = await this.scope(client, key, true);
      // Serializes this project's batches/backlog check, across API processes/keys.
      await client.query(
        "SELECT id FROM projects WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [scope.project_id, scope.organization_id],
      );
      const receipt: IngestionReceipt = { accepted: [], duplicates: [] };
      const now = this.now();
      const fresh: SecurityEvent[] = [];
      for (const event of unique.values()) {
        if (event.environment !== scope.environment) throw new AccessError(400);
        const previous = await client.query<{ same: boolean }>(
          "SELECT payload=$3::jsonb AS same FROM events WHERE project_id=$1 AND event_id=$2",
          [scope.project_id, event.event_id, JSON.stringify(event)],
        );
        if (previous.rows[0]) {
          if (!previous.rows[0].same) throw new AccessError(409);
          receipt.duplicates.push(event.event_id);
        } else {
          if (!isEventWithinTimeWindow(event, now)) throw new AccessError(400);
          fresh.push(event);
        }
      }
      const backlog = await client.query<{ count: string }>(
        "SELECT count(*) FROM detection_jobs WHERE project_id=$1 AND status IN ('pending','processing')",
        [scope.project_id],
      );
      if (
        fresh.length &&
        Number(backlog.rows[0]?.count) + fresh.length > INGEST_MAX_BACKLOG
      )
        throw new AccessError(503, 60);
      const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
      const quota = await client.query<{ events: number }>(
        `UPDATE ingestion_quotas SET events=CASE WHEN window_start<$2 THEN 0 ELSE events END + $3, requests=CASE WHEN window_start<$2 THEN 1 ELSE requests END, window_start=GREATEST(window_start,$2) WHERE project_id=$1 RETURNING events`,
        [scope.project_id, start, parsed.data.events.length],
      );
      if (!quota.rows[0] || quota.rows[0].events > INGEST_EVENTS_PER_MINUTE)
        throw new AccessError(429, 60);
      for (const event of fresh) {
        await client.query(
          `INSERT INTO events(organization_id,project_id,event_id,ingestion_key_id,environment,type,actor_id,source_ip,occurred_at,received_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [
            scope.organization_id,
            scope.project_id,
            event.event_id,
            scope.id,
            scope.environment,
            event.type,
            event.actor_id ?? null,
            event.source_ip ?? null,
            event.occurred_at,
            now,
            JSON.stringify(event),
          ],
        );
        await client.query(
          "INSERT INTO detection_jobs(organization_id,project_id,event_id) VALUES($1,$2,$3)",
          [scope.organization_id, scope.project_id, event.event_id],
        );
        receipt.accepted.push(event.event_id);
      }
      return receipt;
    });
  }
}

function canonical(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, JSON.parse(canonical(item))]),
      ),
    );
  return JSON.stringify(value);
}

export async function registerIngestionRoutes(
  app: FastifyInstance,
  service: IngestionService,
) {
  let active = 0;
  app.post(
    "/v1/ingest/events",
    {
      bodyLimit: BATCH_MAX_BYTES,
      schema: {
        body: eventBatchSchema,
        response: { 202: ingestionReceiptSchema },
      },
      onRequest: async (request, reply) => {
        if (active >= 8) throw new AccessError(503, 1);
        active++;
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            active--;
          }
        };
        reply.raw.once("finish", release);
        reply.raw.once("close", release);
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ") || header.length > 128)
          throw new AccessError(401);
        await service.authorize(header.slice(7));
      },
    },
    async (request, reply) => {
      const receipt = await service.ingest(
        request.headers.authorization?.slice(7) ?? "",
        request.body,
      );
      return reply.code(202).send(receipt);
    },
  );
}
