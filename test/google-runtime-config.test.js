import assert from "node:assert/strict";
import test from "node:test";
import { resolveGoogleOAuthConfig } from "../src/integrations/google/google-runtime-config.js";

test("packaged Google OAuth metadata configures Calendar without process environment", () => {
  assert.deepEqual(
    resolveGoogleOAuthConfig({
      packageMetadata: {
        brahGoogleOAuthClientId: " packaged-client ",
        brahGoogleOAuthClientSecret: " packaged-secret ",
      },
    }),
    { clientId: "packaged-client", clientSecret: "packaged-secret" },
  );
});

test("environment Google OAuth configuration takes precedence during development", () => {
  assert.deepEqual(
    resolveGoogleOAuthConfig({
      env: {
        BRAH_GOOGLE_OAUTH_CLIENT_ID: "dev-client",
        BRAH_GOOGLE_OAUTH_CLIENT_SECRET: "dev-secret",
      },
      packageMetadata: {
        brahGoogleOAuthClientId: "packaged-client",
        brahGoogleOAuthClientSecret: "packaged-secret",
      },
    }),
    { clientId: "dev-client", clientSecret: "dev-secret" },
  );
});
