const express = require('express');
const path = require('path');
const config = require('./config/secrets');
const { checkIdAndSendMagicLink } = require('./services/auth');
const { verifyMagicLink, resendMagicLinkByToken, isFlyProduction } = require('./services/magicLink');
const {
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
  isPeopleSheetAdminRole,
  isPeopleSheetAdminByIdentity,
} = require('./services/googleSheets');
const { getTeacherRoster, getStudentGrades } = require('./services/classroomSync');
const { isDatabaseEnabled, checkDatabaseHealth } = require('./db/index');
const { getRoleByEmailFromDb, getGradesByEmailFromDb, getPersonByAesopId, getMirrorCacheStatus, personRowToProfile, recordPortalDingChangeInDb } = require('./services/classroomDb');
const {
  isPortalAdmin,
  resolvePortalReviewerAccess,
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
const { refreshPortalCaches } = require('./services/portalCacheRefresh');
const {
  loadReviewAssignmentsForReviewer,
  saveReviewAssessment,
} = require('./services/applicantReviews');
const {
  getEmailGroups,
  getAdmissionsMetadata,
  previewEmailRecipients,
  sendAdminEmailTest,
  startAdminEmailCampaign,
  getAdminEmailCampaignStatus,
  listAdminEmailCampaigns,
  getAdminEmailCampaignDetail,
  startEmailCampaignWorker,
} = require('./services/adminEmail');
const {
  verifyPostmarkWebhookAuth,
  handlePostmarkWebhook,
  getWebhookSecret,
} = require('./services/postmarkWebhooks');
const {
  syncVoiceMemoRound2Status,
  getApplicantRowByAesopId,
  classifyRound1ApplicationStatus,
  getRound1ApplicationStats,
} = require('./services/voiceMemoSync');
const {
  getPortalVoiceMemoStatus,
  reportPortalVoiceMemoDuration,
  getPortalVoiceMemoStream,
  getPortalVoiceMemoStreamByToken,
  getReviewVoiceMemoStreamByToken,
  verifyVoiceStreamToken,
  verifyReviewVoiceStreamToken,
} = require('./services/portalVoiceMemo');
const { getPortalCalendarForApplicant } = require('./services/portalCalendar');
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
const { getClientIp } = require('./utils/clientIp');
const { securityHeaders } = require('./middleware/security');
const { formatDingChangeTimestamp } = require('./utils/dingSheetTime');
const { sendDingNumberUpdatedEmail, sendPortalDingHelpRequestEmail } = require('./services/email');
const { formatErrorForLog, formatGoogleSheetsWriteErrorForLog, isGoogleSheetsForbidden, formatDbErrorMessage } = require('./utils/errorLogging');
const {
  createPortalMetricsMiddleware,
  createRequestLogMiddleware,
  startPortalMetricsFlusher,
  recordLoginSuccess,
  recordLoginFailed,
  recordVerifyError,
  recordMagicLinkRequest,
  recordPortalClassGradeFail,
  getPortalStats,
  getRecentErrors,
  isRequestLogEnabled,
} = require('./services/portalMetrics');

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
 * @param {string} userId
 * @param {boolean} isApplicant
 * @returns {Promise<string>}
 */
async function resolveApplicationStatus(userId, isApplicant) {
  if (!isApplicant || !userId) {
    return '';
  }
  try {
    const applicant = await getApplicantRowByAesopId(userId);
    if (!applicant) {
      return '';
    }
    return classifyRound1ApplicationStatus(applicant.round1);
  } catch (error) {
    console.warn('Applicants Round 1 status lookup failed:', formatErrorForLog(error));
    return '';
  }
}

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

const PORTAL_APPLICANT_DING_MESSAGE =
  'Applicants cannot update Ding numbers here. Ding updates are for enrolled students and teachers.';

/**
 * @param {string} userId
 * @param {{ peopleStatus?: string }|null|undefined} [profile]
 * @returns {Promise<boolean>}
 */
async function isPortalApplicantProfile(userId, profile) {
  try {
    const applicant = await getApplicantRowByAesopId(userId);
    if (applicant) {
      return true;
    }
  } catch (error) {
    console.warn('Applicants sheet lookup failed during Ding access check:', formatErrorForLog(error));
  }
  return isAppliedPeopleStatus(resolvePeopleStatus(userId, profile?.peopleStatus || ''));
}

async function requirePortalReviewer(res, body) {
  const profile = await verifyPortalSessionBody(body.userId, body.email);
  if (!profile) {
    res.status(403).json({ error: 'Unable to continue. Please sign in again from the login link.' });
    return null;
  }
  if (!await resolvePortalReviewerAccess(profile)) {
    res.status(403).json({ error: 'Reviewer access required.' });
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
    res.status(403).json({ error: 'Unable to continue. Please sign in again from the login link.' });
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

app.use(createRequestLogMiddleware());
if (isRequestLogEnabled()) {
  console.log('[request-log] access logging enabled (REQUEST_LOG); view with: flyctl logs -a aesop-afghanistan');
}

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

app.use(
  createPortalMetricsMiddleware({
    isPortalHost: (req) => isPortalRequestHost(req),
  }),
);

app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }
  if (
    req.path === '/profile' ||
    req.path === '/faq' ||
    req.path === '/admin' ||
    req.path === '/admin/emails' ||
    req.path === '/admin/campaigns' ||
    req.path === '/admin/stats' ||
    req.path === '/reviews'
  ) {
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

const MAGIC_LINK_REQUEST_ACK_MESSAGE =
  'If that AESOP ID is on file, we emailed a one-time login link. Check your inbox and spam folder.';

// Request magic link
app.post('/api/request-magic-link', async (req, res) => {
  try {
    let { userId } = req.body;
    
    // Validate ID exists
    if (!userId || typeof userId !== 'string') {
      console.warn('Invalid student ID request: missing or non-string ID', {
        ip: getClientIp(req),
        route: req.originalUrl
      });
      return res.status(400).json({ error: 'ID is required' });
    }

    // Sanitize and validate ID format
    userId = sanitizeIdentifier(userId);
    if (!userId) {
      console.warn('Invalid student ID request: failed ID sanitization', {
        ip: getClientIp(req),
        route: req.originalUrl
      });
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    // Never reveal whether the ID exists (prevents AESOP ID enumeration).
    // Fire the lookup + send without awaiting so the response time is identical
    // whether or not the ID was found; errors are logged, not surfaced.
    recordMagicLinkRequest(1);
    checkIdAndSendMagicLink(userId).catch((error) => {
      console.error('Error requesting magic link:', formatErrorForLog(error));
    });

    res.json({
      success: true,
      message: MAGIC_LINK_REQUEST_ACK_MESSAGE,
    });
  } catch (error) {
    // Log error but don't expose details to client
    console.error('Error requesting magic link:', formatErrorForLog(error));
    res.status(500).json({ error: 'An error occurred. Please try again later.' });
  }
});

// Resend magic link for an expired or used token
app.post('/api/resend-magic-link', async (req, res) => {
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
      return res.status(400).json({ error: result.error || 'Unable to resend login link.' });
    }

    res.json({ success: true, message: result.message });
  } catch (error) {
    console.error('Error resending magic link:', formatErrorForLog(error));
    res.status(500).json({ error: 'An error occurred sending the link.' });
  }
});

// Verify magic link (changed to POST to prevent token exposure in URLs/logs)
app.post('/api/verify-magic-link', async (req, res) => {
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
      } catch (profileError) {
        console.warn('Profile lookup failed during verify; using token/DB fallback:', formatErrorForLog(profileError));
      }
      if (!profile && result.userId && isDatabaseEnabled()) {
        try {
          const fromDb = await getPersonByAesopId(result.userId);
          if (fromDb) {
            profile = personRowToProfile(fromDb);
            profile.peopleStatus = resolvePeopleStatus(
              profile.id || result.userId,
              profile.peopleStatus,
            );
            if (
              !isPeopleSheetAdminRole(profile.portalRole) &&
              (await isPeopleSheetAdminByIdentity(profile.id || result.userId, profile.email))
            ) {
              profile.portalRole = 'Admin';
            }
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
      const isReviewer = await resolvePortalReviewerAccess(profile);
      const applicationStatus = await resolveApplicationStatus(studentUserId, isApplicant);

      if (studentUserId) {
        recordPeopleLastLogin(studentUserId).catch((loginErr) => {
          console.warn('Last login sheet update failed:', formatErrorForLog(loginErr));
        });
      }

      recordLoginSuccess();
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
        isReviewer,
        isApplied,
        isApplicant,
        applicationStatus,
        peopleStatus,
        message: 'Login link verified successfully',
      });
    } else {
      recordLoginFailed();
      res.status(401).json({
        error: 'Invalid or expired login link.',
        canResend: result.canResend === true,
        reason: result.reason || 'unknown',
      });
    }
  } catch (error) {
    // Log error but don't expose details to client
    recordVerifyError(1);
    console.error('Error verifying magic link:', formatErrorForLog(error));
    res.status(500).json({ error: 'An error occurred verifying the link.' });
  }
});

const RATE_LIMIT_WINDOW_15M_MS = 15 * 60 * 1000;
const RATE_LIMIT_MIN_PER_15M = 50;

function portalSubjectKey(req) {
  const userId = sanitizeIdentifier(req.body?.userId);
  if (userId) {
    return `id:${userId}`;
  }

  const streamToken = typeof req.query?.st === 'string' ? req.query.st.trim() : '';
  if (streamToken) {
    const verified = verifyVoiceStreamToken(streamToken);
    if (verified?.userId) {
      const id = sanitizeIdentifier(verified.userId);
      if (id) {
        return `id:${id}`;
      }
    }
    const reviewVerified = verifyReviewVoiceStreamToken(streamToken);
    if (reviewVerified?.reviewerId) {
      const id = sanitizeIdentifier(reviewVerified.reviewerId);
      if (id) {
        return `id:${id}`;
      }
    }
  }

  return `ip:${getClientIp(req)}`;
}

// Rate limiter for updating ding number from the portal
const dingUpdateRateLimiter = createRateLimiter({
  name: 'update-ding',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: RATE_LIMIT_MIN_PER_15M,
  resolveKeySuffix: portalSubjectKey,
});

const portalDingHelpRateLimiter = createRateLimiter({
  name: 'portal-ding-help',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: RATE_LIMIT_MIN_PER_15M,
  resolveKeySuffix: portalSubjectKey,
});

const portalDingHistoryRateLimiter = createRateLimiter({
  name: 'portal-ding-history',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: RATE_LIMIT_MIN_PER_15M,
  resolveKeySuffix: portalSubjectKey,
});

const portalClassGradeRateLimiter = createRateLimiter({
  name: 'portal-class-grade',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: RATE_LIMIT_MIN_PER_15M,
  resolveKeySuffix: portalSubjectKey,
});

const portalTeacherRosterRateLimiter = createRateLimiter({
  name: 'portal-teacher-roster',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: RATE_LIMIT_MIN_PER_15M,
  resolveKeySuffix: portalSubjectKey,
});

const portalStudentGradesRateLimiter = createRateLimiter({
  name: 'portal-student-grades',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: RATE_LIMIT_MIN_PER_15M,
  resolveKeySuffix: portalSubjectKey,
});

const portalAdminRateLimiter = createRateLimiter({
  name: 'portal-admin',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: 200,
  resolveKeySuffix: portalSubjectKey,
});

const portalVoiceMemoRateLimiter = createRateLimiter({
  name: 'portal-voice-memo',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: 15 * 10,
  resolveKeySuffix: portalSubjectKey,
});
const portalVoiceMemoStreamRateLimiter = createRateLimiter({
  name: 'portal-voice-memo-stream',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: 120,
  resolveKeySuffix: portalSubjectKey,
});
const portalCalendarRateLimiter = createRateLimiter({
  name: 'portal-calendar',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: RATE_LIMIT_MIN_PER_15M,
  resolveKeySuffix: portalSubjectKey,
});
const portalReviewsRateLimiter = createRateLimiter({
  name: 'portal-reviews',
  windowMs: RATE_LIMIT_WINDOW_15M_MS,
  max: RATE_LIMIT_MIN_PER_15M,
  resolveKeySuffix: portalSubjectKey,
});
// Postmark sends many events per campaign from a few source IPs; keep this
// generous but bounded so an unauthenticated flood or secret brute-force is throttled.
// Throttled events return non-2xx and Postmark retries them later with backoff.
const postmarkWebhookRateLimiter = createRateLimiter({ name: 'postmark-webhook', windowMs: 60 * 1000, max: 600 });

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
      return res.status(403).json({ error: 'Unable to update. Please sign in again from the login link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res.status(403).json({ error: 'Unable to update. Please sign in again from the login link.' });
    }

    if (await isPortalApplicantProfile(userId, profile)) {
      return res.status(403).json({ error: PORTAL_APPLICANT_DING_MESSAGE });
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

    recordPortalDingChangeInDb(idForSheet, ding, when).catch((dbErr) => {
      console.warn('Ding change saved to Sheets but DB mirror update failed:', formatErrorForLog(dbErr));
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
      return res.status(403).json({ error: 'Unable to send request. Please sign in again from the login link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res.status(403).json({ error: 'Unable to send request. Please sign in again from the login link.' });
    }

    if (await isPortalApplicantProfile(userId, profile)) {
      return res.status(403).json({ error: PORTAL_APPLICANT_DING_MESSAGE });
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
      return res.status(403).json({ error: 'Unable to load history. Please sign in again from the login link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res.status(403).json({ error: 'Unable to load history. Please sign in again from the login link.' });
    }

    if (await isPortalApplicantProfile(userId, profile)) {
      return res.status(403).json({ error: PORTAL_APPLICANT_DING_MESSAGE });
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
      recordPortalClassGradeFail(1);
      return res.status(400).json({ error: 'ID and email are required.' });
    }

    userId = sanitizeIdentifier(userId);
    const emailSan = sanitizeEmail(email);
    if (!userId || !emailSan) {
      recordPortalClassGradeFail(1);
      return res.status(400).json({ error: 'Invalid ID or email.' });
    }

    const profile = await findProfileById(userId);
    if (!profile) {
      recordPortalClassGradeFail(1);
      return res
        .status(403)
        .json({ error: 'Unable to load class. Please sign in again from the login link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      recordPortalClassGradeFail(1);
      return res
        .status(403)
        .json({ error: 'Unable to load class. Please sign in again from the login link.' });
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
    const isReviewer = await resolvePortalReviewerAccess(profile);
    const applicationStatus = await resolveApplicationStatus(userId, isApplicant);

    res.json({
      success: true,
      classSection,
      calculatedGrade,
      classGrades,
      isTeacher,
      teacherClasses,
      isAdmin,
      isReviewer,
      isApplied,
      isApplicant,
      applicationStatus,
      peopleStatus,
    });
  } catch (error) {
    recordPortalClassGradeFail(1);
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
        .json({ error: 'Unable to load grades. Please sign in again from the login link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res
        .status(403)
        .json({ error: 'Unable to load grades. Please sign in again from the login link.' });
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
        .json({ error: 'Unable to load roster. Please sign in again from the login link.' });
    }

    if (sanitizeEmail(profile.email) !== emailSan) {
      return res
        .status(403)
        .json({ error: 'Unable to load roster. Please sign in again from the login link.' });
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

app.post('/api/portal-admin/stats', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const windowKey = typeof req.body.window === 'string' ? req.body.window : '5m';
    const stats = await getPortalStats(windowKey);
    res.json({ success: true, ...stats, recentErrors: getRecentErrors() });
  } catch (error) {
    console.error('Error loading portal admin stats:', formatErrorForLog(error));
    res.status(500).json({ error: 'Could not load portal stats.' });
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
    const applicationStatus = await resolveApplicationStatus(targetUserId, isApplicant);
    const isReviewer = await resolvePortalReviewerAccess(targetProfile);
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
      isTeacher: isApplied ? false : isTeacher,
      teacherClasses: isApplied ? '' : teacherClasses,
      isAdmin: false,
      isReviewer,
      isApplied,
      isApplicant,
      applicationStatus,
      peopleStatus,
    });
  } catch (error) {
    console.error('Error in admin impersonate:', formatErrorForLog(error));
    res.status(500).json({ success: false, error: error.message || 'Could not start impersonation.' });
  }
});

app.get('/api/health', async (_req, res) => {
  const db = await checkDatabaseHealth();
  let mirrorCache = null;
  if (db.enabled && db.ok) {
    try {
      mirrorCache = await getMirrorCacheStatus();
    } catch (error) {
      mirrorCache = { error: error.message || String(error) };
    }
  }
  res.json({
    ok: true,
    database: db,
    mirrorCache,
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
    res.status(status).json({
      error: error.message || formatDbErrorMessage(error) || 'Could not send test email.',
    });
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

    const refreshDuration = req.body?.refreshDuration === true;
    const status = await getPortalVoiceMemoStatus({
      userId,
      email: emailSan,
      refreshDuration,
    });
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('Error loading portal voice memo status:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not load voice memo status.' });
  }
});

app.post('/api/portal-voice-memo/duration', portalVoiceMemoRateLimiter, async (req, res) => {
  try {
    let { userId, email, fileId } = req.body;
    const durationSeconds = Number(req.body?.durationSeconds);

    if (!userId || typeof userId !== 'string' || !email || typeof email !== 'string') {
      return res.status(400).json({ error: 'ID and email are required.' });
    }

    userId = sanitizeIdentifier(userId);
    const emailSan = sanitizeEmail(email);
    if (!userId || !emailSan) {
      return res.status(400).json({ error: 'Invalid ID or email.' });
    }

    const result = await reportPortalVoiceMemoDuration({
      userId,
      email: emailSan,
      durationSeconds,
      fileId: typeof fileId === 'string' ? fileId : '',
    });
    res.json(result);
  } catch (error) {
    console.error('Error reporting portal voice memo duration:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not update voice memo duration.' });
  }
});

app.post('/api/portal-calendar', portalCalendarRateLimiter, async (req, res) => {
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

    const calendar = await getPortalCalendarForApplicant({ userId, email: emailSan });
    res.json({ success: true, ...calendar });
  } catch (error) {
    console.error('Error loading portal application calendar:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not load application calendar.' });
  }
});

app.post('/api/portal-reviews/list', portalReviewsRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalReviewer(res, req.body);
    if (!profile) {
      return;
    }

    const assignments = await loadReviewAssignmentsForReviewer(profile.id);
    res.json({ success: true, assignments });
  } catch (error) {
    console.error('Error loading review assignments:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not load review assignments.' });
  }
});

app.get('/api/portal-reviews/voice-memo/stream', portalVoiceMemoStreamRateLimiter, async (req, res) => {
  try {
    const token = typeof req.query.st === 'string' ? req.query.st : '';
    if (!token) {
      return res.status(400).json({ error: 'Missing stream token.' });
    }

    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
    const streamResult = await getReviewVoiceMemoStreamByToken({ token, rangeHeader });
    writeVoiceMemoStream(res, streamResult);
  } catch (error) {
    console.error('Error streaming review voice memo:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not stream voice memo.' });
  }
});

app.post('/api/portal-reviews/save', portalReviewsRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalReviewer(res, req.body);
    if (!profile) {
      return;
    }

    const applicantId =
      typeof req.body.applicantId === 'string' ? req.body.applicantId.trim() : '';
    const level = typeof req.body.englishLevel === 'string' ? req.body.englishLevel.trim() : '';
    const suspectedAi = req.body.suspectedAi === true;
    const instructionFollowing =
      typeof req.body.instructionFollowing === 'string' ? req.body.instructionFollowing.trim() : '';
    const originalThinking =
      typeof req.body.originalThinking === 'string' ? req.body.originalThinking.trim() : '';
    const character = typeof req.body.character === 'string' ? req.body.character.trim() : '';

    if (!applicantId) {
      return res.status(400).json({ error: 'Applicant ID is required.' });
    }

    const saved = await saveReviewAssessment({
      reviewerAesopId: profile.id,
      applicantAesopId: applicantId,
      englishLevel: level,
      suspectedAi,
      instructionFollowing,
      originalThinking,
      character,
    });
    res.json({ success: true, ...saved });
  } catch (error) {
    console.error('Error saving review assessment:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not save review assessment.' });
  }
});

function writeVoiceMemoStream(res, streamResult) {
  const { stream, mimeType, fileName, size, status, contentRange, contentLength } = streamResult;

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

async function pipePortalVoiceMemoStream(req, res, userId, emailSan) {
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
  const streamResult = await getPortalVoiceMemoStream({ userId, email: emailSan, rangeHeader });
  writeVoiceMemoStream(res, streamResult);
}

async function pipePortalVoiceMemoStreamByToken(req, res, token) {
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
  const streamResult = await getPortalVoiceMemoStreamByToken({ token, rangeHeader });
  writeVoiceMemoStream(res, streamResult);
}

app.get('/api/portal-voice-memo/stream', portalVoiceMemoStreamRateLimiter, async (req, res) => {
  try {
    // Authorized by a short-lived signed token (minted by the status endpoint),
    // so no userId/email appears in the URL, access logs, or browser history.
    const token = typeof req.query.st === 'string' ? req.query.st : '';
    if (!token) {
      return res.status(400).json({ error: 'Missing stream token.' });
    }

    await pipePortalVoiceMemoStreamByToken(req, res, token);
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

app.post('/api/portal-admin/cache/refresh', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const includeClassroom = req.body.includeClassroom !== false;
    const result = await refreshPortalCaches({ includeClassroom });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error refreshing portal cache:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not refresh portal cache.' });
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

app.post('/api/portal-admin/applications/round1-stats', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const stats = await getRound1ApplicationStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error loading Round 1 application stats:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not load application status counts.' });
  }
});

app.post('/api/portal-admin/email/campaigns', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const limit = Number.parseInt(String(req.body.limit ?? ''), 10);
    const campaigns = await listAdminEmailCampaigns(limit);
    res.json({ success: true, campaigns });
  } catch (error) {
    console.error('Error listing email campaigns:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not list campaigns.' });
  }
});

app.post('/api/portal-admin/email/campaign-detail', portalAdminRateLimiter, async (req, res) => {
  try {
    const profile = await requirePortalAdmin(res, req.body);
    if (!profile) {
      return;
    }
    const campaignId = Number.parseInt(String(req.body.campaignId ?? ''), 10);
    if (!Number.isFinite(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: 'A valid campaignId is required.' });
    }
    const detail = await getAdminEmailCampaignDetail(campaignId);
    res.json({ success: true, ...detail });
  } catch (error) {
    console.error('Error loading email campaign detail:', formatErrorForLog(error));
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || 'Could not load campaign detail.' });
  }
});

app.post('/api/postmark/webhook', postmarkWebhookRateLimiter, async (req, res) => {
  if (!verifyPostmarkWebhookAuth(req)) {
    const hasSecret = Boolean(getWebhookSecret());
    console.warn(
      'Postmark webhook rejected:',
      hasSecret ? 'auth mismatch' : 'POSTMARK_WEBHOOK_SECRET not configured',
    );
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
  startPortalMetricsFlusher();
  if (process.env.DATABASE_AUTO_MIGRATE === 'true' && isDatabaseEnabled()) {
    try {
      const { runMigrations } = require('./db/migrate');
      await runMigrations();
      console.log('[db] auto-migrate complete');
    } catch (error) {
      console.error('[db] auto-migrate failed:', formatErrorForLog(error));
    }
  }
  // Never auto-send campaign batches from a dev machine; the worker polls the
  // DB and pushes real Postmark sends. Opt in locally with EMAIL_CAMPAIGN_WORKER=true.
  if (isFlyProduction() || process.env.EMAIL_CAMPAIGN_WORKER === 'true') {
    startEmailCampaignWorker();
  } else {
    console.log('[email-campaigns] worker disabled outside Fly (set EMAIL_CAMPAIGN_WORKER=true to enable locally)');
  }
});
