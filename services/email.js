const nodemailer = require('nodemailer');
const config = require('../config/secrets');

let transporter = null;

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
  } else {
    throw new Error(`Unsupported email provider: ${config.email.provider}`);
  }

  return transporter;
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
    const transporter = initEmailTransporter();
    const fromEmail = config.email.from || config.email.smtp?.user || 'noreply@aesopafghanistan.org';

    // Sanitize subject to prevent header injection
    const sanitizedSubject = (subject || '').replace(/[\r\n]/g, '').slice(0, 200);

    const mailOptions = {
      from: `"AESOP Afghanistan" <${fromEmail}>`,
      to, // Email should already be sanitized before calling this function
      subject: sanitizedSubject,
      text: text || '',
      html: html || '',
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully');
    return info;
  } catch (error) {
    // Don't expose email details in error logs
    console.error('Error sending email:', error.message);
    throw error;
  }
}

module.exports = {
  sendEmail,
  initEmailTransporter
};
