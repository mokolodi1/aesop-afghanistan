const { GoogleAuth, JWT } = require("google-auth-library");
const config = require("../config/secrets");

/**
 * @param {string} key
 * @returns {string}
 */
function normalizeServiceAccountPrivateKey(key) {
  const raw = String(key || "");
  if (!raw) {
    return "";
  }
  if (raw.includes("\\n") && !raw.includes("\n")) {
    return raw.replace(/\\n/g, "\n");
  }
  return raw;
}

/**
 * @returns {import('google-auth-library').JWT|null}
 */
function getServiceAccountCredentials() {
  const credentials = config.email?.gmailServiceAccount?.credentials;
  if (!credentials?.client_email || !credentials?.private_key) {
    return null;
  }
  return {
    ...credentials,
    private_key: normalizeServiceAccountPrivateKey(credentials.private_key),
  };
}

/**
 * Build a JWT client for the configured Gmail/Sheets service account.
 * @param {string|string[]} scopes
 * @returns {Promise<import('google-auth-library').OAuth2Client>}
 */
async function buildServiceAccountJwt(scopes) {
  const scopeList = Array.isArray(scopes) ? scopes : [scopes];
  const credentials = getServiceAccountCredentials();

  if (credentials) {
    const client = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: scopeList,
    });
    await client.authorize();
    return client;
  }

  if (process.env.FLY_APP_NAME) {
    throw new Error(
      "Google service account credentials are not configured. Set email.gmailServiceAccount.credentials " +
        "in SECRETS_JSON or GMAIL_SA_CREDENTIALS_JSON on Fly.",
    );
  }

  const auth = new GoogleAuth({
    scopes: scopeList,
  });
  return auth.getClient();
}

module.exports = {
  buildServiceAccountJwt,
  getServiceAccountCredentials,
  normalizeServiceAccountPrivateKey,
};
