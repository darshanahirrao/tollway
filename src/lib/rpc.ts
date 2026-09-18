import { Connection } from "@solana/web3.js";

export interface RpcEndpointHealth {
  url: string;
  ok: boolean;
  latencyMs: number | null;
  slot: number | null;
  error: string | null;
  lastChecked: string;
}

/**
 * Connection pool with health tracking and failover.
 *
 * A payment gateway lives or dies on being able to read the chain when a payer
 * retries. A single public RPC endpoint rate limits long before that, so the
 * pool keeps one healthy primary and promotes a standby the moment the primary
 * starts failing. The order in `TOLLWAY_RPC_URLS` is the preference order, and
 * the first entry is normally RPC Fast.
 */
export class RpcPool {
  private readonly connections: Connection[] = [];
  private readonly health: Map<string, RpcEndpointHealth> = new Map();
  private activeIndex = 0;

  constructor(urls: readonly string[]) {
    if (urls.length === 0) {
      throw new Error("RpcPool needs at least one endpoint");
    }
    for (const url of urls) {
      this.connections.push(new Connection(url, "confirmed"));
      this.health.set(url, {
        url,
        ok: false,
        latencyMs: null,
        slot: null,
        error: null,
        lastChecked: new Date(0).toISOString(),
      });
    }
  }

  get size(): number {
    return this.connections.length;
  }

  get activeUrl(): string {
    return this.connections[this.activeIndex]!.rpcEndpoint;
  }

  /** The connection callers should use right now. */
  get active(): Connection {
    return this.connections[this.activeIndex]!;
  }

  /**
   * Run `operation` against the preferred endpoint. On failure, move to the
   * next endpoint and retry, so a single rate-limited provider does not turn
   * into a failed payment for the caller.
   */
  async withFailover<T>(
    operation: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < this.connections.length; attempt++) {
      const index = (this.activeIndex + attempt) % this.connections.length;
      const connection = this.connections[index]!;
      try {
        const result = await operation(connection);
        if (index !== this.activeIndex) {
          this.activeIndex = index;
        }
        this.markOk(connection.rpcEndpoint);
        return result;
      } catch (error) {
        lastError = error;
        this.markFailed(
          connection.rpcEndpoint,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("All RPC endpoints failed");
  }

  /** Probe every endpoint. Used by the health endpoint and by the live check. */
  async probe(): Promise<RpcEndpointHealth[]> {
    await Promise.all(
      this.connections.map(async (connection) => {
        const url = connection.rpcEndpoint;
        const started = Date.now();
        try {
          const slot = await connection.getSlot("confirmed");
          const entry = this.health.get(url)!;
          entry.ok = true;
          entry.slot = slot;
          entry.latencyMs = Date.now() - started;
          entry.error = null;
          entry.lastChecked = new Date().toISOString();
        } catch (error) {
          this.markFailed(
            url,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    );
    return [...this.health.values()];
  }

  private markOk(url: string): void {
    const entry = this.health.get(url);
    if (!entry) return;
    entry.ok = true;
    entry.error = null;
    entry.lastChecked = new Date().toISOString();
  }

  private markFailed(url: string, error: string): void {
    const entry = this.health.get(url);
    if (!entry) return;
    entry.ok = false;
    entry.error = error;
    entry.lastChecked = new Date().toISOString();
  }
}
