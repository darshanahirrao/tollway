import express from "express";
import { Connection } from "@solana/web3.js";
import { config } from "./config.js";
import { InvoiceLedger } from "./lib/receipts.js";
import { createApp } from "./app.js";

const connection = new Connection(config.rpcUrl, "confirmed");
const ledger = new InvoiceLedger(config.dataDir);

const app = createApp({ connection, ledger });

app.listen(config.port, () => {
  const banner = [
    "",
    "  Tollway - pay-per-call APIs for AI agents",
    `  network     ${config.network}`,
    `  rpc         ${config.rpcUrl}`,
    `  merchant    ${config.merchantWallet.toBase58()}`,
    `  listening   ${config.publicBaseUrl}`,
    "",
    `  try:  curl -i ${config.publicBaseUrl}/v1/data/solana-validator-health`,
    "",
  ].join("\n");
  console.log(banner);
});
