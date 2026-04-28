const express = require('express');
const path = require('path');
const { checkIdAndSendMagicLink } = require('./services/auth');
const { verifyMagicLink } = require('./services/magicLink');
const { findProfileByEmail, findProfileById, findLatestDingNumberById, appendDingChangeRow } = require('./services/googleSheets');
const { sanitizeEmail, isValidToken, sanitizeIdentifier, sanitizeDingNumberInput, sanitizePortalDisplayName } = require('./utils/validation');
const { createRateLimiter } = require('./middleware/rateLimiter');
const { securityHeaders } = require('./middleware/security');
const { formatDingChangeTimestamp } = require('./utils/dingSheetTime');
const { formatErrorForLog, formatGoogleSheetsWriteErrorForLog, isGoogleSheetsForbidden } = require('./utils/errorLogging');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for accurate IP addresses (important for Fly.io)
app.set('trust proxy', 1);

// Security headers
app.use(securityHeaders());

// Middleware
app.use(express.json({ limit: '10kb' })); // Limit JSON payload size
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AESOP Afghanistan API',
    timestamp: new Date().toISOString()
  });
});

// Rate limiter for magic link requests (5 requests per 15 minutes per IP)
const magicLinkRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

// Request magic link
app.post('/api/request-magic-link', magicLinkRateLimiter, async (req, res) => {
  try {
    let { userId } = req.body;
    
    // Validate ID exists
    if (!userId || typeof userId !== 'string') {
      console.warn('Invalid student ID request: missing or non-string ID', {
        ip: req.ip,
        route: req.originalUrl
      });
      return res.status(400).json({ error: 'ID is required' });
    }

    // Sanitize and validate ID format
    userId = sanitizeIdentifier(userId);
    if (!userId) {
      console.warn('Invalid student ID request: failed ID sanitization', {
        ip: req.ip,
        route: req.originalUrl
      });
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const result = await checkIdAndSendMagicLink(userId);
    if (!result?.userFound) {
      // Keep generic response for user enumeration prevention, but log internal signal.
      console.warn('Invalid student ID request: ID not found', {
        ip: req.ip,
        route: req.originalUrl,
        userId
      });
    }
    
    // Always return success to prevent user enumeration
    res.json({ 
      success: true, 
      message: 'If your submitted student ID is valid, a magic link has been sent to your registered email.' 
    });
  } catch (error) {
    // Log error but don't expose details to client
    console.error('Error requesting magic link:', formatErrorForLog(error));
    res.status(500).json({ error: 'An error occurred. Please try again later.' });
  }
});

// Rate limiter for token verification (10 attempts per 15 minutes per IP)
const verifyRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

// Verify magic link (changed to POST to prevent token exposure in URLs/logs)
app.post('/api/verify-magic-link', verifyRateLimiter, async (req, res) => {
  try {
    const { token } = req.body;
    
    // Validate token exists
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Validate token format to prevent injection
    if (!isValidToken(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    const result = await verifyMagicLink(token);
    
    if (result.valid) {
      const sanitizedEmail = sanitizeEmail(result.email);
      let profile = null;
      if (result.userId) {
        const idKey = sanitizeIdentifier(result.userId);
        if (idKey) {
          profile = await findProfileById(idKey);
        }
      }
      if (!profile) {
        profile = await findProfileByEmail(sanitizedEmail);
      }
      const emailFromSheet = profile?.email ? sanitizeEmail(profile.email) : sanitizedEmail;
      const studentName = profile?.name || '';
      const studentPhone = typeof profile?.phone === 'string' ? profile.phone.trim() : '';
      let studentUserId = '';
      if (profile?.id) {
        studentUserId = sanitizeIdentifier(profile.id) || '';
      }
      if (!studentUserId && result.userId) {
        studentUserId = sanitizeIdentifier(result.userId) || '';
      }

      let newDingNumber = '';
      if (studentUserId) {
        const ding = await findLatestDingNumberById(studentUserId);
        if (ding != null && String(ding).trim() !== '') {
          newDingNumber = String(ding).trim();
        }
      }

      res.json({
        success: true,
        email: emailFromSheet,
        name: studentName,
        phone: studentPhone,
        userId: studentUserId,
        newDingNumber,
        message: 'Magic link verified successfully',
      });
    } else {
      res.status(401).json({ error: 'Invalid or expired magic link' });
    }
  } catch (error) {
    // Log error but don't expose details to client
    console.error('Error verifying magic link:', formatErrorForLog(error));
    res.status(500).json({ error: 'An error occurred verifying the link.' });
  }
});

// Rate limiter for updating ding number from the portal
const dingUpdateRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

app.post('/api/update-ding-number', dingUpdateRateLimiter, async (req, res) => {
  try {
    let { userId, email, newDingNumber, displayName } = req.body;

    if (!userId || typeof userId !== 'string' || !email || typeof email !== 'string') {
      return res.status(400).json({ error: 'ID and email are required.' });
    }

    userId = sanitizeIdentifier(userId);
    const emailSan = sanitizeEmail(email);
    if (!userId || !emailSan) {
      return res.status(400).json({ error: 'Invalid ID or email.' });
    }

    const ding = sanitizeDingNumberInput(typeof newDingNumber === 'string' ? newDingNumber : '');
    if (!ding) {
      return res.status(400).json({ error: 'Please enter a new ding number.' });
    }

    const profile = await findProfileById(userId);
    if (!profile) {
      return res.status(403).json({ error: 'Unable to update. Please sign in again from the magic link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res.status(403).json({ error: 'Unable to update. Please sign in again from the magic link.' });
    }

    const nameForRow = sanitizePortalDisplayName(
      typeof displayName === 'string' && displayName.trim() !== '' ? displayName : profile.name
    ) || (profile.name || '');

    const when = new Date();
    const timestamp = formatDingChangeTimestamp(when);
    const dateForNote = timestamp.split(' ')[0] || when.toISOString().slice(0, 10);
    const portalNote = `Using student portal on ${dateForNote}`;

    const idForSheet = (profile.id && String(profile.id).trim()) || userId;

    await appendDingChangeRow({
      userId: idForSheet,
      timestamp,
      newDingNumber: ding,
      displayName: nameForRow,
      portalNote,
      phone: typeof profile.phone === 'string' ? profile.phone.trim() : '',
    });

    const latest = await findLatestDingNumberById(userId);
    const displayDing =
      latest != null && String(latest).trim() !== '' ? String(latest).trim() : ding;

    res.json({
      success: true,
      newDingNumber: displayDing,
    });
  } catch (error) {
    if (isGoogleSheetsForbidden(error)) {
      console.error('Ding update blocked by Google (403):', formatGoogleSheetsWriteErrorForLog(error));
      return res.status(503).json({
        error:
          'Could not write to the spreadsheet. An administrator must share the Google Sheet with the app’s service account as Editor (not Viewer) and ensure the Google Sheets API is enabled in Google Cloud.',
        code: 'SHEETS_WRITE_FORBIDDEN',
      });
    }
    console.error('Error updating ding number:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not save your ding number. Please try again later.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
