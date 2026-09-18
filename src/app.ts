import express, { type Express } from "express";
import { Connection } from "@solana/web3.js";
import { InvoiceLedger } from "./lib/receipts.js";
import { createApiRouter } from "./routes/api.js";

export interface AppDeps {
  connection: Connection;
  ledger: InvoiceLedger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(createApiRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return app;
}
