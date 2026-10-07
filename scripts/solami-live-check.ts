/**
 * Live Solami check against Solana mainnet.
 *
 * This is the demo path the Solami bounty requires: real requests, real
 * mainnet, no fixtures. It asks every Solami region the same questions and
 * reports where they disagree, which is the only thing a single-endpoint RPC
 * cannot tell you.
 *
 * The key comes from SOLAMI_API_KEY, or from ../.secrets/solami.json.
 *
 * Run with:  pnpm tsx scripts/solami-live-check.ts
 */
import { readFileSync } from "node:fs";
import { SolamiClient } from "../src/providers/solami.js";

function resolveApiKey(): string | null {
  if (process.env.SOLAMI_API_KEY) return process.env.SOLAMI_API_KEY;
  try {
    const raw = readFileSync(
      new URL("../../.secrets/solami.json", import.meta.url),
      "utf8",
    );
    return (JSON.parse(raw) as { apiKey?: string }).apiKey ?? null;
  } catch {
    return null;
  }
}

const apiKey = resolveApiKey();
if (!apiKey) {
  console.error(
    "No Solami key found. Set SOLAMI_API_KEY or create ../.secrets/solami.json.",
  );
  process.exitCode = 1;
} else {
  const client = new SolamiClient({ apiKey });

  console.log(`Solami multi-region check — key ${apiKey.slice(0, 10)}...`);
  console.log("Network: sol (Solana mainnet)\n");

  const report = await client.slotSkew("sol");

  console.log("region        ok   latency   slot          epoch");
  for (const r of report.regions) {
    const latency = r.latencyMs === null ? "   -" : `${r.latencyMs}ms`.padStart(6);
    const slot = r.slot === null ? "-" : String(r.slot).padStart(13);
    const epoch = r.epoch === null ? "" : String(r.epoch);
    console.log(
      `${r.region.padEnd(6)} ${(r.ok ? "yes" : "no ").padEnd(5)} ${latency}   ${slot}  ${epoch}` +
        (r.error ? `   ${r.error}` : ""),
    );
  }

  console.log(`\nReachable regions: ${report.reachable}/${report.regions.length}`);
  console.log(`Fastest: ${report.fastestRegion ?? "n/a"}   Slowest: ${report.slowestRegion ?? "n/a"}`);
  console.log(`Slot delta: ${report.slotDelta ?? "n/a"}   Consistent: ${report.consistent}`);
  console.log(`Verdict: ${report.verdict}`);

  // A real on-chain read through the fastest region, to prove the data path
  // carries actual account state and not just health pings.
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  try {
    // Reuse the region we already measured rather than probing a second time.
    const account = await client.getAccount(USDC_MINT, report.fastestRegion ?? undefined);
    const value = account.result.value;
    console.log(
      `\nAccount read via ${account.region} (${account.latencyMs}ms): ${USDC_MINT}` +
        `\n  owner: ${value?.owner ?? "not found"}` +
        `\n  lamports: ${value?.lamports ?? 0}` +
        `\n  observed at slot: ${account.result.context.slot}`,
    );
  } catch (error) {
    console.error(
      "\nAccount read failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }

  if (report.reachable < 2) {
    console.error("\nFewer than two regions answered; a single region is not enough.");
    process.exitCode = 1;
  }
}
