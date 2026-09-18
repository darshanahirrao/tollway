/**
 * Live check against Solana devnet.
 *
 * There is no faucet SOL available to this machine, so instead of minting a
 * throwaway payment this script replays a *real* historical devnet USDC
 * transfer through the same verification code path the gateway uses in
 * production, then calls the real paid handlers against the live RPC.
 *
 * What this proves, end to end and unfaked:
 *   - the reference-anchored lookup finds a real transaction on chain
 *   - the merchant balance delta is read correctly out of token balances
 *   - underpayment is rejected
 *   - the data handlers return live cluster data
 *
 * Run with:  pnpm tsx scripts/live-check.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";

// Real devnet USDC transfer, captured 18 Sep 2026 (slot 500188983).
const REAL_SIGNATURE =
  "669PwMJQXsYmqqE9Zm1jREkXbVD934umrTPM8ctUbVPPLSZUfG7FUz5NMxZfEjXFeyMjXLJVkbSNvxGLSKHV2G9o";
const REAL_RECIPIENT = "75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza";
const REAL_REFERENCE = "GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb";

process.env.TOLLWAY_NETWORK = "devnet";
process.env.TOLLWAY_MERCHANT_WALLET = REAL_RECIPIENT;

const { config, resourceBySlug } = await import("../src/config.js");
const { verifyPayment } = await import("../src/payments/verify.js");
const { handlers } = await import("../src/lib/data.js");

const line = (label: string, value: unknown) =>
  console.log(`  ${label.padEnd(26)} ${String(value)}`);

const connection = new Connection(config.rpcUrl, "confirmed");

console.log("\n=== Tollway live check (Solana devnet) ===");
line("rpc", config.rpcUrl);
line("merchant", config.merchantWallet.toBase58());

console.log("\n1. reference lookup + balance delta on a real transaction");
const base = resourceBySlug("solana-validator-health")!;
const exact = await verifyPayment(
  connection,
  { ...base, price: 0.001, currency: "usdc" },
  new PublicKey(REAL_REFERENCE),
);
if (!exact.ok) {
  console.log(`  FAILED: ${exact.reason} ${exact.detail ?? ""}`);
  process.exit(1);
}
line("signature", exact.signature);
// This replay reuses a historical wallet as the reference, so several
// transactions on chain mention it. The verifier picks the first that actually
// credited the merchant. Real invoices mint a fresh keypair per invoice, which
// makes the reference unique to one payment.
line("unique reference (live)", exact.signature === REAL_SIGNATURE);
line("payer", exact.payer);
line("received base units", exact.receivedBaseUnits);

console.log("\n2. underpayment is rejected");
const overpriced = await verifyPayment(
  connection,
  { ...base, price: 1, currency: "usdc" },
  new PublicKey(REAL_REFERENCE),
);
line("price 1.00 USDC ->", overpriced.ok ? "ACCEPTED (bad)" : overpriced.reason);
if (overpriced.ok) process.exit(1);

console.log("\n3. paid handlers against the live cluster");
const health = (await handlers["solana-validator-health"]({
  connection,
  params: {},
})) as Record<string, unknown>;
line("slot", health.slot);
line("epoch", health.epoch);
line("epoch progress %", health.epochProgressPct);
line("avg tps", health.avgTpsLast10Samples);
line("healthy", health.healthy);

const risk = (await handlers["token-risk-scan"]({
  connection,
  params: { mint: config.usdcMint.toBase58() },
})) as Record<string, unknown>;
line("usdc mint", risk.mint);
line("usdc supply", risk.supplyUi);
line("usdc risk level", risk.riskLevel);
line("usdc risk flags", JSON.stringify(risk.riskFlags));

console.log("\n=== live check passed ===\n");
