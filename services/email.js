const nodemailer = require('nodemailer');
const { JWT } = require('google-auth-library');
const config = require('../config/secrets');
const { formatGmailAuthError, formatErrorForLog } = require('../utils/errorLogging');

let transporter = null;
let gmailJwtClient = null;

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * Initialize email transporter based on configuration
 */
function initEmailTransporter() {
  if (transporter) {
    return transporter;
  }

  if (!config.email) {
    throw new Error('Email configuration is missing. Please check your secrets.json file.');
  }

  // Support multiple email providers
  if (config.email.provider === 'smtp') {
    transporter = nodemailer.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port || 587,
      secure: config.email.smtp.secure || false, // true for 465, false for other ports
      auth: {
        user: config.email.smtp.user,
        pass: config.email.smtp.password,
      },
    });
  } else if (config.email.provider === 'sendgrid') {
    // SendGrid uses SMTP
    transporter = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: {
        user: 'apikey',
        pass: config.email.sendgrid.apiKey,
      },
    });
  } else if (config.email.provider === 'gmail') {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: config.email.gmail.user,
        pass: config.email.gmail.appPassword, // Use App Password, not regular password
      },
    });
  } else if (config.email.provider === 'gmailServiceAccount') {
    return null;
  } else {
    throw new Error(`Unsupported email provider: ${config.email.provider}`);
  }

  return transporter;
}

/**
 * Encode string to base64url as required by Gmail API
 * @param {string} value
 * @returns {string}
 */
function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Escape minimal HTML entities for safe email body generation
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build RFC-822 MIME message for Gmail API
 * @param {Object} options
 * @param {string} options.from
 * @param {string} options.to
 * @param {string} options.subject
 * @param {string} options.text
 * @param {string} options.html
 * @returns {string}
 */
function buildMimeMessage({ from, to, subject, text, html }) {
  const boundary = `aesop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const plainText = text || '';
  const htmlBody = html || `<pre>${escapeHtml(plainText)}</pre>`;

  return [
    `From: "AESOP Afghanistan" <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    plainText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlBody,
    '',
    `--${boundary}--`,
  ].join('\r\n');
}

/**
 * Initialize JWT auth client for Gmail API domain-wide delegation
 * @returns {JWT}
 */
function initGmailJwtClient() {
  if (gmailJwtClient) {
    return gmailJwtClient;
  }

  const delegatedUser = config.email?.gmailServiceAccount?.delegatedUser;
  const credentials = config.email?.gmailServiceAccount?.credentials;

  if (!delegatedUser) {
    throw new Error('Missing email.gmailServiceAccount.delegatedUser in secrets config.');
  }

  if (!credentials || !credentials.client_email || !credentials.private_key) {
    throw new Error('Missing email.gmailServiceAccount.credentials with service account JSON details.');
  }

  gmailJwtClient = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [GMAIL_SEND_SCOPE],
    subject: delegatedUser,
  });

  return gmailJwtClient;
}

/**
 * Send email through Gmail API using service account delegation
 * @param {Object} options
 * @param {string} options.to
 * @param {string} options.subject
 * @param {string} options.text
 * @param {string} options.html
 * @param {string} options.fromEmail
 * @returns {Promise<Object>}
 */
async function sendWithGmailServiceAccount({ to, subject, text, html, fromEmail }) {
  const delegatedUser = config.email.gmailServiceAccount.delegatedUser;
  let accessToken;

  try {
    const jwtClient = initGmailJwtClient();
    const tokenResponse = await jwtClient.authorize();
    accessToken = tokenResponse?.access_token;
  } catch (error) {
    const formattedError = formatGmailAuthError(error, delegatedUser);
    throw new Error(formattedError, { cause: error });
  }

  if (!accessToken) {
    throw new Error('Failed to acquire Gmail API access token from service account.');
  }

  const mimeMessage = buildMimeMessage({
    from: fromEmail,
    to,
    subject,
    text,
    html,
  });

  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(delegatedUser)}/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      raw: toBase64Url(mimeMessage),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail API send failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Send an email
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email (must be pre-validated and sanitized)
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Plain text body
 * @param {string} options.html - HTML body
 * @returns {Promise<void>}
 */
async function sendEmail({ to, subject, text, html }) {
  try {
    const fromEmail = config.email.from || config.email.smtp?.user || config.email.gmailServiceAccount?.delegatedUser || 'noreply@aesopafghanistan.org';

    // Sanitize subject to prevent header injection
    const sanitizedSubject = (subject || '').replace(/[\r\n]/g, '').slice(0, 200);

    const mailOptions = {
      from: `"AESOP Afghanistan" <${fromEmail}>`,
      to, // Email should already be sanitized before calling this function
      subject: sanitizedSubject,
      text: text || '',
      html: html || '',
    };

    let info;
    if (config.email.provider === 'gmailServiceAccount') {
      info = await sendWithGmailServiceAccount({
        to,
        subject: sanitizedSubject,
        text: mailOptions.text,
        html: mailOptions.html,
        fromEmail,
      });
    } else {
      const transporter = initEmailTransporter();
      info = await transporter.sendMail(mailOptions);
    }

    console.log('Email sent successfully');
    return info;
  } catch (error) {
    // Don't expose email details in error logs
    console.error('Error sending email:', formatErrorForLog(error));
    throw error;
  }
}

module.exports = {
  sendEmail,
  initEmailTransporter
};
