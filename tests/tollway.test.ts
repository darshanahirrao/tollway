import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, Connection } from "@solana/web3.js";

// config.ts reads the environment at module load, so anything the gateway needs
// must be present before it is imported. The dynamic imports below run after this.
const MERCHANT = Keypair.generate();
process.env.TOLLWAY_NETWORK = "devnet";
process.env.TOLLWAY_MERCHANT_WALLET = MERCHANT.publicKey.toBase58();
process.env.TOLLWAY_DATA_DIR = mkdtempSync(join(tmpdir(), "tollway-test-"));
process.env.TOLLWAY_PUBLIC_URL = "http://localhost:4021";

let toBaseUnits: typeof import("../src/payments/solana-pay.js").toBaseUnits;
let buildPaymentRequest: typeof import("../src/payments/solana-pay.js").buildPaymentRequest;
let newReference: typeof import("../src/payments/solana-pay.js").newReference;
let InvoiceLedger: typeof import("../src/lib/receipts.js").InvoiceLedger;
let resourceBySlug: typeof import("../src/config.js").resourceBySlug;
let createApp: typeof import("../src/app.js").createApp;

beforeAll(async () => {
  const pay = await import("../src/payments/solana-pay.js");
  toBaseUnits = pay.toBaseUnits;
  buildPaymentRequest = pay.buildPaymentRequest;
  newReference = pay.newReference;
  ({ InvoiceLedger } = await import("../src/lib/receipts.js"));
  ({ resourceBySlug } = await import("../src/config.js"));
  ({ createApp } = await import("../src/app.js"));
});

describe("price conversion", () => {
  it("converts USDC to 6-decimal base units exactly", () => {
    expect(toBaseUnits(0.01, "usdc")).toBe("10000");
    expect(toBaseUnits(0.05, "usdc")).toBe("50000");
    expect(toBaseUnits(1, "usdc")).toBe("1000000");
  });

  it("converts SOL to lamports", () => {
    expect(toBaseUnits(0.5, "sol")).toBe("500000000");
    expect(toBaseUnits(1, "sol")).toBe("1000000000");
  });

  it("avoids float drift on awkward decimals", () => {
    expect(toBaseUnits(0.07, "usdc")).toBe("70000");
    expect(toBaseUnits(0.29, "usdc")).toBe("290000");
  });

  it("rejects non-positive prices", () => {
    expect(() => toBaseUnits(0, "usdc")).toThrow();
    expect(() => toBaseUnits(-1, "usdc")).toThrow();
  });
});

describe("solana pay request", () => {
  it("builds a solana: URI carrying the reference and token mint", () => {
    const resource = resourceBySlug("token-risk-scan")!;
    const reference = newReference();
    const pay = buildPaymentRequest(
      resource,
      reference,
      "2030-01-01T00:00:00.000Z",
    );
    expect(pay.payUrl.startsWith("solana:")).toBe(true);
    expect(pay.payUrl).toContain(reference.toBase58());
    expect(pay.payUrl).toContain("spl-token=");
    expect(pay.json.recipient).toBe(MERCHANT.publicKey.toBase58());
    expect(pay.json.reference).toBe(reference.toBase58());
  });
});

describe("invoice ledger", () => {
  it("settles exactly once so a reference cannot be replayed", () => {
    const ledger = new InvoiceLedger(process.env.TOLLWAY_DATA_DIR!);
    const reference = newReference().toBase58();
    ledger.create(
      {
        reference,
        slug: "solana-validator-health",
        amountBaseUnits: "10000",
        amountDisplay: 0.01,
        currency: "USDC",
      },
      900,
    );
    expect(ledger.settle(reference, "payer-a", "sig-1")).toBe(true);
    expect(ledger.settle(reference, "payer-b", "sig-2")).toBe(false);
    const stored = ledger.get(reference)!;
    expect(stored.state).toBe("paid");
    expect(stored.payer).toBe("payer-a");
    expect(stored.signature).toBe("sig-1");
  });

  it("expires unpaid invoices once the TTL passes", () => {
    const ledger = new InvoiceLedger(process.env.TOLLWAY_DATA_DIR!);
    const reference = newReference().toBase58();
    ledger.create(
      {
        reference,
        slug: "wallet-activity-digest",
        amountBaseUnits: "20000",
        amountDisplay: 0.02,
        currency: "USDC",
      },
      -1,
    );
    expect(ledger.get(reference)!.state).toBe("expired");
  });

  it("preserves state across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "tollway-reopen-"));
    const first = new InvoiceLedger(dir);
    const reference = newReference().toBase58();
    first.create(
      {
        reference,
        slug: "solana-validator-health",
        amountBaseUnits: "10000",
        amountDisplay: 0.01,
        currency: "USDC",
      },
      900,
    );
    const second = new InvoiceLedger(dir);
    expect(second.get(reference)).toBeDefined();
  });
});

describe("402 flow", () => {
  async function withServer(
    run: (base: string, ledger: InstanceType<typeof InvoiceLedger>) => Promise<void>,
  ) {
    const ledger = new InvoiceLedger(mkdtempSync(join(tmpdir(), "tollway-http-")));
    // The connection is never dialled in these cases: every request below either
    // stops at an invoice check or is rejected before on-chain verification.
    const connection = new Connection("http://127.0.0.1:1", "confirmed");
    const app = createApp({ connection, ledger });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      await run(`http://127.0.0.1:${port}`, ledger);
    } finally {
      server.close();
    }
  }

  it("issues an invoice with a pay URL when no payment is present", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/v1/data/solana-validator-health`);
      expect(res.status).toBe(402);
      const body = (await res.json()) as any;
      expect(body.error).toBe("payment_required");
      expect(body.payUrl.startsWith("solana:")).toBe(true);
      expect(body.reference).toBeTruthy();
      expect(body.amount).toBe(0.01);
      expect(body.instructions.length).toBeGreaterThan(0);
    });
  });

  it("serves the catalogue without payment", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/v1/catalog`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.resources).toHaveLength(3);
    });
  });

  it("rejects a reference that was never issued", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/v1/data/solana-validator-health`, {
        headers: {
          "X-Payment-Reference": Keypair.generate().publicKey.toBase58(),
        },
      });
      expect(res.status).toBe(402);
      expect(((await res.json()) as any).error).toBe("unknown_reference");
    });
  });

  it("refuses a reference issued for a different resource", async () => {
    await withServer(async (base, ledger) => {
      const reference = newReference().toBase58();
      ledger.create(
        {
          reference,
          slug: "token-risk-scan",
          amountBaseUnits: "50000",
          amountDisplay: 0.05,
          currency: "USDC",
        },
        900,
      );
      const res = await fetch(`${base}/v1/data/solana-validator-health`, {
        headers: { "X-Payment-Reference": reference },
      });
      expect(res.status).toBe(402);
      expect(((await res.json()) as any).error).toBe("reference_mismatch");
    });
  });

  it("refuses to redeem the same reference twice", async () => {
    await withServer(async (base, ledger) => {
      const reference = newReference().toBase58();
      ledger.create(
        {
          reference,
          slug: "solana-validator-health",
          amountBaseUnits: "10000",
          amountDisplay: 0.01,
          currency: "USDC",
        },
        900,
      );
      ledger.settle(reference, "payer", "sig");
      const res = await fetch(`${base}/v1/data/solana-validator-health`, {
        headers: { "X-Payment-Reference": reference },
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error).toBe(
        "reference_already_redeemed",
      );
    });
  });
});
