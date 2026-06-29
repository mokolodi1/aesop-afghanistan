const express = require('express');
const path = require('path');
const config = require('./config/secrets');
const { checkIdAndSendMagicLink } = require('./services/auth');
const { verifyMagicLink, resendMagicLinkByToken } = require('./services/magicLink');
const {
  findProfileByEmail,
  findProfileById,
  findLatestDingNumberById,
  recordPeopleLastLogin,
  appendDingChangeRow,
  syncPastDingNumbersToPeople,
  getPortalDingChangeHistory,
  getPortalClassGradeByStudentName,
  getPortalTeacherByUserId,
  getRoleByEmail,
  getClassGradeByEmail,
  resolvePeopleStatus,
  isAppliedPeopleStatus,
} = require('./services/googleSheets');
const { getTeacherRoster, getStudentGrades } = require('./services/classroomSync');
const { isDatabaseEnabled, checkDatabaseHealth } = require('./db/index');
const { getRoleByEmailFromDb, getGradesByEmailFromDb, getPersonByAesopId } = require('./services/classroomDb');
const {
  isPortalAdmin,
  getAdminDashboard,
  getHighGradeStudents,
  buildDingConnectTopUpCsv,
  lookupStudentForAdmin,
  searchAdminStudents,
  getAdminClassList,
  getAdminClassRoster,
  getAdminAllClassesRoster,
  getAdminViewAsStudent,
  getAdminViewAsTeacher,
} = require('./services/adminPortal');
const {
  getEmailGroups,
  getAdmissionsMetadata,
  previewEmailRecipients,
  sendAdminEmailTest,
  startAdminEmailCampaign,
  getAdminEmailCampaignStatus,
  startEmailCampaignWorker,
} = require('./services/adminEmail');
const {
  verifyPostmarkWebhookAuth,
  handlePostmarkWebhook,
} = require('./services/postmarkWebhooks');
const { syncVoiceMemoRound2Status, getApplicantRowByAesopId } = require('./services/voiceMemoSync');
const {
  getPortalVoiceMemoStatus,
  getPortalVoiceMemoStream,
} = require('./services/portalVoiceMemo');
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
 * When the Google Classroom sync is enabled and Postgres is configured, Classroom
 * roles and grades come from the database (daily sync). People profile, Ding data,
 * and legacy tabs remain on Google Sheets.
 *
 * @param {{ userId: string, email: string, name: string, peopleStatus?: string }} params
 * @returns {Promise<{ isTeacher: boolean, teacherClasses: string, classSection: string, calculatedGrade: string, classGrades: Array<{ classSection: string, calculatedGrade: string }>, isApplied: boolean, isApplicant: boolean, peopleStatus: string }>}
 */
async function resolvePortalRoleAndGrade({ userId, email, name, peopleStatus = '' }) {
  const resolvedStatus = resolvePeopleStatus(userId, peopleStatus);

  try {
    const applicant = await getApplicantRowByAesopId(userId);
    if (applicant) {
      return {
        isTeacher: false,
        teacherClasses: '',
        classSection: '',
        calculatedGrade: '',
        classGrades: [],
        isApplied: true,
        isApplicant: true,
        peopleStatus: resolvedStatus || 'Applied',
      };
    }
  } catch (error) {
    console.warn('Applicants sheet lookup failed:', formatErrorForLog(error));
  }

  if (isAppliedPeopleStatus(resolvedStatus)) {
    return {
      isTeacher: false,
      teacherClasses: '',
      classSection: '',
      calculatedGrade: '',
      classGrades: [],
      isApplied: true,
      isApplicant: false,
      peopleStatus: resolvedStatus,
    };
  }

  let isTeacher = false;
  let teacherClasses = '';
  let classSection = '';
  let calculatedGrade = '';
  let classGrades = [];

  const classroomEnabled = !!config.classroom?.enabled;
  const emailKey = email && isValidEmail(email) ? sanitizeEmail(email) : '';

  if (classroomEnabled && emailKey) {
    try {
      if (isDatabaseEnabled()) {
        const role = await getRoleByEmailFromDb(emailKey);
        if (role.found) {
          isTeacher = role.isTeacher;
          teacherClasses = role.teacherClasses;
        }
        const grades = await getGradesByEmailFromDb(emailKey);
        if (grades.length > 0) {
          classGrades = grades.map((row) => ({
            classSection: row.classSection,
            calculatedGrade: row.calculatedGrade,
          }));
          classSection = classGrades.map((row) => row.classSection).filter(Boolean).join(', ');
          calculatedGrade = classGrades.length === 1 ? classGrades[0].calculatedGrade : '';
        }
      } else {
        const role = await getRoleByEmail(emailKey);
        if (role.found) {
          isTeacher = role.isTeacher;
          teacherClasses = role.teacherClasses;
        }
        const grade = await getClassGradeByEmail(emailKey);
        if (grade.found) {
          classSection = grade.classSection;
          calculatedGrade = grade.calculatedGrade;
          classGrades = Array.isArray(grade.classGrades) ? grade.classGrades : [];
        }
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

  return {
    isTeacher,
    teacherClasses,
    classSection,
    calculatedGrade,
    classGrades,
    isApplied: false,
    isApplicant: false,
    peopleStatus: resolvedStatus,
  };
}

/**
 * Verify portal session body (userId + email) against the People sheet.
 * @returns {Promise<{ id: string, name: string, email: string, phone: string, portalRole: string }|null>}
 */
async function verifyPortalSessionBody(userId, email) {
  const idKey = sanitizeIdentifier(userId);
  const emailSan = sanitizeEmail(email);
  if (!idKey || !emailSan) {
    return null;
  }
  const profile = await findProfileById(idKey);
  if (!profile || sanitizeEmail(profile.email) !== emailSan) {
    return null;
  }
  return profile;
}

/**
 * @param {import('express').Response} res
 * @param {{ userId: string, email: string }} body
 * @returns {Promise<{ id: string, name: string, email: string, phone: string, portalRole: string }|null>}
 */
async function requirePortalAdmin(res, body) {
  const profile = await verifyPortalSessionBody(body.userId, body.email);
  if (!profile) {
    res.status(403).json({ error: 'Unable to continue. Please sign in again from the magic link.' });
    return null;
  }
  if (!isPortalAdmin(profile)) {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return profile;
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
  if (req.path === '/profile' || req.path === '/faq' || req.path === '/admin' || req.path === '/admin/emails') {
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
const magicLinkRateLimiter = createRateLimiter({ name: 'magic-link', windowMs: 15 * 60 * 1000, max: 5 });

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

// Resend magic link for an expired or used token (same rate limit as new requests)
app.post('/api/resend-magic-link', magicLinkRateLimiter, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }

    if (!isValidToken(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    const result = await resendMagicLinkByToken(token);
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Unable to resend magic link.' });
    }

    res.json({ success: true, message: result.message });
  } catch (error) {
    console.error('Error resending magic link:', formatErrorForLog(error));
    res.status(500).json({ error: 'An error occurred sending the link.' });
  }
});

// Rate limiter for token verification (10 attempts per 15 minutes per IP)
const verifyRateLimiter = createRateLimiter({ name: 'verify-magic-link', windowMs: 15 * 60 * 1000, max: 10 });

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
      try {
        if (result.userId) {
          const idKey = sanitizeIdentifier(result.userId);
          if (idKey) {
            profile = await findProfileById(idKey);
          }
        }
        if (!profile) {
          profile = await findProfileByEmail(sanitizedEmail);
        }
      } catch (profileError) {
        console.warn('Profile sheet lookup failed during verify; using token/DB fallback:', formatErrorForLog(profileError));
      }
      if (!profile && result.userId && isDatabaseEnabled()) {
        try {
          const fromDb = await getPersonByAesopId(result.userId);
          if (fromDb) {
            profile = {
              id: fromDb.aesopId || result.userId,
              name: fromDb.name || '',
              email: fromDb.email || sanitizedEmail,
              phone: fromDb.phone || '',
              portalRole: fromDb.portalRole || '',
              peopleStatus:
                String(fromDb.portalRole || '').trim().toLowerCase() === 'applied'
                  ? 'applied'
                  : resolvePeopleStatus(fromDb.aesopId || result.userId, ''),
            };
          }
        } catch (dbError) {
          console.warn('Profile DB lookup failed during verify:', formatErrorForLog(dbError));
        }
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

      const {
        isTeacher,
        teacherClasses,
        classSection,
        calculatedGrade,
        classGrades,
        isApplied,
        isApplicant,
        peopleStatus,
      } = await resolvePortalRoleAndGrade({
        userId: studentUserId,
        email: emailFromSheet,
        name: studentName,
        peopleStatus: profile?.peopleStatus,
      });
      const isAdmin = isPortalAdmin({ email: emailFromSheet, portalRole: profile?.portalRole });

      if (studentUserId) {
        recordPeopleLastLogin(studentUserId).catch((loginErr) => {
          console.warn('Last login sheet update failed:', formatErrorForLog(loginErr));
        });
      }

      res.json({
        success: true,
        email: emailFromSheet,
        name: studentName,
        phone: studentPhone,
        userId: studentUserId,
        newDingNumber,
        classSection,
        calculatedGrade,
        classGrades,
        isTeacher,
        teacherClasses,
        isAdmin,
        isApplied,
        isApplicant,
        peopleStatus,
        message: 'Magic link verified successfully',
      });
    } else {
      res.status(401).json({
        error: 'Invalid or expired magic link.',
        canResend: result.canResend === true,
      });
    }
  } catch (error) {
    // Log error but don't expose details to client
    console.error('Error verifying magic link:', formatErrorForLog(error));
    res.status(500).json({ error: 'An error occurred verifying the link.' });
  }
});

// Rate limiter for updating ding number from the portal
const dingUpdateRateLimiter = createRateLimiter({ name: 'update-ding', windowMs: 15 * 60 * 1000, max: 20 });

const portalDingHelpRateLimiter = createRateLimiter({ name: 'portal-ding-help', windowMs: 15 * 60 * 1000, max: 8 });

const portalDingHistoryRateLimiter = createRateLimiter({ name: 'portal-ding-history', windowMs: 15 * 60 * 1000, max: 40 });

const portalClassGradeRateLimiter = createRateLimiter({ name: 'portal-class-grade', windowMs: 15 * 60 * 1000, max: 40 });

const portalTeacherRosterRateLimiter = createRateLimiter({ name: 'portal-teacher-roster', windowMs: 15 * 60 * 1000, max: 20 });

const portalStudentGradesRateLimiter = createRateLimiter({ name: 'portal-student-grades', windowMs: 15 * 60 * 1000, max: 20 });

const portalAdminRateLimiter = createRateLimiter({ name: 'portal-admin', windowMs: 15 * 60 * 1000, max: 200 });
const portalVoiceMemoRateLimiter = createRateLimiter({ name: 'portal-voice-memo', windowMs: 15 * 60 * 1000, max: 40 });
const portalVoiceMemoStreamRateLimiter = createRateLimiter({
  name: 'portal-voice-memo-stream',
  windowMs: 15 * 60 * 1000,
  max: 120,
});

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

    const displayDing = ding;

    res.json({
      success: true,
      newDingNumber: displayDing,
    });

    sendDingNumberUpdatedEmail({
      to: emailSan,
      displayName: greetingName || 'Student',
      newDingNumber: displayDing,
    }).catch((emailErr) => {
      console.warn('Ding number saved but notification email failed:', formatErrorForLog(emailErr));
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
    const {
      isTeacher,
      teacherClasses,
      classSection,
      calculatedGrade,
      classGrades,
      isApplied,
      isApplicant,
      peopleStatus,
    } = await resolvePortalRoleAndGrade({
      userId,
      email: profileEmail,
      name: studentName,
      peopleStatus: profile?.peopleStatus,
    });
    const isAdmin = isPortalAdmin({ email: profileEmail, portalRole: profile?.portalRole });

    res.json({
      success: true,
      classSection,
      calculatedGrade,
      classGrades,
      isTeacher,
      teacherClasses,
      isAdmin,
      isApplied,
      isApplicant,
      peopleStatus,
    });
  } catch (error) {
    console.error('Error loading portal class/grade:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load class or grade. Please try again later.' });
  }
});

app.post('/api/portal-student-grades', portalStudentGradesRateLimiter, async (req, res) => {
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
        .json({ error: 'Unable to load grades. Please sign in again from the magic link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res
        .status(403)
        .json({ error: 'Unable to load grades. Please sign in again from the magic link.' });
    }

    if (!config.classroom?.enabled) {
      return res.status(503).json({ error: 'Classroom data is not enabled.' });
    }

    const profileEmail = profile?.email ? sanitizeEmail(profile.email) : emailSan;
    const { classes } = await getStudentGrades(profileEmail);

    res.json({ success: true, classes });
  } catch (error) {
    console.error('Error loading student grades:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load your grades. Please try again later.' });
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

    // Teachers and admins may pull class rosters.
    const role = isDatabaseEnabled()
      ? await getRoleByEmailFromDb(profileEmail)
      : await getRoleByEmail(profileEmail);
    if (!isPortalAdmin({ email: profileEmail, portalRole: profile?.portalRole }) && (!role.found || !role.isTeacher)) {
      return res.status(403).json({ error: 'Only teachers can view class rosters.' });
    }

    const { classes } = await getTeacherRoster(profileEmail);

    res.json({ success: true, classes });
  } catch (error) {
    console.error('Error loading teacher roster:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load your class roster. Please try again later.' });
  }
});

app.post('/api/portal-admin/dashboard', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const dashboard = await getAdminDashboard();
    res.json({ success: true, dashboard });
  } catch (error) {
    console.error('Error loading admin dashboard:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load admin dashboard.' });
  }
});

app.post('/api/portal-admin/lookup', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const query = typeof req.body.query === 'string' ? req.body.query.trim() : '';
    if (query.length < 2) {
      return res.status(400).json({ error: 'Enter at least 2 characters to search.' });
    }
    const result = await lookupStudentForAdmin(query);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error in admin student lookup:', formatErrorForLog(error));
    res.status(500).json({
      success: false,
      error: error.message || 'Could not complete lookup.',
    });
  }
});

app.post('/api/portal-admin/search-students', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const query = typeof req.body.query === 'string' ? req.body.query.trim() : '';
    if (query.length < 2) {
      return res.status(400).json({ success: false, error: 'Enter at least 2 characters to search.' });
    }
    const data = await searchAdminStudents(query);
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error in admin student search:', formatErrorForLog(error));
    res.status(500).json({
      success: false,
      error: error.message || 'Could not search students.',
    });
  }
});

app.post('/api/portal-admin/high-grades', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const thresholdRaw = req.body.threshold;
    const threshold =
      thresholdRaw != null && String(thresholdRaw).trim() !== ''
        ? Number.parseFloat(String(thresholdRaw))
        : undefined;
    const data = await getHighGradeStudents(threshold);
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error loading high-grade students:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load high-grade students.' });
  }
});

app.post('/api/portal-admin/all-classes', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    if (!config.classroom?.enabled) {
      return res.status(503).json({ success: false, error: 'Classroom data is not enabled.' });
    }
    const data = await getAdminClassList();
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error loading admin class list:', formatErrorForLog(error));
    res.status(500).json({ success: false, error: 'Could not load classes from Google Classroom.' });
  }
});

app.post('/api/portal-admin/class-roster', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    if (!config.classroom?.enabled) {
      return res.status(503).json({ success: false, error: 'Classroom data is not enabled.' });
    }
    const courseId = typeof req.body.courseId === 'string' ? req.body.courseId.trim() : '';
    if (!courseId) {
      return res.status(400).json({ success: false, error: 'courseId is required.' });
    }
    const live = req.body.live === true;
    const roster = await getAdminClassRoster(courseId, { live });
    res.json({ success: true, ...roster });
  } catch (error) {
    console.error('Error loading admin class roster:', formatErrorForLog(error));
    const message =
      error && error.message && String(error.message).includes('not found')
        ? 'That class could not be loaded.'
        : 'Could not load this class from Google Classroom.';
    res.status(500).json({ success: false, error: message });
  }
});

app.post('/api/portal-admin/view/student', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const targetUserId = sanitizeIdentifier(req.body.targetUserId);
    if (!targetUserId) {
      return res.status(400).json({ success: false, error: 'targetUserId is required.' });
    }
    const data = await getAdminViewAsStudent(targetUserId, { live: req.body.live === true });
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error in admin view-as student:', formatErrorForLog(error));
    res.status(500).json({ success: false, error: error.message || 'Could not load student view.' });
  }
});

app.post('/api/portal-admin/view/teacher', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const targetUserId = sanitizeIdentifier(req.body.targetUserId);
    if (!targetUserId) {
      return res.status(400).json({ success: false, error: 'targetUserId is required.' });
    }
    const data = await getAdminViewAsTeacher(targetUserId, { live: req.body.live === true });
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error in admin view-as teacher:', formatErrorForLog(error));
    res.status(500).json({ success: false, error: error.message || 'Could not load teacher view.' });
  }
});

app.post('/api/portal-admin/impersonate', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const targetUserId = sanitizeIdentifier(req.body.targetUserId);
    if (!targetUserId) {
      return res.status(400).json({ success: false, error: 'targetUserId is required.' });
    }
    const viewRole = req.body.viewRole === 'teacher' ? 'teacher' : 'student';
    const targetProfile = await findProfileById(targetUserId);
    if (!targetProfile) {
      return res.status(404).json({ success: false, error: 'Person not found for that AESOP ID.' });
    }
    const emailFromSheet = sanitizeEmail(targetProfile.email);
    if (!emailFromSheet) {
      return res.status(404).json({ success: false, error: 'Person not found for that AESOP ID.' });
    }
    const studentName = typeof targetProfile.name === 'string' ? targetProfile.name : '';
    const studentPhone = typeof targetProfile.phone === 'string' ? targetProfile.phone.trim() : '';
    let newDingNumber = '';
    const ding = await findLatestDingNumberById(targetUserId);
    if (ding != null && String(ding).trim() !== '') {
      newDingNumber = String(ding).trim();
    }
    const {
      isTeacher,
      teacherClasses,
      classSection,
      calculatedGrade,
      classGrades,
      isApplied,
      isApplicant,
      peopleStatus,
    } = await resolvePortalRoleAndGrade({
      userId: targetUserId,
      email: emailFromSheet,
      name: studentName,
      peopleStatus: targetProfile.peopleStatus,
    });
    const effectiveIsTeacher = !isApplied && viewRole === 'teacher';
    res.json({
      success: true,
      email: emailFromSheet,
      name: studentName,
      phone: studentPhone,
      userId: targetUserId,
      newDingNumber,
      classSection: isApplied ? '' : classSection,
      calculatedGrade: isApplied ? '' : calculatedGrade,
      classGrades: isApplied ? [] : classGrades,
      isTeacher: effectiveIsTeacher,
      teacherClasses: effectiveIsTeacher ? teacherClasses : '',
      isAdmin: false,
      isApplied,
      isApplicant,
      peopleStatus,
      viewRole,
      actualIsTeacher: isTeacher,
    });
  } catch (error) {
    console.error('Error in admin impersonate:', formatErrorForLog(error));
    res.status(500).json({ success: false, error: error.message || 'Could not start impersonation.' });
  }
});

app.get('/api/health', async (_req, res) => {
  const db = await checkDatabaseHealth();
  res.json({
    ok: true,
    database: db,
    classroomEnabled: !!config.classroom?.enabled,
  });
});

app.post('/api/portal-admin/dingconnect-export', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const thresholdRaw = req.body.threshold;
    const threshold =
      thresholdRaw != null && String(thresholdRaw).trim() !== ''
        ? Number.parseFloat(String(thresholdRaw))
        : undefined;
    const data = await buildDingConnectTopUpCsv(threshold);
    const asDownload = req.body.download === true || req.query.download === '1';
    if (asDownload) {
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dingconnect-topup-${stamp}.csv"`);
      return res.send(data.csv);
    }
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error building DingConnect export:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not build DingConnect export.' });
  }
});

app.post('/api/portal-admin/email/groups', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    res.json({ success: true, groups: getEmailGroups() });
  } catch (error) {
    console.error('Error loading email groups:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load email groups.' });
  }
});

app.post('/api/portal-admin/email/admissions-metadata', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const metadata = await getAdmissionsMetadata();
    res.json({ success: true, metadata });
  } catch (error) {
    console.error('Error loading admissions metadata:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load Admissions sheet metadata.' });
  }
});

app.post('/api/portal-admin/email/preview', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const group = typeof req.body.group === 'string' ? req.body.group.trim() : 'admissions';
    const preview = await previewEmailRecipients({ group, filter: req.body.filter });
    res.json({ success: true, ...preview });
  } catch (error) {
    console.error('Error previewing email recipients:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not preview recipients.' });
  }
});

app.post('/api/portal-admin/email/test', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const result = await sendAdminEmailTest(profile.email, {
      group: req.body.group,
      subject: req.body.subject,
      body: req.body.body,
      globalVars: req.body.globalVars,
      filter: req.body.filter,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error sending admin test email:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not send test email.' });
  }
});

app.post('/api/portal-admin/email/send', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const result = await startAdminEmailCampaign(profile.email, {
      group: req.body.group,
      subject: req.body.subject,
      body: req.body.body,
      globalVars: req.body.globalVars,
      filter: req.body.filter,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error starting admin email campaign:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not start email campaign.' });
  }
});

app.post('/api/portal-admin/email/campaign-status', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const campaignId = Number.parseInt(String(req.body.campaignId ?? ''), 10);
    if (!Number.isFinite(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: 'A valid campaignId is required.' });
    }
    const status = await getAdminEmailCampaignStatus(campaignId);
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error loading email campaign status:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not load campaign status.' });
  }
});

app.post('/api/portal-voice-memo/status', portalVoiceMemoRateLimiter, async (req, res) => {
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

    const status = await getPortalVoiceMemoStatus({ userId, email: emailSan });
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('Error loading portal voice memo status:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not load voice memo status.' });
  }
});

async function pipePortalVoiceMemoStream(req, res, userId, emailSan) {
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
  const { stream, mimeType, fileName, size, status, contentRange, contentLength } =
    await getPortalVoiceMemoStream({
      userId,
      email: emailSan,
      rangeHeader,
    });

  res.status(status === 206 ? 206 : 200);
  res.setHeader('Content-Type', mimeType || 'audio/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `inline; filename="${String(fileName || 'voice-memo.m4a').replace(/"/g, '')}"`);
  if (contentRange) {
    res.setHeader('Content-Range', contentRange);
  }
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  } else if (size != null) {
    res.setHeader('Content-Length', String(size));
  }

  stream.on('error', (streamError) => {
    console.error('Error streaming portal voice memo:', formatErrorForLog(streamError));
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not stream voice memo.' });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

app.get('/api/portal-voice-memo/stream', portalVoiceMemoStreamRateLimiter, async (req, res) => {
  try {
    let userId = typeof req.query.userId === 'string' ? req.query.userId : '';
    let email = typeof req.query.email === 'string' ? req.query.email : '';

    userId = sanitizeIdentifier(userId);
    const emailSan = sanitizeEmail(email);
    if (!userId || !emailSan) {
      return res.status(400).json({ error: 'Invalid ID or email.' });
    }

    await pipePortalVoiceMemoStream(req, res, userId, emailSan);
  } catch (error) {
    console.error('Error streaming portal voice memo:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not stream voice memo.' });
  }
});

app.post('/api/portal-voice-memo/stream', portalVoiceMemoStreamRateLimiter, async (req, res) => {
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

    await pipePortalVoiceMemoStream(req, res, userId, emailSan);
  } catch (error) {
    console.error('Error streaming portal voice memo:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not stream voice memo.' });
  }
});

app.post('/api/portal-admin/voice-memo/sync', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const result = await syncVoiceMemoRound2Status();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error syncing voice memos:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not sync voice memos.' });
  }
});

app.post('/api/postmark/webhook', async (req, res) => {
  if (!verifyPostmarkWebhookAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized webhook request.' });
  }
  try {
    const result = await handlePostmarkWebhook(req.body || {});
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Postmark webhook error:', formatErrorForLog(error));
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.DATABASE_AUTO_MIGRATE === 'true' && isDatabaseEnabled()) {
    try {
      const { runMigrations } = require('./db/migrate');
      await runMigrations();
      console.log('[db] auto-migrate complete');
    } catch (error) {
      console.error('[db] auto-migrate failed:', formatErrorForLog(error));
    }
  }
  startEmailCampaignWorker();
});
