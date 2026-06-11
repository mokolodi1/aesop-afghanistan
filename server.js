const express = require('express');
const path = require('path');
const config = require('./config/secrets');
const { checkIdAndSendMagicLink } = require('./services/auth');
const { verifyMagicLink } = require('./services/magicLink');
const {
  findProfileByEmail,
  findProfileById,
  findLatestDingNumberById,
  appendDingChangeRow,
  syncPastDingNumbersToPeople,
  getPortalDingChangeHistory,
  getPortalClassGradeByStudentName,
  getPortalTeacherByUserId,
  getRoleByEmail,
  getClassGradeByEmail,
} = require('./services/googleSheets');
const { getTeacherRoster } = require('./services/classroomSync');
const {
  sanitizeEmail,
  isValidEmail,
  isValidToken,
  sanitizeIdentifier,
  sanitizeDingNumberInput,
  sanitizePortalDisplayName,
  normalizeAfghanistanPhoneDigits,
  isValidAfghanistanPhoneNumber,
  getAfghanistanPhoneFormatMessage,
  DING_CONFIRM_REQUIRED_MESSAGE,
  DING_CONFIRM_MISMATCH_MESSAGE,
  sanitizePortalDingHelpPhone,
  sanitizePortalDingHelpNote,
  PORTAL_DING_HELP_NEED_DETAIL_MESSAGE,
} = require('./utils/validation');
const { createRateLimiter } = require('./middleware/rateLimiter');
const { securityHeaders } = require('./middleware/security');
const { formatDingChangeTimestamp } = require('./utils/dingSheetTime');
const { sendDingNumberUpdatedEmail, sendPortalDingHelpRequestEmail } = require('./services/email');
const { formatErrorForLog, formatGoogleSheetsWriteErrorForLog, isGoogleSheetsForbidden } = require('./utils/errorLogging');

/** Value for Ding changes sheet column D when the student updates Ding via the portal (not their personal name). */
const PORTAL_DING_CHANGE_SOURCE_LABEL = 'Student portal';

function resolvePortalContactEmail() {
  const explicit = config.portalContactEmail && String(config.portalContactEmail).trim();
  if (explicit && isValidEmail(explicit)) {
    return sanitizeEmail(explicit);
  }
  const from = config.email?.from;
  if (from && isValidEmail(from)) {
    return sanitizeEmail(from);
  }
  return '';
}

/**
 * Resolve a signed-in user's role, class/section, and calculated grade.
 *
 * When the Google Classroom sync is enabled, the email-keyed Classroom Roles /
 * Classroom Grades tabs are the source of truth. Anything not found there falls
 * back to the legacy Teachers (by AESOP ID) and Import: Google Grades (by name)
 * tabs so existing data keeps working during the transition.
 *
 * @param {{ userId: string, email: string, name: string }} params
 * @returns {Promise<{ isTeacher: boolean, teacherClasses: string, classSection: string, calculatedGrade: string }>}
 */
async function resolvePortalRoleAndGrade({ userId, email, name }) {
  let isTeacher = false;
  let teacherClasses = '';
  let classSection = '';
  let calculatedGrade = '';

  const classroomEnabled = !!config.classroom?.enabled;
  const emailKey = email && isValidEmail(email) ? sanitizeEmail(email) : '';

  if (classroomEnabled && emailKey) {
    try {
      const role = await getRoleByEmail(emailKey);
      if (role.found) {
        isTeacher = role.isTeacher;
        teacherClasses = role.teacherClasses;
      }
      const grade = await getClassGradeByEmail(emailKey);
      if (grade.found) {
        classSection = grade.classSection;
        calculatedGrade = grade.calculatedGrade;
      }
    } catch (error) {
      console.warn('Classroom role/grade lookup failed; using legacy tabs:', formatErrorForLog(error));
    }
  }

  // Fallback to the legacy ID/name-based tabs for anything still missing.
  if (!isTeacher && userId) {
    const t = await getPortalTeacherByUserId(userId);
    if (t.isTeacher) {
      isTeacher = true;
      teacherClasses = t.teacherClasses;
    }
  }
  if (!classSection && !calculatedGrade && name && name.trim()) {
    const cg = await getPortalClassGradeByStudentName(name);
    classSection = cg.classSection;
    calculatedGrade = cg.calculatedGrade;
  }

  return { isTeacher, teacherClasses, classSection, calculatedGrade };
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for accurate IP addresses (important for Fly.io)
app.set('trust proxy', 1);

// Security headers
app.use(securityHeaders());

// Middleware
app.use(express.json({ limit: '10kb' })); // Limit JSON payload size
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

/** Hostname the client asked for (Fly and many CDNs set X-Forwarded-Host). */
function getInboundHostname(req) {
  const forwarded = (req.get('x-forwarded-host') || '').split(',')[0].trim();
  const raw = forwarded || req.get('host') || '';
  return raw.split(':')[0].toLowerCase();
}

/**
 * Portal SPA: portal.* (or PORTAL_EXTRA_HOSTS) serves portal.html for /. /profile and /faq always
 * serve portal.html so deep links and nav work on any host (including plain localhost).
 */
function isPortalRequestHost(req) {
  const host = getInboundHostname(req);
  const extras = process.env.PORTAL_EXTRA_HOSTS;
  if (extras && typeof extras === 'string') {
    const allowed = extras
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.includes(host)) {
      return true;
    }
  }
  return host.startsWith('portal.');
}

app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }
  if (req.path === '/profile' || req.path === '/faq') {
    return res.sendFile(path.join(__dirname, 'public', 'portal.html'));
  }
  if (isPortalRequestHost(req) && req.path === '/') {
    return res.sendFile(path.join(__dirname, 'public', 'portal.html'));
  }
  next();
});

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
      console.warn('Invalid student ID request: ID not found', {
        ip: req.ip,
        route: req.originalUrl,
        userId
      });
      return res.json({
        success: false,
        message: 'Your ID is invalid. Please enter a correct ID.'
      });
    }

    res.json({
      success: true,
      message: 'Your ID is valid. A magic link has been sent to your registered email.'
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

      const { isTeacher, teacherClasses, classSection, calculatedGrade } =
        await resolvePortalRoleAndGrade({
          userId: studentUserId,
          email: emailFromSheet,
          name: studentName,
        });

      res.json({
        success: true,
        email: emailFromSheet,
        name: studentName,
        phone: studentPhone,
        userId: studentUserId,
        newDingNumber,
        classSection,
        calculatedGrade,
        isTeacher,
        teacherClasses,
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

const portalDingHelpRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });

const portalDingHistoryRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 40 });

const portalClassGradeRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 40 });

const portalTeacherRosterRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

app.post('/api/update-ding-number', dingUpdateRateLimiter, async (req, res) => {
  try {
    let { userId, email, newDingNumber, confirmNewDingNumber, displayName } = req.body;

    if (!userId || typeof userId !== 'string' || !email || typeof email !== 'string') {
      return res.status(400).json({ error: 'ID and email are required.' });
    }

    userId = sanitizeIdentifier(userId);
    const emailSan = sanitizeEmail(email);
    if (!userId || !emailSan) {
      return res.status(400).json({ error: 'Invalid ID or email.' });
    }

    const dingRaw = sanitizeDingNumberInput(typeof newDingNumber === 'string' ? newDingNumber : '');
    const confirmRaw = sanitizeDingNumberInput(typeof confirmNewDingNumber === 'string' ? confirmNewDingNumber : '');
    if (!dingRaw) {
      return res.status(400).json({ error: 'Please enter a new ding number.' });
    }
    if (!confirmRaw) {
      return res.status(400).json({ error: DING_CONFIRM_REQUIRED_MESSAGE });
    }
    if (!isValidAfghanistanPhoneNumber(dingRaw)) {
      return res.status(400).json({ error: getAfghanistanPhoneFormatMessage(dingRaw) });
    }
    if (!isValidAfghanistanPhoneNumber(confirmRaw)) {
      return res.status(400).json({ error: getAfghanistanPhoneFormatMessage(confirmRaw) });
    }
    const ding = normalizeAfghanistanPhoneDigits(dingRaw);
    const confirmDing = normalizeAfghanistanPhoneDigits(confirmRaw);
    if (ding !== confirmDing) {
      return res.status(400).json({ error: DING_CONFIRM_MISMATCH_MESSAGE });
    }

    const profile = await findProfileById(userId);
    if (!profile) {
      return res.status(403).json({ error: 'Unable to update. Please sign in again from the magic link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res.status(403).json({ error: 'Unable to update. Please sign in again from the magic link.' });
    }

    const greetingName =
      sanitizePortalDisplayName(
        typeof displayName === 'string' && displayName.trim() !== '' ? displayName : profile.name,
      ) ||
      profile.name ||
      '';

    const when = new Date();
    const timestamp = formatDingChangeTimestamp(when);
    const dateForNote = timestamp.split(' ')[0] || when.toISOString().slice(0, 10);
    const portalNote = `Using student portal on ${dateForNote}`;

    const idForSheet = (profile.id && String(profile.id).trim()) || userId;

    await appendDingChangeRow({
      userId: idForSheet,
      timestampAt: when,
      newDingNumber: ding,
      displayName: PORTAL_DING_CHANGE_SOURCE_LABEL,
      portalNote,
      phone: typeof profile.phone === 'string' ? profile.phone.trim() : '',
    });

    try {
      await syncPastDingNumbersToPeople(idForSheet);
    } catch (syncErr) {
      console.warn(
        'Ding change logged but People “past Ding” column was not updated:',
        formatErrorForLog(syncErr),
      );
    }

    const latest = await findLatestDingNumberById(userId);
    const displayDing =
      latest != null && String(latest).trim() !== '' ? String(latest).trim() : ding;

    try {
      await sendDingNumberUpdatedEmail({
        to: emailSan,
        displayName: greetingName || 'Student',
        newDingNumber: displayDing,
      });
    } catch (emailErr) {
      console.warn('Ding number saved but notification email failed:', formatErrorForLog(emailErr));
    }

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

app.post('/api/portal-request-ding-help', portalDingHelpRateLimiter, async (req, res) => {
  try {
    let { userId, email, displayName, requestedPhone, note } = req.body;

    if (!userId || typeof userId !== 'string' || !email || typeof email !== 'string') {
      return res.status(400).json({ error: 'ID and email are required.' });
    }

    userId = sanitizeIdentifier(userId);
    const emailSan = sanitizeEmail(email);
    if (!userId || !emailSan) {
      return res.status(400).json({ error: 'Invalid ID or email.' });
    }

    const phoneSan = sanitizePortalDingHelpPhone(typeof requestedPhone === 'string' ? requestedPhone : '');
    const noteSan = sanitizePortalDingHelpNote(typeof note === 'string' ? note : '');

    if (!phoneSan && !noteSan) {
      return res.status(400).json({ error: PORTAL_DING_HELP_NEED_DETAIL_MESSAGE });
    }

    const profile = await findProfileById(userId);
    if (!profile) {
      return res.status(403).json({ error: 'Unable to send request. Please sign in again from the magic link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res.status(403).json({ error: 'Unable to send request. Please sign in again from the magic link.' });
    }

    const adminTo = resolvePortalContactEmail();
    if (!adminTo) {
      console.error('Portal Ding help: no valid portalContactEmail or email.from in configuration.');
      return res.status(503).json({
        error: 'Contact requests are not configured yet. Please email the organization through aesopafghanistan.org.',
      });
    }

    const studentLabel =
      sanitizePortalDisplayName(typeof displayName === 'string' ? displayName : '') ||
      sanitizePortalDisplayName(profile.name) ||
      profile.name ||
      '';

    const latestDing = await findLatestDingNumberById(userId);
    const dingDisplay =
      latestDing != null && String(latestDing).trim() !== '' ? String(latestDing).trim() : '';

    await sendPortalDingHelpRequestEmail({
      to: adminTo,
      studentDisplayName: studentLabel,
      studentUserId: userId,
      studentEmail: emailSan,
      phoneOnFile: typeof profile.phone === 'string' ? profile.phone.trim() : '',
      currentDingDisplay: dingDisplay,
      requestedPhone: phoneSan,
      note: noteSan,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error sending portal Ding help request:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not send your request. Please try again later.' });
  }
});

app.post('/api/portal-ding-history', portalDingHistoryRateLimiter, async (req, res) => {
  try {
    let { userId, email } = req.body;

    if (!userId || typeof userId !== 'string' || !email || typeof email !== 'string') {
      return res.status(400).json({ error: 'ID and email are required.' });
    }

    userId = sanitizeIdentifier(userId);
    const emailSan = sanitizeEmail(email);
    if (!userId || !emailSan) {
      return res.status(400).json({ error: 'Invalid ID or email.' });
    }

    const profile = await findProfileById(userId);
    if (!profile) {
      return res.status(403).json({ error: 'Unable to load history. Please sign in again from the magic link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res.status(403).json({ error: 'Unable to load history. Please sign in again from the magic link.' });
    }

    const entries = await getPortalDingChangeHistory(userId);
    res.json({ success: true, entries });
  } catch (error) {
    console.error('Error loading portal Ding history:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load Ding history. Please try again later.' });
  }
});

app.post('/api/portal-class-grade', portalClassGradeRateLimiter, async (req, res) => {
  try {
    let { userId, email } = req.body;

    if (!userId || typeof userId !== 'string' || !email || typeof email !== 'string') {
      return res.status(400).json({ error: 'ID and email are required.' });
    }

    userId = sanitizeIdentifier(userId);
    const emailSan = sanitizeEmail(email);
    if (!userId || !emailSan) {
      return res.status(400).json({ error: 'Invalid ID or email.' });
    }

    const profile = await findProfileById(userId);
    if (!profile) {
      return res
        .status(403)
        .json({ error: 'Unable to load class. Please sign in again from the magic link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res
        .status(403)
        .json({ error: 'Unable to load class. Please sign in again from the magic link.' });
    }

    const studentName = typeof profile.name === 'string' ? profile.name : '';
    const profileEmail = profile?.email ? sanitizeEmail(profile.email) : emailSan;
    const { isTeacher, teacherClasses, classSection, calculatedGrade } =
      await resolvePortalRoleAndGrade({
        userId,
        email: profileEmail,
        name: studentName,
      });

    res.json({
      success: true,
      classSection,
      calculatedGrade,
      isTeacher,
      teacherClasses,
    });
  } catch (error) {
    console.error('Error loading portal class/grade:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load class or grade. Please try again later.' });
  }
});

app.post('/api/portal-teacher-roster', portalTeacherRosterRateLimiter, async (req, res) => {
  try {
    let { userId, email } = req.body;

    if (!userId || typeof userId !== 'string' || !email || typeof email !== 'string') {
      return res.status(400).json({ error: 'ID and email are required.' });
    }

    userId = sanitizeIdentifier(userId);
    const emailSan = sanitizeEmail(email);
    if (!userId || !emailSan) {
      return res.status(400).json({ error: 'Invalid ID or email.' });
    }

    const profile = await findProfileById(userId);
    if (!profile) {
      return res
        .status(403)
        .json({ error: 'Unable to load roster. Please sign in again from the magic link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res
        .status(403)
        .json({ error: 'Unable to load roster. Please sign in again from the magic link.' });
    }

    if (!config.classroom?.enabled) {
      return res.status(503).json({ error: 'Classroom data is not enabled.' });
    }

    const profileEmail = profile?.email ? sanitizeEmail(profile.email) : emailSan;

    // Only confirmed teachers may pull a roster of other students' grades.
    const role = await getRoleByEmail(profileEmail);
    if (!role.found || !role.isTeacher) {
      return res.status(403).json({ error: 'Only teachers can view class rosters.' });
    }

    const { classes } = await getTeacherRoster(profileEmail);

    res.json({ success: true, classes });
  } catch (error) {
    console.error('Error loading teacher roster:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load your class roster. Please try again later.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
