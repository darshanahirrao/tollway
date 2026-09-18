# Tollway

**Pay-per-call APIs for AI agents, settled in USDC on Solana.**

Agents are starting to buy things: data, inference, RPC access, scraping, verification.
Today every one of those purchases runs through a human-shaped rail. You sign up for an
account, generate an API key, put a card on file, and hope the provider bills you at the end
of the month. An autonomous agent cannot do any of that, and no provider wants to issue
thousands of tiny invoices.

Tollway removes the account entirely. An agent calls an endpoint, gets a price, pays it on
Solana, and receives the data. No signup, no key, no invoice, no human.

```
agent  -> GET /v1/data/token-risk-scan
        <- 402 Payment Required  { payUrl: "solana:...", reference: "..." }
agent  -> pays 0.05 USDC on Solana (reference rides along in the transaction)
agent  -> GET /v1/data/token-risk-scan  (X-Payment-Reference: ...)
        <- 200 OK  { data: {...}, receipt: { signature, payer, ... } }
```

## Why this needs a blockchain

The hard part of machine-to-machine payments is not moving money, it is **settling a sub-cent
payment between parties who have no relationship**. Cards cannot do it, because the fee
exceeds the payment and the rail requires an account. Prepaid credits need an account too.
Off-chain ledgers reintroduce a trusted operator.

Solana settles a one-cent payment in about 400ms for a fraction of a cent, and it supports a
pattern that makes server-side verification clean: an invoice can carry a **reference key**
that the payer includes in the transaction. The gateway looks the payment up *by reference*
rather than trusting a client-supplied signature, so a caller cannot claim someone else's
transfer.

## How verification works

This is the part that has to be right, so it is the most heavily tested part of the repo.

1. The gateway mints a fresh reference keypair per invoice and returns a Solana Pay URL.
2. The payer includes that reference as a read-only account in the transaction.
3. On retry, the gateway calls `getSignaturesForAddress(reference)` and walks the matches.
4. For each candidate it checks that the transaction succeeded, that the reference is really
   in the account list, and that the **merchant's balance delta** covers the price: SOL via
   `postBalances - preBalances`, SPL via `postTokenBalances - preTokenBalances` filtered by
   owner and mint.
5. The reference is burned in the ledger. One reference buys exactly one response.

Paying in the wrong mint is rejected as `wrong_mint` instead of being silently credited.
Underpaying by a single base unit is rejected as `underpaid`.

## Tests

```
pnpm test
```

23 tests across three suites. The verification suite runs against
`tests/fixtures/devnet-usdc-transfer.json`, a **real Solana devnet transaction**
(slot 500188983): an actual 0.001 USDC transfer carrying a Memo instruction, which is exactly
the shape Tollway invoices produce. Testing against real chain data catches parsing mistakes
that hand-written fixtures hide.

Covered: exact 6dp and 9dp price conversion without float drift, replay protection, invoice
expiry, cross-resource reference reuse, wrong mint, underpayment, failed transactions, the
full 402 handshake over HTTP, and RPC failover.

## RPC failover

A payment gateway cannot afford to lose the chain read at the moment a payer retries. Settlement
verification is the one call where a flaky provider turns into real money that looks unpaid, so
it runs through a preference-ordered endpoint pool rather than a single connection.

```
TOLLWAY_RPC_URLS="https://<key>.rpcfast.com/?<params>,https://api.devnet.solana.com"
```

The first entry is the primary. If it throws or rate limits, the pool retries the next endpoint
and promotes it, so the following call starts from a healthy provider instead of paying the
failure cost again. `GET /v1/rpc/health` reports every endpoint with latency, current slot and
the last error, and `pnpm tsx scripts/live-check.ts` probes the pool as part of its run.

This is also how Tollway runs on **RPC Fast** infrastructure: put the RPC Fast endpoint first and
keep a public endpoint behind it as a safety net.

## Live check

```
pnpm tsx scripts/live-check.ts
```

Runs the real verification path against the live devnet RPC using a historical on-chain
payment, then calls the paid handlers for real:

```
1. reference lookup + balance delta on a real transaction
  payer                      GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb
  received base units        1000
2. underpayment is rejected
  price 1.00 USDC ->         underpaid
3. paid handlers against the live cluster
  slot                       500190640
  epoch                      1157
  epoch progress %           84.87
  avg tps                    147.9
  healthy                    true
```

## Quickstart

```bash
pnpm install
cp .env.example .env
# set TOLLWAY_MERCHANT_WALLET to a wallet you control
pnpm start
```

```bash
curl http://localhost:4021/v1/catalog
curl -i http://localhost:4021/v1/data/solana-validator-health   # 402 + payUrl
```

`pnpm demo` runs the whole loop (issue, pay, redeem, refuse replay) against devnet. It prints
an agent keypair that needs a little devnet SOL; devnet faucets are heavily rate limited, so
fund the printed address at https://faucet.solana.com if the airdrop is refused.

## MCP server

`pnpm mcp` starts a Model Context Protocol server over stdio. Each paid resource is exposed as
a tool, and the 402 handshake is surfaced as a structured tool result rather than an error the
model has to interpret. The MCP layer never holds keys: it hands the `payUrl` to the calling
agent's wallet and redeems the reference on retry.

This is what makes Tollway agent-native rather than just another API gateway. A tool call can
cost money, and the agent can pay it.

## Catalogue

| Resource | Price | What it returns |
|---|---|---|
| `solana-validator-health` | 0.01 USDC | Slot, epoch progress, observed TPS, supply, health flag |
| `token-risk-scan` | 0.05 USDC | Mint/freeze authority, supply, risk flags, top holders |
| `wallet-activity-digest` | 0.02 USDC | Balance, sampled tx count, failure rate, last activity |

Prices live in `src/config.ts`. `TOLLWAY_CURRENCY` reprices the whole catalogue into one
currency, which is how devnet demos run on SOL.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TOLLWAY_NETWORK` | `devnet` | `devnet` or `mainnet-beta` |
| `TOLLWAY_RPC_URL` | cluster default | RPC endpoint |
| `TOLLWAY_MERCHANT_WALLET` | required | Where payments land |
| `TOLLWAY_USDC_MINT` | per-network USDC | Token accepted for USDC-priced resources |
| `TOLLWAY_CURRENCY` | per-resource | Force the catalogue to `usdc` or `sol` |
| `TOLLWAY_INVOICE_TTL` | `900` | Seconds an invoice stays payable |
| `TOLLWAY_PUBLIC_URL` | `http://localhost:4021` | Base URL used in pay URLs |

## Revenue model

The gateway takes a basis-point spread on each settled call. Because settlement is per call
rather than per month, revenue scales with agent activity instead of with seats. A provider
listing a feed keeps their existing infrastructure and gets paid by machines they could never
have onboarded manually.

## Roadmap

- Persistent ledger (Postgres) with per-provider aggregates.
- x402-compatible wire format alongside the reference scheme.
- Streaming payment for long-running inference, billed per token rather than per call.
- Provider self-serve: list an endpoint, set a price, receive USDC.

## Limitations

- The ledger is file-backed and single-process. Correct for a gateway, not yet for a fleet.
- Verification polls the chain on retry rather than subscribing to a websocket, so a payment
  that lands before the cluster indexes it returns `payment_not_settled` and succeeds on
  retry.
- Refunds for a handler that fails after settlement are not automated.
