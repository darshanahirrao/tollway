import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SOLAMI_REGIONS,
  SolamiClient,
  SolamiError,
  solamiFromEnv,
} from "../src/providers/solami.js";
import { HandlerError, handlers } from "../src/lib/data.js";

interface Call {
  url: string;
  method: string;
  body: { method?: string; params?: unknown[] } | null;
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
      body: init.body ? JSON.parse(String(init.body)) : null,
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

const rpc = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });

beforeEach(() => {
  calls.length = 0;
  delete process.env.SOLAMI_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SolamiClient", () => {
  it("builds the undocumented endpoint shape the API actually expects", () => {
    const client = new SolamiClient({ apiKey: "sk_test_key" });
    expect(client.endpoint("ams")).toBe(
      "https://rpc.solami.dev/sol/ams?api_key=sk_test_key",
    );
    expect(client.endpoint("SGP", "eth")).toBe(
      "https://rpc.solami.dev/eth/SGP?api_key=sk_test_key",
    );
  });

  it("sends the key as a query parameter, not a header", async () => {
    stubFetch(() => rpc(123));
    const client = new SolamiClient({ apiKey: "sk_test_key" });

    const result = await client.call<number>("nl", "getSlot");

    expect(result.result).toBe(123);
    expect(result.region).toBe("nl");
    expect(calls[0].url).toContain("api_key=sk_test_key");
    expect(calls[0].body?.method).toBe("getSlot");
  });

  it("retries a rate-limited burst and then succeeds", async () => {
    stubFetch((_call, attempt) =>
      attempt === 1
        ? json({ message: "rate limited" }, 429)
        : rpc(456),
    );
    const client = new SolamiClient({ apiKey: "sk_test_key", maxAttempts: 3 });

    const result = await client.call<number>("ams", "getSlot");

    expect(result.result).toBe(456);
    expect(calls).toHaveLength(2);
  });

  it("surfaces an upstream failure as a typed error with its status", async () => {
    stubFetch(() => json({ message: "unauthorized" }, 401));
    const client = new SolamiClient({ apiKey: "sk_test_key", maxAttempts: 1 });

    const error = (await client.call("ams", "getSlot").catch((e: unknown) => e)) as SolamiError;

    expect(error).toBeInstanceOf(SolamiError);
    expect(error.code).toBe("HTTP_401");
    expect(error.status).toBe(401);
  });

  it("keeps one failing region from failing the whole probe", async () => {
    stubFetch((call) => {
      if (call.url.includes("/SGP?")) return json({ message: "down" }, 503);
      const isEpoch = call.body?.method === "getEpochInfo";
      return rpc(isEpoch ? { epoch: 1000, absoluteSlot: 10, blockHeight: 9 } : 500);
    });
    const client = new SolamiClient({ apiKey: "sk_test_key", maxAttempts: 1 });

    const regions = await client.probe("sol");
    const byId = Object.fromEntries(regions.map((r) => [r.region, r]));

    expect(regions).toHaveLength(SOLAMI_REGIONS.length);
    expect(byId.ams.ok).toBe(true);
    expect(byId.ams.slot).toBe(500);
    expect(byId.SGP.ok).toBe(false);
    expect(byId.SGP.error).toBeTruthy();
  });

  it("reports the slot delta between the freshest and lagging region", async () => {
    stubFetch((call) => {
      const isEpoch = call.body?.method === "getEpochInfo";
      if (isEpoch) return rpc({ epoch: 1000, absoluteSlot: 10, blockHeight: 9 });
      // SGP is three slots behind the others.
      return rpc(call.url.includes("/SGP?") ? 497 : 500);
    });
    const client = new SolamiClient({ apiKey: "sk_test_key", maxAttempts: 1 });

    const report = await client.slotSkew("sol");

    expect(report.highestSlot).toBe(500);
    expect(report.lowestSlot).toBe(497);
    expect(report.slotDelta).toBe(3);
    expect(report.consistent).toBe(false);
    expect(report.verdict).toContain("3 slots");
  });

  it("falls over to another region when the first one fails", async () => {
    stubFetch((call) => {
      if (call.url.includes("/ams?")) return json({ message: "down" }, 503);
      return rpc({
        context: { slot: 1 },
        value: { lamports: 42, owner: "owner", executable: false, data: null },
      });
    });
    const client = new SolamiClient({ apiKey: "sk_test_key", maxAttempts: 1 });

    const account = await client.getAccount("pubkey", "ams");

    expect(account.region).not.toBe("ams");
    expect(account.result.value?.lamports).toBe(42);
  });

  it("reports every region when a read fails everywhere", async () => {
    stubFetch(() => json({ message: "down" }, 503));
    const client = new SolamiClient({ apiKey: "sk_test_key", maxAttempts: 1 });

    const error = (await client
      .getAccount("pubkey", "ams")
      .catch((e: unknown) => e)) as SolamiError;

    expect(error).toBeInstanceOf(SolamiError);
    expect(error.code).toBe("NO_REGION");
    expect(error.message).toContain("ams");
  });
});

describe("solamiFromEnv", () => {
  it("returns null without a key and a client with one", () => {
    expect(solamiFromEnv()).toBeNull();
    process.env.SOLAMI_API_KEY = "sk_from_env";
    expect(solamiFromEnv()).toBeInstanceOf(SolamiClient);
  });
});

describe("Solami gateway handlers", () => {
  const ctx = (params: Record<string, string>) =>
    ({ params }) as unknown as Parameters<(typeof handlers)[string]>[0];

  it("fails closed with 503 when the gateway has no Solami key", async () => {
    const error = (await handlers["solami-slot-skew"](ctx({})).catch(
      (e: unknown) => e,
    )) as HandlerError;
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.status).toBe(503);
    expect(String(error.message)).toContain("SOLAMI_API_KEY");
  });

  it("rejects an unknown region before calling Solami", async () => {
    process.env.SOLAMI_API_KEY = "sk_from_env";
    stubFetch(() => rpc(1));

    const error = (await handlers["solami-account-read"](
      ctx({ pubkey: "abc", region: "mars" }),
    ).catch((e: unknown) => e)) as HandlerError;

    expect(error).toBeInstanceOf(HandlerError);
    expect(error.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns a shaped account read", async () => {
    process.env.SOLAMI_API_KEY = "sk_from_env";
    stubFetch(() =>
      rpc({
        context: { slot: 77 },
        value: { lamports: 2_000_000_000, owner: "Tokenkeg", executable: false, data: null },
      }),
    );

    const result = (await handlers["solami-account-read"](
      ctx({ pubkey: "abc", region: "nl" }),
    )) as Record<string, unknown>;

    expect(result.region).toBe("nl");
    expect(result.slot).toBe(77);
    expect(result.sol).toBe(2);
    expect(result.owner).toBe("Tokenkeg");
  });
});
