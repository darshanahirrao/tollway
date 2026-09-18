import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type InvoiceState = "open" | "paid" | "expired";

export interface Invoice {
  /** Solana Pay reference key. Unique per invoice, doubles as replay guard. */
  reference: string;
  slug: string;
  /** Base units (lamports or token base units) as a string to avoid float drift. */
  amountBaseUnits: string;
  amountDisplay: number;
  currency: string;
  state: InvoiceState;
  createdAt: string;
  expiresAt: string;
  paidAt?: string;
  payer?: string;
  signature?: string;
}

/**
 * File-backed invoice ledger.
 *
 * Single-process by design: Tollway is a gateway, not a database. Swapping this
 * for Postgres or Redis is a drop-in change behind the same interface.
 */
export class InvoiceLedger {
  private readonly path: string;
  private invoices: Map<string, Invoice>;

  constructor(dataDir: string) {
    this.path = join(dataDir, "invoices.json");
    mkdirSync(dirname(this.path), { recursive: true });
    this.invoices = new Map();
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Invoice[];
        for (const inv of raw) this.invoices.set(inv.reference, inv);
      } catch {
        // A corrupt ledger should not take the gateway down; start clean and
        // let the caller re-issue. Nothing has been paid against it yet.
        this.invoices = new Map();
      }
    }
  }

  private flush(): void {
    const all = [...this.invoices.values()];
    writeFileSync(this.path, JSON.stringify(all, null, 2), "utf8");
  }

  create(inv: Omit<Invoice, "state" | "createdAt" | "expiresAt" | "paidAt" | "payer" | "signature">, ttlSeconds: number): Invoice {
    const now = new Date();
    const invoice: Invoice = {
      ...inv,
      state: "open",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    this.invoices.set(invoice.reference, invoice);
    this.flush();
    return invoice;
  }

  get(reference: string): Invoice | undefined {
    const inv = this.invoices.get(reference);
    if (!inv) return undefined;
    if (inv.state === "open" && new Date(inv.expiresAt).getTime() < Date.now()) {
      inv.state = "expired";
      this.flush();
    }
    return inv;
  }

  /**
   * Mark an invoice settled. Returns false when the invoice was already paid,
   * which is the replay-protection path: one reference pays for exactly one
   * response, no matter how many times the caller retries.
   */
  settle(reference: string, payer: string, signature: string): boolean {
    const inv = this.invoices.get(reference);
    if (!inv || inv.state === "paid") return false;
    inv.state = "paid";
    inv.paidAt = new Date().toISOString();
    inv.payer = payer;
    inv.signature = signature;
    this.flush();
    return true;
  }

  list(): Invoice[] {
    return [...this.invoices.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
}
