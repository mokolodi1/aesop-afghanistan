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

/**
 * Notify student by email after they update their Ding number in the portal.
 * @param {{ to: string, displayName: string, newDingNumber: string }} params
 */
async function sendDingNumberUpdatedEmail({ to, displayName, newDingNumber }) {
  const name = displayName && String(displayName).trim() ? String(displayName).trim() : 'Student';
  const ding = String(newDingNumber || '').trim();
  const safeName = escapeHtml(name);
  const safeDing = escapeHtml(ding);

  const subject = 'Your AESOP Ding number was updated';
  const text = [
    `Hello ${name},`,
    '',
    `Your Ding number on file has been updated to: ${ding}`,
    '',
    'If you did not make this change, please contact AESOP Afghanistan right away.',
    '',
    '— AESOP Afghanistan',
    'https://aesopafghanistan.org/',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#1c1917;max-width:560px;margin:0 auto;padding:24px;">
  <p>Hello ${safeName},</p>
  <p>Your <strong>Ding number</strong> on file has been updated to:</p>
  <p style="font-size:1.15rem;font-weight:700;letter-spacing:0.03em;">${safeDing}</p>
  <p style="color:#57534e;font-size:14px;">If you did not make this change, please contact AESOP Afghanistan right away.</p>
  <p style="margin-top:28px;font-size:14px;color:#57534e;">— AESOP Afghanistan<br /><a href="https://aesopafghanistan.org/">aesopafghanistan.org</a></p>
</body>
</html>`;

  await sendEmail({ to, subject, text, html });
}

/**
 * Notify administrators when a student cannot submit an Afghanistan Ding number via the portal.
 * @param {{
 *   to: string,
 *   studentDisplayName: string,
 *   studentUserId: string,
 *   studentEmail: string,
 *   phoneOnFile: string,
 *   currentDingDisplay: string,
 *   requestedPhone: string,
 *   note: string,
 * }} params
 */
async function sendPortalDingHelpRequestEmail({
  to,
  studentDisplayName,
  studentUserId,
  studentEmail,
  phoneOnFile,
  currentDingDisplay,
  requestedPhone,
  note,
}) {
  const name = studentDisplayName && String(studentDisplayName).trim() ? String(studentDisplayName).trim() : 'Student';
  const safeName = escapeHtml(name);
  const safeId = escapeHtml(studentUserId);
  const safeEmail = escapeHtml(studentEmail);
  const safePhoneFile = escapeHtml(phoneOnFile || '—');
  const safeDing = escapeHtml(currentDingDisplay || '—');
  const safeReq = escapeHtml(requestedPhone || '—');
  const safeNote = escapeHtml(note || '—');

  const subject = `[AESOP Portal] Ding help — ${studentUserId}`;
  const text = [
    'A student asked for help updating their Ding number (portal form).',
    '',
    `Name (portal): ${name}`,
    `AESOP ID: ${studentUserId}`,
    `Email on file: ${studentEmail}`,
    `Phone on file: ${phoneOnFile || '—'}`,
    `Current Ding on portal: ${currentDingDisplay || '—'}`,
    '',
    `Phone number they need for Ding: ${requestedPhone || '—'}`,
    '',
    'Note:',
    note || '—',
    '',
    `— Sent automatically from student portal · ${new Date().toISOString()}`,
  ].join('\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#1c1917;max-width:560px;margin:0 auto;padding:24px;">
  <p style="font-weight:700;">Ding number — manual update requested</p>
  <p style="color:#57534e;font-size:14px;">The student could not use the Afghanistan-only Ding form (for example a non-Afghan number). Please review and update the sheet if appropriate.</p>
  <table style="border-collapse:collapse;font-size:14px;margin:16px 0;">
    <tr><td style="padding:4px 12px 4px 0;color:#57534e;">Name</td><td>${safeName}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#57534e;">AESOP ID</td><td>${safeId}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#57534e;">Email</td><td>${safeEmail}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#57534e;">Phone on file</td><td>${safePhoneFile}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#57534e;">Ding on portal</td><td>${safeDing}</td></tr>
  </table>
  <p><strong>Phone they need for Ding</strong></p>
  <p style="font-size:1.05rem;">${safeReq}</p>
  <p><strong>Note</strong></p>
  <p style="white-space:pre-wrap;font-size:14px;">${safeNote}</p>
  <p style="margin-top:28px;font-size:12px;color:#78716c;">${escapeHtml(new Date().toISOString())}</p>
</body>
</html>`;

  await sendEmail({ to, subject, text, html });
}

module.exports = {
  sendEmail,
  sendDingNumberUpdatedEmail,
  sendPortalDingHelpRequestEmail,
  initEmailTransporter,
};
