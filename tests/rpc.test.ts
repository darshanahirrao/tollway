import { describe, expect, it } from "vitest";
import { RpcPool } from "../src/lib/rpc.js";

describe("RPC pool failover", () => {
  it("uses the preferred endpoint when it is healthy", async () => {
    const pool = new RpcPool(["https://primary.invalid", "https://backup.invalid"]);
    const seen: string[] = [];
    const result = await pool.withFailover(async (connection) => {
      seen.push(connection.rpcEndpoint);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual(["https://primary.invalid"]);
    expect(pool.activeUrl).toBe("https://primary.invalid");
  });

  it("moves to the next endpoint when the primary throws", async () => {
    const pool = new RpcPool(["https://primary.invalid", "https://backup.invalid"]);
    const seen: string[] = [];
    const result = await pool.withFailover(async (connection) => {
      seen.push(connection.rpcEndpoint);
      if (connection.rpcEndpoint === "https://primary.invalid") {
        throw new Error("429 Too Many Requests");
      }
      return "from backup";
    });
    expect(result).toBe("from backup");
    expect(seen).toEqual(["https://primary.invalid", "https://backup.invalid"]);
    // The standby is promoted so the next call starts healthy.
    expect(pool.activeUrl).toBe("https://backup.invalid");
  });

  it("throws the last error when every endpoint fails", async () => {
    const pool = new RpcPool(["https://a.invalid", "https://b.invalid"]);
    await expect(
      pool.withFailover(async () => {
        throw new Error("rpc down");
      }),
    ).rejects.toThrow("rpc down");
  });

  it("tracks health per endpoint", async () => {
    const pool = new RpcPool(["https://a.invalid", "https://b.invalid"]);
    await pool.withFailover(async (connection) => {
      if (connection.rpcEndpoint === "https://a.invalid") throw new Error("down");
      return true;
    });
    const report = await pool.probe();
    expect(report).toHaveLength(2);
    const a = report.find((e) => e.url === "https://a.invalid")!;
    // probe() reaches the network, so the recorded error is whatever the
    // connection attempt produced. Assert the endpoint is marked unhealthy and
    // that a reason was captured, not the exact transport message.
    expect(a.ok).toBe(false);
    expect(typeof a.error).toBe("string");
    expect(a.error!.length).toBeGreaterThan(0);
  });

  it("requires at least one endpoint", () => {
    expect(() => new RpcPool([])).toThrow();
  });
});
