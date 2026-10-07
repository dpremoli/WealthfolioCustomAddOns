import { describe, it, expect, afterEach, vi } from "vitest";
import { Trading212ProxyClient } from "./proxy-client";

const CONFIG = { proxyUrl: "http://proxy", env: "demo" as const, apiKey: "k", apiSecret: "s" };

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

describe("Trading212ProxyClient — transient network retry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a fetch that throws a TypeError (dropped link), then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return jsonResponse([]);
      }),
    );

    const client = new Trading212ProxyClient(CONFIG);
    const p = client.listExports();
    await vi.advanceTimersByTimeAsync(2000); // first backoff
    const res = await p;

    expect(calls).toBe(2);
    expect(res).toEqual([]);
  });

  it("does not retry a non-network error (e.g. UNAUTHORIZED)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw new Error("UNAUTHORIZED");
      }),
    );

    const client = new Trading212ProxyClient(CONFIG);
    await expect(client.listExports()).rejects.toThrow("UNAUTHORIZED");
    expect(calls).toBe(1);
  });
});
