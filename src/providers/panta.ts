/**
 * Panta prediction-market API client.
 *
 * Panta is a binary YES/NO prediction market on Solana. The API never holds
 * keys: every write is quote -> build -> sign in the caller's wallet ->
 * broadcast -> confirm. This client covers that whole surface so Tollway can
 * sell it to agents one call at a time.
 *
 * Docs: https://docs.panta.market
 */

export type PantaSide = "yes" | "no";

export interface PantaErrorShape {
  code?: string;
  message?: string;
  field?: string;
  fields?: Record<string, string[]>;
}

export class PantaError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly field?: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "PantaError";
  }
}

export class PantaNotConfigured extends Error {
  constructor() {
    super(
      "Panta is not configured. Set PANTA_API_KEY (pk_test_... or pk_live_...) to enable the Panta resources.",
    );
    this.name = "PantaNotConfigured";
  }
}

const DEFAULT_BASE_URL = "https://live-api.panta.market/api/v1";
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export interface PantaClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface MarketRow {
  marketId: string;
  category: string | null;
  title: string;
  description: string | null;
  images: string[];
  phase: string;
  marketType: string;
  startTime: number | null;
  endTime: number | null;
  resolutionTime: number | null;
  region: string | null;
  resolved: boolean;
  status: string | null;
  volumeUsdc: string | null;
  campaignId: string | null;
  createdByPartner: boolean;
  yesPrice: string | null;
  noPrice: string | null;
  primaryYesPrice?: string | null;
  primaryNoPrice?: string | null;
  secondaryYesPrice?: string | null;
  secondaryNoPrice?: string | null;
}

export interface ListMarketsResult {
  items: MarketRow[];
  nextCursor: string | null;
}

export interface PositionRow {
  marketId: string;
  category: string | null;
  side: PantaSide;
  shares: string;
  phase: string;
  claimable: boolean;
  claimed: boolean;
  outcome: string | null;
}

export interface PositionsResult {
  wallet: string;
  positions: PositionRow[];
}

export interface BuyQuote {
  quoteId: string;
  marketId: string;
  side: PantaSide;
  amountUsdc: string;
  shares: string;
  avgPrice: string;
  feeUsdc: string;
  expiresAt: string;
  blockhashExpiryHintSec?: number;
}

export interface SolanaInstruction {
  programId: string;
  data: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
}

export interface BuiltBuyOrder {
  orderId: string;
  quoteId: string;
  wallet: string;
  marketId: string;
  side: PantaSide;
  amountUsdc: string;
  expectedShares: string;
  feeUsdc: string;
  status: string;
  instructions: SolanaInstruction[];
  derived?: Record<string, string>;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
}

export interface BuiltClaim {
  wallet: string;
  marketId: string;
  outcome: string;
  winningShares: string;
  instructions: SolanaInstruction[];
  derived?: Record<string, string>;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
}

export interface BuiltCreatorFeeClaim {
  wallet: string;
  marketId: string;
  claimableFeesUsdc: string;
  instructions: SolanaInstruction[];
  derived?: Record<string, string>;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
}

export interface CreateMarketQuote {
  createId: string;
  paymentUsdc: string;
  expectedEventPda: string;
  expiresAt?: string;
}

export interface BuiltCreateMarket {
  createId: string;
  transaction: string;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
  buildFingerprint?: string;
  derived?: Record<string, string>;
}

export interface ReportTradeResult {
  status: string;
  kind: string;
  side?: PantaSide;
  signature?: string;
  marketId?: string;
  wallet?: string;
}

export interface TradeStatusResult {
  signature: string;
  status?: string;
  kind?: string;
  side?: PantaSide;
  marketId?: string;
  wallet?: string;
}

export interface QuoteBuyInput {
  wallet: string;
  marketId: string;
  side: PantaSide | string;
  amountUsdc: string | number;
  userId?: string;
}

export interface BuildBuyInput {
  quoteId: string;
  wallet: string;
  userId?: string;
  maxSlippageBps?: number;
}

export interface BuildClaimInput {
  wallet: string;
  marketId: string;
}

export interface QuoteCreateMarketInput {
  wallet: string;
  question: string;
  resolutionRule: string;
  sourcesOfTruth: string[];
  category: string;
  startTime: number;
  endTime: number;
  resolutionTime: number;
  imageUrl: string;
  marketType?: "standard" | "breaking";
  eventInProgress?: boolean;
  title?: string;
  region?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Trailing slashes are required by the Panta API, so paths are declared with
 * them and query strings are appended after.
 */
export class PantaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: PantaClientOptions) {
    if (!options.apiKey) throw new PantaNotConfigured();
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private url(
    path: string,
    query?: Record<string, string | number | undefined>,
  ) {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${suffix}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    init: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const url = this.url(path, init.query);
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          method,
          headers: {
            "X-Api-Key": this.apiKey,
            Accept: "application/json",
            ...(init.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        });

        const text = await response.text();
        const parsed: unknown = text ? safeJson(text) : null;

        if (response.ok) {
          return (parsed ?? {}) as T;
        }

        const shape: PantaErrorShape = isPlainObject(parsed)
          ? (parsed as PantaErrorShape)
          : {};
        const error = new PantaError(
          shape.message ?? `Panta request failed with HTTP ${response.status}`,
          shape.code ?? `HTTP_${response.status}`,
          response.status,
          shape.field,
          shape.fields,
        );

        if (RETRYABLE_STATUS.has(response.status) && attempt < 2) {
          lastError = error;
          const retryAfter = Number(response.headers.get("Retry-After") ?? "0");
          await sleep(retryAfter > 0 ? retryAfter * 1000 : 400 * (attempt + 1));
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof PantaError) throw error;
        lastError = error;
        if (attempt >= 2) throw error;
        await sleep(400 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Panta request failed");
  }

  /** Account bound to the API key. Useful as a liveness probe. */
  account() {
    return this.request<Record<string, unknown>>("GET", "/account/");
  }

  /** Allowlist of categories accepted by create and list filters. */
  categories() {
    return this.request<{ categories: string[] }>("GET", "/categories/");
  }

  listMarkets(
    params: {
      category?: string;
      status?: string;
      createdBy?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    return this.request<ListMarketsResult>("GET", "/markets/", {
      query: params,
    });
  }

  /** Single catalog row with spot prices filled from on-chain state. */
  getMarket(marketId: string) {
    return this.request<MarketRow>(
      "GET",
      `/markets/${encodeURIComponent(marketId)}/`,
    );
  }

  /** Holdings for a wallet, including whether each side can be claimed. */
  positions(wallet: string) {
    return this.request<PositionsResult>("GET", "/positions/", {
      query: { wallet },
    });
  }

  /** Quote a YES/NO fill on the bonding curve. Sessions last about 90s. */
  quoteBuy(input: QuoteBuyInput) {
    return this.request<BuyQuote>("POST", "/primaryorderquote/", {
      body: input,
    });
  }

  /** Build unsigned primary_order_usdc instructions from a live quote. */
  buildBuy(input: BuildBuyInput) {
    return this.request<BuiltBuyOrder>("POST", "/primaryorderbuild/", {
      body: input,
    });
  }

  /** Register the broadcast signature. Idempotent for the same pair. */
  submitBuy(input: { orderId: string; signature: string; wallet?: string }) {
    return this.request<{ orderId: string; status: string; signature: string }>(
      "POST",
      "/primaryordersubmit/",
      { body: input },
    );
  }

  /** Current order status. Optionally associates a signature without blocking. */
  verifyBuy(input: { orderId: string; signature?: string }) {
    return this.request<Record<string, unknown>>(
      "POST",
      "/primaryorderverify/",
      { body: input },
    );
  }

  /** Unsigned claim instructions for a resolved market the wallet won. */
  buildWinClaim(input: BuildClaimInput) {
    return this.request<BuiltClaim>("POST", "/claim/build/", { body: input });
  }

  /** Creator-fee claim instructions. Not reportable through /trades/. */
  buildCreatorFeeClaim(input: BuildClaimInput) {
    return this.request<BuiltCreatorFeeClaim>(
      "POST",
      "/claim/creator-fees/build/",
      { body: input },
    );
  }

  /** Verify an on-chain buy or win claim and store attribution. */
  reportTrade(input: {
    signature: string;
    wallet: string;
    marketId: string;
    quoteId?: string;
    clientOrderId?: string;
    userId?: string;
  }) {
    return this.request<ReportTradeResult>("POST", "/trades/", {
      body: input,
    });
  }

  /** Attribution or confirmation status for a broadcast signature. */
  tradeStatus(signature: string) {
    return this.request<TradeStatusResult>(
      "GET",
      `/trades/${encodeURIComponent(signature)}/`,
    );
  }

  /** Fee quote for creating a market. Sessions last about 5 minutes. */
  quoteCreateMarket(input: QuoteCreateMarketInput) {
    return this.request<CreateMarketQuote>("POST", "/markets/create/quote/", {
      body: input,
    });
  }

  /** Unsigned versioned transaction for the quoted create. */
  buildCreateMarket(input: { createId: string; wallet?: string }) {
    return this.request<BuiltCreateMarket>("POST", "/markets/create/build/", {
      body: input,
    });
  }

  /** Verify the confirmed on-chain create and write catalog metadata. */
  registerMarket(input: { createId: string; signature: string }) {
    return this.request<{
      createId: string;
      marketId: string;
      status: string;
      signature: string;
      images: string[];
    }>("POST", "/markets/register/", { body: input });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 400) };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds a client from the environment, or returns null when unconfigured. */
export function pantaFromEnv(): PantaClient | null {
  const apiKey = process.env.PANTA_API_KEY;
  if (!apiKey) return null;
  return new PantaClient({
    apiKey,
    baseUrl: process.env.PANTA_BASE_URL,
    timeoutMs: process.env.PANTA_TIMEOUT_MS
      ? Number(process.env.PANTA_TIMEOUT_MS)
      : undefined,
  });
}
