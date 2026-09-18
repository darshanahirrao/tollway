import { Keypair, PublicKey } from "@solana/web3.js";
import { config, decimalsFor, type Resource } from "../config.js";

export interface PaymentRequest {
  reference: PublicKey;
  /** solana: URI an agent wallet can parse and pay directly. */
  payUrl: string;
  /** Human- and agent-readable JSON form of the same invoice. */
  json: {
    recipient: string;
    amount: number;
    currency: string;
    reference: string;
    label: string;
    message: string;
    expiresAt: string;
  };
}

/**
 * Convert a display price into base units without floating point drift.
 * 0.01 USDC -> "10000"; 0.5 SOL -> "500000000".
 */
export function toBaseUnits(amount: number, currency: Resource["currency"]): string {
  const decimals = decimalsFor(currency);
  const scaled = Math.round(amount * 10 ** decimals);
  if (!Number.isFinite(scaled) || scaled <= 0) {
    throw new Error(`Invalid price ${amount} for currency ${currency}`);
  }
  return scaled.toString();
}

export function buildPaymentRequest(
  resource: Resource,
  reference: PublicKey,
  expiresAt: string,
): PaymentRequest {
  const amount = toBaseUnits(resource.price, resource.currency);
  const params = new URLSearchParams();
  params.set("amount", resource.price.toString());
  if (resource.currency === "usdc") {
    params.set("spl-token", config.usdcMint.toBase58());
  }
  params.set("reference", reference.toBase58());
  params.set("label", "Tollway");
  params.set("message", `${resource.name} (${amount} base units)`);

  return {
    reference,
    payUrl: `solana:${config.merchantWallet.toBase58()}?${params.toString()}`,
    json: {
      recipient: config.merchantWallet.toBase58(),
      amount: resource.price,
      currency: resource.currency.toUpperCase(),
      reference: reference.toBase58(),
      label: "Tollway",
      message: resource.name,
      expiresAt,
    },
  };
}

export function newReference(): PublicKey {
  return Keypair.generate().publicKey;
}
