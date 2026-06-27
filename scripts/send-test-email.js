#!/usr/bin/env node
/**
 * Send a test email through the configured provider (Postmark, Gmail, SMTP, etc.).
 *
 * Requires local config/secrets.json or SECRETS_JSON / env matching production.
 *
 * Usage: node scripts/send-test-email.js recipient@example.com
 */

require('../config/secrets');
const { sendEmail } = require('../services/email');
const { formatErrorForLog } = require('../utils/errorLogging');

async function main() {
  const to = process.argv[2];
  if (!to || !to.includes('@')) {
    console.error('Usage: node scripts/send-test-email.js recipient@example.com');
    process.exit(1);
  }

  const subject = 'AESOP test email';
  const text = [
    'This is a test message from the AESOP Afghanistan portal.',
    '',
    `Sent at: ${new Date().toISOString()}`,
    `Provider: ${require('../config/secrets').email?.provider || 'unknown'}`,
  ].join('\n');
  const html = `<p>This is a <strong>test message</strong> from the AESOP Afghanistan portal.</p>
<p>Sent at: ${new Date().toISOString()}</p>`;

  const result = await sendEmail({ to, subject, text, html });
  const messageId = result?.MessageID || result?.messageId;
  if (messageId) {
    console.log('Test email sent. Message ID:', messageId);
  } else {
    console.log('Test email sent.');
  }
}

main().catch((error) => {
  console.error('Failed to send test email:', formatErrorForLog(error));
  process.exit(1);
});
