import type { AddonContext } from "@wealthfolio/addon-sdk";

type NetworkRequest = Parameters<AddonContext["api"]["network"]["request"]>[0];
type NetworkResponse = Awaited<ReturnType<AddonContext["api"]["network"]["request"]>>;

/** A non-2xx response from the upstream API. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
  ) {
    super(message ?? `Request failed (${status})${body ? `: ${body.slice(0, 300)}` : ""}`);
    this.name = "HttpError";
  }
}

export interface BrokerOptions {
  /** How many times to wait out a 429 before giving up. */
  max429Retries?: number;
  /** Fallback wait for a 429 with no Retry-After / x-ratelimit-reset header. */
  default429BackoffMs?: number;
  /**
   * Retries for transient transport failures (timeouts, dropped connections). Set 0 for
   * a request that must not be sent twice, such as redeeming a single-use token.
   */
  maxTransportRetries?: number;
  /**
   * Retries for a 500/502/503/504 ("try again later") answer, with backoff. Default 0:
   * only enable it for idempotent requests (GETs).
   */
  maxServerErrorRetries?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Errors the host raises for a request it will never send (bad host, policy,
// missing secret). Retrying those only delays the real error.
const NON_RETRYABLE = /not approved|not allowed|must use|must include|cannot include|invalid|too large|secret|permission/i;

const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

/** Lower-cases header names: the host returns them as received. */
export function header(res: NetworkResponse, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(res.headers ?? {})) if (k.toLowerCase() === want) return v;
  return undefined;
}

/** How long to wait after a 429, from Retry-After or an epoch-seconds reset header. */
export function retryDelayMs(res: NetworkResponse, fallbackMs: number, now = Date.now()): number {
  const retryAfter = header(res, "retry-after");
  if (retryAfter && Number.isFinite(Number(retryAfter))) {
    return Math.max(1, Number(retryAfter)) * 1000;
  }
  const reset = header(res, "x-ratelimit-reset");
  if (reset && Number.isFinite(Number(reset))) {
    const ms = Number(reset) * 1000 - now;
    if (ms > 0) return Math.min(ms + 500, 60_000);
  }
  return fallbackMs;
}

/**
 * Sends a request through Wealthfolio's network broker (`ctx.api.network.request`),
 * the only way a sandboxed add-on can reach the internet. Retries 429s (honouring
 * the rate-limit headers), transient transport failures and, when asked, transient
 * 5xx answers; returns any other
 * response as-is, including non-2xx.
 */
export async function brokeredRequest(
  ctx: AddonContext,
  req: NetworkRequest,
  opts: BrokerOptions = {},
): Promise<NetworkResponse> {
  const sleep = opts.sleep ?? defaultSleep;
  const max429 = opts.max429Retries ?? 12;
  const maxTransport = opts.maxTransportRetries ?? 3;
  const maxServer = opts.maxServerErrorRetries ?? 0;
  let rateLimited = 0;
  let transport = 0;
  let server = 0;
  for (;;) {
    let res: NetworkResponse;
    try {
      res = await ctx.api.network.request(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NON_RETRYABLE.test(message) || transport >= maxTransport) {
        throw err instanceof Error ? err : new Error(message);
      }
      await sleep(Math.min(16_000, 2000 * 2 ** transport));
      transport++;
      continue;
    }
    if (res.status === 429) {
      if (rateLimited >= max429) throw new HttpError(429, res.body, "Rate limit exceeded. Try again shortly.");
      await sleep(retryDelayMs(res, opts.default429BackoffMs ?? 15_000, opts.now?.()));
      rateLimited++;
      continue;
    }
    if (TRANSIENT_STATUS.has(res.status) && server < maxServer) {
      await sleep(Math.min(16_000, 2000 * 2 ** server));
      server++;
      continue;
    }
    return res;
  }
}

/** {@link brokeredRequest} that throws {@link HttpError} on non-2xx and parses JSON. */
export async function brokeredJson<T>(
  ctx: AddonContext,
  req: NetworkRequest,
  opts: BrokerOptions = {},
): Promise<T> {
  const res = await brokeredRequest(ctx, req, opts);
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, res.body);
  const body = res.body?.trim();
  return (body ? JSON.parse(body) : {}) as T;
}

/** Encodes a query string, skipping undefined/empty values. */
export function withQuery(url: string, params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}
