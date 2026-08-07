const baseConfig = require("./package.json").build;

module.exports = {
  ...baseConfig,
  extraMetadata: {
    brahGoogleOAuthClientId: process.env.BRAH_GOOGLE_OAUTH_CLIENT_ID?.trim() || "",
    brahGoogleOAuthClientSecret: process.env.BRAH_GOOGLE_OAUTH_CLIENT_SECRET?.trim() || "",
  },
};
