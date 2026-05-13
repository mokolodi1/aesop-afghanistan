/**
 * Transactional HTML email palette — matches student portal theme
 * (src/client/styles.css, aesopafghanistan.org). Use hex for client support.
 */
const AESOP_EMAIL = {
  ink: '#373737',
  inkSoft: '#454545',
  muted: '#5c5c5c',
  line: '#e7e7e7',
  paper: '#f3f3f2',
  card: '#ffffff',
  accent: '#e85d3c',
  accentDark: '#c4492f',
  skyTint: '#faf6f5',
};

const FONT_STACK =
  "'Raleway', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const FONT_HEADING =
  "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** Official contact lines for transactional emails */
const AESOP_CONTACT = {
  phoneDisplay: '+1 (609) 362-2023',
  phoneTel: '+16093622023',
  email: 'noreply@aesopafghanistan.org',
};

/**
 * Escape HTML for safe interpolation in email bodies (not for full URL attributes).
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
 * Shared layout: paper background, white card, top accent bar, org footer.
 * @param {string} innerHtml — table cell content only
 * @param {{ title?: string }} [options]
 * @returns {string}
 */
function wrapAesopEmail(innerHtml, options = {}) {
  const { ink, muted, line, paper, card, accent } = AESOP_EMAIL;
  const titleTag = options.title
    ? `<title>${escapeHtml(options.title)}</title>`
    : '<title>AESOP Afghanistan</title>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${titleTag}
</head>
<body style="margin:0;padding:0;background-color:${paper};">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:${paper};">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background-color:${card};border-radius:16px;border:1px solid ${line};overflow:hidden;">
          <tr>
            <td style="height:4px;background-color:${accent};font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px 28px 32px;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${ink};">
              ${innerHtml}
            </td>
          </tr>
        </table>
        <p style="margin:20px 0 0;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${muted};max-width:560px;">
          Afghan Education Student Outreach Project (AESOP)<br />
          <a href="https://aesopafghanistan.org/" style="color:${accent};font-weight:600;text-decoration:none;">aesopafghanistan.org</a><br />
          <a href="tel:${AESOP_CONTACT.phoneTel}" style="color:${muted};text-decoration:none;">${AESOP_CONTACT.phoneDisplay}</a>
          <span style="color:${line};">&nbsp;·&nbsp;</span>
          <a href="mailto:${AESOP_CONTACT.email}" style="color:${accent};font-weight:600;text-decoration:none;">${AESOP_CONTACT.email}</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  AESOP_EMAIL,
  AESOP_CONTACT,
  FONT_STACK,
  FONT_HEADING,
  escapeHtml,
  wrapAesopEmail,
};
