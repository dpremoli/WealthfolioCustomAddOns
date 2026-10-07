import type { AddonContext } from "@wealthfolio/addon-sdk";
import { brokeredJson, brokeredRequest, HttpError, retryDelayMs, withQuery } from "./network";

type Res = { status: number; headers: Record<string, string>; body: string };

function ctxWith(responses: (Res | Error)[]) {
  const request = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { ctx: { api: { network: { request } } } as unknown as AddonContext, request };
}

const ok = (body: unknown): Res => ({ status: 200, headers: {}, body: JSON.stringify(body) });
const sleep = vi.fn(async () => {});

describe("brokeredRequest", () => {
  beforeEach(() => sleep.mockClear());

  it("retries a 429 using Retry-After", async () => {
    const { ctx, request } = ctxWith([{ status: 429, headers: { "Retry-After": "2" }, body: "" }, ok({ a: 1 })]);
    const res = await brokeredRequest(ctx, { url: "https://x.test" }, { sleep });
    expect(res.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up after max429Retries", async () => {
    const r429: Res = { status: 429, headers: {}, body: "" };
    const { ctx } = ctxWith([r429, r429]);
    await expect(brokeredRequest(ctx, { url: "https://x.test" }, { sleep, max429Retries: 1 })).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it("retries transient transport errors but not policy errors", async () => {
    const { ctx, request } = ctxWith([new Error("operation timed out"), ok({})]);
    await brokeredRequest(ctx, { url: "https://x.test" }, { sleep });
    expect(request).toHaveBeenCalledTimes(2);

    const policy = ctxWith([new Error("Addon network host 'x.test' is not approved")]);
    await expect(brokeredRequest(policy.ctx, { url: "https://x.test" }, { sleep })).rejects.toThrow(/not approved/);
    expect(policy.request).toHaveBeenCalledTimes(1);
  });

  it("returns non-2xx responses untouched", async () => {
    const { ctx } = ctxWith([{ status: 401, headers: {}, body: "nope" }]);
    expect((await brokeredRequest(ctx, { url: "https://x.test" }, { sleep })).status).toBe(401);
  });
});

describe("brokeredJson", () => {
  it("parses JSON and treats an empty body as {}", async () => {
    const { ctx } = ctxWith([ok({ x: 1 }), { status: 204, headers: {}, body: "" }]);
    expect(await brokeredJson(ctx, { url: "https://x.test" })).toEqual({ x: 1 });
    expect(await brokeredJson(ctx, { url: "https://x.test" })).toEqual({});
  });

  it("throws HttpError with status on failure", async () => {
    const { ctx } = ctxWith([{ status: 403, headers: {}, body: "forbidden" }]);
    await expect(brokeredJson(ctx, { url: "https://x.test" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("helpers", () => {
  it("retryDelayMs uses x-ratelimit-reset epoch seconds", () => {
    const now = 1_000_000;
    const res: Res = { status: 429, headers: { "x-ratelimit-reset": String(now / 1000 + 5) }, body: "" };
    expect(retryDelayMs(res, 15_000, now)).toBe(5500);
    expect(retryDelayMs({ ...res, headers: {} }, 15_000, now)).toBe(15_000);
  });

  it("withQuery skips empty values", () => {
    expect(withQuery("https://a.test/x", { a: 1, b: undefined, c: "", d: "z" })).toBe("https://a.test/x?a=1&d=z");
  });
});
