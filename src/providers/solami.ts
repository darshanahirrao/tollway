/**
 * Solami multi-region RPC provider.
 *
 * Solami exposes the same cluster from several points of presence, which is the
 * thing this provider sells: not "a balance", but "which of my endpoints is
 * lagging right now". A trader about to send a transaction cares whether one
 * region is four slots behind the others, and that question can only be answered
 * by asking several regions at once.
 *
 * Endpoint shape, which is not documented publicly and had to be discovered:
 *   https://rpc.solami.dev/<network>/<region>?api_key=<key>
 * The network segment accepts sol/solana/Solana (also monad, eth); the region
 * segment accepts ams, nl and SGP. The key must be the `api_key` query
 * parameter; the same URL with an X-Api-Key or Bearer header returns 401.
 *
 * Docs: https://solami.dev/docs
 */

export type SolamiRegion = "ams" | "nl" | "SGP";

export interface SolamiRegionInfo {
  id: SolamiRegion;
  label: string;
  location: string;
}

export const SOLAMI_REGIONS: SolamiRegionInfo[] = [
  { id: "ams", label: "Amsterdam", location: "EU West" },
  { id: "nl", label: "Netherlands", location: "EU West" },
  { id: "SGP", label: "Singapore", location: "AP Southeast" },
];

const DEFAULT_BASE_URL = "https://rpc.solami.dev";

export class SolamiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SolamiError";
  }
}

export class SolamiNotConfigured extends Error {
  constructor() {
    super(
      "Solami is not configured. Set SOLAMI_API_KEY to enable the Solami resources.",
    );
    this.name = "SolamiNotConfigured";
  }
}

export interface SolamiClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface SolamiCallResult<T> {
  result: T;
  latencyMs: number;
  region: SolamiRegion;
}

export interface RegionProbe {
  region: SolamiRegion;
  location: string;
  ok: boolean;
  latencyMs: number | null;
  slot: number | null;
  epoch: number | null;
  blockHeight: number | null;
  error: string | null;
}

export interface SlotSkewReport {
  network: string;
  observedAt: string;
  regions: RegionProbe[];
  reachable: number;
  fastestRegion: SolamiRegion | null;
  slowestRegion: SolamiRegion | null;
  highestSlot: number | null;
  lowestSlot: number | null;
  /** How many slots separate the freshest and the most behind region. */
  slotDelta: number | null;
  /** True when every reachable region agrees within one slot. */
  consistent: boolean;
  verdict: string;
}

/**
 * Talks to Solami. Every call is region-explicit: there is no "default region",
 * because silently picking one would hide exactly the information this provider
 * exists to surface.
 */
export class SolamiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: SolamiClientOptions) {
    if (!options.apiKey) throw new SolamiNotConfigured();
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxAttempts = options.maxAttempts ?? 4;
  }

  endpoint(region: SolamiRegion, network = "sol") {
    return `${this.baseUrl}/${network}/${region}?api_key=${encodeURIComponent(this.apiKey)}`;
  }

  async call<T>(
    region: SolamiRegion,
    method: string,
    params: unknown[] = [],
    network = "sol",
  ): Promise<SolamiCallResult<T>> {
    // A burst across three regions trips Solami's burst limiter, so 429 is an
    // expected condition rather than an error, and the demo has to survive it.
    let lastError: SolamiError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const started = Date.now();
      try {
        const response = await fetch(this.endpoint(region, network), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal,
        });
        const latencyMs = Date.now() - started;
        const text = await response.text();
        const parsed = safeJson(text);

        if (!response.ok) {
          const message =
            (isRecord(parsed) && typeof parsed.message === "string"
              ? parsed.message
              : null) ?? `Solami returned HTTP ${response.status}`;
          lastError = new SolamiError(
            message,
            `HTTP_${response.status}`,
            response.status,
          );
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt < this.maxAttempts
          ) {
            const retryAfter = Number(
              response.headers.get("retry-after") ?? "0",
            );
            await sleep(
              retryAfter > 0 ? retryAfter * 1000 : 350 * 2 ** (attempt - 1),
            );
            continue;
          }
          throw lastError;
        }
        if (isRecord(parsed) && "error" in parsed) {
          const err = parsed.error as { message?: string; code?: number };
          throw new SolamiError(
            err?.message ?? "Solami JSON-RPC error",
            `RPC_${err?.code ?? "UNKNOWN"}`,
            response.status,
          );
        }
        if (!isRecord(parsed) || !("result" in parsed)) {
          throw new SolamiError("Solami response had no result", "MALFORMED");
        }
        return { result: parsed.result as T, latencyMs, region };
      } catch (error) {
        if (error instanceof SolamiError) {
          lastError = error;
          if (error.code.startsWith("HTTP_5") && attempt < this.maxAttempts) {
            await sleep(350 * 2 ** (attempt - 1));
            continue;
          }
          throw error;
        }
        lastError =
          error instanceof Error
            ? new SolamiError(error.message, "NETWORK")
            : new SolamiError("Solami request failed", "NETWORK");
        if (attempt < this.maxAttempts) {
          await sleep(350 * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new SolamiError("Solami request failed", "UNKNOWN");
  }

  /**
   * Asks every region the same question. Failures are captured per region
   * rather than thrown, because "one region is down" is the answer the caller
   * is paying for.
   */
  async probe(network = "sol"): Promise<RegionProbe[]> {
    return Promise.all(
      SOLAMI_REGIONS.map(async ({ id, location }): Promise<RegionProbe> => {
        const base: RegionProbe = {
          region: id,
          location,
          ok: false,
          latencyMs: null,
          slot: null,
          epoch: null,
          blockHeight: null,
          error: null,
        };
        try {
          const slot = await this.call<number>(id, "getSlot", [], network);
          const epoch = await this.call<{ epoch: number; absoluteSlot: number; blockHeight: number }>(
            id,
            "getEpochInfo",
            [],
            network,
          );
          return {
            ...base,
            ok: true,
            latencyMs: slot.latencyMs,
            slot: slot.result,
            epoch: epoch.result?.epoch ?? null,
            blockHeight: epoch.result?.blockHeight ?? null,
          };
        } catch (error) {
          return {
            ...base,
            error: error instanceof Error ? error.message.slice(0, 160) : "unknown error",
          };
        }
      }),
    );
  }

  /** Cross-region freshness report: the multi-region question, answered. */
  async slotSkew(network = "sol"): Promise<SlotSkewReport> {
    const regions = await this.probe(network);
    const healthy = regions.filter((r) => r.ok && r.slot !== null);
    const slots = healthy.map((r) => r.slot as number);
    const highest = slots.length ? Math.max(...slots) : null;
    const lowest = slots.length ? Math.min(...slots) : null;
    const delta = highest !== null && lowest !== null ? highest - lowest : null;

    const byLatency = healthy
      .filter((r) => r.latencyMs !== null)
      .sort((a, b) => (a.latencyMs as number) - (b.latencyMs as number));

    return {
      network,
      observedAt: new Date().toISOString(),
      regions,
      reachable: healthy.length,
      fastestRegion: byLatency.length ? byLatency[0].region : null,
      slowestRegion: byLatency.length ? byLatency[byLatency.length - 1].region : null,
      highestSlot: highest,
      lowestSlot: lowest,
      slotDelta: delta,
      consistent: delta !== null && delta <= 1,
      verdict:
        healthy.length === 0
          ? "No Solami region answered."
          : delta !== null && delta > 1
            ? `Regions disagree by ${delta} slots; the slowest is behind.`
            : "All reachable regions are on the same slot.",
    };
  }

  /**
   * Reads an account. A region can be named, or the fastest healthy one is
   * chosen by probing first. Reads fail over across regions, because the whole
   * point of paying for several is that one of them being slow should not break
   * a read.
   */
  async getAccount(
    pubkey: string,
    region?: SolamiRegion,
    network = "sol",
  ) {
    const order: SolamiRegion[] = region
      ? [region, ...SOLAMI_REGIONS.map((r) => r.id).filter((id) => id !== region)]
      : [];

    if (!region) {
      const report = await this.slotSkew(network);
      const preferred = report.regions
        .filter((r) => r.ok)
        .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))
        .map((r) => r.region);
      order.push(...preferred, ...SOLAMI_REGIONS.map((r) => r.id));
    }

    const attempts: string[] = [];
    for (const target of [...new Set(order)]) {
      try {
        return await this.call<{
          context: { slot: number };
          value: {
            lamports: number;
            owner: string;
            executable: boolean;
            data: unknown;
          } | null;
        }>(target, "getAccountInfo", [pubkey, { encoding: "base64" }], network);
      } catch (error) {
        attempts.push(
          `${target}: ${error instanceof Error ? error.message.slice(0, 60) : "failed"}`,
        );
      }
    }
    throw new SolamiError(
      `Every Solami region failed to read ${pubkey}. ${attempts.join(" | ")}`,
      "NO_REGION",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds a client from the environment, or returns null when unconfigured. */
export function solamiFromEnv(): SolamiClient | null {
  const apiKey = process.env.SOLAMI_API_KEY;
  if (!apiKey) return null;
  return new SolamiClient({
    apiKey,
    baseUrl: process.env.SOLAMI_BASE_URL,
    timeoutMs: process.env.SOLAMI_TIMEOUT_MS
      ? Number(process.env.SOLAMI_TIMEOUT_MS)
      : undefined,
  });
}
