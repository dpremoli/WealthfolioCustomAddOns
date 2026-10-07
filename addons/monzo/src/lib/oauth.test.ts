import { describe, expect, it } from "vitest";
import {
  OAuthInputError,
  buildAuthUrl,
  codeExchangeBody,
  expiresAtFrom,
  generateState,
  isExpiring,
  parsePastedAuth,
  refreshBody,
  verifyState,
} from "./oauth";

describe("generateState", () => {
  it("is 32 hex chars (128 bits) and differs between calls", () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("uses the supplied random source", () => {
    const rng = { getRandomValues: <T extends ArrayBufferView | null>(a: T) => {
      (a as unknown as Uint8Array).fill(0xab);
      return a;
    } };
    expect(generateState(rng as Crypto)).toBe("ab".repeat(16));
  });
});

describe("buildAuthUrl", () => {
  it("builds the Monzo login URL with an encoded redirect and the state", () => {
    const url = buildAuthUrl({
      clientId: "oauth2client_abc",
      redirectUrl: "https://localhost/monzo-callback",
      state: "st4te",
    });
    expect(url.startsWith("https://auth.monzo.com/?")).toBe(true);
    const u = new URL(url);
    expect(u.searchParams.get("client_id")).toBe("oauth2client_abc");
    expect(u.searchParams.get("redirect_uri")).toBe("https://localhost/monzo-callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("st4te");
    expect(url).toContain("redirect_uri=https%3A%2F%2Flocalhost%2Fmonzo-callback");
  });
});

describe("parsePastedAuth", () => {
  it("extracts code and state from a full redirect URL", () => {
    expect(
      parsePastedAuth("https://localhost/monzo-callback?code=abc.DEF-123&state=s1"),
    ).toEqual({ code: "abc.DEF-123", state: "s1", structured: true });
  });

  it("tolerates whitespace, quotes and a trailing fragment", () => {
    expect(parsePastedAuth('  "https://localhost/cb?code=xyz&state=s#frag"\n')).toEqual({
      code: "xyz",
      state: "s",
      structured: true,
    });
  });

  it("accepts a bare query string", () => {
    expect(parsePastedAuth("?code=c0de&state=s")).toEqual({ code: "c0de", state: "s", structured: true });
    expect(parsePastedAuth("code=c0de")).toEqual({ code: "c0de", state: undefined, structured: true });
  });

  it("accepts a bare code", () => {
    const code = "eyJhbGciOiJFUzI1NiJ9.eyJqdGkiOiJhdXRoeiJ9.sig_-x";
    expect(parsePastedAuth(code)).toEqual({ code });
  });

  it("reports an error returned by Monzo", () => {
    expect(() =>
      parsePastedAuth("https://localhost/cb?error=access_denied&error_description=No+thanks"),
    ).toThrow(/access_denied \(No thanks\)/);
  });

  it("rejects empty input and URLs without a code", () => {
    expect(() => parsePastedAuth("   ")).toThrow(OAuthInputError);
    expect(() => parsePastedAuth("https://localhost/cb?state=s")).toThrow(/No authorisation code/);
  });
});

describe("verifyState", () => {
  it("passes when the pasted state matches", () => {
    expect(() => verifyState({ code: "c", state: "s" }, "s")).not.toThrow();
  });

  it("fails on a mismatch", () => {
    expect(() => verifyState({ code: "c", state: "evil" }, "s")).toThrow(/does not match/);
  });

  it("fails when a state is pasted but no attempt is in progress", () => {
    expect(() => verifyState({ code: "c", state: "s" }, null)).toThrow(/No connection is in progress/);
  });

  it("skips the check for a bare code", () => {
    expect(() => verifyState({ code: "c" }, "s")).not.toThrow();
    expect(() => verifyState({ code: "c" }, null)).not.toThrow();
    expect(() => verifyState(parsePastedAuth("https://localhost/cb?code=abc"), "s")).toThrow(/no state/);
  });
});

describe("token request bodies", () => {
  it("builds the authorization_code form body", () => {
    const body = codeExchangeBody({
      clientId: "oauth2client_abc",
      clientSecret: "mnzconf.s3cr&t=",
      redirectUrl: "https://localhost/monzo-callback",
      code: "the code",
    });
    expect(body).toBe(
      "grant_type=authorization_code&client_id=oauth2client_abc&client_secret=mnzconf.s3cr%26t%3D" +
        "&redirect_uri=https%3A%2F%2Flocalhost%2Fmonzo-callback&code=the+code",
    );
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: "authorization_code",
      client_id: "oauth2client_abc",
      client_secret: "mnzconf.s3cr&t=",
      redirect_uri: "https://localhost/monzo-callback",
      code: "the code",
    });
  });

  it("builds the refresh_token form body", () => {
    expect(
      Object.fromEntries(
        new URLSearchParams(refreshBody({ clientId: "cid", clientSecret: "sec", refreshToken: "ref" })),
      ),
    ).toEqual({ grant_type: "refresh_token", client_id: "cid", client_secret: "sec", refresh_token: "ref" });
  });
});

describe("token expiry", () => {
  it("derives expires_at from expires_in, defaulting to 6 hours", () => {
    expect(expiresAtFrom({ access_token: "a", expires_in: 100 }, 1_000)).toBe(101_000);
    expect(expiresAtFrom({ access_token: "a" }, 0)).toBe(21_600_000);
  });

  it("flags tokens within five minutes of expiry", () => {
    expect(isExpiring(null, 0)).toBe(false);
    expect(isExpiring(1_000_000, 1_000_000 - 301_000)).toBe(false);
    expect(isExpiring(1_000_000, 1_000_000 - 299_000)).toBe(true);
    expect(isExpiring(1_000_000, 2_000_000)).toBe(true);
  });
});
