import { Connection, PublicKey } from "@solana/web3.js";

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
};
