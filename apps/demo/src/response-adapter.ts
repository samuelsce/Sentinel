import { BlockList, isIP } from "node:net";
import { z } from "zod";

const commandSchema = z.strictObject({
  id: z.uuid(),
  environment: z.literal("demo"),
  sourceIp: z
    .string()
    .max(45)
    .refine((ip) => isIP(ip) !== 0),
  state: z.enum(["requested", "applied", "expired"]),
  expiresAt: z.iso.datetime(),
});
const envelope = z.strictObject({ commands: z.array(commandSchema).max(200) });
export type AdapterOptions = {
  endpoint: string;
  key: string;
  transport?: typeof fetch;
  now?: () => number;
};

// Commands are restored before HTTP listen. Expiry is enforced locally even while
// Sentinel is unavailable; repeated delivery can never extend the absolute TTL.
export class DemoResponseAdapter {
  private readonly blocks = new Map<string, z.infer<typeof commandSchema>>();
  private syncing: Promise<void> | undefined;
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly options: AdapterOptions) {
    const endpoint = new URL(options.endpoint);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !["http:", "https:"].includes(endpoint.protocol) ||
      (endpoint.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) ||
      !/^snt_rsp_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(options.key)
    )
      throw new Error("Invalid response adapter configuration");
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? Date.now;
  }
  isBlocked(ip: string) {
    const family = isIP(ip);
    if (!family) return false;
    const list = new BlockList();
    for (const [id, command] of this.blocks) {
      if (Date.parse(command.expiresAt) <= this.now()) this.blocks.delete(id);
      else
        list.addAddress(
          command.sourceIp,
          isIP(command.sourceIp) === 6 ? "ipv6" : "ipv4",
        );
    }
    return list.check(ip, family === 6 ? "ipv6" : "ipv4");
  }
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.poll().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }
  private async call(
    path: string,
    body?: { state: string; failureCode?: string },
  ) {
    const result = await this.transport(
      `${this.options.endpoint.replace(/\/$/, "")}${path}`,
      {
        method: body ? "POST" : "GET",
        redirect: "error",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${this.options.key}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!result.ok) throw new Error("Response adapter unavailable");
    return result;
  }
  private async poll() {
    const result = envelope.parse(await (await this.call("/commands")).json());
    for (const [id, command] of this.blocks)
      if (Date.parse(command.expiresAt) <= this.now()) this.blocks.delete(id);
    // Expired confirmations are sent after the local block is removed.
    for (const command of result.commands) {
      if (
        command.state === "expired" ||
        Date.parse(command.expiresAt) <= this.now()
      ) {
        this.blocks.delete(command.id);
        await this.call(`/commands/${command.id}/ack`, { state: "expired" });
      } else {
        if (this.blocks.size >= 100 && !this.blocks.has(command.id)) {
          await this.call(`/commands/${command.id}/ack`, {
            state: "failed",
            failureCode: "capacity",
          });
          continue;
        }
        this.blocks.set(command.id, command);
        await this.call(`/commands/${command.id}/ack`, { state: "applied" });
      }
    }
  }
}
