/**
 * Tollway MCP server.
 *
 * This is the piece that makes Tollway agent-native rather than just another API
 * gateway: it exposes each paid resource as an MCP tool, and handles the 402
 * handshake transparently. An agent that supports MCP can pay for and consume a
 * Solana data feed with no API key and no account.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config, resources } from "../config.js";

const baseUrl = config.publicBaseUrl;

interface PaymentRequired {
  reference: string;
  payUrl: string;
  amount: number;
  currency: string;
  expiresAt: string;
}

/**
 * Fetches a Tollway resource, surfacing the invoice when payment is required.
 * The MCP layer never holds keys: it returns the payUrl for the calling agent's
 * wallet to settle, then redeems the reference on retry.
 */
async function callResource(
  slug: string,
  query: Record<string, string>,
  reference?: string,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`/v1/data/${slug}`, baseUrl);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {};
  if (reference) headers["X-Payment-Reference"] = reference;

  const res = await fetch(url, { headers });
  const body = (await res.json()) as unknown;
  return { status: res.status, body };
}

const server = new McpServer({
  name: "tollway",
  version: "0.1.0",
});

function schemaFor(slug: string): Record<string, z.ZodTypeAny> {
  switch (slug) {
    case "token-risk-scan":
      return { mint: z.string().describe("SPL mint address to scan") };
    case "wallet-activity-digest":
      return {
        wallet: z.string().describe("Wallet address to summarise"),
        limit: z.string().optional().describe("How many recent transactions to sample"),
      };
    default:
      return {};
  }
}

for (const resource of resources) {
  server.registerTool(
    resource.slug,
    {
      title: resource.name,
      description: `${resource.description} Costs ${resource.price} ${resource.currency.toUpperCase()} per call, paid on Solana.`,
      inputSchema: {
        ...schemaFor(resource.slug),
        reference: z
          .string()
          .optional()
          .describe(
            "Payment reference from a previous 402 response. Omit on the first call to receive an invoice.",
          ),
      },
    },
    async (args: Record<string, string | undefined>) => {
      const { reference, ...query } = args;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(query)) if (v) clean[k] = v;

      const { status, body } = await callResource(resource.slug, clean, reference);

      if (status === 402) {
        const invoice = body as PaymentRequired & { instructions?: string[] };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "payment_required",
                  amount: `${invoice.amount} ${invoice.currency}`,
                  payUrl: invoice.payUrl,
                  reference: invoice.reference,
                  expiresAt: invoice.expiresAt,
                  nextStep:
                    "Settle payUrl on Solana, then call this tool again with the same reference.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
        isError: status >= 400,
      };
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
