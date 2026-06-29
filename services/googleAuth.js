const { GoogleAuth, JWT } = require("google-auth-library");
const config = require("../config/secrets");

/**
 * @returns {import('google-auth-library').JWT|null}
 */
function getServiceAccountCredentials() {
  const credentials = config.email?.gmailServiceAccount?.credentials;
  if (!credentials?.client_email || !credentials?.private_key) {
    return null;
  }
  return credentials;
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
    return new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: scopeList,
    });
  }

  const auth = new GoogleAuth({
    scopes: scopeList,
  });
  return auth.getClient();
}

module.exports = {
  buildServiceAccountJwt,
  getServiceAccountCredentials,
};
