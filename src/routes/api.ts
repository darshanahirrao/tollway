import { Router, type Request, type Response } from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import { config, resourceBySlug, resources, type Resource } from "../config.js";
import { InvoiceLedger } from "../lib/receipts.js";
import { HandlerError, handlers } from "../lib/data.js";
import { buildPaymentRequest, newReference, toBaseUnits } from "../payments/solana-pay.js";
import { verifyPayment } from "../payments/verify.js";

export interface ApiDeps {
  connection: Connection;
  ledger: InvoiceLedger;
}

function resourceView(resource: Resource) {
  return {
    slug: resource.slug,
    name: resource.name,
    description: resource.description,
    price: resource.price,
    currency: resource.currency.toUpperCase(),
    unit: resource.unit,
    endpoint: `${config.publicBaseUrl}/v1/data/${resource.slug}`,
  };
}

/**
 * 402 response body. Deliberately machine-first: an agent should be able to pay
 * and retry without a human reading a docs page.
 */
function paymentRequiredBody(
  resource: Resource,
  pay: ReturnType<typeof buildPaymentRequest>,
  expiresAt: string,
) {
  return {
    error: "payment_required",
    resource: resource.slug,
    amount: resource.price,
    currency: resource.currency.toUpperCase(),
    recipient: config.merchantWallet.toBase58(),
    reference: pay.reference.toBase58(),
    expiresAt,
    network: config.network,
    payUrl: pay.payUrl,
    payment: pay.json,
    instructions: [
      "Pay the payUrl on Solana, including the reference account in the transaction.",
      `Retry this request with header X-Payment-Reference: ${pay.reference.toBase58()}`,
      "The reference is single-use. A new request without payment issues a new reference.",
    ],
  };
}

export function createApiRouter(deps: ApiDeps): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.json({ ok: true, network: config.network });
  });

  /** Free discovery surface, so an agent can browse the catalogue before paying. */
  router.get("/v1/catalog", (_req, res) => {
    res.json({ resources: resources.map(resourceView) });
  });

  router.get("/v1/receipts/:reference", (req, res) => {
    const invoice = deps.ledger.get(req.params.reference);
    if (!invoice) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(invoice);
  });

  router.get("/v1/ledger", (_req, res) => {
    const all = deps.ledger.list();
    const paid = all.filter((i) => i.state === "paid");
    const grossByCurrency = paid.reduce<Record<string, number>>((acc, i) => {
      acc[i.currency] = (acc[i.currency] ?? 0) + i.amountDisplay;
      return acc;
    }, {});
    res.json({
      invoices: all.length,
      paid: paid.length,
      grossByCurrency,
      recent: all.slice(0, 20),
    });
  });

  router.get("/v1/data/:slug", async (req: Request, res: Response) => {
    const resource = resourceBySlug(req.params.slug);
    if (!resource) {
      res.status(404).json({ error: "unknown_resource", slug: req.params.slug });
      return;
    }

    const handler = handlers[resource.slug];
    if (!handler) {
      res.status(501).json({ error: "handler_not_implemented", slug: resource.slug });
      return;
    }

    const referenceHeader = req.header("X-Payment-Reference");

    // No reference yet: issue an invoice.
    if (!referenceHeader) {
      const reference = newReference();
      const ttl = config.invoiceTtlSeconds;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      const pay = buildPaymentRequest(resource, reference, expiresAt);
      deps.ledger.create(
        {
          reference: reference.toBase58(),
          slug: resource.slug,
          amountBaseUnits: toBaseUnits(resource.price, resource.currency),
          amountDisplay: resource.price,
          currency: resource.currency.toUpperCase(),
        },
        ttl,
      );
      res.status(402).json(paymentRequiredBody(resource, pay, expiresAt));
      return;
    }

    const invoice = deps.ledger.get(referenceHeader);
    if (!invoice) {
      res.status(402).json({
        error: "unknown_reference",
        detail: "This reference was never issued, or the gateway restarted with a fresh ledger.",
      });
      return;
    }
    if (invoice.slug !== resource.slug) {
      res.status(402).json({
        error: "reference_mismatch",
        detail: `Reference was issued for ${invoice.slug}, not ${resource.slug}.`,
      });
      return;
    }
    if (invoice.state === "paid") {
      res.status(409).json({
        error: "reference_already_redeemed",
        detail: "Each reference buys exactly one response. Request a new invoice.",
        signature: invoice.signature,
      });
      return;
    }

    let reference: PublicKey;
    try {
      reference = new PublicKey(referenceHeader);
    } catch {
      res.status(400).json({ error: "invalid_reference" });
      return;
    }

    const verification = await verifyPayment(deps.connection, resource, reference);
    if (!verification.ok) {
      res.status(402).json({
        error: "payment_not_settled",
        reason: verification.reason,
        detail: verification.detail,
        reference: referenceHeader,
      });
      return;
    }

    const settled = deps.ledger.settle(
      referenceHeader,
      verification.payer,
      verification.signature,
    );
    if (!settled) {
      res.status(409).json({ error: "reference_already_redeemed" });
      return;
    }

    try {
      const data = await handler({
        connection: deps.connection,
        params: req.query as Record<string, string>,
      });
      res.json({
        data,
        receipt: {
          reference: referenceHeader,
          signature: verification.signature,
          payer: verification.payer,
          amount: resource.price,
          currency: resource.currency.toUpperCase(),
          receivedBaseUnits: verification.receivedBaseUnits,
          settledAt: new Date().toISOString(),
          network: config.network,
        },
      });
    } catch (error) {
      if (error instanceof HandlerError) {
        // The payment is already settled; surfaces the real reason rather than
        // silently charging for a failed lookup.
        res.status(error.status).json({
          error: "handler_failed",
          detail: error.message,
          receipt: { reference: referenceHeader, signature: verification.signature },
        });
        return;
      }
      res.status(500).json({
        error: "handler_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
