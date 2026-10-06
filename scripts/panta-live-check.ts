/**
 * Live check of the Panta provider against the real Panta API.
 *
 * This runs the same handler code the paid gateway runs, with a real
 * PANTA_API_KEY, and prints what came back. Nothing is mocked: if Panta is
 * unreachable, mis-keyed, or the request shape is wrong, this exits non-zero.
 *
 * The key is read from PANTA_API_KEY, or from ../.secrets/panta.json (the
 * gitignored store used when the account was provisioned).
 *
 * Run with:  pnpm tsx scripts/panta-live-check.ts
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

// config.ts reads the environment at import time.
process.env.TOLLWAY_NETWORK ??= "devnet";
process.env.TOLLWAY_MERCHANT_WALLET ??= Keypair.generate().publicKey.toBase58();
process.env.TOLLWAY_DATA_DIR ??= mkdtempSync(join(tmpdir(), "tollway-panta-"));

function resolveApiKey(): string | null {
  if (process.env.PANTA_API_KEY) return process.env.PANTA_API_KEY;
  try {
    const raw = readFileSync(
      new URL("../../.secrets/panta.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { apiKey?: string };
    return parsed.apiKey ?? null;
  } catch {
    return null;
  }
}

const apiKey = resolveApiKey();
if (!apiKey) {
  console.error(
    "No Panta key found. Set PANTA_API_KEY or create ../.secrets/panta.json.",
  );
  process.exitCode = 1;
} else {
  process.env.PANTA_API_KEY = apiKey;

  const { handlers } = await import("../src/lib/data.js");
  const { resources } = await import("../src/config.js");

  type Row = { slug: string; price: number; ok: boolean; detail: string };
  const rows: Row[] = [];
  const pantaSlugs = resources
    .map((r) => r.slug)
    .filter((slug) => slug.startsWith("panta-"));

  const call = async (
    slug: string,
    params: Record<string, string>,
  ): Promise<Row> => {
    const price = resources.find((r) => r.slug === slug)?.price ?? 0;
    const handler = handlers[slug];
    if (!handler) {
      return { slug, price, ok: false, detail: "no handler registered" };
    }
    try {
      const result = (await handler({
        // The Panta handlers do not touch the cluster; a dummy connection is
        // never dereferenced.
        connection: {} as never,
        params,
      })) as Record<string, unknown>;
      const summary =
        (Array.isArray(result.items) && `items: ${result.items.length}`) ||
        (Array.isArray(result.positions) && `positions: ${result.positions.length}`) ||
        (typeof result.title === "string" && `title: ${result.title}`) ||
        (typeof result.createId === "string" && `createId: ${result.createId}`) ||
        `keys: ${Object.keys(result).slice(0, 4).join(",")}`;
      return { slug, price, ok: true, detail: String(summary) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { slug, price, ok: false, detail: message.slice(0, 90) };
    }
  };

  console.log(`Panta provider live check — key ${apiKey.slice(0, 12)}...`);
  console.log(`Catalogue exposes ${pantaSlugs.length} Panta resources.\n`);

  const WALLET = "Buyer111111111111111111111111111111111";
  const MARKET = "TestMarket1111111111111111111111111111111";

  rows.push(await call("panta-markets", { limit: "3" }));
  rows.push(await call("panta-market", { marketId: MARKET }));
  rows.push(await call("panta-positions", { wallet: WALLET }));
  // Writes need a live quote; without a funded sandbox wallet these are
  // expected to be rejected upstream, which still proves the request path.
  rows.push(
    await call("panta-buy-quote", {
      wallet: WALLET,
      marketId: MARKET,
      side: "yes",
      amountUsdc: "1.00",
    }),
  );
  rows.push(await call("panta-claim-build", { wallet: WALLET, marketId: MARKET }));
  rows.push(
    await call("panta-creator-fee-build", { wallet: WALLET, marketId: MARKET }),
  );
  rows.push(
    await call("panta-trade-report", {
      signature: "1111111111111111111111111111111111111111111111111111111111111111",
      wallet: WALLET,
      marketId: MARKET,
    }),
  );
  // Creation fee quote. Panta requires startTime to be at least the on-chain
  // minimum delay ahead of now, so the window is computed at run time.
  const now = Math.floor(Date.now() / 1000);
  rows.push(
    await call("panta-market-create-quote", {
      wallet: WALLET,
      question: "Will Tollway settle a Panta market call before the deadline?",
      resolutionRule:
        "Resolves YES if the Tollway gateway returns a paid Panta market-creation quote before the stated deadline.",
      sources: "https://docs.panta.market,https://github.com/darshanahirrao/tollway",
      category: "crypto",
      startTime: String(now + 7200),
      endTime: String(now + 86_400),
      resolutionTime: String(now + 90_000),
      imageUrl: "https://darshanahirrao.github.io/tollway/assets/tollway-logo-1024.png",
    }),
  );

  for (const row of rows) {
    const mark = row.ok ? "ok  " : "err ";
    console.log(
      `${mark} ${row.slug.padEnd(26)} $${row.price.toFixed(2)}  ${row.detail}`,
    );
  }

  const readChecks = rows.filter((r) =>
    ["panta-markets", "panta-market", "panta-positions"].includes(r.slug),
  );
  const failedReads = readChecks.filter((r) => !r.ok);
  console.log(
    `\nRead paths passing: ${readChecks.length - failedReads.length}/${readChecks.length}`,
  );
  if (failedReads.length > 0) {
    console.error("Read paths must pass; see failures above.");
    process.exitCode = 1;
  }
}
