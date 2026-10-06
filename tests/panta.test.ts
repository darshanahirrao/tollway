import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  PantaClient,
  PantaError,
  pantaFromEnv,
} from "../src/providers/panta.js";
import { HandlerError, handlers } from "../src/lib/data.js";

// config.ts reads the environment at module load, so the gateway's required
// values must exist before it is imported. The catalogue test below pulls it in
// dynamically for that reason.
process.env.TOLLWAY_NETWORK = "devnet";
process.env.TOLLWAY_MERCHANT_WALLET =
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

let resourceBySlug: typeof import("../src/config.js").resourceBySlug;

beforeAll(async () => {
  ({ resourceBySlug } = await import("../src/config.js"));
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const calls: Call[] = [];

function stubFetch(
  responder: (call: Call, attempt: number) => Response | Promise<Response>,
) {
  let attempt = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    attempt += 1;
    return responder(call, attempt);
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls.length = 0;
  delete process.env.PANTA_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PantaClient", () => {
  it("sends the API key and keeps the required trailing slash", async () => {
    stubFetch(() => json({ categories: ["crypto"] }));
    const client = new PantaClient({ apiKey: "pk_test_abc" });

    const result = await client.categories();

    expect(result.categories).toEqual(["crypto"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://live-api.panta.market/api/v1/categories/",
    );
    expect(calls[0].headers["X-Api-Key"]).toBe("pk_test_abc");
  });

  it("encodes query parameters and omits empty ones", async () => {
    stubFetch(() => json({ items: [], nextCursor: null }));
    const client = new PantaClient({ apiKey: "pk_test_abc" });

    await client.listMarkets({ category: "crypto", limit: 5, status: "" });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/markets/");
    expect(url.searchParams.get("category")).toBe("crypto");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("surfaces the upstream error envelope as a typed error", async () => {
    stubFetch(() =>
      json(
        {
          code: "MARKET_NOT_FOUND",
          message: "Market account missing",
          field: "marketId",
        },
        404,
      ),
    );
    const client = new PantaClient({ apiKey: "pk_test_abc" });

    const error = await client.getMarket("missing").catch((e) => e);

    expect(error).toBeInstanceOf(PantaError);
    expect(error.code).toBe("MARKET_NOT_FOUND");
    expect(error.status).toBe(404);
    expect(error.field).toBe("marketId");
  });

  it("retries a rate-limited response and then succeeds", async () => {
    stubFetch((_call, attempt) =>
      attempt === 1
        ? new Response("{}", { status: 429, headers: { "Retry-After": "0" } })
        : json({ wallet: "w", positions: [] }),
    );
    const client = new PantaClient({ apiKey: "pk_test_abc" });

    const result = await client.positions("w");

    expect(result.positions).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("posts a primary buy quote to the documented path", async () => {
    stubFetch(() => json({ quoteId: "qt_1", shares: "38.42" }));
    const client = new PantaClient({ apiKey: "pk_test_abc" });

    await client.quoteBuy({
      wallet: "buyer",
      marketId: "market",
      side: "yes",
      amountUsdc: "20.00",
    });

    expect(calls[0].url).toBe(
      "https://live-api.panta.market/api/v1/primaryorderquote/",
    );
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ side: "yes", amountUsdc: "20.00" });
  });
});

describe("pantaFromEnv", () => {
  it("returns null when the key is absent and a client when present", () => {
    expect(pantaFromEnv()).toBeNull();
    process.env.PANTA_API_KEY = "pk_test_env";
    expect(pantaFromEnv()).toBeInstanceOf(PantaClient);
  });
});

describe("Panta gateway handlers", () => {
  const ctx = (params: Record<string, string>) =>
    ({ params }) as unknown as Parameters<(typeof handlers)[string]>[0];

  it("fails closed with 503 when the gateway has no Panta key", async () => {
    const error = (await handlers["panta-markets"](ctx({})).catch(
      (e: unknown) => e,
    )) as HandlerError;
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.status).toBe(503);
    expect(String(error.message)).toContain("PANTA_API_KEY");
  });

  it("maps an upstream Panta error onto the matching HTTP status", async () => {
    process.env.PANTA_API_KEY = "pk_test_env";
    stubFetch(() => json({ code: "MARKET_NOT_FOUND", message: "nope" }, 404));

    const error = (await handlers["panta-market"](ctx({ marketId: "abc" })).catch(
      (e: unknown) => e,
    )) as HandlerError;

    expect(error).toBeInstanceOf(HandlerError);
    expect(error.status).toBe(404);
    expect(String(error.message)).toContain("MARKET_NOT_FOUND");
  });

  it("rejects a missing required parameter before calling Panta", async () => {
    process.env.PANTA_API_KEY = "pk_test_env";
    stubFetch(() => json({}));

    const error = (await handlers["panta-positions"](ctx({})).catch(
      (e: unknown) => e,
    )) as HandlerError;

    expect(error).toBeInstanceOf(HandlerError);
    expect(error.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("splits the comma-separated sources when quoting a create", async () => {
    process.env.PANTA_API_KEY = "pk_test_env";
    stubFetch(() => json({ createId: "cr_1", paymentUsdc: "1000000" }));

    await handlers["panta-market-create-quote"](
      ctx({
        wallet: "creator",
        question: "Will it ship?",
        resolutionRule: "Resolves yes if shipped.",
        sources: "https://a.example,https://b.example",
        category: "crypto",
        startTime: "1",
        endTime: "2",
        resolutionTime: "3",
        imageUrl: "https://img.example/x.png",
      }),
    );

    expect(calls[0].body).toMatchObject({
      sourcesOfTruth: ["https://a.example", "https://b.example"],
      category: "crypto",
    });
  });
});

describe("Panta catalogue wiring", () => {
  it("registers every Panta slug with a USDC price", () => {
    const slugs = [
      "panta-markets",
      "panta-market",
      "panta-positions",
      "panta-buy-quote",
      "panta-buy-build",
      "panta-claim-build",
      "panta-creator-fee-build",
      "panta-trade-report",
      "panta-market-create-quote",
    ];
    for (const slug of slugs) {
      const resource = resourceBySlug(slug);
      expect(resource, slug).toBeDefined();
      expect(resource?.currency).toBe("usdc");
      expect(resource?.price).toBeGreaterThan(0);
      expect(handlers[slug], slug).toBeTypeOf("function");
    }
  });
});
