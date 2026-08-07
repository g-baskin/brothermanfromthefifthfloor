export function resolveGoogleOAuthConfig({ env = {}, packageMetadata = {} } = {}) {
  return {
    clientId: firstConfiguredValue(
      env.BRAH_GOOGLE_OAUTH_CLIENT_ID,
      packageMetadata.brahGoogleOAuthClientId,
    ),
    clientSecret: firstConfiguredValue(
      env.BRAH_GOOGLE_OAUTH_CLIENT_SECRET,
      packageMetadata.brahGoogleOAuthClientSecret,
    ),
  };
}

function firstConfiguredValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}
