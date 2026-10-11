import { describe, expect, it } from "vitest";
import {
  KEY_AUTHENTICATED_AT,
  KEY_CLIENT_ID,
  KEY_EXPIRES_AT,
  KEY_LAST_RESULT,
  KEY_OAUTH_STATE,
  KEY_REDIRECT_URL,
  SECRET_ACCESS_TOKEN,
  SECRET_CLIENT_SECRET,
  SECRET_REFRESH_TOKEN,
} from "../constants";
import { json, makeCtx } from "../test-utils";
import {
  MonzoAuthError,
  beginAuthorisation,
  completeAuthorisation,
  disconnect,
  getConnectionStatus,
  refreshAccessToken,
  saveSettings,
} from "./auth";

const REDIRECT = "https://localhost/monzo-callback";

async function configured(handler?: Parameters<typeof makeCtx>[0]) {
  const t = makeCtx(handler);
  await saveSettings(t.ctx, { clientId: "oauth2client_abc", clientSecret: "mnzconf.sec", redirectUrl: REDIRECT });
  return t;
}

describe("saveSettings", () => {
  it("keeps the secret in secrets and the rest in storage", async () => {
    const t = await configured();
    expect(t.secrets.get(SECRET_CLIENT_SECRET)).toBe("mnzconf.sec");
    expect(t.storage.get(KEY_CLIENT_ID)).toBe("oauth2client_abc");
    expect(t.storage.get(KEY_REDIRECT_URL)).toBe(REDIRECT);
  });

  it("keeps the stored secret when the field is left blank", async () => {
    const t = await configured();
    await saveSettings(t.ctx, { clientId: "oauth2client_abc", clientSecret: "", redirectUrl: REDIRECT });
    expect(t.secrets.get(SECRET_CLIENT_SECRET)).toBe("mnzconf.sec");
  });
});

describe("beginAuthorisation", () => {
  it("stores a random state and returns a login URL carrying it", async () => {
    const t = await configured();
    const { url, state } = await beginAuthorisation(t.ctx);
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(t.storage.get(KEY_OAUTH_STATE)).toBe(state);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://auth.monzo.com/");
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("client_id")).toBe("oauth2client_abc");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
  });

  it("requires saved credentials", async () => {
    const { ctx } = makeCtx();
    await expect(beginAuthorisation(ctx)).rejects.toMatchObject({ kind: "needs-credentials" });
  });
});

describe("completeAuthorisation", () => {
  const tokenReply = json(200, {
    access_token: "acc-1",
    refresh_token: "ref-1",
    expires_in: 21600,
    token_type: "Bearer",
    client_id: "oauth2client_abc",
    user_id: "user_1",
  });

  it("exchanges the code from a pasted redirect URL and stores the tokens", async () => {
    const t = await configured({ handler: () => tokenReply });
    const { state } = await beginAuthorisation(t.ctx);
    const before = Date.now();
    await completeAuthorisation(t.ctx, `${REDIRECT}?code=the-code&state=${state}`);

    expect(t.requests).toHaveLength(1);
    const req = t.requests[0];
    expect(req.url).toBe("https://api.monzo.com/oauth2/token");
    expect(req.method).toBe("POST");
    expect(req.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(req.auth).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({
      grant_type: "authorization_code",
      client_id: "oauth2client_abc",
      client_secret: "mnzconf.sec",
      redirect_uri: REDIRECT,
      code: "the-code",
    });

    expect(t.secrets.get(SECRET_ACCESS_TOKEN)).toBe("acc-1");
    expect(t.secrets.get(SECRET_REFRESH_TOKEN)).toBe("ref-1");
    expect(Number(t.storage.get(KEY_EXPIRES_AT))).toBeGreaterThanOrEqual(before + 21_600_000);
    expect(t.storage.has(KEY_OAUTH_STATE)).toBe(false);
    expect(await getConnectionStatus(t.ctx)).toMatchObject({ connected: true, hasCredentials: true, hasRefreshToken: true });
  });

  it("records when the login completed (ms since epoch), and a failed exchange records nothing", async () => {
    const t = await configured({ handler: () => tokenReply });
    const { state } = await beginAuthorisation(t.ctx);
    const before = Date.now();
    await completeAuthorisation(t.ctx, `${REDIRECT}?code=the-code&state=${state}`);
    const at = Number(t.storage.get(KEY_AUTHENTICATED_AT));
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());

    const failing = await configured({ handler: () => json(400, { error: "invalid_grant" }) });
    await beginAuthorisation(failing.ctx);
    await expect(completeAuthorisation(failing.ctx, "bad-code")).rejects.toThrow();
    expect(failing.storage.has(KEY_AUTHENTICATED_AT)).toBe(false);
  });

  it("accepts a bare code", async () => {
    const t = await configured({ handler: () => tokenReply });
    await beginAuthorisation(t.ctx);
    await completeAuthorisation(t.ctx, "  bare-code  ");
    expect(new URLSearchParams(t.requests[0].body).get("code")).toBe("bare-code");
  });

  it("rejects a mismatched state without calling Monzo", async () => {
    const t = await configured({ handler: () => tokenReply });
    await beginAuthorisation(t.ctx);
    await expect(completeAuthorisation(t.ctx, `${REDIRECT}?code=c&state=forged`)).rejects.toThrow(/does not match/);
    expect(t.requests).toHaveLength(0);
    expect(t.secrets.has(SECRET_ACCESS_TOKEN)).toBe(false);
  });

  it("surfaces Monzo's rejection and stores nothing", async () => {
    const t = await configured({ handler: () => json(400, { error: "invalid_grant", error_description: "bad code" }) });
    await beginAuthorisation(t.ctx);
    await expect(completeAuthorisation(t.ctx, "stale")).rejects.toThrow(/400: bad code/);
    expect(t.secrets.has(SECRET_ACCESS_TOKEN)).toBe(false);
    expect(t.storage.has(KEY_EXPIRES_AT)).toBe(false);
  });
});

describe("refreshAccessToken", () => {
  async function connected(handler: Parameters<typeof makeCtx>[0]) {
    const t = await configured(handler);
    t.secrets.set(SECRET_ACCESS_TOKEN, "old-acc");
    t.secrets.set(SECRET_REFRESH_TOKEN, "old-ref");
    t.storage.set(KEY_EXPIRES_AT, "1");
    return t;
  }

  it("posts the refresh_token grant and rotates both tokens", async () => {
    const t = await connected({
      handler: () => json(200, { access_token: "new-acc", refresh_token: "new-ref", expires_in: 100 }),
    });
    await refreshAccessToken(t.ctx);
    expect(Object.fromEntries(new URLSearchParams(t.requests[0].body))).toEqual({
      grant_type: "refresh_token",
      client_id: "oauth2client_abc",
      client_secret: "mnzconf.sec",
      refresh_token: "old-ref",
    });
    expect(t.secrets.get(SECRET_ACCESS_TOKEN)).toBe("new-acc");
    expect(t.secrets.get(SECRET_REFRESH_TOKEN)).toBe("new-ref");
  });

  it("does not count as a new login", async () => {
    const t = await connected({
      handler: () => json(200, { access_token: "new-acc", refresh_token: "new-ref", expires_in: 100 }),
    });
    await refreshAccessToken(t.ctx);
    expect(t.storage.has(KEY_AUTHENTICATED_AT)).toBe(false);
  });

  it("shares one request between concurrent refreshes (refresh tokens are single-use)", async () => {
    const t = await connected({
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return json(200, { access_token: "new-acc", refresh_token: "new-ref", expires_in: 100 });
      },
    });
    await Promise.all([refreshAccessToken(t.ctx), refreshAccessToken(t.ctx), refreshAccessToken(t.ctx)]);
    expect(t.requests).toHaveLength(1);
  });

  it("asks for the client credentials when only v1 tokens exist", async () => {
    const t = makeCtx();
    t.secrets.set(SECRET_REFRESH_TOKEN, "v1-ref");
    t.storage.set(KEY_EXPIRES_AT, "0");
    await expect(refreshAccessToken(t.ctx)).rejects.toMatchObject({ kind: "needs-credentials" });
    expect(t.requests).toHaveLength(0);
  });

  it("maps a rejected refresh token to a reconnect error", async () => {
    const t = await connected({ handler: () => json(401, { error: "invalid_token" }) });
    const err = await refreshAccessToken(t.ctx).catch((e) => e);
    expect(err).toBeInstanceOf(MonzoAuthError);
    expect(err.kind).toBe("reconnect");
  });
});

describe("disconnect", () => {
  it("forgets tokens but keeps the OAuth client settings", async () => {
    const t = await configured();
    t.secrets.set(SECRET_ACCESS_TOKEN, "a");
    t.secrets.set(SECRET_REFRESH_TOKEN, "r");
    t.storage.set(KEY_EXPIRES_AT, "5");
    await disconnect(t.ctx);
    expect(t.secrets.has(SECRET_ACCESS_TOKEN)).toBe(false);
    expect(t.secrets.has(SECRET_REFRESH_TOKEN)).toBe(false);
    expect(t.storage.has(KEY_EXPIRES_AT)).toBe(false);
    expect(t.secrets.get(SECRET_CLIENT_SECRET)).toBe("mnzconf.sec");
    expect(t.storage.get(KEY_CLIENT_ID)).toBe("oauth2client_abc");
  });

  it("forgets when the login happened", async () => {
    const t = await configured();
    t.storage.set(KEY_AUTHENTICATED_AT, String(Date.now()));
    await disconnect(t.ctx);
    expect(t.storage.has(KEY_AUTHENTICATED_AT)).toBe(false);
  });

  it("forgets the last sync's view so a disconnected add-on does not show it", async () => {
    const t = await configured();
    t.storage.set(KEY_LAST_RESULT, "{}");
    await disconnect(t.ctx);
    expect(t.storage.has(KEY_LAST_RESULT)).toBe(false);
  });

  it("revokes the token at Monzo first, and still disconnects if that fails", async () => {
    const t = await configured({ handler: () => ({ status: 500, body: "" }) });
    t.secrets.set(SECRET_ACCESS_TOKEN, "a");
    t.storage.set(KEY_EXPIRES_AT, "5");
    await disconnect(t.ctx);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toMatchObject({
      url: "https://api.monzo.com/oauth2/logout",
      method: "POST",
      auth: { type: "bearer", secretKey: SECRET_ACCESS_TOKEN },
    });
    expect(t.secrets.has(SECRET_ACCESS_TOKEN)).toBe(false);
  });
});
