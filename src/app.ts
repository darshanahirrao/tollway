import express, { type Express } from "express";
import { Connection } from "@solana/web3.js";
import { InvoiceLedger } from "./lib/receipts.js";
import { createApiRouter } from "./routes/api.js";
import type { RpcPool } from "./lib/rpc.js";

export interface AppDeps {
  connection: Connection;
  ledger: InvoiceLedger;
  /** Optional: when present the health endpoint reports every endpoint. */
  pool?: RpcPool;
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
