import { Connection, PublicKey } from "@solana/web3.js";
import {
  PantaError,
  pantaFromEnv,
  type PantaClient,
  type PantaSide,
} from "../providers/panta.js";
import {
  MeteoraError,
  getPreset,
  listPresets,
  validateConfig,
} from "../providers/meteora.js";
import type { ConfigParameters } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  SOLAMI_REGIONS,
  SolamiError,
  solamiFromEnv,
  type SolamiClient,
  type SolamiRegion,
} from "../providers/solami.js";

export interface HandlerContext {
  connection: Connection;
  params: Record<string, string>;
}

export type Handler = (ctx: HandlerContext) => Promise<unknown>;

export class HandlerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (!value) {
    throw new HandlerError(`Missing required query parameter: ${name}`);
  }
  return value;
}

function parsePubkey(value: string, name: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new HandlerError(`${name} is not a valid base58 address: ${value}`);
  }
}

function optionalParam(
  params: Record<string, string>,
  name: string,
): string | undefined {
  const value = params[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Panta handlers share three concerns: the gateway must be configured, the
 * upstream error code has to survive as an HTTP status an agent can act on, and
 * nothing should be silently swallowed. This keeps all three in one place.
 */
async function withPanta<T>(fn: (client: PantaClient) => Promise<T>): Promise<T> {
  const client = pantaFromEnv();
  if (!client) {
    throw new HandlerError(
      "Panta is not configured on this gateway. Set PANTA_API_KEY to enable the Panta resources.",
      503,
    );
  }
  try {
    return await fn(client);
  } catch (error) {
    if (error instanceof PantaError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      throw new HandlerError(`${error.code}: ${error.message}`, status);
    }
    throw error;
  }
}

/** Solami key handling, with the upstream status preserved for the caller. */
async function withSolami<T>(fn: (client: SolamiClient) => Promise<T>): Promise<T> {
  const client = solamiFromEnv();
  if (!client) {
    throw new HandlerError(
      "Solami is not configured on this gateway. Set SOLAMI_API_KEY to enable the Solami resources.",
      503,
    );
  }
  try {
    return await fn(client);
  } catch (error) {
    if (error instanceof SolamiError) {
      const status =
        error.status && error.status >= 400 && error.status < 600
          ? error.status
          : 502;
      throw new HandlerError(`${error.code}: ${error.message}`, status);
    }
    throw error;
  }
}

function solamiRegion(params: Record<string, string>): SolamiRegion | undefined {
  const raw = optionalParam(params, "region");
  if (!raw) return undefined;
  const match = SOLAMI_REGIONS.find(
    (r) => r.id.toLowerCase() === raw.toLowerCase(),
  );
  if (!match) {
    throw new HandlerError(
      `Unknown Solami region: ${raw}. Known regions: ${SOLAMI_REGIONS.map((r) => r.id).join(", ")}`,
    );
  }
  return match.id;
}

/** Per-region latency and liveness. */
const solamiRegionLatency: Handler = async ({ params }) =>
  withSolami(async (client) => {
    const regions = await client.probe(optionalParam(params, "network") ?? "sol");
    const healthy = regions.filter((r) => r.ok);
    return {
      network: optionalParam(params, "network") ?? "sol",
      regions,
      healthy: healthy.length,
      total: regions.length,
      fastest: healthy
        .filter((r) => r.latencyMs !== null)
        .sort((a, b) => (a.latencyMs as number) - (b.latencyMs as number))[0]
        ?.region ?? null,
      observedAt: new Date().toISOString(),
    };
  });

/** The multi-region report: who is behind, and by how much. */
const solamiSlotSkew: Handler = async ({ params }) =>
  withSolami((client) =>
    client.slotSkew(optionalParam(params, "network") ?? "sol"),
  );

/** Account state, read through the fastest region with cross-region failover. */
const solamiAccountRead: Handler = async ({ params }) =>
  withSolami(async (client) => {
    const pubkey = requireParam(params, "pubkey");
    const result = await client.getAccount(
      pubkey,
      solamiRegion(params),
      optionalParam(params, "network") ?? "sol",
    );
    const value = result.result.value;
    return {
      pubkey,
      region: result.region,
      latencyMs: result.latencyMs,
      slot: result.result.context.slot,
      exists: value !== null,
      lamports: value?.lamports ?? 0,
      sol: value ? value.lamports / 1e9 : 0,
      owner: value?.owner ?? null,
      executable: value?.executable ?? null,
      dataEncoding: value ? "base64" : null,
    };
  });

/** Panta's public USDC market catalog. */
const pantaMarkets: Handler = async ({ params }) =>
  withPanta((client) =>
    client.listMarkets({
      category: optionalParam(params, "category"),
      status: optionalParam(params, "status"),
      createdBy: optionalParam(params, "createdBy"),
      cursor: optionalParam(params, "cursor"),
      limit: params.limit ? Number(params.limit) : undefined,
    }),
  );

/** Pay-to-use preset marketplace: what a launchpad browses before it deploys. */
const meteoraDbcPresets: Handler = async () => listPresets();

/** A single preset as a ready ConfigParameters object. */
const meteoraDbcPreset: Handler = async ({ params }) => {
  const slug = requireParam(params, "slug");
  try {
    return getPreset(slug);
  } catch (error) {
    if (error instanceof MeteoraError) {
      throw new HandlerError(`${error.code}: ${error.message}`, 404);
    }
    throw error;
  }
};

/**
 * Config doctor. Runs Meteora's own validator over a caller-supplied config so
 * a launchpad finds out why its config would be rejected before it pays for a
 * create transaction.
 */
const meteoraDbcConfigValidate: Handler = async ({ params }) => {
  const raw = requireParam(params, "config");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HandlerError("config must be a JSON object", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerError("config must be a JSON object", 400);
  }
  return validateConfig(parsed as ConfigParameters);
};

/** One market with live spot prices, for mark-to-market and price checks. */
const pantaMarket: Handler = async ({ params }) =>
  withPanta((client) =>
    client.getMarket(requireParam(params, "marketId")),
  );

/** Holdings plus claim eligibility, the read an agent makes before it claims. */
const pantaPositions: Handler = async ({ params }) =>
  withPanta((client) => client.positions(requireParam(params, "wallet")));

/** Step one of a buy: price the fill and open a short-lived quote session. */
const pantaBuyQuote: Handler = async ({ params }) =>
  withPanta((client) =>
    client.quoteBuy({
      wallet: requireParam(params, "wallet"),
      marketId: requireParam(params, "marketId"),
      side: requireParam(params, "side").toLowerCase() as PantaSide,
      amountUsdc: requireParam(params, "amountUsdc"),
      userId: optionalParam(params, "userId"),
    }),
  );

/** Step two of a buy: unsigned instructions the caller's wallet signs. */
const pantaBuyBuild: Handler = async ({ params }) =>
  withPanta((client) =>
    client.buildBuy({
      quoteId: requireParam(params, "quoteId"),
      wallet: requireParam(params, "wallet"),
      userId: optionalParam(params, "userId"),
      maxSlippageBps: params.maxSlippageBps
        ? Number(params.maxSlippageBps)
        : undefined,
    }),
  );

/** Claim instructions for winning shares in a resolved market. */
const pantaClaimBuild: Handler = async ({ params }) =>
  withPanta((client) =>
    client.buildWinClaim({
      wallet: requireParam(params, "wallet"),
      marketId: requireParam(params, "marketId"),
    }),
  );

/** Creator-fee claim instructions for a graduated market. */
const pantaCreatorFeeBuild: Handler = async ({ params }) =>
  withPanta((client) =>
    client.buildCreatorFeeClaim({
      wallet: requireParam(params, "wallet"),
      marketId: requireParam(params, "marketId"),
    }),
  );

/** Verify a broadcast transaction on chain and store partner attribution. */
const pantaTradeReport: Handler = async ({ params }) =>
  withPanta((client) =>
    client.reportTrade({
      signature: requireParam(params, "signature"),
      wallet: requireParam(params, "wallet"),
      marketId: requireParam(params, "marketId"),
      quoteId: optionalParam(params, "quoteId"),
      clientOrderId: optionalParam(params, "clientOrderId"),
      userId: optionalParam(params, "userId"),
    }),
  );

/**
 * Market creation fee quote. `sources` is a comma-separated list because the
 * gateway surface is GET with query parameters.
 */
const pantaMarketCreateQuote: Handler = async ({ params }) =>
  withPanta((client) =>
    client.quoteCreateMarket({
      wallet: requireParam(params, "wallet"),
      question: requireParam(params, "question"),
      resolutionRule: requireParam(params, "resolutionRule"),
      sourcesOfTruth: requireParam(params, "sources")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      category: requireParam(params, "category"),
      startTime: Number(requireParam(params, "startTime")),
      endTime: Number(requireParam(params, "endTime")),
      resolutionTime: Number(requireParam(params, "resolutionTime")),
      imageUrl: requireParam(params, "imageUrl"),
      marketType: optionalParam(params, "marketType") as
        | "standard"
        | "breaking"
        | undefined,
      title: optionalParam(params, "title"),
      region: optionalParam(params, "region"),
    }),
  );

/** Cluster liveness and epoch progress, the numbers an agent checks before it transacts. */
const solanaValidatorHealth: Handler = async ({ connection }) => {
  const [slot, epoch, samples, supply] = await Promise.all([
    connection.getSlot("confirmed"),
    connection.getEpochInfo("confirmed"),
    connection.getRecentPerformanceSamples(10),
    connection.getSupply("confirmed"),
  ]);

  const observed = samples
    .filter((s) => s.samplePeriodSecs > 0)
    .map((s) => s.numTransactions / s.samplePeriodSecs);
  const tps =
    observed.length > 0
      ? observed.reduce((a, b) => a + b, 0) / observed.length
      : 0;

  return {
    slot,
    epoch: epoch.epoch,
    epochProgressPct: Number(
      ((epoch.slotIndex / epoch.slotsInEpoch) * 100).toFixed(2),
    ),
    slotsInEpoch: epoch.slotsInEpoch,
    absoluteSlot: epoch.absoluteSlot,
    blockHeight: epoch.blockHeight,
    avgTpsLast10Samples: Number(tps.toFixed(1)),
    sampleCount: samples.length,
    totalSupplySol: supply.value.total / 1e9,
    healthy: tps > 0 && epoch.slotIndex > 0,
    observedAt: new Date().toISOString(),
  };
};

/** Mint-level risk flags. Cheap to compute, high signal for agents holding tokens. */
const tokenRiskScan: Handler = async ({ connection, params }) => {
  const mint = parsePubkey(requireParam(params, "mint"), "mint");

  const info = await connection.getParsedAccountInfo(mint, "confirmed");
  if (!info.value) {
    throw new HandlerError(`Mint account not found: ${mint.toBase58()}`, 404);
  }

  const data = info.value.data;
  if (!("parsed" in data) || data.parsed?.type !== "mint") {
    throw new HandlerError(`${mint.toBase58()} is not a parsed SPL mint account`);
  }

  const parsed = data.parsed.info as {
    decimals: number;
    supply: string;
    mintAuthority: string | null;
    freezeAuthority: string | null;
    isInitialized: boolean;
  };

  let largestAccounts: { address: string; uiAmount: number | null }[] = [];
  try {
    const largest = await connection.getTokenLargestAccounts(mint);
    largestAccounts = largest.value.slice(0, 10).map((a) => ({
      address: a.address.toBase58(),
      uiAmount: a.uiAmount,
    }));
  } catch {
    // Largest-account RPC is not available on every provider; the mint-level
    // flags below are still valid, so degrade instead of failing.
    largestAccounts = [];
  }

  const flags: string[] = [];
  if (parsed.mintAuthority) flags.push("mint_authority_active");
  if (parsed.freezeAuthority) flags.push("freeze_authority_active");
  if (!parsed.isInitialized) flags.push("mint_not_initialized");

  return {
    mint: mint.toBase58(),
    decimals: parsed.decimals,
    supplyRaw: parsed.supply,
    supplyUi: Number(parsed.supply) / 10 ** parsed.decimals,
    mintAuthority: parsed.mintAuthority,
    freezeAuthority: parsed.freezeAuthority,
    isInitialized: parsed.isInitialized,
    riskFlags: flags,
    riskLevel:
      flags.includes("uninitialized") || flags.length >= 2
        ? "high"
        : flags.length === 1
          ? "medium"
          : "low",
    topHolders: largestAccounts,
    observedAt: new Date().toISOString(),
  };
};

/** Recent behaviour of a wallet: is this counterparty reliable or a burner? */
const walletActivityDigest: Handler = async ({ connection, params }) => {
  const wallet = parsePubkey(requireParam(params, "wallet"), "wallet");
  const limit = Math.min(Number(params.limit ?? 50), 200);

  const [signatures, balance] = await Promise.all([
    connection.getSignaturesForAddress(wallet, { limit }),
    connection.getBalance(wallet, "confirmed"),
  ]);

  const failures = signatures.filter((s) => s.err).length;
  const blockTimes = signatures
    .map((s) => s.blockTime)
    .filter((t): t is number => typeof t === "number");

  const first = blockTimes.length ? Math.min(...blockTimes) : null;
  const last = blockTimes.length ? Math.max(...blockTimes) : null;

  return {
    wallet: wallet.toBase58(),
    solBalance: balance / 1e9,
    sampledTransactions: signatures.length,
    failedTransactions: failures,
    failureRatePct: signatures.length
      ? Number(((failures / signatures.length) * 100).toFixed(1))
      : 0,
    lastActivityAt: last ? new Date(last * 1000).toISOString() : null,
    activityWindowSeconds: first && last ? last - first : null,
    isActive: signatures.length > 0,
    isFresh: signatures.length === 0 || balance === 0,
    observedAt: new Date().toISOString(),
  };
};

export const handlers: Record<string, Handler> = {
  "solana-validator-health": solanaValidatorHealth,
  "token-risk-scan": tokenRiskScan,
  "wallet-activity-digest": walletActivityDigest,
  "panta-markets": pantaMarkets,
  "panta-market": pantaMarket,
  "panta-positions": pantaPositions,
  "panta-buy-quote": pantaBuyQuote,
  "panta-buy-build": pantaBuyBuild,
  "panta-claim-build": pantaClaimBuild,
  "panta-creator-fee-build": pantaCreatorFeeBuild,
  "panta-trade-report": pantaTradeReport,
  "panta-market-create-quote": pantaMarketCreateQuote,
  "meteora-dbc-presets": meteoraDbcPresets,
  "meteora-dbc-preset": meteoraDbcPreset,
  "meteora-dbc-config-validate": meteoraDbcConfigValidate,
  "solami-region-latency": solamiRegionLatency,
  "solami-slot-skew": solamiSlotSkew,
  "solami-account-read": solamiAccountRead,
};
