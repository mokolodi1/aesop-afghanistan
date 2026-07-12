const config = require('../config/secrets');
const { sendEmail } = require('./email');
const { escapeHtml } = require('./emailBranding');
const { isValidEmail, sanitizeEmail } = require('../utils/validation');

function portalOrigin() {
  return String(process.env.PORTAL_BASE_URL || process.env.BASE_URL || 'https://portal.aesopafghanistan.org').replace(/\/+$/, '');
}

async function sendStudentTicketUpdate({ to, name, ticketId, subject }) {
  if (!isValidEmail(to)) return;
  const url = `${portalOrigin()}/tickets`;
  const greeting = name ? `Hello ${name},` : 'Hello,';
  await sendEmail({
    to: sanitizeEmail(to),
    subject: `Update to AESOP support ticket #${ticketId}`,
    text: `${greeting}\n\nThe Operations Team replied to your ticket: ${subject}\n\nView the update in the AESOP portal: ${url}`,
    html: `<p>${escapeHtml(greeting)}</p><p>The Operations Team replied to your ticket: <strong>${escapeHtml(subject)}</strong></p><p><a href="${escapeHtml(url)}">View the update in the AESOP portal</a></p>`,
  });
}

async function notifyOperationsOfStudentMessage({ ticketId, subject, studentName, isNew }) {
  const raw = config.portalContactEmail || '';
  if (!isValidEmail(raw)) return;
  const url = `${portalOrigin()}/operations/tickets`;
  const action = isNew ? 'created a new ticket' : 'sent a follow-up';
  await sendEmail({
    to: sanitizeEmail(raw),
    subject: `AESOP support ticket #${ticketId}: ${subject}`,
    text: `${studentName || 'A student'} ${action}.\n\nView it in the AESOP portal: ${url}`,
    html: `<p>${escapeHtml(studentName || 'A student')} ${escapeHtml(action)}.</p><p><a href="${escapeHtml(url)}">View ticket #${ticketId}</a></p>`,
  });
}

module.exports = { sendStudentTicketUpdate, notifyOperationsOfStudentMessage };
