/**
 * Extended live Solami demo for screen capture.
 *
 * Same real data path as solami-live-check.ts, staged so a viewer can follow it
 * in real time: every number below comes from a live Solana mainnet request
 * through Solami, plus a cross-check against the public mainnet endpoint to
 * show the chain head is genuine. No fixtures, no recorded output.
 *
 * Run with:  pnpm tsx scripts/solami-live-demo.ts
 */
import { readFileSync } from "node:fs";
import { SolamiClient } from "../src/providers/solami.js";
import type { RegionProbe } from "../src/providers/solami.js";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pacing multiplier for the printed lines only, so the recording reads at a
// human speed. Network waits and the deliberate replay pause stay unscaled.
const PACE = 2.0;
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

async function line(text = "", delay = 900) {
  console.log(text);
  await sleep(Math.round(delay * PACE));
}

async function publicMainnetSlot(): Promise<number | null> {
  try {
    const res = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }),
    });
    const body = (await res.json()) as { result?: number };
    return typeof body.result === "number" ? body.result : null;
  } catch {
    return null;
  }
}

const client = new SolamiClient({ apiKey: resolveApiKey() ?? "" });
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

const stamp = () =>
  new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";

const bySpeed = (list: RegionProbe[], dir: 1 | -1) =>
  list.filter((r) => r.ok).sort((a, b) => dir * ((a.latencyMs ?? 0) - (b.latencyMs ?? 0)))[0];

process.stdout.write("\x1b[2J\x1b[H");

await line(`${BOLD}Tollway — Solami multi-region RPC check${RESET}`, 1100);
await line(`${DIM}Solana mainnet. Live requests, no fixtures.${RESET}`, 1100);
await line(`${DIM}started ${stamp()}${RESET}`, 1600);
await line("");

await line(`${CYAN}[1/6] Which Solami region is healthy right now?${RESET}`, 1200);
await line(`${DIM}asking ams, nl and SGP the same question at the same time...${RESET}`, 1400);

const probeA = await client.probe("sol");

await line("");
await line(`${DIM}region   ok    latency       slot     epoch${RESET}`, 250);
for (const r of probeA) {
  const latency = r.latencyMs === null ? "     -" : `${r.latencyMs}ms`.padStart(7);
  const slot = r.slot === null ? "-" : String(r.slot).padStart(12);
  const epoch = r.epoch === null ? "-" : String(r.epoch).padStart(6);
  const ok = r.ok ? `${GREEN} yes${RESET}` : "  no";
  await line(`${r.region.padEnd(7)} ${ok}  ${latency}  ${slot}  ${epoch}`, 650);
}
await line("");
await line(`Reachable regions: ${BOLD}${probeA.filter((r) => r.ok).length}/3${RESET}`, 900);
await line(
  `Fastest: ${GREEN}${bySpeed(probeA, 1)?.region ?? "n/a"}${RESET}   ` +
    `Slowest: ${YELLOW}${bySpeed(probeA, -1)?.region ?? "n/a"}${RESET}`,
  1800,
);
await line("");

await line(`${CYAN}[2/6] Do the regions agree on the chain head?${RESET}`, 1200);
const slotsA = probeA.filter((r) => r.slot !== null).map((r) => r.slot as number);
const delta = slotsA.length > 1 ? Math.max(...slotsA) - Math.min(...slotsA) : 0;
await line(
  `slot delta: ${delta === 0 ? GREEN : YELLOW}${delta}${RESET}   ` +
    `consistent: ${delta === 0 ? GREEN + "true" : YELLOW + "false"}${RESET}`,
  1200,
);
await line(`${DIM}one endpoint cannot answer this — it only ever sees its own head${RESET}`, 1800);
await line("");

await line(`${CYAN}[3/6] Read real account state through the fastest region${RESET}`, 1200);
const fastest = bySpeed(probeA, 1);
const readA = await client.getAccount(USDC_MINT, fastest?.region);
await line(`${DIM}${USDC_MINT}${RESET}  ${DIM}(USDC mint)${RESET}`, 700);
await line(`  served by:    ${BOLD}${readA.region}${RESET} in ${readA.latencyMs}ms`, 800);
await line(`  owner:        ${readA.result.value?.owner ?? "not found"}`, 800);
await line(`  lamports:     ${readA.result.value?.lamports ?? 0}`, 800);
await line(`  read at slot: ${readA.result.context.slot}`, 1400);
await line("");

await line(`${CYAN}[4/6] Cross-check — is the chain head genuine?${RESET}`, 1200);
await line(`${DIM}polling api.mainnet-beta.solana.com directly...${RESET}`, 1000);
const publicSlot = await publicMainnetSlot();
const solamiSlot = readA.result.context.slot;
if (publicSlot !== null) {
  const gap = Math.abs(publicSlot - solamiSlot);
  await line(`  public mainnet-beta slot: ${publicSlot}`, 800);
  await line(`  solami (${readA.region}) read at: ${solamiSlot}`, 800);
  await line(
    `  gap: ${gap} slots  ${gap <= 64 ? GREEN + "(same chain; blocks are ~0.4s)" : YELLOW + "(check clock)"}${RESET}`,
    1800,
  );
} else {
  await line(`${YELLOW}  public endpoint unavailable this run${RESET}`, 1500);
}
await line("");

await line(`${CYAN}[5/6] Read a second account through the same region${RESET}`, 1200);
const readB = await client.getAccount(WRAPPED_SOL, readA.region);
await line(`  ${WRAPPED_SOL}`, 700);
await line(`  owner: ${readB.result.value?.owner ?? "not found"}`, 800);
await line(
  `  served by ${BOLD}${readB.region}${RESET} in ${readB.latencyMs}ms at slot ${readB.result.context.slot}`,
  1400,
);
await line("");

await line(`${CYAN}[6/6] Second pass — does the chain actually move?${RESET}`, 1200);
await line(`${DIM}waiting 20s, then asking every region again...${RESET}`, 1200);
await sleep(20_000);
const probeB = await client.probe("sol");
await line("");
await line(`${DIM}region   ok    latency       slot     epoch${RESET}`, 250);
for (const r of probeB) {
  const latency = r.latencyMs === null ? "     -" : `${r.latencyMs}ms`.padStart(7);
  const slot = r.slot === null ? "-" : String(r.slot).padStart(12);
  const epoch = r.epoch === null ? "-" : String(r.epoch).padStart(6);
  const ok = r.ok ? `${GREEN} yes${RESET}` : "  no";
  await line(`${r.region.padEnd(7)} ${ok}  ${latency}  ${slot}  ${epoch}`, 650);
}
const slotsB = probeB.filter((r) => r.slot !== null).map((r) => r.slot as number);
const moved = Math.max(...slotsB) - Math.max(...slotsA);
await line("");
await line(
  `slot advanced by ${BOLD}${moved}${RESET} since the first pass  ${DIM}(live chain, not a fixture)${RESET}`,
  1500,
);
await line("");

await line(`${BOLD}Sell it per call.${RESET}`, 1200);
await line(`github.com/darshanahirrao/tollway`, 1200);
await line(`${DIM}pnpm tsx scripts/solami-live-check.ts${RESET}`, 1200);
await line(
  `${DIM}Three priced resources. Payable in USDC, no API key handed to the caller.${RESET}`,
  1200,
);
await line("");
await line(`${DIM}ended ${stamp()}${RESET}`, 4000);
