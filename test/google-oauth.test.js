import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createGoogleOAuthClient,
  createPkcePair,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
} from "../src/integrations/google/google-oauth.js";

function tokenStore(initial = null) {
  let value = initial;
  return {
    isEncryptionAvailable: () => true,
    load: async () => value,
    save: async (next) => {
      value = next;
    },
    delete: async () => {
      value = null;
    },
    inspect: () => value,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("PKCE uses a high-entropy verifier and S256 base64url challenge", () => {
  const { verifier, challenge } = createPkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(challenge, createHash("sha256").update(verifier, "ascii").digest("base64url"));
});

test("connect opens system authorization with state and PKCE then persists refresh token", async () => {
  const store = tokenStore();
  let authorizationUrl;
  let tokenRequest;
  const client = createGoogleOAuthClient({
    clientId: "desktop-client-id",
    tokenStore: store,
    now: () => Date.parse("2026-08-06T12:00:00.000Z"),
    openExternal: async (url) => {
      authorizationUrl = new URL(url);
      const callbackUrl = new URL(authorizationUrl.searchParams.get("redirect_uri"));
      callbackUrl.searchParams.set("state", authorizationUrl.searchParams.get("state"));
      callbackUrl.searchParams.set("code", "authorization-code");
      const response = await fetch(callbackUrl);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, GOOGLE_TOKEN_ENDPOINT);
      tokenRequest = options.body;
      return jsonResponse({
        access_token: "access-token",
        expires_in: 3600,
        refresh_token: "refresh-token",
      });
    },
  });

  const result = await client.connect();
  assert.equal(result.connected, true);
  assert.equal(authorizationUrl.searchParams.get("scope"), GOOGLE_CALENDAR_SCOPE);
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizationUrl.searchParams.get("prompt"), "consent");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizationUrl.searchParams.get("state"));
  assert.equal(tokenRequest.get("code"), "authorization-code");
  assert.ok(tokenRequest.get("code_verifier"));
  assert.equal(tokenRequest.has("client_secret"), false);
  assert.equal(store.inspect().refreshToken, "refresh-token");
  assert.equal(await client.getAccessToken(), "access-token");
});

test("state mismatch rejects connection and leaves prior credentials untouched", async () => {
  const existing = {
    refreshToken: "existing-refresh",
    metadata: { connectedAt: "2026-08-01T00:00:00.000Z" },
  };
  const store = tokenStore(existing);
  const client = createGoogleOAuthClient({
    clientId: "desktop-client-id",
    tokenStore: store,
    openExternal: async (url) => {
      const callbackUrl = new URL(new URL(url).searchParams.get("redirect_uri"));
      callbackUrl.searchParams.set("state", "wrong-state");
      callbackUrl.searchParams.set("code", "stolen-code");
      await fetch(callbackUrl);
    },
    fetchImpl: async () => assert.fail("token endpoint must not be called"),
  });

  await assert.rejects(client.connect(), (error) => error.code === "oauth_state_mismatch");
  assert.deepEqual(store.inspect(), existing);
});

test("duplicate callback security parameters are rejected before token exchange", async () => {
  const store = tokenStore();
  const client = createGoogleOAuthClient({
    clientId: "desktop-client-id",
    tokenStore: store,
    openExternal: async (url) => {
      const auth = new URL(url);
      const callbackUrl = new URL(auth.searchParams.get("redirect_uri"));
      callbackUrl.searchParams.append("state", auth.searchParams.get("state"));
      callbackUrl.searchParams.append("state", "duplicate-state");
      callbackUrl.searchParams.append("code", "authorization-code");
      await fetch(callbackUrl);
    },
    fetchImpl: async () => assert.fail("token endpoint must not be called"),
  });

  await assert.rejects(client.connect(), (error) => error.code === "oauth_state_mismatch");
  assert.equal(store.inspect(), null);
});

test("authorization denial is concise and preserves prior credentials", async () => {
  const existing = { refreshToken: "existing-refresh", metadata: {} };
  const store = tokenStore(existing);
  const client = createGoogleOAuthClient({
    clientId: "desktop-client-id",
    tokenStore: store,
    openExternal: async (url) => {
      const auth = new URL(url);
      const callbackUrl = new URL(auth.searchParams.get("redirect_uri"));
      callbackUrl.searchParams.set("state", auth.searchParams.get("state"));
      callbackUrl.searchParams.set("error", "access_denied");
      await fetch(callbackUrl);
    },
  });

  await assert.rejects(client.connect(), (error) => error.code === "oauth_denied");
  assert.deepEqual(store.inspect(), existing);
});

test("authorization timeout closes without token exchange", async () => {
  const client = createGoogleOAuthClient({
    clientId: "desktop-client-id",
    tokenStore: tokenStore(),
    timeoutMs: 20,
    openExternal: async () => {},
    fetchImpl: async () => assert.fail("token endpoint must not be called"),
  });
  await assert.rejects(client.connect(), (error) => error.code === "oauth_timeout");
});

test("access token refresh caches tokens and invalid_grant removes credentials", async () => {
  const store = tokenStore({ refreshToken: "stored-refresh", metadata: {} });
  let refreshCalls = 0;
  const client = createGoogleOAuthClient({
    clientId: "desktop-client-id",
    tokenStore: store,
    openExternal: async () => {},
    fetchImpl: async (_url, options) => {
      refreshCalls += 1;
      assert.equal(options.body.get("refresh_token"), "stored-refresh");
      if (refreshCalls === 1) {
        return jsonResponse({ access_token: "fresh-access", expires_in: 3600 });
      }
      return jsonResponse({ error: "invalid_grant" }, 400);
    },
  });

  assert.equal(await client.getAccessToken(), "fresh-access");
  assert.equal(await client.getAccessToken(), "fresh-access");
  assert.equal(refreshCalls, 1);
  await assert.rejects(
    client.getAccessToken({ forceRefresh: true }),
    (error) => error.code === "integration_not_connected",
  );
  assert.equal(store.inspect(), null);
});

test("missing client ID returns setup-specific status", async () => {
  const client = createGoogleOAuthClient({
    clientId: "",
    tokenStore: tokenStore(),
    openExternal: async () => {},
  });
  assert.deepEqual(await client.getStatus(), { state: "unconfigured" });
  await assert.rejects(client.connect(), (error) => error.code === "integration_unconfigured");
});
