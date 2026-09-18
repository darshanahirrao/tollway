import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Verification tests driven by a real Solana devnet transaction.
 *
 * The fixture is an actual devnet USDC transfer: 0.001 USDC from
 * 8sh86hmW... to 75AjMdh7... that carries a Memo instruction, which is exactly
 * the shape Tollway invoices produce. Testing against real chain data catches
 * the parsing mistakes that synthetic fixtures hide.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures", "devnet-usdc-transfer.json"),
    "utf8",
  ),
);

const RECIPIENT = "75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza";
const PAYER = "GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb";
const SIGNATURE = FIXTURE.transaction.signatures[0];

process.env.TOLLWAY_NETWORK = "devnet";
process.env.TOLLWAY_MERCHANT_WALLET = RECIPIENT;

let verifyPayment: typeof import("../src/payments/verify.js").verifyPayment;
let resourceBySlug: typeof import("../src/config.js").resourceBySlug;

beforeAll(async () => {
  ({ verifyPayment } = await import("../src/payments/verify.js"));
  ({ resourceBySlug } = await import("../src/config.js"));
});

/** Minimal stand-in for a Connection, serving the recorded fixture. */
function stubConnection(
  tx: unknown = FIXTURE,
  signatures: unknown = [
    { signature: SIGNATURE, err: null, blockTime: FIXTURE.blockTime },
  ],
): Connection {
  return {
    getSignaturesForAddress: async () => signatures,
    getParsedTransaction: async () => tx,
  } as unknown as Connection;
}

function withPrice(slug: string, price: number) {
  const resource = resourceBySlug(slug)!;
  return { ...resource, price, currency: "usdc" as const };
}

describe("on-chain payment verification", () => {
  it("accepts the real devnet transfer when the price is met", async () => {
    // The fixture moved 1000 base units (0.001 USDC) to the merchant.
    const result = await verifyPayment(
      stubConnection(),
      withPrice("solana-validator-health", 0.001),
      new PublicKey(PAYER),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receivedBaseUnits).toBe("1000");
      expect(result.signature).toBe(SIGNATURE);
      expect(result.payer).toBe(PAYER);
    }
  });

  it("rejects the same transfer when the price is higher", async () => {
    const result = await verifyPayment(
      stubConnection(),
      withPrice("token-risk-scan", 0.05),
      new PublicKey(PAYER),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("underpaid");
      expect(result.detail).toContain("50000");
    }
  });

  it("reports no_matching_transaction when the reference is unused", async () => {
    const result = await verifyPayment(
      stubConnection(FIXTURE, []),
      withPrice("solana-validator-health", 0.001),
      new PublicKey(PAYER),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_matching_transaction");
  });

  it("rejects a payment in an unexpected mint", async () => {
    // Same real transaction, with the mint rewritten to a token the merchant is
    // not configured to accept. This is the "paid in the wrong currency" path.
    const otherMint = "So11111111111111111111111111111111111111112";
    const tampered = structuredClone(FIXTURE);
    for (const row of tampered.meta.postTokenBalances) row.mint = otherMint;
    for (const row of tampered.meta.preTokenBalances) row.mint = otherMint;

    const result = await verifyPayment(
      stubConnection(tampered),
      withPrice("solana-validator-health", 0.001),
      new PublicKey(PAYER),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_mint");
  });

  it("ignores failed transactions", async () => {
    const result = await verifyPayment(
      stubConnection(FIXTURE, [
        { signature: SIGNATURE, err: { InstructionError: [0, "Custom"] }, blockTime: 1 },
      ]),
      withPrice("solana-validator-health", 0.001),
      new PublicKey(PAYER),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("transaction_failed");
  });
});
