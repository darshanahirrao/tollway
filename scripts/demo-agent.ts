/**
 * End-to-end devnet demo.
 *
 * Plays both sides of the protocol: it boots the Tollway gateway in-process,
 * then acts as an autonomous agent that discovers a paid resource, gets a 402,
 * settles the invoice on Solana devnet, and redeems it for the data.
 *
 * Run with:  pnpm demo
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const KEYPAIR_DIR = "keypairs";
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const kp = Keypair.generate();
  mkdirSync(KEYPAIR_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  return kp;
}

async function ensureFunds(
  connection: Connection,
  kp: Keypair,
  minimumSol: number,
): Promise<boolean> {
  const balance = await connection.getBalance(kp.publicKey);
  if (balance >= minimumSol * LAMPORTS_PER_SOL) return true;

  console.log(`  airdropping 1 devnet SOL to ${kp.publicKey.toBase58()}...`);
  try {
    const sig = await connection.requestAirdrop(
      kp.publicKey,
      LAMPORTS_PER_SOL,
    );
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: sig, ...latest },
      "confirmed",
    );
    return true;
  } catch (error) {
    console.log(
      `  airdrop failed (devnet faucets are rate limited): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function main() {
  mkdirSync(KEYPAIR_DIR, { recursive: true });
  const merchant = loadOrCreateKeypair(join(KEYPAIR_DIR, "merchant.json"));
  const agent = loadOrCreateKeypair(join(KEYPAIR_DIR, "agent.json"));

  // config.ts reads env at import time, so set everything before importing it.
  process.env.TOLLWAY_NETWORK = "devnet";
  process.env.TOLLWAY_CURRENCY = "sol";
  process.env.TOLLWAY_MERCHANT_WALLET = merchant.publicKey.toBase58();
  process.env.TOLLWAY_DATA_DIR = ".tollway-demo";

  const { config } = await import("../src/config.js");
  const { InvoiceLedger } = await import("../src/lib/receipts.js");
  const { createApp } = await import("../src/app.js");

  const connection = new Connection(config.rpcUrl, "confirmed");
  const ledger = new InvoiceLedger(config.dataDir);
  const app = createApp({ connection, ledger });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 4021;
  const base = `http://127.0.0.1:${port}`;

  console.log("\n=== Tollway end-to-end devnet demo ===");
  console.log(`merchant : ${merchant.publicKey.toBase58()}`);
  console.log(`agent    : ${agent.publicKey.toBase58()}`);
  console.log(`gateway  : ${base}\n`);

  const funded = await ensureFunds(connection, agent, 0.05);
  if (!funded) {
    console.log(
      "\nAgent has no devnet SOL, so it cannot settle the invoice.",
    );
    console.log(
      "Fund the agent address above from https://faucet.solana.com and re-run `pnpm demo`.",
    );
    server.close();
    process.exitCode = 1;
    return;
  }

  const slug = "solana-validator-health";
  const url = `${base}/v1/data/${slug}`;

  console.log(`1. agent requests ${slug} without paying`);
  const first = await fetch(url);
  const invoice = (await first.json()) as {
    payUrl: string;
    reference: string;
    amount: number;
    currency: string;
    recipient: string;
  };
  console.log(`   -> HTTP ${first.status} payment_required`);
  console.log(`   -> ${invoice.amount} ${invoice.currency} to ${invoice.recipient}`);
  console.log(`   -> reference ${invoice.reference}`);

  console.log("\n2. agent settles the invoice on Solana devnet");
  const reference = new PublicKey(invoice.reference);
  const lamports = Math.round(invoice.amount * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: agent.publicKey,
      toPubkey: config.merchantWallet,
      lamports,
    }),
    // The reference rides along as a read-only account so the gateway can find
    // this payment without trusting a client-supplied signature.
    new TransactionInstruction({
      keys: [
        { pubkey: agent.publicKey, isSigner: true, isWritable: false },
        { pubkey: reference, isSigner: false, isWritable: false },
      ],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from("tollway", "utf8"),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [agent], {
    commitment: "confirmed",
  });
  console.log(`   -> settled ${signature}`);
  console.log(
    `   -> https://explorer.solana.com/tx/${signature}?cluster=devnet`,
  );

  console.log("\n3. agent retries with the payment reference");
  const second = await fetch(url, {
    headers: { "X-Payment-Reference": invoice.reference },
  });
  if (second.status !== 200) {
    console.log(`   -> HTTP ${second.status}`);
    console.log(`   -> ${JSON.stringify(await second.json(), null, 2)}`);
    console.log(
      "\nIf this says no_matching_transaction, the RPC has not indexed the payment yet. Re-run in a few seconds.",
    );
    server.close();
    process.exitCode = 1;
    return;
  }
  const payload = (await second.json()) as {
    data: Record<string, unknown>;
    receipt: Record<string, unknown>;
  };
  console.log(`   -> HTTP ${second.status} OK`);
  console.log(`   -> data keys: ${Object.keys(payload.data).join(", ")}`);
  console.log(`   -> receipt signature: ${payload.receipt.signature}`);

  console.log("\n4. replaying the same reference must be refused");
  const replay = await fetch(url, {
    headers: { "X-Payment-Reference": invoice.reference },
  });
  const replayBody = (await replay.json()) as { error: string };
  console.log(`   -> HTTP ${replay.status} ${replayBody.error}`);

  console.log("\n=== demo complete ===\n");
  server.close();
}

await main();
