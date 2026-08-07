import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;

export function createPkcePair() {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

export function createGoogleOAuthClient({
  clientId,
  clientSecret = "",
  tokenStore,
  openExternal,
  fetchImpl = globalThis.fetch,
  createServer = createHttpServer,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  let accessToken = null;
  let accessTokenExpiresAt = 0;

  function assertConfigured() {
    if (typeof clientId !== "string" || !clientId.trim()) {
      throw oauthError(
        "integration_unconfigured",
        "Google Calendar is not configured. Set BRAH_GOOGLE_OAUTH_CLIENT_ID.",
      );
    }
  }

  return {
    isConfigured: () => Boolean(clientId?.trim()),

    async connect() {
      assertConfigured();
      if (!tokenStore.isEncryptionAvailable()) {
        throw oauthError(
          "secure_storage_unavailable",
          "Secure credential storage is unavailable, so Google Calendar cannot connect.",
        );
      }

      const state = randomBytes(32).toString("base64url");
      const { verifier, challenge } = createPkcePair();
      const callback = await waitForLoopbackCallback({ createServer, state, timeoutMs });
      const redirectUri = `http://127.0.0.1:${callback.port}/oauth2/callback`;
      const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      authorizationUrl.search = new URLSearchParams({
        access_type: "offline",
        client_id: clientId,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "consent",
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_CALENDAR_SCOPE,
        state,
      }).toString();

      try {
        await openExternal(authorizationUrl.toString());
      } catch {
        callback.cancel();
        throw oauthError(
          "oauth_browser_error",
          "The Google authorization page could not be opened.",
        );
      }

      let code;
      try {
        code = await callback.result;
      } finally {
        callback.cancel();
      }

      const tokens = await exchangeAuthorizationCode({
        clientId,
        clientSecret,
        code,
        codeVerifier: verifier,
        redirectUri,
        fetchImpl,
      });
      if (!tokens.refreshToken) {
        throw oauthError(
          "oauth_refresh_token_missing",
          "Google did not return offline access. Reconnect and approve Calendar access.",
        );
      }

      await tokenStore.save({
        refreshToken: tokens.refreshToken,
        metadata: { connectedAt: new Date(now()).toISOString(), scope: GOOGLE_CALENDAR_SCOPE },
      });
      accessToken = tokens.accessToken;
      accessTokenExpiresAt = now() + tokens.expiresIn * 1000;
      return { connected: true, connectedAt: new Date(now()).toISOString() };
    },

    async getAccessToken({ forceRefresh = false } = {}) {
      assertConfigured();
      if (!forceRefresh && accessToken && accessTokenExpiresAt - ACCESS_TOKEN_SKEW_MS > now()) {
        return accessToken;
      }

      const stored = await tokenStore.load();
      if (!stored) {
        throw oauthError(
          "integration_not_connected",
          "Google Calendar is not connected. Connect it in Settings.",
        );
      }

      let tokens;
      try {
        tokens = await refreshGoogleAccessToken({
          clientId,
          clientSecret,
          refreshToken: stored.refreshToken,
          fetchImpl,
        });
      } catch (error) {
        if (error.code === "integration_not_connected") {
          await tokenStore.delete();
        }
        throw error;
      }
      accessToken = tokens.accessToken;
      accessTokenExpiresAt = now() + tokens.expiresIn * 1000;
      return accessToken;
    },

    async getStatus() {
      if (!clientId?.trim()) {
        return { state: "unconfigured" };
      }
      if (!tokenStore.isEncryptionAvailable()) {
        return { state: "error", message: "Secure credential storage is unavailable." };
      }
      try {
        const stored = await tokenStore.load();
        return stored
          ? { state: "connected", connectedAt: stored.metadata.connectedAt || null }
          : { state: "disconnected" };
      } catch {
        return { state: "error", message: "Saved Google Calendar credentials are unreadable." };
      }
    },

    async disconnect() {
      let revocationFailed = false;
      try {
        const stored = await tokenStore.load();
        if (stored) {
          try {
            await revokeGoogleToken({ token: stored.refreshToken, fetchImpl });
          } catch {
            revocationFailed = true;
          }
        }
      } finally {
        accessToken = null;
        accessTokenExpiresAt = 0;
        await tokenStore.delete();
      }
      return { disconnected: true, revocationFailed };
    },
  };
}

export async function exchangeAuthorizationCode({
  clientId,
  clientSecret = "",
  code,
  codeVerifier,
  redirectUri,
  fetchImpl = globalThis.fetch,
}) {
  return requestTokens(
    new URLSearchParams({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    fetchImpl,
  );
}

export async function refreshGoogleAccessToken({
  clientId,
  clientSecret = "",
  refreshToken,
  fetchImpl = globalThis.fetch,
}) {
  return requestTokens(
    new URLSearchParams({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    fetchImpl,
  );
}

export async function revokeGoogleToken({ token, fetchImpl = globalThis.fetch }) {
  let response;
  try {
    response = await fetchImpl(GOOGLE_REVOCATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    throw oauthError("oauth_network_error", "Google token revocation could not be reached.");
  }
  if (!response.ok) {
    throw oauthError("oauth_revocation_failed", "Google token revocation failed.");
  }
}

async function requestTokens(body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw oauthError("oauth_network_error", "Google authorization could not be reached.");
  }

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    if (payload?.error === "invalid_grant") {
      throw oauthError(
        "integration_not_connected",
        "Google Calendar authorization expired or was revoked. Reconnect in Settings.",
      );
    }
    throw oauthError("oauth_token_error", "Google authorization failed. Try connecting again.");
  }
  if (
    typeof payload?.access_token !== "string" ||
    !payload.access_token ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  ) {
    throw oauthError(
      "oauth_invalid_response",
      "Google returned an invalid authorization response.",
    );
  }

  return {
    accessToken: payload.access_token,
    expiresIn: payload.expires_in,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
  };
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForLoopbackCallback({ createServer, state, timeoutMs }) {
  let settle;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    settle = resolve;
    rejectResult = reject;
  });
  // The browser opener may await the callback HTTP response before connect() awaits
  // this promise, so attach a handler immediately to avoid transient unhandled rejections.
  result.catch(() => {});
  let settled = false;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== "/oauth2/callback") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const returnedStates = requestUrl.searchParams.getAll("state");
    const errors = requestUrl.searchParams.getAll("error");
    const codes = requestUrl.searchParams.getAll("code");
    const returnedState = returnedStates.length === 1 ? returnedStates[0] : null;
    const error = errors.length === 1 ? errors[0] : null;
    const code = codes.length === 1 ? codes[0] : null;
    if (!secureStringEqual(returnedState, state)) {
      finish(
        rejectResult,
        oauthError("oauth_state_mismatch", "Google authorization state did not match."),
      );
      sendBrowserResponse(response, false);
      return;
    }
    if (errors.length > 1 || codes.length > 1 || (errors.length > 0 && codes.length > 0)) {
      finish(
        rejectResult,
        oauthError("oauth_invalid_callback", "Google returned an invalid authorization callback."),
      );
      sendBrowserResponse(response, false);
      return;
    }
    if (error) {
      finish(
        rejectResult,
        oauthError("oauth_denied", "Google Calendar authorization was cancelled."),
      );
      sendBrowserResponse(response, false);
      return;
    }
    if (!code) {
      finish(
        rejectResult,
        oauthError("oauth_invalid_callback", "Google returned no authorization code."),
      );
      sendBrowserResponse(response, false);
      return;
    }
    finish(settle, code);
    sendBrowserResponse(response, true);
  });

  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(value);
  };
  const timer = setTimeout(() => {
    finish(rejectResult, oauthError("oauth_timeout", "Google Calendar authorization timed out."));
    server.close();
  }, timeoutMs);
  timer.unref?.();

  server.on("error", () => {
    finish(
      rejectResult,
      oauthError("oauth_listener_error", "The authorization callback could not start."),
    );
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  }).catch(() => {
    finish(
      rejectResult,
      oauthError("oauth_listener_error", "The authorization callback could not start."),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    clearTimeout(timer);
    throw oauthError("oauth_listener_error", "The authorization callback could not start.");
  }

  return {
    port: address.port,
    result,
    cancel() {
      if (!settled) {
        finish(rejectResult, oauthError("oauth_cancelled", "Google authorization was cancelled."));
      }
      server.close();
    },
  };
}

function sendBrowserResponse(response, success) {
  response.writeHead(success ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Brah Google Calendar</title><p>${
      success
        ? "Google Calendar authorization received. Return to Brah while it finishes and confirms the connection."
        : "Google Calendar did not connect. Return to Brah and try again."
    }</p>`,
  );
}

function secureStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function oauthError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
