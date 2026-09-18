import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { config, decimalsFor, type Resource } from "../config.js";
import { toBaseUnits } from "./solana-pay.js";

export type VerifyFailure =
  | "no_matching_transaction"
  | "transaction_failed"
  | "reference_missing"
  | "underpaid"
  | "wrong_mint";

export type VerifyResult =
  | {
      ok: true;
      signature: string;
      payer: string;
      receivedBaseUnits: string;
    }
  | { ok: false; reason: VerifyFailure; detail?: string };

/**
 * Accepts both shapes the RPC layer can hand back: `@solana/web3.js` returns
 * PublicKey instances from getParsedTransaction, while raw JSON-RPC payloads
 * (fixtures, proxies, other clients) carry base58 strings.
 */
function sameKey(a: unknown, b: unknown): boolean {
  return String(a) === String(b);
}

function merchantDeltaSol(
  tx: ParsedTransactionWithMeta,
  merchant: PublicKey,
): bigint | null {
  const keys = tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => sameKey(k.pubkey, merchant));
  if (idx < 0) return null;
  const pre = tx.meta?.preBalances?.[idx];
  const post = tx.meta?.postBalances?.[idx];
  if (pre === undefined || post === undefined) return null;
  return BigInt(post) - BigInt(pre);
}

function merchantDeltaSpl(
  tx: ParsedTransactionWithMeta,
  merchant: PublicKey,
  mint: PublicKey,
): bigint | null {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  const merchantKey = merchant.toBase58();
  const mintKey = mint.toBase58();

  const sum = (rows: typeof pre): bigint => {
    let total = 0n;
    for (const row of rows) {
      if (!row.owner) continue;
      if (row.owner !== merchantKey) continue;
      if (row.mint !== mintKey) continue;
      total += BigInt(row.uiTokenAmount.amount);
    }
    return total;
  };

  // Only report a delta when this transaction actually touched the merchant's
  // balance for the mint in question; otherwise an unrelated transaction could
  // be credited against a stale invoice.
  const touched = post.some((row) => row.owner === merchantKey && row.mint === mintKey);
  if (!touched) return null;

  return sum(post) - sum(pre);
}

/**
 * Confirm that `reference` was paid the required amount to the merchant wallet.
 *
 * Verification is anchored on the reference key rather than a client-supplied
 * signature: the reference is generated server-side per invoice and must appear
 * in the transaction's account list, so a caller cannot claim someone else's
 * payment.
 */
export async function verifyPayment(
  connection: Connection,
  resource: Resource,
  reference: PublicKey,
  options: { minContextSlot?: number } = {},
): Promise<VerifyResult> {
  const required = BigInt(toBaseUnits(resource.price, resource.currency));

  const signatures = await connection.getSignaturesForAddress(reference, {
    limit: 10,
    ...(options.minContextSlot !== undefined
      ? { minContextSlot: options.minContextSlot }
      : {}),
  });

  if (signatures.length === 0) {
    return { ok: false, reason: "no_matching_transaction" };
  }

  // Oldest first, so the first valid payment is authoritative when a payer
  // accidentally double-sends.
  for (const entry of [...signatures].reverse()) {
    if (entry.err) continue;

    const tx = await connection.getParsedTransaction(entry.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || tx.meta?.err) continue;

    const usesReference = tx.transaction.message.accountKeys.some((k) =>
      sameKey(k.pubkey, reference),
    );
    if (!usesReference) continue;

    let delta: bigint | null;
    if (resource.currency === "sol") {
      delta = merchantDeltaSol(tx, config.merchantWallet);
    } else {
      delta = merchantDeltaSpl(tx, config.merchantWallet, config.usdcMint);
      if (delta === null) {
        return { ok: false, reason: "wrong_mint" };
      }
    }

    if (delta === null) return { ok: false, reason: "reference_missing" };
    if (delta < required) {
      return {
        ok: false,
        reason: "underpaid",
        detail: `needed ${required.toString()}, saw ${delta.toString()}`,
      };
    }

    const payer = tx.transaction.message.accountKeys[0]?.pubkey
      ? String(tx.transaction.message.accountKeys[0].pubkey)
      : "unknown";
    return {
      ok: true,
      signature: entry.signature,
      payer,
      receivedBaseUnits: delta.toString(),
    };
  }

  return { ok: false, reason: "transaction_failed" };
}

export function displayAmount(resource: Resource): string {
  return `${resource.price} ${resource.currency.toUpperCase()} (${decimalsFor(
    resource.currency,
  )} decimals)`;
}
