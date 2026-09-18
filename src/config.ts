import { PublicKey } from "@solana/web3.js";

// Load .env before anything reads process.env. Guarded because loadEnvFile is
// only present on Node 20.12+ and the file may legitimately not exist.
try {
  process.loadEnvFile?.();
} catch {
  // No .env present; fall back to the ambient environment.
}

export type Network = "devnet" | "mainnet-beta";

const USDC_MINT: Record<Network, string> = {
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

function requirePubkey(name: string, value: string | undefined): PublicKey {
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in the environment or in a .env file before starting Tollway.`,
    );
  }
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} is not a valid base58 Solana address: ${value}`);
  }
}

const network = (process.env.TOLLWAY_NETWORK ?? "devnet") as Network;
if (network !== "devnet" && network !== "mainnet-beta") {
  throw new Error(`TOLLWAY_NETWORK must be devnet or mainnet-beta, got ${network}`);
}

const defaultRpc =
  network === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com";

/**
 * Currency a resource is priced in. `sol` is supported so the gateway can be
 * demonstrated on devnet without holding a stablecoin balance.
 */
export type Currency = "usdc" | "sol";

export interface Resource {
  /** URL-safe identifier. */
  slug: string;
  name: string;
  description: string;
  /** Price in the resource's currency. USDC uses 6dp, SOL uses 9dp. */
  price: number;
  currency: Currency;
  /** Documented unit of the response, used in invoices and the MCP tool schema. */
  unit: string;
}

const defaultResources: Resource[] = [
  {
    slug: "solana-validator-health",
    name: "Solana Validator Health",
    description:
      "Live slot height, average slot time, epoch progress, and delinquency signals for the connected cluster.",
    price: 0.01,
    currency: "usdc",
    unit: "call",
  },
  {
    slug: "token-risk-scan",
    name: "SPL Token Risk Scan",
    description:
      "Mint authority, freeze authority, supply, and holder concentration flags for any SPL mint.",
    price: 0.05,
    currency: "usdc",
    unit: "call",
  },
  {
    slug: "wallet-activity-digest",
    name: "Wallet Activity Digest",
    description:
      "Recent transaction count, failure rate, and SOL flow summary for a wallet address.",
    price: 0.02,
    currency: "usdc",
    unit: "call",
  },
];

export const config = {
  network,
  rpcUrl: process.env.TOLLWAY_RPC_URL ?? defaultRpc,
  /**
   * Preference-ordered RPC endpoints. The first is the primary; the rest are
   * standbys used when the primary fails or rate limits. Set this to run on
   * RPC Fast with a public endpoint behind it:
   *   TOLLWAY_RPC_URLS="https://<key>.rpcfast.com/?...,https://api.devnet.solana.com"
   */
  rpcUrls: (
    process.env.TOLLWAY_RPC_URLS ??
    process.env.TOLLWAY_RPC_URL ??
    defaultRpc
  )
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0),
  port: Number(process.env.PORT ?? 4021),
  merchantWallet: requirePubkey(
    "TOLLWAY_MERCHANT_WALLET",
    process.env.TOLLWAY_MERCHANT_WALLET,
  ),
  usdcMint: new PublicKey(
    process.env.TOLLWAY_USDC_MINT ?? USDC_MINT[network],
  ),
  /** How long an issued invoice stays payable. */
  invoiceTtlSeconds: Number(process.env.TOLLWAY_INVOICE_TTL ?? 900),
  dataDir: process.env.TOLLWAY_DATA_DIR ?? ".tollway",
  /** Public base URL used when building pay URLs that agents hand back. */
  publicBaseUrl: process.env.TOLLWAY_PUBLIC_URL ?? "http://localhost:4021",
} as const;

/**
 * Operators can reprice the whole catalogue into a single currency. This exists
 * because a devnet deployment has no reliable stablecoin faucet, so demos run on
 * SOL while production runs on USDC.
 */
const currencyOverride = process.env.TOLLWAY_CURRENCY as Currency | undefined;
if (
  currencyOverride &&
  currencyOverride !== "usdc" &&
  currencyOverride !== "sol"
) {
  throw new Error(
    `TOLLWAY_CURRENCY must be usdc or sol, got ${currencyOverride}`,
  );
}

export const resources: Resource[] = currencyOverride
  ? defaultResources.map((r) => ({ ...r, currency: currencyOverride }))
  : defaultResources;

export function resourceBySlug(slug: string): Resource | undefined {
  return resources.find((r) => r.slug === slug);
}

export function decimalsFor(currency: Currency): number {
  return currency === "usdc" ? 6 : 9;
}
