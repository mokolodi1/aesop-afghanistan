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
  "'Raleway', Tahoma, 'Geeza Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const FONT_HEADING =
  "'Space Grotesk', Tahoma, 'Geeza Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** Arabic, Persian/Dari, Hebrew, and related scripts */
const RTL_CHAR_RE =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const STRONG_LTR_CHAR_RE = /[A-Za-z0-9]/;

const URL_RE = /\b(https?:\/\/[^\s<>\]\)}"']+|www\.[^\s<>\]\)}"']+)/gi;

const MARKDOWN_LINK_RE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s<>)}"']+|www\.[^\s<>)}"']+)\)/gi;

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
 * Infer paragraph direction from the first strong character (Unicode bidi).
 * @param {string} text
 * @returns {'rtl' | 'ltr' | 'auto'}
 */
function paragraphDirection(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return 'auto';
  }
  for (const ch of trimmed) {
    if (RTL_CHAR_RE.test(ch)) {
      return 'rtl';
    }
    if (STRONG_LTR_CHAR_RE.test(ch)) {
      return 'ltr';
    }
  }
  return 'auto';
}

/**
 * @param {string} href
 * @param {string} label
 * @param {string} linkStyle
 * @returns {string}
 */
function renderEmailLink(href, label, linkStyle) {
  const normalizedHref = href.startsWith('www.') ? `https://${href}` : href;
  if (!/^https?:\/\//i.test(normalizedHref)) {
    return escapeHtml(label);
  }
  const safeHref = normalizedHref.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<a href="${safeHref}" dir="ltr" style="${linkStyle}">${escapeHtml(label)}</a>`;
}

/**
 * Autolink bare URLs in a text segment (no markdown links).
 * @param {string} text
 * @param {string} linkStyle
 * @returns {string}
 */
function linkifyBareUrls(text, linkStyle) {
  let result = '';
  let lastIndex = 0;
  URL_RE.lastIndex = 0;
  let match;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += escapeHtml(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    result += renderEmailLink(url, url, linkStyle);
    lastIndex = URL_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    result += escapeHtml(text.slice(lastIndex));
  }
  return result;
}

/**
 * Turn markdown links and bare URLs into clickable anchors (LTR-isolated in RTL text).
 * @param {string} text — raw paragraph text
 * @returns {string} HTML-safe inline content
 */
function linkifyPlainText(text) {
  const { accent } = AESOP_EMAIL;
  const linkStyle = `color:${accent};font-weight:600;text-decoration:underline;word-break:break-all;unicode-bidi:isolate;direction:ltr;`;
  let result = '';
  let lastIndex = 0;
  MARKDOWN_LINK_RE.lastIndex = 0;
  let match;
  while ((match = MARKDOWN_LINK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += linkifyBareUrls(text.slice(lastIndex, match.index), linkStyle);
    }
    result += renderEmailLink(match[2], match[1], linkStyle);
    lastIndex = MARKDOWN_LINK_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    result += linkifyBareUrls(text.slice(lastIndex), linkStyle);
  }
  return result.replace(/\n/g, '<br />');
}

/**
 * Convert plain-text email body to HTML paragraphs with RTL support and linkified URLs.
 * @param {string} text
 * @returns {string}
 */
function formatEmailBodyHtml(text) {
  const normalized = String(text || '');
  if (!normalized.trim()) {
    return `<p dir="auto" style="margin:0;">&nbsp;</p>`;
  }
  return normalized
    .split(/\n\n+/)
    .map((paragraph) => {
      const dir = paragraphDirection(paragraph);
      const inline = linkifyPlainText(paragraph);
      return `<p dir="${dir}" style="margin:0 0 16px;text-align:start;">${inline}</p>`;
    })
    .join('');
}

/**
 * Shared layout: paper background, white card, top accent bar.
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
            <td dir="auto" style="padding:28px 28px 32px;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${ink};text-align:start;">
              ${innerHtml}
            </td>
          </tr>
        </table>
        <p style="margin:20px 0 0;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${muted};max-width:560px;">
          Afghan Education Student Outreach Project (AESOP)<br />
          <a href="https://aesopafghanistan.org/" style="color:${accent};font-weight:600;text-decoration:none;">aesopafghanistan.org</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  AESOP_EMAIL,
  FONT_STACK,
  FONT_HEADING,
  escapeHtml,
  formatEmailBodyHtml,
  wrapAesopEmail,
};
