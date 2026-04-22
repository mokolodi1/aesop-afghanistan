const fs = require('fs');
const path = require('path');

let secrets = null;

/**
 * Load secrets from secrets.json file
 * Falls back to environment variables if file doesn't exist
 */
function loadSecrets() {
  if (secrets) {
    return secrets;
  }

  const secretsPath = path.join(__dirname, 'secrets.json');
  
  // Try to load from file first
  if (fs.existsSync(secretsPath)) {
    try {
      const fileContent = fs.readFileSync(secretsPath, 'utf8');
      secrets = JSON.parse(fileContent);
      return secrets;
    } catch (error) {
      console.error('Error reading secrets.json:', error);
    }
  }

  // Fall back to environment variables
  secrets = {
    googleSheets: {
      sheetId: process.env.GOOGLE_SHEET_ID || '',
      clientEmail: process.env.GOOGLE_CLIENT_EMAIL || '',
      privateKey: process.env.GOOGLE_PRIVATE_KEY || '',
      sheetIndex: parseInt(process.env.GOOGLE_SHEET_INDEX || '0', 10),
      emailColumn: process.env.GOOGLE_EMAIL_COLUMN || 0
    },
    email: {
      provider: process.env.EMAIL_PROVIDER || 'smtp',
      from: process.env.EMAIL_FROM || 'noreply@aesopafghanistan.org',
      smtp: {
        host: process.env.SMTP_HOST || '',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER || '',
        password: process.env.SMTP_PASSWORD || ''
      },
      sendgrid: {
        apiKey: process.env.SENDGRID_API_KEY || ''
      },
      gmail: {
        user: process.env.GMAIL_USER || '',
        appPassword: process.env.GMAIL_APP_PASSWORD || ''
      }
    }
  };

  return secrets;
}

module.exports = loadSecrets();
