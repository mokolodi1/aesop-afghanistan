import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  isValidAfghanistanPhoneNumber,
  normalizeAfghanistanPhoneDigits,
  AFGHAN_PHONE_FORMAT_HINT,
  getAfghanistanPhoneFormatMessage,
  isAfghanPhoneFormatErrorMessage,
  DING_CONFIRM_REQUIRED_MESSAGE,
  DING_CONFIRM_MISMATCH_MESSAGE,
  PORTAL_DING_HELP_NEED_DETAIL_MESSAGE,
  filterDingPhoneInputChars,
} from '../../utils/validation';
import { paragraphDirection } from '../shared/emailTextDirection.js';
import { hasNonLatinLetters, stripNonLatinLetters } from '../shared/latinText.js';
import { voiceMemoExtensionFromFileName } from '../../utils/voiceMemoExtensions.js';
import {
  getStoredPortalLocale,
  setStoredPortalLocale,
  translatePortalText,
  translateApplicationStatusLabel,
  translateVoiceMemoDurationWarning,
  applyPortalDocumentLocale,
} from './portalI18n.js';
import { getPortalApplicationCalendarEntries } from './portalApplicationCalendar.js';
import {
  classifyVoiceMemoDuration,
  formatVoiceMemoDurationLabel,
  voiceMemoDurationsDiffer,
} from '../../utils/voiceMemoDuration.js';
import {
  postMagicLinkRequest,
  postResendMagicLink,
} from './magicLinkClient.js';
import './styles.css';

const PortalLanguageContext = React.createContext({
  locale: 'en',
  toggleLocale: () => {},
  t: (key, params) => translatePortalText('en', key, params),
});

function PortalLanguageProvider({ children }) {
  const [locale, setLocale] = useState(() => getStoredPortalLocale());

  useEffect(() => {
    applyPortalDocumentLocale(locale);
  }, [locale]);

  const toggleLocale = useCallback(() => {
    setLocale((current) => {
      const next = current === 'en' ? 'fa' : 'en';
      setStoredPortalLocale(next);
      return next;
    });
  }, []);

  const t = useCallback((key, params) => translatePortalText(locale, key, params), [locale]);
  const value = useMemo(() => ({ locale, toggleLocale, t }), [locale, toggleLocale, t]);

  return <PortalLanguageContext.Provider value={value}>{children}</PortalLanguageContext.Provider>;
}

function usePortalI18n() {
  return useContext(PortalLanguageContext);
}

function PortalLanguageToggle() {
  const { locale, toggleLocale, t } = usePortalI18n();
  return (
    <button
      type="button"
      className="portal-language-toggle"
      onClick={toggleLocale}
      aria-label={t('language.toggleAria')}
    >
      {locale === 'en' ? t('language.switchToDari') : t('language.switchToEnglish')}
    </button>
  );
}

function isPortalHostname() {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase();
  if (host.startsWith('portal.')) return true;
  // Local loopback serves the portal SPA at `/` (see PORTAL_EXTRA_HOSTS / server defaults).
  // Treat it like portal.* so hub links stay on `/` instead of `/portal.html`.
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return isPortalSpaDocument();
  }
  return false;
}

function getPortalRouteSegment() {
  const { pathname } = window.location;
  if (pathname === '/portal.html') return 'hub';
  if (pathname === '/' && isPortalHostname()) return 'hub';
  if (pathname === '/profile' || pathname.startsWith('/profile/')) return 'profile';
  if (pathname === '/admin/emails') return 'admin-emails';
  if (pathname === '/admin/campaigns') return 'admin-campaigns';
  if (pathname === '/admin/stats') return 'admin-stats';
  if (pathname === '/reviews') return 'reviews';
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
  return 'hub';
}

function portalHubHref() {
  return isPortalHostname() ? '/' : '/portal.html';
}

function isPortalSpaDocument() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-portal-spa') === '1';
}

function shouldMountPortalSpa() {
  const p = window.location.pathname;
  if (p === '/portal.html') return true;
  const portalPath =
    p === '/' ||
    p === '/profile' ||
    p === '/faq' ||
    p === '/admin' ||
    p === '/admin/emails' ||
    p === '/admin/campaigns' ||
    p === '/admin/stats' ||
    p === '/reviews' ||
    p.startsWith('/profile/') ||
    p.startsWith('/faq/') ||
    p.startsWith('/admin/');
  if (!portalPath) return false;
  return isPortalHostname() || isPortalSpaDocument();
}

function isPortalSessionCompleteSync() {
  if (typeof sessionStorage === 'undefined') return false;
  const uid = sessionStorage.getItem('studentPortalUserId');
  const em = sessionStorage.getItem('studentPortalEmail');
  return !!(uid && String(uid).trim() && em && String(em).trim());
}

function readSessionField(key) {
  if (typeof sessionStorage === 'undefined') return '';
  return sessionStorage.getItem(key) || '';
}

function isAppliedPeopleStatus(status) {
  return String(status || '').trim().toLowerCase() === 'applied';
}

function resolveClientPeopleStatus(aesopId, rawStatus) {
  const trimmed = String(rawStatus || '').trim();
  if (trimmed) {
    return trimmed;
  }
  if (String(aesopId || '').trim().startsWith('262')) {
    return 'Applied';
  }
  return '';
}

function readPortalIsApplicant() {
  return readSessionField('studentPortalIsApplicant') === '1';
}

function readPortalIsReviewer() {
  return readSessionField('studentPortalIsReviewer') === '1';
}

function readPortalIsApplied() {
  return readPortalIsApplicant();
}

/** Keys written when a student completes magic-link verification */
const PORTAL_SESSION_STORAGE_KEYS = [
  'studentPortalName',
  'studentPortalEmail',
  'studentPortalNewDingNumber',
  'studentPortalUserId',
  'studentPortalPhone',
  'studentPortalClass',
  'studentPortalGrade',
  'studentPortalClassGrades',
  'studentPortalIsTeacher',
  'studentPortalTeacherClasses',
  'studentPortalIsAdmin',
  'studentPortalIsReviewer',
  'studentPortalIsApplied',
  'studentPortalIsApplicant',
  'studentPortalPeopleStatus',
  'studentPortalApplicationStatus',
];

const PORTAL_IMPERSONATING_KEY = 'studentPortalImpersonating';
const PORTAL_IMPERSONATION_ROLE_KEY = 'studentPortalImpersonationRole';
const PORTAL_ADMIN_SESSION_BACKUP_KEY = 'studentPortalAdminSessionBackup';

const REMEMBER_USER_ID_ENABLED_KEY = 'studentPortalRememberUserIdEnabled';
const REMEMBERED_USER_ID_KEY = 'studentPortalRememberedUserId';

function readRememberUserIdEnabled() {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(REMEMBER_USER_ID_ENABLED_KEY) === '1';
}

function readRememberedUserId() {
  if (typeof localStorage === 'undefined' || !readRememberUserIdEnabled()) return '';
  return localStorage.getItem(REMEMBERED_USER_ID_KEY)?.trim() || '';
}

function persistRememberUserId(userId, enabled) {
  if (typeof localStorage === 'undefined') return;
  const trimmedUserId = userId.trim();
  if (enabled && trimmedUserId) {
    localStorage.setItem(REMEMBER_USER_ID_ENABLED_KEY, '1');
    localStorage.setItem(REMEMBERED_USER_ID_KEY, trimmedUserId);
    return;
  }
  localStorage.removeItem(REMEMBER_USER_ID_ENABLED_KEY);
  localStorage.removeItem(REMEMBERED_USER_ID_KEY);
}

const PORTAL_SESSION_MS = 3 * 60 * 60 * 1000;
const PORTAL_ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const PORTAL_SESSION_EXPIRES_AT_KEY = 'studentPortalSessionExpiresAt';
const PORTAL_ADMIN_SESSION_LOCAL_KEY = 'studentPortalAdminPersistedSession';
const PORTAL_ADMIN_EMAIL_RECIPIENT_LIST_KEY = 'portalAdminEmailRecipientList';

const APPLICATION_STAT_CATEGORY_LABELS = {
  round1Accepted: 'Round 1 accepted',
  round1Rejected: 'Round 1 rejected',
  round1Pending: 'Round 1 pending',
  voiceMemoSubmitted: 'Voice memos submitted',
  voiceMemoValidDuration: 'Valid voice memo length',
  voiceMemoTooShort: 'Voice memo too short',
  voiceMemoTooLong: 'Voice memo too long',
  voiceMemoUnknownDuration: 'Voice memo duration unknown',
};

const APPLICATION_STAT_ISSUE_CATEGORIES = [
  'voiceMemoTooShort',
  'voiceMemoTooLong',
  'voiceMemoUnknownDuration',
];

function isPortalAdminSession() {
  if (readSessionField('studentPortalIsAdmin') === '1') {
    return true;
  }
  const backup = readAdminSessionBackup();
  return backup?.studentPortalIsAdmin === '1';
}

function getPortalSessionMaxAgeMs() {
  return isPortalAdminSession() ? PORTAL_ADMIN_SESSION_MS : PORTAL_SESSION_MS;
}

function touchPortalSessionExpiry() {
  if (typeof sessionStorage === 'undefined' || !isPortalSessionCompleteSync()) {
    return;
  }
  const expiresAt = Date.now() + getPortalSessionMaxAgeMs();
  sessionStorage.setItem(PORTAL_SESSION_EXPIRES_AT_KEY, String(expiresAt));
  if (isPortalAdminSession()) {
    persistAdminSessionToLocalStorage.lastAt = 0;
    persistAdminSessionToLocalStorage(expiresAt);
  }
}

function isPortalSessionExpired() {
  const raw = readSessionField(PORTAL_SESSION_EXPIRES_AT_KEY);
  if (!raw) {
    return false;
  }
  const expiresAt = Number(raw);
  return !Number.isFinite(expiresAt) || Date.now() >= expiresAt;
}

function persistAdminSessionToLocalStorage(expiresAt) {
  if (typeof localStorage === 'undefined' || !isPortalAdminSession()) {
    return;
  }
  const now = Date.now();
  if (now - persistAdminSessionToLocalStorage.lastAt < 60_000) {
    return;
  }
  persistAdminSessionToLocalStorage.lastAt = now;
  let sessionData;
  if (isPortalImpersonating()) {
    const backup = readAdminSessionBackup();
    if (!backup || backup.studentPortalIsAdmin !== '1') {
      return;
    }
    sessionData = backup;
  } else {
    sessionData = {};
    PORTAL_SESSION_STORAGE_KEYS.forEach((key) => {
      const value = sessionStorage.getItem(key);
      if (value != null) {
        sessionData[key] = value;
      }
    });
  }
  localStorage.setItem(
    PORTAL_ADMIN_SESSION_LOCAL_KEY,
    JSON.stringify({ expiresAt, session: sessionData }),
  );
}
persistAdminSessionToLocalStorage.lastAt = 0;

function clearAdminSessionFromLocalStorage() {
  if (typeof localStorage === 'undefined') {
    return;
  }
  localStorage.removeItem(PORTAL_ADMIN_SESSION_LOCAL_KEY);
}

function restoreAdminSessionFromLocalStorage() {
  if (typeof localStorage === 'undefined' || typeof sessionStorage === 'undefined') {
    return false;
  }
  if (isPortalSessionCompleteSync()) {
    return true;
  }
  let stored;
  try {
    const raw = localStorage.getItem(PORTAL_ADMIN_SESSION_LOCAL_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    return false;
  }
  if (!stored?.session || !stored.expiresAt || Date.now() >= stored.expiresAt) {
    clearAdminSessionFromLocalStorage();
    return false;
  }
  Object.entries(stored.session).forEach(([key, value]) => {
    if (value != null) {
      sessionStorage.setItem(key, value);
    }
  });
  sessionStorage.setItem(PORTAL_SESSION_EXPIRES_AT_KEY, String(stored.expiresAt));
  return isPortalSessionCompleteSync();
}

function ensurePortalSessionReady() {
  restoreAdminSessionFromLocalStorage();
  if (isPortalSessionCompleteSync() && isPortalSessionExpired()) {
    clearPortalSession();
    return;
  }
  if (isPortalSessionCompleteSync() && !readSessionField(PORTAL_SESSION_EXPIRES_AT_KEY)) {
    touchPortalSessionExpiry();
  }
}

/** Dedupe concurrent class/grade fetches (header + hub both mount). */
let portalClassGradeInFlight = null;

/** Dedupe concurrent voice-memo status fetches (memo section + calendar both mount). */
const portalVoiceMemoStatusInFlight = new Map();

/** Dedupe concurrent teacher-roster fetches when multiple roster panels mount. */
let portalTeacherRosterInFlight = null;

/** Dedupe concurrent student-grades fetches. */
let portalStudentGradesInFlight = null;

/** Dedupe concurrent ding-history fetches (e.g. rapid accordion toggles). */
const portalDingHistoryInFlight = new Map();

function readAdminApiCredentials() {
  if (isPortalImpersonating()) {
    const backup = readAdminSessionBackup();
    if (backup) {
      return {
        userId: backup.studentPortalUserId || '',
        email: backup.studentPortalEmail || '',
      };
    }
  }
  return {
    userId: readSessionField('studentPortalUserId'),
    email: readSessionField('studentPortalEmail'),
  };
}

function isPortalImpersonating() {
  return readSessionField(PORTAL_IMPERSONATING_KEY) === '1';
}

function readAdminSessionBackup() {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }
  try {
    const raw = sessionStorage.getItem(PORTAL_ADMIN_SESSION_BACKUP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function backupCurrentPortalSessionForImpersonation() {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  const backup = {};
  PORTAL_SESSION_STORAGE_KEYS.forEach((key) => {
    const value = sessionStorage.getItem(key);
    if (value != null) {
      backup[key] = value;
    }
  });
  sessionStorage.setItem(PORTAL_ADMIN_SESSION_BACKUP_KEY, JSON.stringify(backup));
}

function applicationStatusClassName(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'accepted') {
    return ' portal-application-status--accepted';
  }
  if (normalized === 'rejected') {
    return ' portal-application-status--rejected';
  }
  return ' portal-application-status--pending';
}

/** Render plain text with **bold** markers as React nodes. */
function renderPortalRichText(text) {
  const source = String(text || '');
  const parts = source.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function applyPortalSessionFromApi(data, options = {}) {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  const allowAdmin = options.allowAdmin === true;
  const nameFromApi = typeof data.name === 'string' ? data.name.trim() : '';
  const emailFromApi = typeof data.email === 'string' ? data.email.trim() : '';
  const dingFromApi = typeof data.newDingNumber === 'string' ? data.newDingNumber.trim() : '';
  const userIdFromApi = typeof data.userId === 'string' ? data.userId.trim() : '';
  const phoneFromApi = typeof data.phone === 'string' ? data.phone.trim() : '';
  const classFromApi = typeof data.classSection === 'string' ? data.classSection.trim() : '';
  const gradeFromApi = typeof data.calculatedGrade === 'string' ? data.calculatedGrade.trim() : '';
  const classGradesFromApi = normalizeClassGrades(data.classGrades);
  const isTeacherFromApi = data.isTeacher === true && data.isApplicant !== true;
  const teachingFromApi =
    typeof data.teacherClasses === 'string' ? data.teacherClasses.trim() : '';
  const peopleStatusFromApi =
    typeof data.peopleStatus === 'string'
      ? data.peopleStatus.trim()
      : resolveClientPeopleStatus(userIdFromApi, '');
  const isApplicantFromApi = data.isApplicant === true;

  if (nameFromApi) {
    sessionStorage.setItem('studentPortalName', nameFromApi);
  } else {
    sessionStorage.removeItem('studentPortalName');
  }
  if (emailFromApi) {
    sessionStorage.setItem('studentPortalEmail', emailFromApi);
  } else {
    sessionStorage.removeItem('studentPortalEmail');
  }
  if (dingFromApi) {
    sessionStorage.setItem('studentPortalNewDingNumber', dingFromApi);
  } else {
    sessionStorage.removeItem('studentPortalNewDingNumber');
  }
  if (userIdFromApi) {
    sessionStorage.setItem('studentPortalUserId', userIdFromApi);
  } else {
    sessionStorage.removeItem('studentPortalUserId');
  }
  if (phoneFromApi) {
    sessionStorage.setItem('studentPortalPhone', phoneFromApi);
  } else {
    sessionStorage.removeItem('studentPortalPhone');
  }
  if (classFromApi) {
    sessionStorage.setItem('studentPortalClass', classFromApi);
  } else {
    sessionStorage.removeItem('studentPortalClass');
  }
  if (gradeFromApi) {
    sessionStorage.setItem('studentPortalGrade', gradeFromApi);
  } else {
    sessionStorage.removeItem('studentPortalGrade');
  }
  writeClassGradesToSession(isApplicantFromApi ? [] : classGradesFromApi);
  if (isTeacherFromApi) {
    sessionStorage.setItem('studentPortalIsTeacher', '1');
  } else {
    sessionStorage.removeItem('studentPortalIsTeacher');
  }
  if (data.isAdmin === true && allowAdmin) {
    sessionStorage.setItem('studentPortalIsAdmin', '1');
  } else {
    sessionStorage.removeItem('studentPortalIsAdmin');
  }
  if (data.isReviewer === true) {
    sessionStorage.setItem('studentPortalIsReviewer', '1');
  } else {
    sessionStorage.removeItem('studentPortalIsReviewer');
  }
  if (isApplicantFromApi) {
    sessionStorage.setItem('studentPortalIsApplicant', '1');
    sessionStorage.setItem('studentPortalIsApplied', '1');
    sessionStorage.setItem('studentPortalPeopleStatus', peopleStatusFromApi || 'applied');
    sessionStorage.removeItem('studentPortalClass');
    sessionStorage.removeItem('studentPortalGrade');
    sessionStorage.removeItem('studentPortalClassGrades');
    sessionStorage.removeItem('studentPortalTeacherClasses');
  } else {
    sessionStorage.removeItem('studentPortalIsApplicant');
    sessionStorage.removeItem('studentPortalIsApplied');
    sessionStorage.removeItem('studentPortalPeopleStatus');
  }
  const applicationStatusFromApi =
    typeof data.applicationStatus === 'string' ? data.applicationStatus.trim() : '';
  if (isApplicantFromApi && applicationStatusFromApi) {
    sessionStorage.setItem('studentPortalApplicationStatus', applicationStatusFromApi);
  } else {
    sessionStorage.removeItem('studentPortalApplicationStatus');
  }
  if (isTeacherFromApi && teachingFromApi) {
    sessionStorage.setItem('studentPortalTeacherClasses', teachingFromApi);
  } else {
    sessionStorage.removeItem('studentPortalTeacherClasses');
  }
  touchPortalSessionExpiry();
}

function startPortalImpersonation(data) {
  if (!isPortalImpersonating()) {
    backupCurrentPortalSessionForImpersonation();
    sessionStorage.setItem(PORTAL_IMPERSONATING_KEY, '1');
  }
  sessionStorage.removeItem(PORTAL_IMPERSONATION_ROLE_KEY);
  applyPortalSessionFromApi(data);
}

async function openPortalAsPerson(targetUserId) {
  const trimmed = targetUserId.trim();
  if (!trimmed) {
    throw new Error('AESOP ID is required.');
  }
  const data = await adminApiPost('/api/portal-admin/impersonate', {
    targetUserId: trimmed,
  });
  startPortalImpersonation(data);
  window.location.assign(portalHubHref());
}

function stopPortalImpersonation() {
  if (typeof sessionStorage === 'undefined') {
    window.location.assign('/admin');
    return;
  }
  const backup = readAdminSessionBackup();
  PORTAL_SESSION_STORAGE_KEYS.forEach((key) => sessionStorage.removeItem(key));
  sessionStorage.removeItem(PORTAL_IMPERSONATING_KEY);
  sessionStorage.removeItem(PORTAL_IMPERSONATION_ROLE_KEY);
  sessionStorage.removeItem(PORTAL_ADMIN_SESSION_BACKUP_KEY);
  if (backup) {
    Object.entries(backup).forEach(([key, value]) => {
      if (value != null) {
        sessionStorage.setItem(key, value);
      }
    });
  }
  touchPortalSessionExpiry();
  window.location.assign('/admin');
}

async function portalApiPost(path, body = {}, options = {}) {
  const userId = readSessionField('studentPortalUserId');
  const email = readSessionField('studentPortalEmail');
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeoutId =
    controller != null
      ? window.setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;

  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, email, ...body }),
      signal: controller?.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error((data && data.error) || `Request failed (HTTP ${response.status}).`);
    }
    if (data.success !== true) {
      throw new Error((data && data.error) || 'Request failed.');
    }
    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('Request timed out. Please try again.');
    }
    throw error;
  } finally {
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
    }
  }
}

async function adminApiPost(path, body = {}) {
  const { userId, email } = readAdminApiCredentials();
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, email, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data && data.error) || `Request failed (HTTP ${response.status}).`);
  }
  if (data.success !== true) {
    throw new Error((data && data.error) || 'Request failed.');
  }
  return data;
}

function normalizeClassGrades(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((row) => ({
      classSection: typeof row?.classSection === 'string' ? row.classSection.trim() : '',
      calculatedGrade: typeof row?.calculatedGrade === 'string' ? row.calculatedGrade.trim() : '',
    }))
    .filter((row) => row.classSection || row.calculatedGrade);
}

function readClassGradesFromSession() {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = sessionStorage.getItem('studentPortalClassGrades');
    return raw ? normalizeClassGrades(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeClassGradesToSession(classGrades) {
  if (typeof window === 'undefined') {
    return;
  }
  const normalized = normalizeClassGrades(classGrades);
  if (normalized.length > 0) {
    sessionStorage.setItem('studentPortalClassGrades', JSON.stringify(normalized));
  } else {
    sessionStorage.removeItem('studentPortalClassGrades');
  }
}

async function loadPortalClassGradeFromApi() {
  if (typeof window === 'undefined' || !isPortalSessionCompleteSync()) {
    return Promise.resolve({
      classSection: '',
      calculatedGrade: '',
      classGrades: [],
      isTeacher: false,
      teacherClasses: '',
      isAdmin: false,
      isReviewer: false,
      isApplied: false,
      isApplicant: false,
      peopleStatus: '',
      applicationStatus: '',
    });
  }
  if (portalClassGradeInFlight) {
    return portalClassGradeInFlight;
  }
  portalClassGradeInFlight = (async () => {
    try {
      const userId = readSessionField('studentPortalUserId');
      const email = readSessionField('studentPortalEmail');
      if (!userId.trim() || !email.trim()) {
        return {
          classSection: '',
          calculatedGrade: '',
          classGrades: [],
          isTeacher: false,
          teacherClasses: '',
          isAdmin: false,
          isReviewer: false,
          isApplied: false,
          isApplicant: false,
          peopleStatus: '',
          applicationStatus: '',
        };
      }
      const response = await fetch('/api/portal-class-grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, email }),
      });
      const data = await response.json();
      if (!data.success) {
        // Transient failures (e.g. a 429 from the rate limiter) must NOT strip the
        // user's role flags, otherwise an admin/reviewer loses their nav tabs until
        // the next successful load. Signal failure so callers keep the session values.
        return { failed: true };
      }
      const classSection = typeof data.classSection === 'string' ? data.classSection.trim() : '';
      const calculatedGrade =
        typeof data.calculatedGrade === 'string' ? data.calculatedGrade.trim() : '';
      const classGrades = normalizeClassGrades(data.classGrades);
      const isTeacher = data.isTeacher === true;
      const isAdmin = data.isAdmin === true;
      const isReviewer = data.isReviewer === true;
      const teacherClasses =
        typeof data.teacherClasses === 'string' ? data.teacherClasses.trim() : '';
      const peopleStatus =
        typeof data.peopleStatus === 'string'
          ? data.peopleStatus.trim()
          : resolveClientPeopleStatus(userId, '');
      const isApplicant = data.isApplicant === true;
      const isApplied = isApplicant;
      const applicationStatus =
        typeof data.applicationStatus === 'string' ? data.applicationStatus.trim() : '';
      sessionStorage.setItem('studentPortalClass', isApplied ? '' : classSection);
      sessionStorage.setItem('studentPortalGrade', isApplied ? '' : calculatedGrade);
      writeClassGradesToSession(isApplied ? [] : classGrades);
      if (isTeacher && !isApplied) {
        sessionStorage.setItem('studentPortalIsTeacher', '1');
      } else {
        sessionStorage.removeItem('studentPortalIsTeacher');
      }
      if (isAdmin) {
        sessionStorage.setItem('studentPortalIsAdmin', '1');
      } else {
        sessionStorage.removeItem('studentPortalIsAdmin');
      }
      if (isReviewer) {
        sessionStorage.setItem('studentPortalIsReviewer', '1');
      } else {
        sessionStorage.removeItem('studentPortalIsReviewer');
      }
      if (isApplicant) {
        sessionStorage.setItem('studentPortalIsApplicant', '1');
        sessionStorage.setItem('studentPortalIsApplied', '1');
        sessionStorage.setItem('studentPortalPeopleStatus', peopleStatus || 'applied');
        sessionStorage.removeItem('studentPortalTeacherClasses');
      } else {
        sessionStorage.removeItem('studentPortalIsApplicant');
        sessionStorage.removeItem('studentPortalIsApplied');
        sessionStorage.removeItem('studentPortalPeopleStatus');
        if (teacherClasses) {
          sessionStorage.setItem('studentPortalTeacherClasses', teacherClasses);
        } else {
          sessionStorage.removeItem('studentPortalTeacherClasses');
        }
      }
      if (isApplicant && applicationStatus) {
        sessionStorage.setItem('studentPortalApplicationStatus', applicationStatus);
      } else {
        sessionStorage.removeItem('studentPortalApplicationStatus');
      }
      return {
        classSection: isApplied ? '' : classSection,
        calculatedGrade: isApplied ? '' : calculatedGrade,
        classGrades: isApplied ? [] : classGrades,
        isTeacher: isApplied ? false : isTeacher,
        teacherClasses: isApplied ? '' : teacherClasses,
        isAdmin,
        isReviewer,
        isApplied,
        isApplicant,
        peopleStatus,
        applicationStatus,
      };
    } catch {
      // Network/parse error: preserve existing role flags instead of downgrading.
      return { failed: true };
    } finally {
      portalClassGradeInFlight = null;
    }
  })();
  return portalClassGradeInFlight;
}

async function resolvePortalVoiceMemoAudioError(streamSrc, t) {
  if (!streamSrc) {
    return t('voiceMemo.audioPlayError');
  }
  try {
    const response = await fetch(streamSrc, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });
    if (response.status === 429 || response.status === 503) {
      const payload = await response.json().catch(() => null);
      const serverMessage = String(payload?.error || '').trim();
      if (/reload|expired/i.test(serverMessage)) {
        return t('voiceMemo.streamExpired');
      }
      return t('voiceMemo.audioPlayError');
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const serverMessage = String(payload?.error || '').trim();
      if (/reload|expired/i.test(serverMessage)) {
        return t('voiceMemo.streamExpired');
      }
      return t('voiceMemo.audioPlayError');
    }
  } catch {
    // Fall back to the generic playback message when the probe fails.
  }
  return t('voiceMemo.audioPlayError');
}

async function loadPortalVoiceMemoStatusFromApi({ userId, email }) {
  const id = String(userId || '').trim();
  const em = String(email || '').trim();
  if (!id || !em) {
    return { ok: true, status: null, errorKind: '', errorMessage: '' };
  }
  const cacheKey = `${id}:${em}`;
  if (portalVoiceMemoStatusInFlight.has(cacheKey)) {
    return portalVoiceMemoStatusInFlight.get(cacheKey);
  }
  const promise = (async () => {
    try {
      const response = await fetch('/api/portal-voice-memo/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: id, email: em }),
      });
      const data = await response.json();
      if (!response.ok) {
        return {
          ok: false,
          status: null,
          errorKind: 'load',
          errorMessage: typeof data.error === 'string' ? data.error : '',
        };
      }
      return { ok: true, status: data, errorKind: '', errorMessage: '' };
    } catch {
      return { ok: false, status: null, errorKind: 'network', errorMessage: '' };
    } finally {
      portalVoiceMemoStatusInFlight.delete(cacheKey);
    }
  })();
  portalVoiceMemoStatusInFlight.set(cacheKey, promise);
  return promise;
}

function usePortalVoiceMemoStatus({ enabled, userId, email }) {
  const { t } = usePortalI18n();
  const [loading, setLoading] = useState(Boolean(enabled && userId && email));
  const [error, setError] = useState('');
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!enabled || !String(userId || '').trim() || !String(email || '').trim()) {
      setLoading(false);
      setError('');
      setStatus(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    loadPortalVoiceMemoStatusFromApi({ userId, email }).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setError(
          result.errorMessage ||
            (result.errorKind === 'network' ? t('voiceMemo.networkError') : t('voiceMemo.loadError')),
        );
        setStatus(null);
      } else {
        setStatus(result.status);
        setError('');
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, userId, email, t]);

  return { loading, error, status };
}

async function loadPortalTeacherRosterFromApi() {
  if (typeof window === 'undefined' || !isPortalSessionCompleteSync()) {
    return { ok: false, classes: [], errorMessage: 'Could not load your class roster.' };
  }
  if (portalTeacherRosterInFlight) {
    return portalTeacherRosterInFlight;
  }
  portalTeacherRosterInFlight = (async () => {
    try {
      const userId = readSessionField('studentPortalUserId');
      const email = readSessionField('studentPortalEmail');
      const response = await fetch('/api/portal-teacher-roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, email }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        return {
          ok: false,
          classes: [],
          errorMessage: (data && data.error) || 'Could not load your class roster.',
        };
      }
      return {
        ok: true,
        classes: Array.isArray(data.classes) ? data.classes : [],
        errorMessage: '',
      };
    } catch {
      return { ok: false, classes: [], errorMessage: 'Could not load your class roster.' };
    } finally {
      portalTeacherRosterInFlight = null;
    }
  })();
  return portalTeacherRosterInFlight;
}

async function loadPortalStudentGradesFromApi() {
  if (typeof window === 'undefined' || !isPortalSessionCompleteSync()) {
    return { ok: false, classes: [], errorMessage: 'Could not load your grades.' };
  }
  if (portalStudentGradesInFlight) {
    return portalStudentGradesInFlight;
  }
  portalStudentGradesInFlight = (async () => {
    try {
      const userId = readSessionField('studentPortalUserId');
      const email = readSessionField('studentPortalEmail');
      const response = await fetch('/api/portal-student-grades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, email }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        return {
          ok: false,
          classes: [],
          errorMessage: (data && data.error) || 'Could not load your grades.',
        };
      }
      return {
        ok: true,
        classes: Array.isArray(data.classes) ? data.classes : [],
        errorMessage: '',
      };
    } catch {
      return { ok: false, classes: [], errorMessage: 'Could not load your grades.' };
    } finally {
      portalStudentGradesInFlight = null;
    }
  })();
  return portalStudentGradesInFlight;
}

async function loadPortalDingHistoryFromApi({ userId, email }) {
  const id = String(userId || '').trim();
  const em = String(email || '').trim();
  if (!id || !em) {
    return { ok: false, entries: [], errorMessage: 'Could not load history.' };
  }
  const cacheKey = `${id}:${em}`;
  if (portalDingHistoryInFlight.has(cacheKey)) {
    return portalDingHistoryInFlight.get(cacheKey);
  }
  const promise = (async () => {
    try {
      const response = await fetch('/api/portal-ding-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: id, email: em }),
      });
      const data = await response.json();
      if (!response.ok) {
        return {
          ok: false,
          entries: [],
          errorMessage: (data && data.error) || 'Could not load history.',
        };
      }
      return {
        ok: true,
        entries: Array.isArray(data.entries) ? data.entries : [],
        errorMessage: '',
      };
    } catch {
      return { ok: false, entries: [], errorMessage: 'Network error. Please try again.' };
    } finally {
      portalDingHistoryInFlight.delete(cacheKey);
    }
  })();
  portalDingHistoryInFlight.set(cacheKey, promise);
  return promise;
}

function usePortalClassGrade() {
  const [studentClass, setStudentClass] = useState(() => readSessionField('studentPortalClass'));
  const [studentGrade, setStudentGrade] = useState(() => readSessionField('studentPortalGrade'));
  const [classGrades, setClassGrades] = useState(() => readClassGradesFromSession());
  const [isTeacher, setIsTeacher] = useState(() => readSessionField('studentPortalIsTeacher') === '1');
  const [teacherClasses, setTeacherClasses] = useState(() => readSessionField('studentPortalTeacherClasses'));
  const [isApplied, setIsApplied] = useState(() => readPortalIsApplied());
  const [isApplicant, setIsApplicant] = useState(() => readPortalIsApplicant());
  const [applicationStatus, setApplicationStatus] = useState(() =>
    readSessionField('studentPortalApplicationStatus'),
  );
  const [peopleStatus, setPeopleStatus] = useState(() =>
    resolveClientPeopleStatus(
      readSessionField('studentPortalUserId'),
      readSessionField('studentPortalPeopleStatus'),
    ),
  );

  const [isAdmin, setIsAdmin] = useState(() => readSessionField('studentPortalIsAdmin') === '1');
  const [isReviewer, setIsReviewer] = useState(() => readPortalIsReviewer());

  useEffect(() => {
    let cancelled = false;
    loadPortalClassGradeFromApi().then(
      ({
        failed,
        classSection,
        calculatedGrade,
        classGrades: grades,
        isTeacher: tchr,
        teacherClasses: teach,
        isAdmin: adm,
        isReviewer: reviewer,
        isApplied: applied,
        isApplicant: applicant,
        peopleStatus: status,
        applicationStatus: appStatus,
      }) => {
        if (cancelled) return;
        // A failed load returns only { failed: true }; keep the session-derived
        // role flags rather than wiping them (which would hide admin/reviewer nav).
        if (failed) return;
        setStudentClass(classSection);
        setStudentGrade(calculatedGrade);
        setClassGrades(grades);
        setIsTeacher(tchr);
        setTeacherClasses(teach);
        setIsAdmin(adm);
        setIsReviewer(reviewer);
        setIsApplied(applied);
        setIsApplicant(applicant);
        setPeopleStatus(status);
        setApplicationStatus(appStatus || '');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    studentClass,
    studentGrade,
    classGrades,
    isTeacher,
    teacherClasses,
    isAdmin,
    isReviewer,
    isApplied,
    isApplicant,
    peopleStatus,
    applicationStatus,
  };
}

function computeHasStudentCategory({
  isApplied,
  isApplicant,
  aesopId,
  studentClass,
  studentGrade,
  classGrades,
}) {
  return (
    !isApplied &&
    !isApplicant &&
    aesopId !== '' &&
    (classGrades.length > 0 || (studentClass.trim() !== '' && studentGrade.trim() !== ''))
  );
}

/** Hide student fields (class, grade) for teachers-only; hide Teaching for students-only. */
function usePortalProfileSections() {
  const aesopId = readSessionField('studentPortalUserId').trim();
  const portalClassGrade = usePortalClassGrade();
  const { studentClass, studentGrade, classGrades, isTeacher, isApplied, isApplicant, peopleStatus } =
    portalClassGrade;
  const hasApplicantPortalAccess = isApplicant === true;
  const hasStudentCategory = computeHasStudentCategory({
    isApplied: false,
    isApplicant: false,
    aesopId,
    studentClass,
    studentGrade,
    classGrades,
  });

  if (hasApplicantPortalAccess) {
    return {
      ...portalClassGrade,
      showStudentFields: false,
      showTeacherFields: false,
      hasStudentCategory: false,
      isApplied: true,
      isApplicant: true,
      hasApplicantPortalAccess: true,
      peopleStatus: peopleStatus || 'applied',
    };
  }

  return {
    ...portalClassGrade,
    showStudentFields: false,
    showTeacherFields: false,
    hasStudentCategory: false,
    isApplied: false,
    hasApplicantPortalAccess: false,
  };
}

/**
 * Fetch a live per-class roster (students + grades). Runs for teachers and admins
 * when a portal session exists. Returns loading/error state for placeholders.
 */
function useTeacherRoster(rosterEnabled) {
  const [state, setState] = useState({ status: 'idle', classes: [], error: '' });

  useEffect(() => {
    if (!rosterEnabled || !isPortalSessionCompleteSync()) {
      setState({ status: 'idle', classes: [], error: '' });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading', classes: [], error: '' });
    loadPortalTeacherRosterFromApi().then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setState({ status: 'error', classes: [], error: result.errorMessage });
        return;
      }
      setState({ status: 'ready', classes: result.classes, error: '' });
    });
    return () => {
      cancelled = true;
    };
  }, [rosterEnabled]);

  return state;
}

function useAdminClassList(enabled) {
  const [state, setState] = useState({
    status: 'idle',
    classes: [],
    error: '',
  });

  useEffect(() => {
    if (!enabled || !isPortalSessionCompleteSync()) {
      setState({ status: 'idle', classes: [], error: '' });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading', classes: [], error: '' });
    adminApiPost('/api/portal-admin/all-classes')
      .then((data) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          classes: Array.isArray(data.classes) ? data.classes : [],
          error: '',
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            status: 'error',
            classes: [],
            error: err.message || 'Could not load classes from Google Classroom.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}

async function downloadAdminDingConnectCsv() {
  const { userId, email } = readAdminApiCredentials();
  const response = await fetch('/api/portal-admin/dingconnect-export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, email, download: true }),
  });
  if (!response.ok) {
    let message = 'Could not download CSV.';
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => ({}));
      message = (data && data.error) || message;
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const contentDisposition = response.headers.get('Content-Disposition') || '';
  const match = contentDisposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : 'dingconnect-topup.csv';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function classTabId(label) {
  return `class-tab-${String(label).replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

function studentRowKey(classLabel, email) {
  return `${classLabel}::${email}`;
}

function matchesStudentSearch(student, query) {
  if (!query) {
    return true;
  }
  const haystack = [student.name, student.email, student.userId, student.dingNumber]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function PortalAssignmentTable({ assignments }) {
  const rows = Array.isArray(assignments) ? assignments : [];
  if (rows.length === 0) {
    return <p className="portal-roster-status">No assignments to show for this class yet.</p>;
  }
  return (
    <table className="portal-roster-table portal-assignment-table">
      <thead>
        <tr>
          <th scope="col">Assignment</th>
          <th scope="col">Grade</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.title}>
            <td>{a.title}</td>
            <td className="portal-roster-grade">{a.display || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function useStudentGrades(isStudent) {
  const [state, setState] = useState({ status: 'idle', classes: [], error: '' });

  useEffect(() => {
    if (!isStudent || !isPortalSessionCompleteSync()) {
      setState({ status: 'idle', classes: [], error: '' });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading', classes: [], error: '' });
    loadPortalStudentGradesFromApi().then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setState({ status: 'error', classes: [], error: result.errorMessage });
        return;
      }
      setState({ status: 'ready', classes: result.classes, error: '' });
    });
    return () => {
      cancelled = true;
    };
  }, [isStudent]);

  return state;
}

function PortalStudentGrades({ isStudent }) {
  const { status, classes, error } = useStudentGrades(isStudent);
  const [openClassLabel, setOpenClassLabel] = useState('');

  const toggleClassPanel = (label) => {
    setOpenClassLabel((prev) => (prev === label ? '' : label));
  };

  if (!isStudent) {
    return null;
  }

  return (
    <section className="portal-roster portal-student-grades" aria-label="Your grades by class">
      <h3 className="portal-roster-heading">Your grades</h3>
      {status === 'loading' ? <p className="portal-roster-status">Loading your assignments…</p> : null}
      {status === 'error' ? (
        <p className="portal-roster-status portal-roster-status--error" role="alert">
          {error}
        </p>
      ) : null}
      {status === 'ready' && classes.length === 0 ? (
        <p className="portal-roster-status">No enrolled classes found for your account.</p>
      ) : null}
      {status === 'ready' && classes.length > 0 ? (
        <div className="portal-class-accordion" aria-label="Your classes">
          {classes.map((cls) => {
            const tabId = classTabId(cls.label);
            const isOpen = openClassLabel === cls.label;
            return (
              <div className="portal-class-accordion-item" key={cls.label}>
                <button
                  type="button"
                  id={tabId}
                  className={`portal-class-accordion-tab${isOpen ? ' is-active' : ''}`}
                  aria-expanded={isOpen}
                  aria-controls={`${tabId}-panel`}
                  onClick={() => toggleClassPanel(cls.label)}
                >
                  <span className="portal-class-accordion-label">{cls.label}</span>
                  <span className="portal-class-accordion-meta">{cls.grade || '—'}</span>
                  <span className="portal-class-accordion-chevron" aria-hidden="true">
                    {isOpen ? '▼' : '▶'}
                  </span>
                </button>
                {isOpen ? (
                  <div
                    id={`${tabId}-panel`}
                    className="portal-class-accordion-panel"
                    role="region"
                    aria-labelledby={tabId}
                  >
                    <PortalAssignmentTable assignments={cls.assignments} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function PortalTeacherStudentList({
  classLabel,
  students,
  openStudentKey,
  onToggleStudent,
  searchQuery,
}) {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleStudents = normalizedQuery
    ? students.filter((s) => matchesStudentSearch(s, normalizedQuery))
    : students;

  if (visibleStudents.length === 0) {
    return <p className="portal-roster-status">No students match your search in this class.</p>;
  }

  return (
    <div className="portal-student-accordion" aria-label={`Students in ${classLabel}`}>
      {visibleStudents.map((student) => {
        const rowKey = studentRowKey(classLabel, student.email);
        const isOpen = openStudentKey === rowKey;
        const rowId = classTabId(rowKey);
        return (
          <div className="portal-student-accordion-item" key={rowKey}>
            <button
              type="button"
              id={rowId}
              className={`portal-student-accordion-tab${isOpen ? ' is-active' : ''}`}
              aria-expanded={isOpen}
              aria-controls={`${rowId}-panel`}
              onClick={() => onToggleStudent(rowKey)}
            >
              <span className="portal-student-accordion-name">{student.name || '—'}</span>
              <span className="portal-student-accordion-meta">
                {student.userId ? `${student.userId} · ` : ''}
                {student.grade || '—'}
              </span>
              <span className="portal-student-accordion-chevron" aria-hidden="true">
                {isOpen ? '▼' : '▶'}
              </span>
            </button>
            {isOpen ? (
              <div
                id={`${rowId}-panel`}
                className="portal-student-accordion-panel"
                role="region"
                aria-labelledby={rowId}
              >
                <p className="portal-student-accordion-email">{student.email}</p>
                <PortalAssignmentTable assignments={student.assignments} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function PortalAdminClassStudentTable({ classLabel, students }) {
  if (!students.length) {
    return (
      <p className="portal-roster-status">
        No students found for this class. Run <strong>Classroom sync</strong> to refresh rosters and
        grades, or check that students are enrolled in Google Classroom.
      </p>
    );
  }

  return (
    <div className="portal-admin-table-wrap">
      <table className="portal-admin-table portal-admin-class-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">AESOP ID</th>
            <th scope="col">Ding number</th>
            <th scope="col">Grade</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {students.map((student) => (
            <tr key={studentRowKey(classLabel, student.email)}>
              <td>{student.name || '—'}</td>
              <td className="portal-admin-mono">{student.userId || '—'}</td>
              <td className="portal-admin-mono">{student.dingNumber || '—'}</td>
              <td>{student.grade || '—'}</td>
              <td>
                {student.userId ? (
                  <PortalAdminImpersonateActions targetUserId={student.userId} compact />
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PortalAdminAllClassesRoster() {
  const { status, classes, error } = useAdminClassList(true);
  const [openCourseId, setOpenCourseId] = useState('');
  const [rosters, setRosters] = useState({});

  const loadClassRoster = useCallback(async (courseId) => {
    if (!courseId) {
      return;
    }
    let shouldFetch = false;
    setRosters((prev) => {
      const existing = prev[courseId];
      if (existing?.status === 'ready') {
        return prev;
      }
      shouldFetch = true;
      return { ...prev, [courseId]: { status: 'loading', students: [], error: '' } };
    });
    if (!shouldFetch) {
      return;
    }
    try {
      const data = await adminApiPost('/api/portal-admin/class-roster', { courseId });
      setRosters((prev) => ({
        ...prev,
        [courseId]: {
          status: 'ready',
          students: Array.isArray(data.students) ? data.students : [],
          error: '',
        },
      }));
    } catch (err) {
      setRosters((prev) => ({
        ...prev,
        [courseId]: {
          status: 'error',
          students: [],
          error: err.message || 'Could not load this class.',
        },
      }));
    }
  }, []);

  const toggleClass = (courseId) => {
    setOpenCourseId((prev) => {
      const next = prev === courseId ? '' : courseId;
      if (next) {
        loadClassRoster(next);
      }
      return next;
    });
  };

  return (
    <section className="portal-roster portal-admin-all-classes" aria-label="All classes">
      <p className="portal-admin-hint">
        Class names load first. Open a class to see its roster and grades from the synced{' '}
        <strong>Classroom Grades</strong> sheet (run Classroom sync to refresh).
      </p>
      {status === 'ready' && classes.length > 0 ? (
        <p className="portal-admin-hint">
          {classes.length} active class{classes.length === 1 ? '' : 'es'} found.
        </p>
      ) : null}
      {status === 'loading' ? (
        <p className="portal-roster-status">Loading class list from Google Classroom…</p>
      ) : null}
      {status === 'error' ? (
        <p className="portal-roster-status portal-roster-status--error" role="alert">
          {error}
        </p>
      ) : null}
      {status === 'ready' && classes.length === 0 ? (
        <p className="portal-roster-status">No accessible classes found.</p>
      ) : null}
      {status === 'ready' && classes.length > 0 ? (
        <div className="portal-class-accordion" aria-label="All classes">
          {classes.map((cls) => {
            const tabId = classTabId(`admin-${cls.courseId}`);
            const isOpen = openCourseId === cls.courseId;
            const roster = rosters[cls.courseId];
            const studentMeta =
              roster?.status === 'ready'
                ? `${roster.students.length} ${roster.students.length === 1 ? 'student' : 'students'}`
                : roster?.status === 'loading'
                  ? 'Loading…'
                  : typeof cls.studentCount === 'number' && cls.studentCount > 0
                    ? `${cls.studentCount} ${cls.studentCount === 1 ? 'student' : 'students'}`
                    : 'Open to load';
            return (
              <div className="portal-class-accordion-item" key={cls.courseId}>
                <button
                  type="button"
                  id={tabId}
                  className={`portal-class-accordion-tab${isOpen ? ' is-active' : ''}`}
                  aria-expanded={isOpen}
                  aria-controls={`${tabId}-panel`}
                  onClick={() => toggleClass(cls.courseId)}
                >
                  <span className="portal-class-accordion-label">
                    <span className="portal-class-accordion-course">{cls.label}</span>
                    {Array.isArray(cls.teacherNames) && cls.teacherNames.length > 0 ? (
                      <span className="portal-class-accordion-teachers">
                        {cls.teacherNames.join(', ')}
                      </span>
                    ) : null}
                  </span>
                  <span className="portal-class-accordion-meta">{studentMeta}</span>
                  <span className="portal-class-accordion-chevron" aria-hidden="true">
                    {isOpen ? '▼' : '▶'}
                  </span>
                </button>
                {isOpen ? (
                  <div
                    id={`${tabId}-panel`}
                    className="portal-class-accordion-panel"
                    role="region"
                    aria-labelledby={tabId}
                  >
                    {roster?.status === 'loading' ? (
                      <p className="portal-roster-status">Loading students and grades…</p>
                    ) : null}
                    {roster?.status === 'error' ? (
                      <p className="portal-roster-status portal-roster-status--error" role="alert">
                        {roster.error}
                      </p>
                    ) : null}
                    {roster?.status === 'ready' ? (
                      <PortalAdminClassStudentTable
                        classLabel={cls.label}
                        students={roster.students}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function PortalTeacherRoster({ rosterEnabled, isAdminView }) {
  const { status, classes, error } = useTeacherRoster(rosterEnabled);
  const [openClassLabel, setOpenClassLabel] = useState('');
  const [openStudentKey, setOpenStudentKey] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const searchResults = useMemo(() => {
    if (!normalizedSearch || status !== 'ready') {
      return [];
    }
    const results = [];
    for (const cls of classes) {
      for (const student of cls.students) {
        if (matchesStudentSearch(student, normalizedSearch)) {
          results.push({
            classLabel: cls.label,
            student,
            rowKey: studentRowKey(cls.label, student.email),
          });
        }
      }
    }
    results.sort((a, b) =>
      (a.student.name || a.student.email).localeCompare(b.student.name || b.student.email),
    );
    return results.slice(0, 25);
  }, [classes, normalizedSearch, status]);

  const toggleClassPanel = (label) => {
    setOpenClassLabel((prev) => {
      const next = prev === label ? '' : label;
      if (next !== prev) {
        setOpenStudentKey('');
      }
      return next;
    });
  };

  const toggleStudentPanel = (rowKey) => {
    setOpenStudentKey((prev) => (prev === rowKey ? '' : rowKey));
  };

  const jumpToSearchResult = (result) => {
    setOpenClassLabel(result.classLabel);
    setOpenStudentKey(result.rowKey);
    setSearchQuery('');
  };

  if (!rosterEnabled) {
    return null;
  }

  return (
    <section className="portal-roster" aria-label={isAdminView ? 'Class rosters' : 'Your classes'}>
      <h3 className="portal-roster-heading">{isAdminView ? 'Class rosters' : 'Your classes'}</h3>
      {status === 'ready' && classes.length > 0 ? (
        <div className="portal-roster-search-wrap">
          <label htmlFor="portal-roster-search" className="portal-roster-search-label">
            Search students
          </label>
          <input
            id="portal-roster-search"
            type="search"
            className="portal-roster-search-input"
            placeholder="Name, AESOP ID, or email"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            autoComplete="off"
          />
          {normalizedSearch ? (
            <div className="portal-roster-search-results" role="listbox" aria-label="Search results">
              {searchResults.length === 0 ? (
                <p className="portal-roster-status">No students match your search.</p>
              ) : (
                searchResults.map((result) => (
                  <button
                    key={result.rowKey}
                    type="button"
                    className="portal-roster-search-result"
                    role="option"
                    onClick={() => jumpToSearchResult(result)}
                  >
                    <span className="portal-roster-search-result-name">
                      {result.student.name || result.student.email}
                    </span>
                    <span className="portal-roster-search-result-meta">
                      {result.student.userId ? `${result.student.userId} · ` : ''}
                      {result.classLabel} · {result.student.grade || '—'}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {status === 'loading' ? (
        <p className="portal-roster-status">Loading your roster…</p>
      ) : null}
      {status === 'error' ? (
        <p className="portal-roster-status portal-roster-status--error" role="alert">
          {error}
        </p>
      ) : null}
      {status === 'ready' && classes.length === 0 ? (
        <p className="portal-roster-status">No active classes found for your account.</p>
      ) : null}
      {status === 'ready' && classes.length > 0 ? (
        <div className="portal-class-accordion" aria-label="Class list">
          {classes.map((cls) => {
            const tabId = classTabId(cls.label);
            const isOpen = openClassLabel === cls.label;
            return (
              <div className="portal-class-accordion-item" key={cls.label}>
                <button
                  type="button"
                  id={tabId}
                  className={`portal-class-accordion-tab${isOpen ? ' is-active' : ''}`}
                  aria-expanded={isOpen}
                  aria-controls={`${tabId}-panel`}
                  onClick={() => toggleClassPanel(cls.label)}
                >
                  <span className="portal-class-accordion-label">{cls.label}</span>
                  <span className="portal-class-accordion-meta">
                    {cls.students.length} {cls.students.length === 1 ? 'student' : 'students'}
                  </span>
                  <span className="portal-class-accordion-chevron" aria-hidden="true">
                    {isOpen ? '▼' : '▶'}
                  </span>
                </button>
                {isOpen ? (
                  <div
                    id={`${tabId}-panel`}
                    className="portal-class-accordion-panel"
                    role="region"
                    aria-labelledby={tabId}
                  >
                    <PortalTeacherStudentList
                      classLabel={cls.label}
                      students={cls.students}
                      openStudentKey={openStudentKey}
                      onToggleStudent={toggleStudentPanel}
                      searchQuery={normalizedSearch}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function clearPortalSession() {
  if (typeof sessionStorage === 'undefined') return;
  PORTAL_SESSION_STORAGE_KEYS.forEach((key) => sessionStorage.removeItem(key));
  sessionStorage.removeItem(PORTAL_IMPERSONATING_KEY);
  sessionStorage.removeItem(PORTAL_IMPERSONATION_ROLE_KEY);
  sessionStorage.removeItem(PORTAL_ADMIN_SESSION_BACKUP_KEY);
  sessionStorage.removeItem(PORTAL_SESSION_EXPIRES_AT_KEY);
  clearAdminSessionFromLocalStorage();
}

function logOutPortalClient() {
  clearPortalSession();
  window.location.assign(portalHubHref());
}

function getPortalUrlIntent() {
  if (typeof window === 'undefined') return '';
  const raw = new URLSearchParams(window.location.search).get('intent');
  return raw === 'profile' || raw === 'faq' ? raw : '';
}

/** Ding history instant from the sheet (UTC ms); formatted in this device’s local timezone */
function formatPortalDingHistoryAt(atMs) {
  let ms = atMs;
  if (typeof ms === 'string') {
    const n = Number(ms);
    ms = Number.isFinite(n) ? n : NaN;
  }
  if (ms == null || !Number.isFinite(ms)) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      calendar: 'gregory',
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      hourCycle: 'h12',
      timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return '—';
    }
  }
}

function MagicLinkRequestForm({ inputId, submitLabel }) {
  const { locale, t } = usePortalI18n();
  const resolvedSubmitLabel = submitLabel || t('magicLink.submit');
  const [userId, setUserId] = useState(() => readRememberedUserId());
  const [rememberUserId, setRememberUserId] = useState(() => readRememberUserIdEnabled());
  const [status, setStatus] = useState({ type: '', text: '' });
  const [devLoginUrl, setDevLoginUrl] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = useMemo(
    () => userId.trim().length > 0 && !isSubmitting,
    [userId, isSubmitting],
  );

  const handleUserIdChange = (event) => {
    const nextUserId = event.target.value;
    setUserId(nextUserId);
    if (rememberUserId) {
      persistRememberUserId(nextUserId, true);
    }
  };

  const handleRememberChange = (event) => {
    const enabled = event.target.checked;
    setRememberUserId(enabled);
    persistRememberUserId(userId, enabled);
  };

  const requestMagicLink = async () => {
    if (!canSubmit) {
      return;
    }

    const trimmedUserId = userId.trim();

    if (!trimmedUserId || trimmedUserId.length > 100) {
      setStatus({ type: 'error', text: t('magicLink.invalidId') });
      setDevLoginUrl('');
      return;
    }

    setStatus({ type: 'loading', text: t('magicLink.sending') });
    setDevLoginUrl('');
    setIsSubmitting(true);

    try {
      const result = await postMagicLinkRequest(trimmedUserId, { t });

      if (!result.ok) {
        setStatus({
          type: 'error',
          text: result.message,
        });
        return;
      }

      const loginUrl = String(result.data?.loginUrl || '').trim();
      setDevLoginUrl(loginUrl);
      setStatus({
        type: 'success',
        text: loginUrl ? t('magicLink.linkSentDev') : t('magicLink.linkSent'),
      });
      persistRememberUserId(trimmedUserId, rememberUserId);
    } catch {
      setStatus({ type: 'error', text: t('magicLink.networkError') });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="magic-link-request-inner">
      <div className="form-group">
        <label htmlFor={inputId}>{t('magicLink.aesopId')}</label>
        <input
          type="text"
          id={inputId}
          name="userId"
          required
          autoComplete="username"
          placeholder={t('magicLink.enterId')}
          dir={locale === 'fa' ? 'ltr' : undefined}
          className={locale === 'fa' ? 'portal-ltr-input' : undefined}
          value={userId}
          onChange={handleUserIdChange}
          disabled={isSubmitting}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              requestMagicLink();
            }
          }}
        />
      </div>
      <label className="portal-remember-id" htmlFor={`${inputId}-remember`}>
        <input
          id={`${inputId}-remember`}
          type="checkbox"
          checked={rememberUserId}
          onChange={handleRememberChange}
          disabled={isSubmitting}
        />
        <span>{t('magicLink.rememberId')}</span>
      </label>
      <button type="button" onClick={requestMagicLink} disabled={!canSubmit} aria-disabled={!canSubmit}>
        {resolvedSubmitLabel}
      </button>
      <div className={`status ${status.type || ''}`} aria-live="polite">
        {status.text}
      </div>
      {devLoginUrl ? (
        <div className="magic-link-dev-login" role="status">
          <p className="magic-link-dev-login-label">{t('magicLink.devLinkLabel')}</p>
          <a className="magic-link-dev-login-url portal-ltr" href={devLoginUrl} dir="ltr">
            {devLoginUrl}
          </a>
        </div>
      ) : null}
    </div>
  );
}

function PortalSignInOnlyContent({ inputId = 'portalMagicUserId' }) {
  const { t } = usePortalI18n();
  return (
    <>
      <h2 className="portal-welcome portal-welcome-signout">{t('hub.studentPortalTitle')}</h2>
      <div id="portal-magic-link-form" className="portal-signin-panel">
        <h3 className="portal-signin-heading">{t('hub.signInHeading')}</h3>
        <p className="portal-signin-lead">{t('hub.signInLead')}</p>
        <p className="portal-signin-id-hint">{t('hub.signInIdHint')}</p>
        <MagicLinkRequestForm inputId={inputId} />
      </div>
      <p className="portal-hub-footnote">
        <a href="https://aesopafghanistan.org/">aesopafghanistan.org</a>
      </p>
    </>
  );
}

function RequestMagicLinkApp() {
  return (
    <div className="container">
      <div className="login-brand-mark">
        <img
          className="login-logo"
          src="/images/aesop-logo.webp"
          alt=""
          width={220}
          height={63}
          decoding="async"
        />
      </div>
      <h1>AESOP Afghanistan</h1>
      <p className="subtitle">Enter your AESOP ID to receive a login link</p>
      <MagicLinkRequestForm inputId="userId" submitLabel="Send Login Link" />
    </div>
  );
}

function VerifyMagicLinkApp() {
  const t = (key, params) => translatePortalText(getStoredPortalLocale(), key, params);
  const [status, setStatus] = useState(() => t('verify.verifying'));
  const [message, setMessage] = useState({ type: '', text: '' });
  const [devLoginUrl, setDevLoginUrl] = useState('');
  const [showSpinner, setShowSpinner] = useState(true);
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [canResendByToken, setCanResendByToken] = useState(false);
  const [canOneClickResend, setCanOneClickResend] = useState(false);
  const [linkToken, setLinkToken] = useState('');
  const [showIdForm, setShowIdForm] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const canSendAgain = !isResending;

  const verifyFailureMessage = (reason, oneClickResend) => {
    if (!oneClickResend) {
      return t('verify.failedEnterId');
    }
    if (reason === 'expired') {
      return t('verify.expiredCanResend');
    }
    if (reason === 'used') {
      return t('verify.usedCanResend');
    }
    return t('verify.failedCanResend');
  };

  useEffect(() => {
    const runVerification = async () => {
      // Prefer the URL fragment (never sent to the server/logs); fall back to
      // the query string for any older links still in inboxes.
      const hashParams = new URLSearchParams(
        window.location.hash.startsWith('#')
          ? window.location.hash.slice(1)
          : window.location.hash,
      );
      const token =
        hashParams.get('token') ||
        new URLSearchParams(window.location.search).get('token');

      if (token) {
        // Drop the token from the address bar/history; it lives in state now.
        try {
          window.history.replaceState(null, '', window.location.pathname);
        } catch {
          // Non-fatal: verification proceeds with the token already in memory.
        }
      }

      if (!token) {
        setStatus(t('verify.invalidLink'));
        setShowSpinner(false);
        setMessage({ type: 'error', text: t('verify.noToken') });
        setVerificationFailed(true);
        setShowIdForm(true);
        return;
      }

      setLinkToken(token);

      if (!/^[a-f0-9]{64}$/i.test(token)) {
        setStatus(t('verify.invalidLink'));
        setShowSpinner(false);
        setMessage({ type: 'error', text: t('verify.invalidToken') });
        setVerificationFailed(true);
        setShowIdForm(true);
        return;
      }

      try {
        const response = await fetch('/api/verify-magic-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        let data = {};
        try {
          data = await response.json();
        } catch {
          data = {};
        }
        setShowSpinner(false);

        if (response.ok && data.success) {
          setStatus('Success!');
          setMessage({ type: 'success', text: t('verify.success') });
          try {
            applyPortalSessionFromApi(data, { allowAdmin: true });
          } catch (sessionError) {
            console.error('Could not save portal session after verify:', sessionError);
            setStatus('Error');
            setMessage({
              type: 'error',
              text: sessionError?.message || t('verify.sessionError'),
            });
            setVerificationFailed(true);
            return;
          }
          window.setTimeout(() => {
            window.location.assign(portalHubHref());
          }, 600);
          return;
        }

        const pendingUserId = sessionStorage.getItem('studentPortalPendingMagicUserId')?.trim();
        const resendByToken = data.canResend === true;
        const oneClickResend = resendByToken || !!pendingUserId;

        setStatus(t('verify.failed'));
        setMessage({
          type: 'error',
          text:
            response.status === 401
              ? verifyFailureMessage(data.reason, oneClickResend)
              : data.error ||
                (response.ok
                  ? t('verify.failedEnterId')
                  : `Request failed (HTTP ${response.status}). Try again.`),
        });
        setVerificationFailed(true);
        setCanResendByToken(resendByToken);
        setCanOneClickResend(oneClickResend);
        setShowIdForm(!oneClickResend);
      } catch (error) {
        setShowSpinner(false);
        setStatus('Error');
        setMessage({
          type: 'error',
          text: t('verify.networkError'),
        });
        setVerificationFailed(true);
        const pendingUserId = sessionStorage.getItem('studentPortalPendingMagicUserId')?.trim();
        setCanOneClickResend(!!pendingUserId);
        setShowIdForm(!pendingUserId);
      }
    };

    runVerification();
  }, []);

  const requestMagicLinkByUserId = async (userId) => {
    setIsResending(true);
    setMessage({ type: 'loading', text: t('magicLink.sending') });
    setDevLoginUrl('');

    try {
      const result = await postMagicLinkRequest(userId, { t });

      if (!result.ok) {
        setStatus(t('verify.failed'));
        setMessage({
          type: 'error',
          text: result.message,
        });
        setShowIdForm(true);
        return;
      }

      const loginUrl = String(result.data?.loginUrl || '').trim();
      setDevLoginUrl(loginUrl);
      setStatus(t('verify.checkEmail'));
      setMessage({
        type: 'success',
        text: loginUrl ? t('magicLink.linkSentDev') : t('magicLink.linkSent'),
      });
      setVerificationFailed(false);
    } catch {
      setStatus('Error');
      setMessage({ type: 'error', text: t('magicLink.networkError') });
      setShowIdForm(true);
    } finally {
      setIsResending(false);
    }
  };

  const handleSendAgain = async () => {
    if (!canSendAgain) {
      return;
    }

    if (canResendByToken && linkToken) {
      setIsResending(true);
      setMessage({ type: 'loading', text: t('magicLink.sending') });
      setDevLoginUrl('');

      try {
        const result = await postResendMagicLink(linkToken, { t });

        if (result.ok) {
          const loginUrl = String(result.data?.loginUrl || '').trim();
          setDevLoginUrl(loginUrl);
          setStatus(t('verify.checkEmail'));
          setMessage({
            type: 'success',
            text: loginUrl
              ? t('magicLink.linkSentDev')
              : result.data?.message || t('magicLink.linkSent'),
          });
          setVerificationFailed(false);
          setCanOneClickResend(false);
          return;
        }

        if (!result.ok) {
          const pendingUserId = sessionStorage.getItem('studentPortalPendingMagicUserId')?.trim();
          if (pendingUserId) {
            await requestMagicLinkByUserId(pendingUserId);
            return;
          }

          setMessage({
            type: 'error',
            text: result.message || t('magicLink.resendFailed'),
          });
          setShowIdForm(true);
          return;
        }
      } catch {
        setMessage({ type: 'error', text: t('magicLink.networkError') });
        setShowIdForm(true);
      } finally {
        setIsResending(false);
      }
      return;
    }

    const pendingUserId = sessionStorage.getItem('studentPortalPendingMagicUserId')?.trim();
    if (pendingUserId) {
      await requestMagicLinkByUserId(pendingUserId);
      return;
    }

    setShowIdForm(true);
  };

  return (
    <div className="container verify-container">
      {showSpinner ? <div className="spinner" /> : null}
      <h2>{status}</h2>
      <div className={`message ${message.type || ''}`}>{message.text}</div>
      {devLoginUrl ? (
        <div className="magic-link-dev-login" role="status">
          <p className="magic-link-dev-login-label">{t('magicLink.devLinkLabel')}</p>
          <a className="magic-link-dev-login-url portal-ltr" href={devLoginUrl} dir="ltr">
            {devLoginUrl}
          </a>
        </div>
      ) : null}
      {verificationFailed && canOneClickResend && !showIdForm ? (
        <div className="verify-resend">
          <button
            type="button"
            className="verify-resend-btn"
            onClick={handleSendAgain}
            disabled={!canSendAgain}
            aria-disabled={!canSendAgain}
          >
            {t('magicLink.resendOneClick')}
          </button>
        </div>
      ) : null}
      {verificationFailed && showIdForm ? (
        <div className="verify-resend-form">
          <MagicLinkRequestForm inputId="verifyUserId" submitLabel={t('magicLink.resendOneClick')} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Role pill adapted from the AESOP Dashboard's RoleNav badge. Shows Teacher or
 * Student only when the role is known (from the Classroom sync / sheets).
 */
function PortalRoleBadge({ isTeacher, hasStudentCategory, isAdmin, isApplied, className }) {
  const { t } = usePortalI18n();
  if (isAdmin) {
    const classes = ['portal-role-badge', 'portal-role-badge--admin', className].filter(Boolean).join(' ');
    return <span className={classes}>{t('role.admin')}</span>;
  }
  if (isApplied) {
    const classes = ['portal-role-badge', 'portal-role-badge--applied', className].filter(Boolean).join(' ');
    return <span className={classes}>{t('role.applicant')}</span>;
  }
  if (!isTeacher && !hasStudentCategory) {
    return null;
  }
  if (isTeacher && hasStudentCategory) {
    return (
      <span className={['portal-role-badges', className].filter(Boolean).join(' ')}>
        <span className="portal-role-badge portal-role-badge--teacher">{t('role.teacher')}</span>
        <span className="portal-role-badge portal-role-badge--student">{t('role.student')}</span>
      </span>
    );
  }
  const variant = isTeacher ? 'portal-role-badge--teacher' : 'portal-role-badge--student';
  const classes = ['portal-role-badge', variant, className].filter(Boolean).join(' ');
  return <span className={classes}>{isTeacher ? t('role.teacher') : t('role.student')}</span>;
}

function parsePortalClassList(raw) {
  if (!raw || !String(raw).trim()) {
    return [];
  }
  const text = String(raw).trim();
  if (text.includes(' | ')) {
    return text
      .split(' | ')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Show one class name, or the first plus a "more classes" control listing the rest. */
function PortalMultiClassList({
  value,
  classGrades,
  emptyDisplay = '—',
  className,
  moreLabel = 'more classes',
  moreAriaLabel = 'Additional classes',
}) {
  const items = useMemo(() => {
    const grades = normalizeClassGrades(classGrades);
    if (grades.length > 0) {
      return grades.map((row) => row.classSection).filter(Boolean);
    }
    return parsePortalClassList(value);
  }, [value, classGrades]);

  if (items.length === 0) {
    return <span className={className}>{emptyDisplay}</span>;
  }
  if (items.length === 1) {
    return <span className={className}>{items[0]}</span>;
  }
  const [first, ...rest] = items;
  return (
    <span className={['portal-multi-class-list', className].filter(Boolean).join(' ')}>
      <span className="portal-multi-class-list-primary">{first}</span>{' '}
      <details className="portal-multi-class-more">
        <summary className="portal-multi-class-more-trigger">{moreLabel}</summary>
        <ul className="portal-multi-class-more-list" aria-label={moreAriaLabel}>
          {rest.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </details>
    </span>
  );
}

function formatClassGradeLabel(row, emptyDisplay = '—') {
  const section = row?.classSection ? String(row.classSection).trim() : '';
  const grade = row?.calculatedGrade ? String(row.calculatedGrade).trim() : '';
  if (section && grade) {
    return `${section} · ${grade}`;
  }
  if (section) {
    return section;
  }
  if (grade) {
    return grade;
  }
  return emptyDisplay;
}

/** Show the first grade, with additional class grades under "more classes". */
function PortalClassGradeList({
  classGrades,
  fallbackClass,
  fallbackGrade,
  emptyDisplay = '—',
  moreLabel = 'more classes',
  moreAriaLabel = 'Additional class grades',
}) {
  let items = normalizeClassGrades(classGrades);
  if (items.length === 0) {
    const classes = parsePortalClassList(fallbackClass);
    if (classes.length > 0) {
      const grade = typeof fallbackGrade === 'string' ? fallbackGrade.trim() : '';
      items = classes.map((classSection, index) => ({
        classSection,
        calculatedGrade: index === 0 ? grade : '',
      }));
    }
  }
  if (items.length === 0) {
    const single = typeof fallbackGrade === 'string' ? fallbackGrade.trim() : '';
    return single || emptyDisplay;
  }
  if (items.length === 1) {
    return formatClassGradeLabel(items[0], emptyDisplay);
  }
  const [first, ...rest] = items;
  return (
    <span className="portal-multi-class-list">
      <span className="portal-multi-class-list-primary">{formatClassGradeLabel(first, emptyDisplay)}</span>{' '}
      <details className="portal-multi-class-more">
        <summary className="portal-multi-class-more-trigger">{moreLabel}</summary>
        <ul className="portal-multi-class-more-list" aria-label={moreAriaLabel}>
          {rest.map((row) => (
            <li key={row.classSection || row.calculatedGrade}>
              {formatClassGradeLabel(row, emptyDisplay)}
            </li>
          ))}
        </ul>
      </details>
    </span>
  );
}

function PortalLayout({ children }) {
  const { t } = usePortalI18n();
  const portalHomeHref = portalHubHref();
  const signedIn = isPortalSessionCompleteSync();
  const impersonating = isPortalImpersonating();
  const fullName = readSessionField('studentPortalName').trim();
  const aesopId = readSessionField('studentPortalUserId').trim();
  const headerEmail = readSessionField('studentPortalEmail').trim();
  const { studentClass, studentGrade, classGrades, teacherClasses, showStudentFields, showTeacherFields, hasApplicantPortalAccess } =
    usePortalProfileSections();

  const dash = '—';
  const fullNameDisplay = fullName || dash;
  const gradeDisplay = (
    <PortalClassGradeList
      classGrades={classGrades}
      fallbackClass={studentClass}
      fallbackGrade={studentGrade}
      emptyDisplay={dash}
    />
  );
  const profileHeaderLabel = impersonating ? 'Person profile' : t('header.yourProfile');

  return (
    <div className="portal-page">
      <header className="portal-header">
        <div className="portal-header-inner">
          <div className="portal-header-col portal-header-col--brand">
            <div className="portal-header-brand">
              <span className="portal-header-brand-accent" aria-hidden="true" />
              <div className="portal-header-brand-text">
                <p className="portal-header-kicker">AESOP Afghanistan</p>
                <h1 className="portal-header-title">{t('header.studentPortal')}</h1>
                <p className="portal-header-tagline">
                  <span className="portal-header-tagline-part">{t('header.taglineEducation')}</span>
                  <span className="portal-header-tagline-dot" aria-hidden="true">
                    ·
                  </span>
                  <span className="portal-header-tagline-part">{t('header.taglineService')}</span>
                  <span className="portal-header-tagline-dot" aria-hidden="true">
                    ·
                  </span>
                  <span className="portal-header-tagline-part">{t('header.taglineCommunity')}</span>
                </p>
              </div>
            </div>
            <PortalLanguageToggle />
          </div>
          <div className="portal-header-col portal-header-col--logo">
            {impersonating ? (
              <div className="portal-header-impersonation" role="status">
                <p className="portal-header-impersonation-kicker">Admin impersonation</p>
                <p className="portal-header-impersonation-title">You&apos;re viewing this person&apos;s profile</p>
                <p className="portal-header-impersonation-name">{fullNameDisplay}</p>
                <p className="portal-header-impersonation-meta">
                  {aesopId ? `AESOP ID ${aesopId}` : 'AESOP ID unavailable'}
                </p>
                <button
                  type="button"
                  className="portal-header-impersonation-back"
                  onClick={() => stopPortalImpersonation()}
                >
                  Back to admin page
                </button>
              </div>
            ) : (
              <a href={portalHomeHref} className="portal-header-logo-link" aria-label={t('header.homeAria')}>
                <img
                  className="portal-logo portal-logo--header-center"
                  src="/images/aesop-logo.webp"
                  width={280}
                  height={80}
                  alt=""
                  decoding="async"
                />
              </a>
            )}
          </div>
          <div className="portal-header-col portal-header-col--student">
            {signedIn ? (
              <div className="portal-header-student-wrap">
                {hasApplicantPortalAccess || impersonating ? (
                  <dl
                    className="portal-header-id-meta"
                    aria-label={profileHeaderLabel}
                  >
                    <dt className="portal-header-id-label">{t('header.fullName')}</dt>
                    <dd className="portal-header-id-value">{fullNameDisplay}</dd>
                    <dt className="portal-header-id-label">{t('header.aesopId')}</dt>
                    <dd className="portal-header-id-value portal-header-id-mono portal-ltr">{aesopId || dash}</dd>
                    <dt className="portal-header-id-label">{t('header.email')}</dt>
                    <dd className="portal-header-id-value portal-header-id-email portal-ltr">{headerEmail || dash}</dd>
                    {showStudentFields ? (
                      <>
                        <dt className="portal-header-id-label">{t('header.class')}</dt>
                        <dd className="portal-header-id-value">
                          <PortalMultiClassList
                            value={studentClass}
                            classGrades={classGrades}
                            emptyDisplay={dash}
                          />
                        </dd>
                        <dt className="portal-header-id-label">{t('header.grade')}</dt>
                        <dd className="portal-header-id-value">{gradeDisplay}</dd>
                      </>
                    ) : null}
                    {showTeacherFields ? (
                      <>
                        <dt className="portal-header-id-label">{t('header.teaching')}</dt>
                        <dd className="portal-header-id-value">
                          <PortalMultiClassList
                            value={teacherClasses}
                            emptyDisplay={dash}
                            moreAriaLabel="Additional teaching classes"
                          />
                        </dd>
                      </>
                    ) : null}
                  </dl>
                ) : null}
                {impersonating ? null : (
                  <button type="button" className="portal-header-logout" onClick={() => logOutPortalClient()}>
                    {t('header.logOff')}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <main className="portal-main">{children}</main>
      <footer className="portal-footer">
        <a href="https://aesopafghanistan.org/" target="_blank" rel="noopener noreferrer">
          aesopafghanistan.org
        </a>
        <span className="portal-footer-sep" aria-hidden="true">
          ·
        </span>
        <span>Afghan Education Student Outreach Project</span>
      </footer>
    </div>
  );
}

function PortalSectionLinks({ current, isAdmin, isReviewer, showEditDingLink = true }) {
  const { t } = usePortalI18n();
  const hubHref = portalHubHref();
  const isApplicant = readPortalIsApplicant();
  // Fall back to session when callers (admin pages) omit isReviewer.
  const resolvedReviewer = isReviewer === true || readPortalIsReviewer();
  // Admins/reviewers use Review Applications instead of Edit Ding; applicants never manage Ding.
  const showEditDing = showEditDingLink && !resolvedReviewer && !isAdmin && !isApplicant;
  const showReviewsLink = resolvedReviewer || isAdmin;
  // For applicants the only destination is "Profile", so drop the tab bar entirely and
  // leave just the "Welcome" heading. Everyone else (students, reviewers, admins) keeps
  // their nav so they never lose access to their tabs.
  const hasExtraLinks = showEditDing || showReviewsLink || isAdmin;
  if (isApplicant && !hasExtraLinks) {
    return null;
  }
  return (
    <nav className="portal-section-links" aria-label={t('nav.portalNav')}>
      <a href={hubHref} className={current === 'hub' ? 'is-current' : undefined}>
        {t('nav.profile')}
      </a>
      {showEditDing ? (
        <>
          <span className="portal-section-links-sep" aria-hidden="true">
            ·
          </span>
          <a href="/profile" className={current === 'profile' ? 'is-current' : undefined}>
            {t('nav.editDing')}
          </a>
        </>
      ) : null}
      {showReviewsLink ? (
        <>
          <span className="portal-section-links-sep" aria-hidden="true">
            ·
          </span>
          <a href="/reviews" className={current === 'reviews' ? 'is-current' : undefined}>
            {t('nav.reviewApplications')}
          </a>
        </>
      ) : null}
      {isAdmin ? (
        <>
          <span className="portal-section-links-sep" aria-hidden="true">
            ·
          </span>
          <a href="/admin" className={current === 'admin' ? 'is-current' : undefined}>
            {t('nav.admin')}
          </a>
          <span className="portal-section-links-sep" aria-hidden="true">
            ·
          </span>
          <a href="/admin/emails" className={current === 'admin-emails' ? 'is-current' : undefined}>
            {t('nav.compose')}
          </a>
          <span className="portal-section-links-sep" aria-hidden="true">
            ·
          </span>
          <a href="/admin/campaigns" className={current === 'admin-campaigns' ? 'is-current' : undefined}>
            {t('nav.campaigns')}
          </a>
          <span className="portal-section-links-sep" aria-hidden="true">
            ·
          </span>
          <a href="/admin/stats" className={current === 'admin-stats' ? 'is-current' : undefined}>
            {t('nav.stats')}
          </a>
        </>
      ) : null}
    </nav>
  );
}

function usePortalStudentRecord() {
  const [studentName] = useState(() => readSessionField('studentPortalName'));
  const [studentEmail] = useState(() => readSessionField('studentPortalEmail'));
  const [studentUserId] = useState(() => readSessionField('studentPortalUserId'));
  const [studentPhone] = useState(() => readSessionField('studentPortalPhone'));
  const [newDingNumber, setNewDingNumber] = useState(() => readSessionField('studentPortalNewDingNumber'));

  const canUpdateDing =
    studentUserId.length > 0 &&
    studentEmail.length > 0 &&
    !readPortalIsApplicant() &&
    !readPortalIsReviewer();
  return {
    studentName,
    studentEmail,
    studentUserId,
    studentPhone,
    newDingNumber,
    setNewDingNumber,
    canUpdateDing,
  };
}

const VOICE_MEMO_SIGNAL_INSTALL_URL = 'https://signal.org/install';
const VOICE_MEMO_SIGNAL_VIDEO_1_URL = 'https://www.youtube.com/watch?v=VFB0edv7VgI';
const VOICE_MEMO_SIGNAL_VIDEO_2_URL = 'https://youtu.be/OAfPYU2Ozs4';
const VOICE_MEMO_SIGNAL_CONTACT_URL =
  'https://signal.me/#eu/HQE6GTyq7KsEe7hRCzxDaZiySUygv1OcQG9_G1dFCi49lRW1BANKL4V7BS3DIdHf';

function PortalVoiceMemoWhySignalItem() {
  const { t } = usePortalI18n();
  return (
    <li>
      {t('voiceMemo.why1Before')}{' '}
      <a
        className="portal-ltr"
        href={VOICE_MEMO_SIGNAL_CONTACT_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        noreplyaesop.55
      </a>
      {t('voiceMemo.why1After')}
    </li>
  );
}

function PortalVoiceMemoReviewRequest({ aesopId }) {
  const { t } = usePortalI18n();
  const [copiedReviewMessage, setCopiedReviewMessage] = useState(false);
  const copyResetTimerRef = useRef(null);
  const idText = String(aesopId || '').trim();
  const reviewMessage = `Please review my voice note.\nMy AESOP ID is ${idText || '#####'}.`;

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const copyReviewMessage = useCallback(async () => {
    if (!idText) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(reviewMessage);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = reviewMessage;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedReviewMessage(true);
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = setTimeout(() => {
        setCopiedReviewMessage(false);
        copyResetTimerRef.current = null;
      }, 2000);
    } catch (err) {
      console.warn('Failed to copy voice note review message', err);
    }
  }, [idText, reviewMessage]);

  return (
    <div className="portal-voice-memo-why portal-voice-memo-review-request">
      <p className="portal-voice-memo-review-request-lead">
        {renderPortalRichText(t('voiceMemo.reviewRequest1'))}{' '}
        <a
          className="portal-ltr"
          href={VOICE_MEMO_SIGNAL_CONTACT_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          noreplyaesop.55
        </a>{' '}
        {renderPortalRichText(t('voiceMemo.reviewRequest2'))}
      </p>
      <div className="portal-voice-memo-review-request-message-row">
        <span className="portal-voice-memo-review-request-message portal-ltr" dir="ltr">
          Please review my voice note. My AESOP ID is {idText || '#####'}.
        </span>
        {idText ? (
          <button
            type="button"
            className="portal-voice-memo-copy-btn"
            onClick={copyReviewMessage}
          >
            {copiedReviewMessage
              ? t('voiceMemo.reviewRequestCopied')
              : t('voiceMemo.reviewRequestCopy')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PortalVoiceMemoResubmit({ aesopId }) {
  const { t } = usePortalI18n();
  const [showInstructions, setShowInstructions] = useState(false);

  return (
    <div className="portal-voice-memo-resubmit-block">
      <div className="portal-voice-memo-resubmit-actions">
        <a
          className="portal-voice-memo-resubmit-btn"
          href={VOICE_MEMO_SIGNAL_CONTACT_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('voiceMemo.resubmitButton')}
        </a>
        <button
          type="button"
          className="portal-voice-memo-resubmit-toggle"
          aria-expanded={showInstructions}
          onClick={() => setShowInstructions((open) => !open)}
        >
          {showInstructions
            ? t('voiceMemo.resubmitSummaryHide')
            : t('voiceMemo.resubmitSummary')}
        </button>
      </div>
      {showInstructions ? <PortalVoiceMemoInstructions aesopId={aesopId} /> : null}
    </div>
  );
}

function PortalVoiceMemoSubmissionDetails({ aesopId }) {
  const { t } = usePortalI18n();
  return (
    <>
      <div className="portal-voice-memo-why">
        <p className="portal-voice-memo-why-title">{t('voiceMemo.whyTitle2')}</p>
        <ul className="portal-voice-memo-why-list">
          <li>{renderPortalRichText(t('voiceMemo.goodToKnow1'))}</li>
          <li>{renderPortalRichText(t('voiceMemo.goodToKnow2'))}</li>
          <li>{renderPortalRichText(t('voiceMemo.goodToKnow3'))}</li>
        </ul>
      </div>
      <div className="portal-voice-memo-why">
        <p className="portal-voice-memo-why-title">{t('voiceMemo.whyTitle')}</p>
        <ul className="portal-voice-memo-why-list">
          <li>{renderPortalRichText(t('voiceMemo.why2'))}</li>
          <PortalVoiceMemoWhySignalItem />
          <li>{renderPortalRichText(t('voiceMemo.why3'))}</li>
          <li>{renderPortalRichText(t('voiceMemo.why4'))}</li>
          <li>{renderPortalRichText(t('voiceMemo.why5'))}</li>
        </ul>
      </div>
      <PortalVoiceMemoReviewRequest aesopId={aesopId} />
      <PortalVoiceMemoResubmit aesopId={aesopId} />
    </>
  );
}

function PortalVoiceMemoSubmissionSection({ aesopId, collapsible = false }) {
  const { t } = usePortalI18n();
  const [expanded, setExpanded] = useState(!collapsible);

  useEffect(() => {
    if (!collapsible) {
      setExpanded(true);
    }
  }, [collapsible]);

  return (
    <div className="portal-voice-memo-block">
      <div className="portal-voice-memo-block-header">
        <h3 className="portal-voice-memo-block-heading">
          {t('voiceMemo.submissionSectionTitle')}
        </h3>
        {collapsible ? (
          <button
            type="button"
            className="portal-voice-memo-section-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? t('voiceMemo.submissionHide') : t('voiceMemo.submissionShowMore')}
          </button>
        ) : null}
      </div>
      {collapsible ? (
        <p className="portal-voice-memo-submission-callout" role="status">
          {t('voiceMemo.submissionDoneCallout')}
        </p>
      ) : null}
      {expanded ? <PortalVoiceMemoSubmissionDetails aesopId={aesopId} /> : null}
    </div>
  );
}

function PortalVoiceMemoPrompt({ prompt, showLead = true }) {
  const { t } = usePortalI18n();
  const text = String(prompt || '').trim();
  if (!text) {
    return null;
  }
  return (
    <div className="portal-voice-memo-prompt">
      <p className="portal-voice-memo-prompt-title">{t('voiceMemo.promptTitle')}</p>
      <p className="portal-voice-memo-prompt-body" dir="auto">
        {text}
      </p>
      {showLead ? (
        <p className="portal-voice-memo-prompt-lead">{t('voiceMemo.promptLead')}</p>
      ) : null}
    </div>
  );
}

function PortalVoiceMemoInstructions({ aesopId }) {
  const { t } = usePortalI18n();
  const [copiedAesopId, setCopiedAesopId] = useState(false);
  const copyResetTimerRef = useRef(null);
  const idText = String(aesopId || '').trim();

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const copyAesopId = useCallback(async () => {
    if (!idText) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(idText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = idText;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedAesopId(true);
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = setTimeout(() => {
        setCopiedAesopId(false);
        copyResetTimerRef.current = null;
      }, 2000);
    } catch (err) {
      console.warn('Failed to copy AESOP ID', err);
    }
  }, [idText]);

  return (
    <div className="portal-voice-memo-instructions">
      <p className="portal-voice-memo-instructions-deadline">{t('voiceMemo.instrDeadline')}</p>
      <ol className="portal-voice-memo-steps">
        <li className="portal-voice-memo-step">
          <p className="portal-voice-memo-step-title">{t('voiceMemo.instrStep1Title')}</p>
          <p className="portal-voice-memo-step-body">
            {t('voiceMemo.instrStep1Body')}{' '}
            <a
              className="portal-ltr"
              href={VOICE_MEMO_SIGNAL_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              signal.org/install
            </a>
          </p>
          <p className="portal-voice-memo-step-help">
            {t('voiceMemo.instrStep1Help')}{' '}
            <a href={VOICE_MEMO_SIGNAL_VIDEO_1_URL} target="_blank" rel="noopener noreferrer">
              {t('voiceMemo.instrVideo1')}
            </a>
            <span aria-hidden="true"> · </span>
            <a href={VOICE_MEMO_SIGNAL_VIDEO_2_URL} target="_blank" rel="noopener noreferrer">
              {t('voiceMemo.instrVideo2')}
            </a>
          </p>
        </li>
        <li className="portal-voice-memo-step">
          <p className="portal-voice-memo-step-title">{t('voiceMemo.instrStep2Title')}</p>
          <p className="portal-voice-memo-step-body">
            {t('voiceMemo.instrStep2Open')}{' '}
            <a href={VOICE_MEMO_SIGNAL_CONTACT_URL} target="_blank" rel="noopener noreferrer">
              {t('voiceMemo.instrStep2Link')}
            </a>
          </p>
          <p className="portal-voice-memo-step-body">{t('voiceMemo.instrStep2Intro')}</p>
          <ol className="portal-voice-memo-substeps">
            <li>
              <div className="portal-voice-memo-substep-id-row">
                <span className="portal-voice-memo-substep-id-line">
                  {t('voiceMemo.instrStep2Id')}{' '}
                  <strong className="portal-ltr">{idText || '—'}</strong>
                </span>
                {idText ? (
                  <button
                    type="button"
                    className="portal-voice-memo-copy-btn"
                    onClick={copyAesopId}
                  >
                    {copiedAesopId
                      ? t('voiceMemo.instrStep2Copied')
                      : t('voiceMemo.instrStep2Copy')}
                  </button>
                ) : null}
              </div>
            </li>
            <li>{t('voiceMemo.instrStep2Voice')}</li>
          </ol>
        </li>
        <li className="portal-voice-memo-step">
          <p className="portal-voice-memo-step-title">{t('voiceMemo.instrStep3Title')}</p>
          <p className="portal-voice-memo-step-body">{t('voiceMemo.instrStep3Body')}</p>
        </li>
      </ol>
    </div>
  );
}

function PortalVoiceMemoLoading() {
  const { t } = usePortalI18n();
  return (
    <div className="portal-voice-memo-loading" role="status" aria-live="polite">
      <div className="portal-voice-memo-loading-spinner" aria-hidden="true" />
      <p className="portal-voice-memo-loading-text">{t('voiceMemo.checking')}</p>
    </div>
  );
}

function PortalVoiceMemoSection({ studentUserId, studentEmail, enabled }) {
  const { locale, t } = usePortalI18n();
  const {
    loading: voiceMemoLoading,
    error: voiceMemoError,
    status: fetchedVoiceMemoStatus,
  } = usePortalVoiceMemoStatus({
    enabled,
    userId: studentUserId,
    email: studentEmail,
  });
  const [voiceMemoStatus, setVoiceMemoStatus] = useState(null);
  const [voiceMemoAudioError, setVoiceMemoAudioError] = useState('');
  const [measuredDurationSeconds, setMeasuredDurationSeconds] = useState(null);
  const [refreshingStream, setRefreshingStream] = useState(false);
  const [voiceMemoPlayerRequested, setVoiceMemoPlayerRequested] = useState(false);
  const [voiceMemoPlayerLoading, setVoiceMemoPlayerLoading] = useState(false);
  const reportedDurationKeyRef = useRef('');

  useEffect(() => {
    if (!enabled) {
      setVoiceMemoStatus(null);
      setVoiceMemoAudioError('');
      setMeasuredDurationSeconds(null);
      setVoiceMemoPlayerRequested(false);
      setVoiceMemoPlayerLoading(false);
      reportedDurationKeyRef.current = '';
      return;
    }
    setVoiceMemoStatus(fetchedVoiceMemoStatus);
    setMeasuredDurationSeconds(null);
    setVoiceMemoPlayerRequested(false);
    setVoiceMemoPlayerLoading(false);
    reportedDurationKeyRef.current = '';
  }, [enabled, fetchedVoiceMemoStatus]);

  const refreshVoiceMemoStream = useCallback(async () => {
    if (!studentUserId || !studentEmail || refreshingStream) {
      return;
    }
    setRefreshingStream(true);
    setVoiceMemoAudioError('');
    setVoiceMemoPlayerRequested(false);
    setVoiceMemoPlayerLoading(false);
    try {
      const result = await loadPortalVoiceMemoStatusFromApi({
        userId: studentUserId,
        email: studentEmail,
      });
      if (!result.ok) {
        setVoiceMemoAudioError(
          result.errorMessage ||
            (result.errorKind === 'network' ? t('voiceMemo.networkError') : t('voiceMemo.loadError')),
        );
        return;
      }
      setVoiceMemoStatus(result.status);
      setMeasuredDurationSeconds(null);
      reportedDurationKeyRef.current = '';
    } catch {
      setVoiceMemoAudioError(t('voiceMemo.networkError'));
    } finally {
      setRefreshingStream(false);
    }
  }, [studentUserId, studentEmail, refreshingStream, t]);

  const voiceMemoStreamSrc = useMemo(() => {
    if (!voiceMemoStatus?.submitted || !voiceMemoStatus?.hasRecording || !enabled) {
      return '';
    }
    // The stream URL carries only a short-lived signed token (no userId/email).
    const streamToken = voiceMemoStatus?.streamToken;
    if (!streamToken) {
      return '';
    }
    const params = new URLSearchParams({ st: streamToken });
    return `/api/portal-voice-memo/stream?${params.toString()}`;
  }, [voiceMemoStatus?.submitted, voiceMemoStatus?.hasRecording, voiceMemoStatus?.streamToken, enabled]);

  // Duration labels and issue state come from the server mirror only. Browser
  // measurement during playback is used to backfill the cache, not to re-render
  // status or submission UI while the student listens.
  const displayDurationSeconds =
    voiceMemoStatus?.durationSeconds != null && Number.isFinite(Number(voiceMemoStatus.durationSeconds))
      ? Number(voiceMemoStatus.durationSeconds)
      : null;
  const displayDurationLabel =
    formatVoiceMemoDurationLabel(displayDurationSeconds) || voiceMemoStatus?.durationLabel || null;
  const displayDurationStatus = voiceMemoStatus?.durationStatus || 'unknown';
  const hasShortSubmissionIssue = voiceMemoStatus?.durationStatus === 'too_short';

  const voiceMemoDurationWarning = useMemo(() => {
    const status = voiceMemoStatus?.durationStatus;
    if (!status || status === 'unknown') {
      return voiceMemoStatus?.durationWarning || null;
    }
    return (
      translateVoiceMemoDurationWarning(locale, status, {
        minSeconds: voiceMemoStatus?.minDurationSeconds,
        maxSeconds: voiceMemoStatus?.maxDurationSeconds,
      }) || voiceMemoStatus?.durationWarning
    );
  }, [locale, voiceMemoStatus]);

  useEffect(() => {
    setVoiceMemoAudioError('');
    setVoiceMemoPlayerRequested(false);
    setVoiceMemoPlayerLoading(false);
  }, [voiceMemoStreamSrc]);

  useEffect(() => {
    if (
      !enabled ||
      !studentUserId ||
      !studentEmail ||
      measuredDurationSeconds == null ||
      !Number.isFinite(measuredDurationSeconds) ||
      !voiceMemoStatus?.fileId
    ) {
      return undefined;
    }
    const measuredStatus = classifyVoiceMemoDuration(measuredDurationSeconds, {
      minSeconds: voiceMemoStatus?.minDurationSeconds,
      maxSeconds: voiceMemoStatus?.maxDurationSeconds,
    });
    const serverMaskedOverachieve =
      voiceMemoStatus.durationStatus === 'too_long' &&
      voiceMemoStatus.durationSeconds == null &&
      measuredStatus === 'too_long';
    if (
      !serverMaskedOverachieve &&
      !voiceMemoDurationsDiffer(voiceMemoStatus.durationSeconds, measuredDurationSeconds)
    ) {
      return undefined;
    }
    const reportKey = `${voiceMemoStatus.fileId}:${Math.round(measuredDurationSeconds)}`;
    if (reportedDurationKeyRef.current === reportKey) {
      return undefined;
    }
    reportedDurationKeyRef.current = reportKey;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/portal-voice-memo/duration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: studentUserId,
            email: studentEmail,
            fileId: voiceMemoStatus.fileId,
            durationSeconds: measuredDurationSeconds,
          }),
        });
        const data = await response.json();
        if (cancelled || !response.ok) {
          return;
        }
        setVoiceMemoStatus((prev) => {
          if (!prev) {
            return prev;
          }
          const durationStatus =
            data.durationStatus ||
            classifyVoiceMemoDuration(measuredDurationSeconds, {
              minSeconds: prev.minDurationSeconds,
              maxSeconds: prev.maxDurationSeconds,
            });
          const isOverachieved = durationStatus === 'too_long';
          return {
            ...prev,
            durationStatus,
            durationSeconds: isOverachieved
              ? null
              : (data.durationSeconds ?? Math.round(measuredDurationSeconds)),
            durationLabel: isOverachieved
              ? null
              : (data.durationLabel || formatVoiceMemoDurationLabel(measuredDurationSeconds)),
            durationWarning: data.durationWarning ?? prev.durationWarning,
          };
        });
      } catch {
        // Keep the browser-measured label even if cache update fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    studentUserId,
    studentEmail,
    measuredDurationSeconds,
    voiceMemoStatus?.fileId,
    voiceMemoStatus?.durationSeconds,
  ]);

  if (!enabled) {
    return null;
  }

  const activeVoiceMemoStatus = voiceMemoStatus ?? fetchedVoiceMemoStatus;

  if (voiceMemoLoading) {
    return (
      <section className="portal-voice-memo-section" aria-label={t('voiceMemo.sectionAria')}>
        <PortalVoiceMemoLoading />
      </section>
    );
  }

  if (!activeVoiceMemoStatus?.eligible) {
    if (voiceMemoError) {
      return (
        <section className="portal-voice-memo-section" aria-label={t('voiceMemo.sectionAria')}>
          <div className="portal-voice-memo-block">
            <p className="portal-field-error" role="alert">
              {voiceMemoError}
            </p>
          </div>
        </section>
      );
    }
    return null;
  }

  return (
    <section className="portal-voice-memo-section" aria-label={t('voiceMemo.sectionAria')}>
      {activeVoiceMemoStatus.submitted ? (
        <>
          <div className="portal-voice-memo-block">
            <div className="portal-voice-memo-block-header">
              <h3 className="portal-voice-memo-block-heading">{t('voiceMemo.statusSectionTitle')}</h3>
              <div
                className={`portal-voice-memo-status${
                  hasShortSubmissionIssue
                    ? ' portal-voice-memo-status--issues'
                    : ' portal-voice-memo-status--submitted'
                }`}
                role="status"
              >
                {hasShortSubmissionIssue
                  ? t('voiceMemo.submittedWithIssues')
                  : t('voiceMemo.submitted')}
              </div>
            </div>
            {voiceMemoDurationWarning && hasShortSubmissionIssue ? (
              <p className="portal-voice-memo-duration-warning" role="alert">
                {voiceMemoDurationWarning}
              </p>
            ) : null}
            {!hasShortSubmissionIssue ? (
              <div className="portal-voice-memo-done">
                <p className="portal-voice-memo-done-title">{t('voiceMemo.doneTitle')}</p>
                <p className="portal-voice-memo-done-lead">{t('voiceMemo.doneLead')}</p>
              </div>
            ) : null}
          </div>

          <div className="portal-voice-memo-block">
            <h3 className="portal-voice-memo-block-heading">{t('voiceMemo.infoSectionTitle')}</h3>
            {voiceMemoError ? (
              <p className="portal-field-error" role="alert">
                {voiceMemoError}
              </p>
            ) : null}
            <PortalVoiceMemoPrompt prompt={activeVoiceMemoStatus.round2Prompt} />
            {displayDurationStatus === 'too_long' ? (
              <p className="portal-field-hint">
                <span className="portal-voice-memo-duration-ok">
                  {t('voiceMemo.durationExceeding')}
                </span>
              </p>
            ) : displayDurationLabel ? (
              <p className="portal-field-hint">
                {t('voiceMemo.recordingLength')}: <strong>{displayDurationLabel}</strong>
                {displayDurationStatus === 'valid' ? (
                  <span className="portal-voice-memo-duration-ok">
                    {' '}
                    {t('voiceMemo.durationWithin')}
                  </span>
                ) : null}
              </p>
            ) : null}
            {activeVoiceMemoStatus.hasRecording ? (
              <>
                {voiceMemoAudioError ? (
                  <p className="portal-voice-memo-audio-warning" role="status">
                    {voiceMemoAudioError}
                  </p>
                ) : null}
                {!voiceMemoPlayerRequested || voiceMemoPlayerLoading ? (
                  <button
                    type="button"
                    className="portal-voice-memo-play-btn"
                    disabled={voiceMemoPlayerLoading || !voiceMemoStreamSrc}
                    onClick={() => {
                      if (voiceMemoPlayerLoading || !voiceMemoStreamSrc) {
                        return;
                      }
                      setVoiceMemoAudioError('');
                      setVoiceMemoPlayerRequested(true);
                      setVoiceMemoPlayerLoading(true);
                    }}
                  >
                    {voiceMemoPlayerLoading
                      ? t('voiceMemo.loadingRecording')
                      : t('voiceMemo.playRecording')}
                  </button>
                ) : null}
                {voiceMemoPlayerRequested && voiceMemoStreamSrc ? (
                  <audio
                    key={voiceMemoStreamSrc}
                    className={`portal-voice-memo-player${
                      voiceMemoPlayerLoading ? ' portal-voice-memo-player--loading' : ''
                    }`}
                    controls={!voiceMemoPlayerLoading}
                    preload="metadata"
                    src={voiceMemoStreamSrc}
                    onLoadedMetadata={(event) => {
                      const duration = event.currentTarget?.duration;
                      if (Number.isFinite(duration) && duration > 0) {
                        setMeasuredDurationSeconds(duration);
                      }
                      setVoiceMemoPlayerLoading(false);
                    }}
                    onError={() => {
                      setVoiceMemoPlayerLoading(false);
                      setVoiceMemoPlayerRequested(false);
                      resolvePortalVoiceMemoAudioError(voiceMemoStreamSrc, t).then((message) => {
                        setVoiceMemoAudioError(message);
                      });
                    }}
                  >
                    {t('voiceMemo.audioUnsupported')}
                  </audio>
                ) : null}
                {refreshingStream || voiceMemoAudioError ? (
                  <button
                    type="button"
                    className="portal-voice-memo-refresh-stream"
                    onClick={refreshVoiceMemoStream}
                    disabled={refreshingStream}
                  >
                    {refreshingStream ? t('voiceMemo.refreshingStream') : t('voiceMemo.refreshStream')}
                  </button>
                ) : null}
              </>
            ) : (
              <p className="portal-field-hint">{t('voiceMemo.audioUnavailable')}</p>
            )}
          </div>

          <PortalVoiceMemoSubmissionSection
            aesopId={studentUserId}
            collapsible={!hasShortSubmissionIssue}
          />
        </>
      ) : (
        <>
          <div className="portal-voice-memo-block">
            <div className="portal-voice-memo-block-header">
              <h3 className="portal-voice-memo-block-heading">{t('voiceMemo.statusSectionTitle')}</h3>
              <div className="portal-voice-memo-status portal-voice-memo-status--pending" role="status">
                {t('voiceMemo.notSubmitted')}
              </div>
            </div>
            <div className="portal-voice-memo-warning" role="alert">
              <p className="portal-voice-memo-warning-title">{t('voiceMemo.noneTitle')}</p>
              <p className="portal-voice-memo-warning-lead">{t('voiceMemo.noneLead')}</p>
            </div>
          </div>

          <div className="portal-voice-memo-block">
            <h3 className="portal-voice-memo-block-heading">{t('voiceMemo.infoSectionTitle')}</h3>
            <PortalVoiceMemoPrompt prompt={activeVoiceMemoStatus.round2Prompt} />
          </div>

          <div className="portal-voice-memo-block">
            <h3 className="portal-voice-memo-block-heading">
              {t('voiceMemo.submissionSectionTitle')}
            </h3>
            <h4 className="portal-voice-memo-instructions-title">{t('voiceMemo.instrTitle')}</h4>
            <PortalVoiceMemoInstructions aesopId={studentUserId} />
            <div className="portal-voice-memo-why portal-voice-memo-why--warning">
              <p className="portal-voice-memo-why-title">{t('voiceMemo.whyTitle')}</p>
              <ul className="portal-voice-memo-why-list">
                <li>{renderPortalRichText(t('voiceMemo.why2'))}</li>
                <PortalVoiceMemoWhySignalItem />
                <li>{renderPortalRichText(t('voiceMemo.why3'))}</li>
                <li>{renderPortalRichText(t('voiceMemo.why4'))}</li>
                <li>{renderPortalRichText(t('voiceMemo.why5'))}</li>
              </ul>
            </div>
            <div className="portal-voice-memo-why">
              <p className="portal-voice-memo-why-title">{t('voiceMemo.whyTitle2')}</p>
              <ul className="portal-voice-memo-why-list">
                <li>{renderPortalRichText(t('voiceMemo.goodToKnow1'))}</li>
                <li>{renderPortalRichText(t('voiceMemo.goodToKnow2'))}</li>
                <li>{renderPortalRichText(t('voiceMemo.goodToKnow3'))}</li>
              </ul>
            </div>
            <PortalVoiceMemoReviewRequest aesopId={studentUserId} />
          </div>
        </>
      )}
    </section>
  );
}

function PortalCalendarSection({ enabled, studentUserId, studentEmail }) {
  const { locale, t } = usePortalI18n();
  const calendarEntries = useMemo(() => getPortalApplicationCalendarEntries(locale), [locale]);
  const { status: voiceMemoStatus } = usePortalVoiceMemoStatus({
    enabled,
    userId: studentUserId,
    email: studentEmail,
  });
  const voiceNoteSubmitted = voiceMemoStatus?.submitted === true;

  if (!enabled) {
    return null;
  }

  const resolveNote = (entry) => {
    if (entry.dynamicNote === 'voiceCompleted') {
      return voiceNoteSubmitted ? t('calendar.note.voiceCompleted') : entry.note || '';
    }
    return entry.note || '';
  };

  return (
    <section className="portal-calendar-section" aria-label={t('calendar.sectionAria')}>
      <h3 className="portal-calendar-heading">{t('calendar.label')}</h3>
      <div className="portal-calendar-scroll">
        <table className="portal-calendar-table">
          <thead>
            <tr>
              <th scope="col">{t('calendar.process')}</th>
              <th scope="col">{t('calendar.date')}</th>
              <th scope="col">{t('calendar.info')}</th>
            </tr>
          </thead>
          <tbody>
            {calendarEntries.map((entry, index) => {
              const note = resolveNote(entry);
              return (
                <tr key={`${entry.process}-${entry.date}-${index}`}>
                  <td data-label={t('calendar.process')}>{entry.process}</td>
                  <td className="portal-calendar-date-cell" data-label={t('calendar.date')}>
                    {entry.date}
                  </td>
                  <td className="portal-calendar-note-cell" data-label={t('calendar.info')}>
                    {note || null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PortalAdminImpersonateActions({ targetUserId, compact = false }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const openProfile = async () => {
    setLoading(true);
    setError('');
    try {
      await openPortalAsPerson(targetUserId);
    } catch (err) {
      setError(err.message || 'Could not open profile.');
      setLoading(false);
    }
  };

  if (!targetUserId?.trim()) {
    return null;
  }

  return (
    <div className={`portal-admin-impersonate-actions${compact ? ' portal-admin-impersonate-actions--compact' : ''}`}>
      <button
        type="button"
        className="portal-admin-action portal-admin-action--primary"
        disabled={loading}
        onClick={openProfile}
      >
        {loading ? 'Opening…' : 'Open profile'}
      </button>
      {error ? (
        <p className="portal-admin-status portal-admin-status--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PortalRejectionLetter({ name }) {
  const displayName = String(name || '').trim();
  const enName = displayName || 'Applicant';
  const faName = displayName || 'متقاضی';
  const enParagraphs = [
    `Dear ${enName},`,
    'Thank you for your application to AESOP English classes in our 2026-2027 academic year.',
    'We regret that your application was not selected to advance. We received over 9,000 applications this summer and we regret that we were not able to accept your application this time.',
    'We admire your dedication to learning and encourage you to keep studying English with the help of AESOP\u2019s youtube channel where you can find English learning videos in English & Dari.',
    'We hope you will apply again for AESOP\u2019s 2027-2028 academic year. Applications will open at AESOPAfghanistan.org in June, 2027.',
    'Sincerely,',
    'AESOP Admission Team',
  ];
  const faParagraphs = [
    `${faName} عزیز،`,
    'از شما سپاسگزاریم که برای صنف‌های انگلیسی AESOP در سال تعلیمی ۲۰۲۶–۲۰۲۷ درخواست فرستادید.',
    'با تأسف باید به شما اطلاع بدهیم که درخواست شما برای مرحلهٔ بعدی انتخاب نشد. در تابستان امسال بیش از ۹۰۰۰ درخواست دریافت کردیم و متأسفانه نتوانستیم درخواست شما را در این دوره بپذیریم.',
    'ما پشتکار و علاقهٔ شما را به یادگیری تحسین می‌کنیم و تشویقتان می‌کنیم که با استفاده از کانال یوتیوب AESOP به یادگیری زبان انگلیسی ادامه بدهید. در آن‌جا می‌توانید ویدیوهای آموزشی زبان انگلیسی به زبان انگلیسی و دری پیدا کنید.',
    'امیدواریم برای سال تعلیمی ۲۰۲۷–۲۰۲۸ دوباره برای AESOP درخواست بدهید. درخواست‌ها در جون ۲۰۲۷ در AESOPAfghanistan.org باز خواهند شد.',
    'با احترام،',
    'تیم پذیرش AESOP',
  ];
  return (
    <section className="portal-rejection-letter">
      <div className="portal-rejection-letter-body" dir="ltr">
        {enParagraphs.map((paragraph, index) => (
          <p key={`en-${index}`} className="portal-rejection-letter-line">
            {paragraph}
          </p>
        ))}
      </div>
      <div className="portal-rejection-letter-body portal-rejection-letter-body--fa" dir="rtl">
        {faParagraphs.map((paragraph, index) => (
          <p key={`fa-${index}`} className="portal-rejection-letter-line">
            {paragraph}
          </p>
        ))}
      </div>
    </section>
  );
}

function PortalComingSoonContent() {
  const { t } = usePortalI18n();
  const { studentName } = usePortalStudentRecord();
  const trimmedName = String(studentName || '').trim();
  const title = trimmedName ? t('hub.comingSoonTitle', { name: trimmedName }) : t('hub.comingSoonTitleNoName');
  return (
    <div className="portal-coming-soon">
      <h2 className="portal-welcome">{title}</h2>
      <p className="portal-coming-soon-message">{t('hub.comingSoonMessage')}</p>
      <p className="portal-coming-soon-message">{t('hub.comingSoonMessage2')}</p>
      <p className="portal-coming-soon-message">
        {t('hub.comingSoonSignoff')}
        <br />
        {t('hub.comingSoonSignoffNames')}
      </p>
    </div>
  );
}

function PortalHubPage() {
  const { locale, t } = usePortalI18n();
  const { studentName, studentUserId, studentEmail, studentPhone } = usePortalStudentRecord();
  const {
    studentClass,
    studentGrade,
    classGrades,
    isTeacher,
    teacherClasses,
    isAdmin,
    isReviewer,
    showStudentFields,
    showTeacherFields,
    hasStudentCategory,
    isApplied,
    applicationStatus,
    hasApplicantPortalAccess,
  } = usePortalProfileSections();
  const signedIn = isPortalSessionCompleteSync();
  const impersonating = isPortalImpersonating();
  const showAdminFeatures = isAdmin && !impersonating;
  const intent = typeof window !== 'undefined' ? getPortalUrlIntent() : '';
  const welcomeName =
    studentName.trim() || (isApplied ? t('hub.welcomeApplicant') : t('hub.welcomeStudent'));
  const isRound1Accepted =
    String(applicationStatus || '').trim().toLowerCase() === 'accepted';
  const isRejected =
    String(applicationStatus || '').trim().toLowerCase() === 'rejected';

  useEffect(() => {
    if (!signedIn && intent) {
      document.getElementById('portal-magic-link-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [signedIn, intent]);

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-hub-card">
        {signedIn ? (
          hasApplicantPortalAccess ? (
            <>
            <PortalSectionLinks
              current="hub"
              isAdmin={showAdminFeatures}
              isReviewer={isReviewer}
              showEditDingLink={false}
            />
            <h2 className="portal-welcome">
              {t('hub.welcomeNamed', { name: welcomeName })}
              <PortalRoleBadge
                isTeacher={showTeacherFields && isTeacher}
                hasStudentCategory={showStudentFields && hasStudentCategory}
                isAdmin={showAdminFeatures}
                isApplied={false}
                className="portal-welcome-role"
              />
            </h2>
            <dl className="portal-hub-meta portal-hub-meta-panel" aria-label={t('hub.yourAccount')}>
              <div className="portal-hub-meta-row">
                <dt className="portal-hub-meta-label">{t('header.aesopId')}</dt>
                <dd className="portal-hub-meta-value portal-hub-meta-mono portal-ltr">{studentUserId || '—'}</dd>
              </div>
              <div className="portal-hub-meta-row">
                <dt className="portal-hub-meta-label">{t('header.email')}</dt>
                <dd className="portal-hub-meta-value portal-ltr">{studentEmail || '—'}</dd>
              </div>
              {showStudentFields ? (
                <div className="portal-hub-meta-row">
                  <dt className="portal-hub-meta-label">{t('header.class')}</dt>
                  <dd
                    className={`portal-hub-meta-value${
                      studentClass.trim() || classGrades.length > 0 ? '' : ' portal-hub-meta-empty'
                    }`}
                  >
                    <PortalMultiClassList value={studentClass} classGrades={classGrades} />
                  </dd>
                </div>
              ) : null}
              {showStudentFields ? (
                <div className="portal-hub-meta-row">
                  <dt className="portal-hub-meta-label">{t('header.grade')}</dt>
                  <dd
                    className={`portal-hub-meta-value${
                      classGrades.length > 0 || studentGrade.trim() ? '' : ' portal-hub-meta-empty'
                    }`}
                  >
                    <PortalClassGradeList
                      classGrades={classGrades}
                      fallbackClass={studentClass}
                      fallbackGrade={studentGrade}
                    />
                  </dd>
                </div>
              ) : null}
              {showTeacherFields ? (
                <div className="portal-hub-meta-row">
                  <dt className="portal-hub-meta-label">{t('header.teaching')}</dt>
                  <dd
                    className={`portal-hub-meta-value${teacherClasses.trim() ? '' : ' portal-hub-meta-empty'}`}
                  >
                    <PortalMultiClassList
                      value={teacherClasses}
                      moreAriaLabel="Additional teaching classes"
                    />
                  </dd>
                </div>
              ) : null}
              {showStudentFields || showTeacherFields || showAdminFeatures ? (
                <div className="portal-hub-meta-row">
                  <dt className="portal-hub-meta-label">{t('header.category')}</dt>
                  <dd className="portal-hub-meta-value">
                    <PortalRoleBadge
                      isTeacher={showTeacherFields && isTeacher}
                      hasStudentCategory={showStudentFields && hasStudentCategory}
                      isAdmin={showAdminFeatures}
                      isApplied={false}
                    />
                  </dd>
                </div>
              ) : null}
              {studentPhone ? (
                <div className="portal-hub-meta-row">
                  <dt className="portal-hub-meta-label">{t('hub.phoneOnFile')}</dt>
                  <dd className="portal-hub-meta-value">{studentPhone}</dd>
                </div>
              ) : null}
              {applicationStatus ? (
                <div className="portal-hub-meta-row">
                  <dt className="portal-hub-meta-label">{t('hub.applicationStatus')}</dt>
                  <dd
                    className={`portal-hub-meta-value portal-application-status${applicationStatusClassName(applicationStatus)}`}
                  >
                    {translateApplicationStatusLabel(locale, applicationStatus)}
                  </dd>
                </div>
              ) : null}
            </dl>
            {isRejected ? <PortalRejectionLetter name={studentName} /> : null}
            <PortalVoiceMemoSection
              studentUserId={studentUserId}
              studentEmail={studentEmail}
              enabled={
                signedIn &&
                isRound1Accepted &&
                studentUserId.length > 0 &&
                studentEmail.length > 0
              }
            />
            <PortalCalendarSection
              enabled={signedIn && isRound1Accepted}
              studentUserId={studentUserId}
              studentEmail={studentEmail}
            />
            {isTeacher || showAdminFeatures ? (
              <PortalTeacherRoster
                rosterEnabled={isTeacher || showAdminFeatures}
                isAdminView={showAdminFeatures && !isTeacher}
              />
            ) : null}
            {showStudentFields && signedIn ? <PortalStudentGrades isStudent /> : null}
            </>
          ) : isReviewer ? (
            <>
              <PortalSectionLinks
                current="hub"
                isAdmin={showAdminFeatures}
                isReviewer={isReviewer}
                showEditDingLink={false}
              />
              <PortalComingSoonContent />
            </>
          ) : (
            <>
              {showAdminFeatures ? (
                <PortalSectionLinks
                  current="hub"
                  isAdmin={showAdminFeatures}
                  showEditDingLink={false}
                />
              ) : null}
              <PortalComingSoonContent />
            </>
          )
        ) : (
          <PortalSignInOnlyContent />
        )}
      </div>
    </PortalLayout>
  );
}

function PortalFaqPage() {
  const { isAdmin } = usePortalClassGrade();

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-faq-card">
        <PortalSectionLinks current="faq" isAdmin={isAdmin} />
        <p className="faq-kicker">AESOP Afghanistan</p>
        <h2 className="faq-title">Frequently asked questions</h2>
        <p className="faq-placeholder">
          Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et
          dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
        </p>
        <p className="faq-placeholder faq-placeholder-muted">
          Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.
          Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est
          laborum.
        </p>
      </div>
    </PortalLayout>
  );
}

function PortalAdminViewAs() {
  const [targetUserId, setTargetUserId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const openPortal = async () => {
    const trimmed = targetUserId.trim();
    if (!trimmed) {
      setError('Enter an AESOP ID.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await openPortalAsPerson(trimmed);
    } catch (err) {
      setError(err.message || 'Could not open profile.');
      setLoading(false);
    }
  };

  return (
    <section className="portal-admin-panel portal-admin-view-as-pinned" aria-label="Open person profile">
      <p className="portal-admin-hint">
        Open the full portal profile for any AESOP ID, including student and teacher information when
        someone has both roles. Use <strong>Back to admin page</strong> in the header when you are done.
      </p>
      <div className="portal-admin-lookup-form">
        <label htmlFor="portal-admin-view-as-id" className="portal-admin-lookup-label">
          AESOP ID
        </label>
        <div className="portal-admin-lookup-row">
          <input
            id="portal-admin-view-as-id"
            type="text"
            className="portal-admin-lookup-input"
            value={targetUserId}
            onChange={(event) => setTargetUserId(event.target.value)}
            placeholder="Enter AESOP ID"
          />
          <button
            type="button"
            className="portal-admin-action portal-admin-action--primary"
            disabled={loading}
            onClick={openPortal}
          >
            {loading ? 'Opening…' : 'Open profile'}
          </button>
        </div>
      </div>
      {error ? (
        <p className="portal-admin-status portal-admin-status--error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function PortalAdminApplicationCategoryRow({
  categoryKey,
  label,
  count,
  activeCategory,
  onSelectCategory,
  statusClassName = '',
}) {
  const isActive = activeCategory === categoryKey;
  const disabled = !count;
  return (
    <div className={`portal-admin-stat-row${isActive ? ' portal-admin-stat-row--active' : ''}`}>
      <dt>{label}</dt>
      <dd>
        <button
          type="button"
          className={`portal-admin-stat-count-btn${statusClassName ? ` ${statusClassName}` : ''}${
            isActive ? ' is-active' : ''
          }`}
          disabled={disabled}
          onClick={() => onSelectCategory(isActive ? null : categoryKey)}
          aria-expanded={isActive}
          aria-label={`${label}: ${count ?? 0}. ${isActive ? 'Hide list' : 'Show list'}`}
        >
          {count ?? 0}
        </button>
      </dd>
    </div>
  );
}

function PortalAdminApplicantListTable({ people, showRecordingColumn = false }) {
  if (!Array.isArray(people) || people.length === 0) {
    return <p className="portal-admin-status">No applicants in this category.</p>;
  }
  const showRecording =
    showRecordingColumn ||
    people.some((person) => person.durationLabel || person.fileName);
  return (
    <div className="portal-admin-table-wrap portal-admin-table-wrap--scroll">
      <table className="portal-admin-table portal-admin-application-category-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">AESOP ID</th>
            <th scope="col">Email</th>
            {showRecording ? <th scope="col">Recording</th> : null}
          </tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <tr key={person.aesopId}>
              <td>{person.name || '—'}</td>
              <td className="portal-admin-mono">{person.aesopId}</td>
              <td>{person.email || '—'}</td>
              {showRecording ? (
                <td>
                  {person.durationLabel
                    ? person.durationLabel
                    : person.fileName
                      ? person.fileName
                      : '—'}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PortalAdminApplicationCategoryPanel({ categoryKey, people, onEmailGroup }) {
  if (!categoryKey || !Array.isArray(people)) {
    return null;
  }
  const label = APPLICATION_STAT_CATEGORY_LABELS[categoryKey] || categoryKey;
  const emailableCount = people.filter((person) => String(person.email || '').trim()).length;

  return (
    <section className="portal-admin-application-category-panel" aria-label={label}>
      <div className="portal-admin-application-category-panel-head">
        <h4 className="portal-admin-subheading">{label}</h4>
        <button
          type="button"
          className="portal-btn portal-btn--secondary portal-admin-application-email-btn"
          disabled={emailableCount === 0}
          onClick={() => onEmailGroup(people, label)}
        >
          Compose email to this group ({emailableCount})
        </button>
      </div>
      <PortalAdminApplicantListTable people={people} showRecordingColumn />
    </section>
  );
}

function PortalAdminApplicationIssuesPanel({ lists, onEmailGroup }) {
  if (!lists || typeof lists !== 'object') {
    return null;
  }
  const issueGroups = APPLICATION_STAT_ISSUE_CATEGORIES.map((categoryKey) => ({
    categoryKey,
    label: APPLICATION_STAT_CATEGORY_LABELS[categoryKey] || categoryKey,
    people: Array.isArray(lists[categoryKey]) ? lists[categoryKey] : [],
  })).filter((group) => group.people.length > 0);

  if (issueGroups.length === 0) {
    return null;
  }

  return (
    <section className="portal-admin-application-issues" aria-label="Voice memo issues">
      <h4 className="portal-admin-subheading">Voice memo issues</h4>
      <p className="portal-admin-hint">
        Applicants with recording problems. Use the AESOP ID to trace each person.
      </p>
      {issueGroups.map((group) => {
        const emailableCount = group.people.filter((person) => String(person.email || '').trim()).length;
        return (
          <section
            key={group.categoryKey}
            className="portal-admin-application-issues-group"
            aria-label={group.label}
          >
            <div className="portal-admin-application-category-panel-head">
              <h5 className="portal-admin-application-issues-title">
                {group.label} ({group.people.length})
              </h5>
              <button
                type="button"
                className="portal-btn portal-btn--secondary portal-admin-application-email-btn"
                disabled={emailableCount === 0}
                onClick={() => onEmailGroup(group.people, group.label)}
              >
                Compose email ({emailableCount})
              </button>
            </div>
            <PortalAdminApplicantListTable people={group.people} showRecordingColumn />
          </section>
        );
      })}
    </section>
  );
}

function PortalAdminVoiceMemoSyncIssuesPanel({ syncResult }) {
  if (!syncResult) {
    return null;
  }
  const duplicateAesopIds = Array.isArray(syncResult.duplicateAesopIds)
    ? syncResult.duplicateAesopIds
    : [];
  const unmatchedFiles = Array.isArray(syncResult.unmatchedFiles) ? syncResult.unmatchedFiles : [];
  const invalidFileNames = Array.isArray(syncResult.invalidFileNames)
    ? syncResult.invalidFileNames
    : [];
  const warnings = Array.isArray(syncResult.warnings) ? syncResult.warnings : [];
  const hasIssues =
    warnings.length > 0 ||
    duplicateAesopIds.length > 0 ||
    unmatchedFiles.length > 0 ||
    invalidFileNames.length > 0;

  if (!hasIssues) {
    return null;
  }

  return (
    <div className="portal-admin-voice-memo-warnings" role="alert">
      {warnings.length > 0 ? (
        <>
          <p className="portal-admin-voice-memo-warnings-title">Drive warnings</p>
          <ul className="portal-admin-voice-memo-warnings-list">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      ) : null}
      {duplicateAesopIds.length > 0 ? (
        <section className="portal-admin-application-issues-group" aria-label="Duplicate AESOP IDs in Drive">
          <h5 className="portal-admin-application-issues-title">
            Duplicate AESOP IDs in Drive ({duplicateAesopIds.length})
          </h5>
          <div className="portal-admin-table-wrap portal-admin-table-wrap--scroll">
            <table className="portal-admin-table portal-admin-application-category-table">
              <thead>
                <tr>
                  <th scope="col">AESOP ID</th>
                  <th scope="col">Files</th>
                </tr>
              </thead>
              <tbody>
                {duplicateAesopIds.map((entry) => (
                  <tr key={entry.aesopId}>
                    <td className="portal-admin-mono">{entry.aesopId}</td>
                    <td>{(entry.files || []).map((file) => file.fileName).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {unmatchedFiles.length > 0 ? (
        <section className="portal-admin-application-issues-group" aria-label="Voice notes with no matching applicant">
          <h5 className="portal-admin-application-issues-title">
            Voice notes with no matching applicant ({unmatchedFiles.length})
          </h5>
          <div className="portal-admin-table-wrap portal-admin-table-wrap--scroll">
            <table className="portal-admin-table portal-admin-application-category-table">
              <thead>
                <tr>
                  <th scope="col">AESOP ID</th>
                  <th scope="col">File</th>
                </tr>
              </thead>
              <tbody>
                {unmatchedFiles.map((entry) => (
                  <tr key={`${entry.aesopId}-${entry.fileName}`}>
                    <td className="portal-admin-mono">{entry.aesopId}</td>
                    <td>{entry.fileName || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {invalidFileNames.length > 0 ? (
        <section className="portal-admin-application-issues-group" aria-label="Invalid voice note file names">
          <h5 className="portal-admin-application-issues-title">
            Ignored file names ({invalidFileNames.length})
          </h5>
          <ul className="portal-admin-voice-memo-warnings-list">
            {invalidFileNames.map((fileName) => (
              <li key={fileName} className="portal-admin-mono">
                {fileName}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function formatMirrorCacheFreshness(entry) {
  if (!entry) {
    return '—';
  }
  if (entry.lastSyncedAt) {
    const when = new Date(entry.lastSyncedAt).toLocaleString();
    return entry.fresh ? `Fresh (last ${when})` : `Stale (last ${when})`;
  }
  if (entry.fresh) {
    return 'Fresh';
  }
  return 'Never synced';
}

const JOB_STATUS_LABELS = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
};

function formatJobTimestamp(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function formatJobDuration(durationMs) {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return '—';
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${totalSeconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatJobTrigger(run) {
  if (!run) {
    return '—';
  }
  return run.triggerSource === 'admin' ? `by ${run.triggeredBy || 'admin'}` : 'scheduled';
}

/** Short "key: value" summary of the numeric fields in a job result. */
function summarizeJobResult(result) {
  if (!result || typeof result !== 'object') {
    return '';
  }
  const parts = [];
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number') {
      parts.push(`${key}: ${value}`);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (typeof nestedValue === 'number') {
          parts.push(`${key}.${nestedKey}: ${nestedValue}`);
        }
      }
    }
  }
  return parts.slice(0, 8).join(' · ');
}

function PortalAdminJobStatusBadge({ status }) {
  return (
    <span className={`portal-job-status portal-job-status--${status}`}>
      {JOB_STATUS_LABELS[status] || status}
    </span>
  );
}

function PortalAdminJobLogPanel({ jobName, logRun, logError, onClose }) {
  return (
    <div className="portal-admin-job-log">
      <div className="portal-admin-job-log-header">
        <h4 className="portal-admin-job-log-title">
          {logRun ? (
            <>
              Run #{logRun.id} · <PortalAdminJobStatusBadge status={logRun.status} /> ·{' '}
              {formatJobTimestamp(logRun.startedAt)} · {formatJobDuration(logRun.durationMs)} ·{' '}
              {formatJobTrigger(logRun)}
            </>
          ) : (
            'Run log'
          )}
        </h4>
        <button type="button" className="portal-admin-job-log-close" onClick={onClose}>
          Close
        </button>
      </div>
      {logError ? (
        <p className="portal-admin-status portal-admin-status--error" role="alert">
          {logError}
        </p>
      ) : null}
      {logRun ? (
        <>
          {logRun.error ? (
            <p className="portal-admin-status portal-admin-status--error">{logRun.error}</p>
          ) : null}
          {jobName === 'voice-memo-sync' && logRun.result ? (
            <PortalAdminVoiceMemoSyncIssuesPanel syncResult={logRun.result} />
          ) : null}
          <pre className="portal-admin-job-log-output">{logRun.logs || 'No logs captured.'}</pre>
          {logRun.status === 'running' ? (
            <p className="portal-admin-hint">Still running — logs refresh every few seconds.</p>
          ) : null}
        </>
      ) : !logError ? (
        <p className="portal-admin-status">Loading log…</p>
      ) : null}
    </div>
  );
}

function PortalAdminJobsTab({ mirrorCacheStatus }) {
  const [overview, setOverview] = useState(null);
  const [overviewError, setOverviewError] = useState('');
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [runsByJob, setRunsByJob] = useState({});
  const [runsLoading, setRunsLoading] = useState(false);
  const [expandedJob, setExpandedJob] = useState('');
  const [triggeringJob, setTriggeringJob] = useState('');
  const [cancellingAction, setCancellingAction] = useState(null); // { jobName, restart }
  const [actionError, setActionError] = useState('');
  const [logView, setLogView] = useState(null);
  const [logRun, setLogRun] = useState(null);
  const [logError, setLogError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  // Load the overview, then keep polling — quickly while a job is running.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const load = async () => {
      try {
        const data = await adminApiPost('/api/portal-admin/jobs/overview');
        if (cancelled) {
          return;
        }
        setOverview(data);
        setOverviewError('');
        const anyRunning = (data.jobs || []).some((job) => job.lastRun?.status === 'running');
        timer = setTimeout(load, anyRunning ? 4000 : 30000);
      } catch (err) {
        if (cancelled) {
          return;
        }
        setOverviewError(err.message || 'Could not load jobs.');
        timer = setTimeout(load, 15000);
      } finally {
        if (!cancelled) {
          setOverviewLoading(false);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [refreshTick]);

  // Run history for the expanded job; refreshes with each overview poll.
  useEffect(() => {
    if (!expandedJob) {
      return undefined;
    }
    let cancelled = false;
    setRunsLoading(true);
    adminApiPost('/api/portal-admin/jobs/runs', { job: expandedJob, limit: 20 })
      .then((data) => {
        if (!cancelled) {
          setRunsByJob((prev) => ({ ...prev, [expandedJob]: data.runs || [] }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setRunsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expandedJob, overview]);

  // Full log for the selected run; refreshes with each overview poll while running.
  useEffect(() => {
    if (!logView) {
      setLogRun(null);
      setLogError('');
      return undefined;
    }
    let cancelled = false;
    adminApiPost('/api/portal-admin/jobs/run-log', { runId: logView.runId })
      .then((data) => {
        if (!cancelled) {
          setLogRun(data.run || null);
          setLogError('');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLogError(err.message || 'Could not load the run log.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [logView, overview]);

  const runJob = async (jobName) => {
    setTriggeringJob(jobName);
    setActionError('');
    try {
      const data = await adminApiPost('/api/portal-admin/jobs/run', { job: jobName });
      setExpandedJob(jobName);
      if (data.runId != null) {
        setLogView({ runId: data.runId, jobName });
      }
      setRefreshTick((tick) => tick + 1);
    } catch (err) {
      setActionError(err.message || 'Could not start the job.');
    } finally {
      setTriggeringJob('');
    }
  };

  const cancelJob = async (jobName, runId, { restart = false } = {}) => {
    setCancellingAction({ jobName, restart });
    setActionError('');
    try {
      const data = await adminApiPost('/api/portal-admin/jobs/cancel', {
        runId,
        restart,
      });
      setExpandedJob(jobName);
      if (restart && data.restartedRunId != null) {
        setLogView({ runId: data.restartedRunId, jobName });
      } else if (data.run?.id != null) {
        setLogView({ runId: data.run.id, jobName });
      }
      setRefreshTick((tick) => tick + 1);
    } catch (err) {
      setActionError(err.message || (restart ? 'Could not stop and restart the job.' : 'Could not stop the job.'));
    } finally {
      setCancellingAction(null);
    }
  };

  return (
    <section className="portal-admin-panel" aria-label="Jobs">
      <p className="portal-admin-hint">
        Sync jobs run on the dedicated cron machine — on their schedule and on demand from here.
        Every run is recorded with its logs. Use Stop if a run is stuck; Stop &amp; restart kills it
        and starts a fresh run.
      </p>
      {mirrorCacheStatus ? (
        <dl className="portal-admin-stats portal-admin-stats--compact">
          <div className="portal-admin-stat-row">
            <dt>People cache</dt>
            <dd>{formatMirrorCacheFreshness(mirrorCacheStatus.people)}</dd>
          </div>
          <div className="portal-admin-stat-row">
            <dt>Applicants cache</dt>
            <dd>{formatMirrorCacheFreshness(mirrorCacheStatus.applicants)}</dd>
          </div>
          <div className="portal-admin-stat-row">
            <dt>Classroom cache</dt>
            <dd>{formatMirrorCacheFreshness(mirrorCacheStatus.classroom)}</dd>
          </div>
        </dl>
      ) : null}
      {overviewLoading && !overview ? <p className="portal-admin-status">Loading jobs…</p> : null}
      {overviewError ? (
        <p className="portal-admin-status portal-admin-status--error" role="alert">
          {overviewError}
        </p>
      ) : null}
      {actionError ? (
        <p className="portal-admin-status portal-admin-status--error" role="alert">
          {actionError}
        </p>
      ) : null}
      {overview && overview.databaseEnabled === false ? (
        <p className="portal-admin-hint">
          Postgres is not configured — job history requires DATABASE_URL.
        </p>
      ) : null}
      {(overview?.jobs || []).map((job) => {
        const lastRun = job.lastRun;
        const isRunning = lastRun?.status === 'running';
        const isExpanded = expandedJob === job.name;
        const runs = runsByJob[job.name] || [];
        return (
          <div key={job.name} className="portal-admin-voice-memo-sync portal-admin-job-card">
            <h3 className="portal-admin-subheading">{job.label}</h3>
            <p className="portal-admin-hint">{job.description}</p>
            <dl className="portal-admin-stats portal-admin-stats--compact">
              <div className="portal-admin-stat-row">
                <dt>Schedule</dt>
                <dd>{job.schedule}</dd>
              </div>
              <div className="portal-admin-stat-row">
                <dt>Last run</dt>
                <dd>
                  {lastRun ? (
                    <>
                      <PortalAdminJobStatusBadge status={lastRun.status} />{' '}
                      {formatJobTimestamp(lastRun.startedAt)}
                      {lastRun.status !== 'running'
                        ? ` · ${formatJobDuration(lastRun.durationMs)}`
                        : ''}{' '}
                      · {formatJobTrigger(lastRun)}
                    </>
                  ) : (
                    'No runs recorded yet'
                  )}
                </dd>
              </div>
              {lastRun?.status === 'failed' && lastRun.error ? (
                <div className="portal-admin-stat-row">
                  <dt>Error</dt>
                  <dd>{lastRun.error}</dd>
                </div>
              ) : null}
            </dl>
            <div className="portal-admin-job-actions">
              {isRunning ? (
                <>
                  <button
                    type="button"
                    className="portal-btn portal-btn--secondary"
                    disabled={Boolean(cancellingAction) || !lastRun?.id}
                    onClick={() => cancelJob(job.name, lastRun.id, { restart: false })}
                  >
                    {cancellingAction?.jobName === job.name && !cancellingAction.restart
                      ? 'Stopping…'
                      : 'Stop'}
                  </button>
                  <button
                    type="button"
                    className="portal-btn portal-btn--secondary"
                    disabled={Boolean(cancellingAction) || !lastRun?.id}
                    onClick={() => cancelJob(job.name, lastRun.id, { restart: true })}
                  >
                    {cancellingAction?.jobName === job.name && cancellingAction.restart
                      ? 'Restarting…'
                      : 'Stop & restart'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="portal-btn portal-btn--secondary"
                  disabled={triggeringJob === job.name}
                  onClick={() => runJob(job.name)}
                >
                  {triggeringJob === job.name ? 'Starting…' : 'Run now'}
                </button>
              )}
              <button
                type="button"
                className="portal-btn portal-btn--secondary"
                onClick={() => {
                  setExpandedJob(isExpanded ? '' : job.name);
                  if (isExpanded && logView?.jobName === job.name) {
                    setLogView(null);
                  }
                }}
              >
                {isExpanded ? 'Hide history' : 'View history'}
              </button>
            </div>
            {isExpanded ? (
              <>
                {runsLoading && runs.length === 0 ? (
                  <p className="portal-admin-status">Loading run history…</p>
                ) : null}
                {runs.length > 0 ? (
                  <div className="portal-admin-table-wrap portal-admin-table-wrap--scroll">
                    <table className="portal-admin-table portal-admin-job-runs-table">
                      <thead>
                        <tr>
                          <th scope="col">Started</th>
                          <th scope="col">Status</th>
                          <th scope="col">Duration</th>
                          <th scope="col">Trigger</th>
                          <th scope="col">Summary</th>
                          <th scope="col">Log</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((run) => (
                          <tr key={run.id}>
                            <td>{formatJobTimestamp(run.startedAt)}</td>
                            <td>
                              <PortalAdminJobStatusBadge status={run.status} />
                            </td>
                            <td>{formatJobDuration(run.durationMs)}</td>
                            <td>{formatJobTrigger(run)}</td>
                            <td className="portal-admin-job-summary">
                              {run.status === 'failed' || run.status === 'skipped'
                                ? run.error || '—'
                                : summarizeJobResult(run.result) || '—'}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="portal-admin-job-log-link"
                                onClick={() => setLogView({ runId: run.id, jobName: job.name })}
                              >
                                View
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : !runsLoading ? (
                  <p className="portal-admin-status">No runs recorded yet.</p>
                ) : null}
                {logView && logView.jobName === job.name ? (
                  <PortalAdminJobLogPanel
                    jobName={job.name}
                    logRun={logRun}
                    logError={logError}
                    onClose={() => setLogView(null)}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function PortalAdminPage() {
  const { isAdmin } = usePortalClassGrade();
  const signedIn = isPortalSessionCompleteSync();
  const [activeTab, setActiveTab] = useState('overview');
  const [dashboard, setDashboard] = useState(null);
  const [dashboardError, setDashboardError] = useState('');
  const [dashboardLoading, setDashboardLoading] = useState(false);

  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [lookupResult, setLookupResult] = useState(null);
  const [reviewerActionLoading, setReviewerActionLoading] = useState(false);
  const [reviewerActionError, setReviewerActionError] = useState('');
  const [reviewerActionSuccess, setReviewerActionSuccess] = useState('');

  const [highGrades, setHighGrades] = useState([]);
  const [highGradesThreshold, setHighGradesThreshold] = useState(null);
  const [highGradesLoading, setHighGradesLoading] = useState(false);
  const [highGradesError, setHighGradesError] = useState('');

  const [exportPreview, setExportPreview] = useState(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportDownloading, setExportDownloading] = useState(false);

  const [mirrorCacheStatus, setMirrorCacheStatus] = useState(null);

  const [round1StatsLoading, setRound1StatsLoading] = useState(false);
  const [round1StatsError, setRound1StatsError] = useState('');
  const [round1StatsResult, setRound1StatsResult] = useState(null);
  const [activeApplicationCategory, setActiveApplicationCategory] = useState(null);

  useEffect(() => {
    if (!signedIn || !isAdmin || activeTab !== 'overview') {
      return undefined;
    }
    let cancelled = false;
    setDashboardLoading(true);
    setDashboardError('');
    adminApiPost('/api/portal-admin/dashboard')
      .then((data) => {
        if (!cancelled) {
          setDashboard(data.dashboard || null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDashboardError(err.message || 'Could not load dashboard.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDashboardLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, isAdmin, activeTab]);

  useEffect(() => {
    if (!signedIn || !isAdmin || activeTab !== 'jobs') {
      return undefined;
    }
    let cancelled = false;
    fetch('/api/health')
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) {
          setMirrorCacheStatus(data.mirrorCache || null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMirrorCacheStatus(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, isAdmin, activeTab]);

  useEffect(() => {
    if (!signedIn || !isAdmin || activeTab !== 'high-grades') {
      return undefined;
    }
    let cancelled = false;
    setHighGradesLoading(true);
    setHighGradesError('');
    adminApiPost('/api/portal-admin/high-grades')
      .then((data) => {
        if (!cancelled) {
          setHighGrades(Array.isArray(data.students) ? data.students : []);
          setHighGradesThreshold(typeof data.threshold === 'number' ? data.threshold : null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setHighGradesError(err.message || 'Could not load students.');
          setHighGrades([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHighGradesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, isAdmin, activeTab]);

  useEffect(() => {
    if (!signedIn || !isAdmin || activeTab !== 'dingconnect') {
      return undefined;
    }
    let cancelled = false;
    setExportLoading(true);
    setExportError('');
    adminApiPost('/api/portal-admin/dingconnect-export')
      .then((data) => {
        if (!cancelled) {
          setExportPreview(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setExportError(err.message || 'Could not load export preview.');
          setExportPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setExportLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, isAdmin, activeTab]);

  const runLookup = async () => {
    const query = lookupQuery.trim();
    if (query.length < 2) {
      setLookupError('Enter at least 2 characters to search.');
      setLookupResult(null);
      return;
    }
    setLookupLoading(true);
    setLookupError('');
    setLookupResult(null);
    setReviewerActionError('');
    setReviewerActionSuccess('');
    try {
      const data = await adminApiPost('/api/portal-admin/lookup', { query });
      setLookupResult(data);
    } catch (err) {
      setLookupError(err.message || 'Lookup failed.');
    } finally {
      setLookupLoading(false);
    }
  };

  const setReviewerAccess = async (reviewer) => {
    const detail = lookupResult?.detail;
    if (!detail?.id && !detail?.email) {
      return;
    }
    setReviewerActionLoading(true);
    setReviewerActionError('');
    setReviewerActionSuccess('');
    try {
      const data = await adminApiPost('/api/portal-admin/set-reviewer', {
        aesopId: detail.id || undefined,
        email: detail.id ? undefined : detail.email || undefined,
        reviewer,
      });
      const person = data.person || {};
      setLookupResult((prev) => {
        if (!prev?.detail) {
          return prev;
        }
        return {
          ...prev,
          detail: {
            ...prev.detail,
            reviewerRole: person.reviewerRole ?? (reviewer ? 'Yes' : ''),
            isReviewer: person.reviewer === true || (reviewer && person.reviewer !== false),
          },
        };
      });
      setReviewerActionSuccess(
        reviewer ? 'Reviewer access granted.' : 'Reviewer access removed.',
      );
    } catch (err) {
      setReviewerActionError(err.message || 'Could not update reviewer access.');
    } finally {
      setReviewerActionLoading(false);
    }
  };

  const handleDownloadCsv = async () => {
    setExportDownloading(true);
    setExportError('');
    try {
      await downloadAdminDingConnectCsv();
    } catch (err) {
      setExportError(err.message || 'Download failed.');
    } finally {
      setExportDownloading(false);
    }
  };

  const runRound1StatsCheck = async () => {
    setRound1StatsLoading(true);
    setRound1StatsError('');
    setRound1StatsResult(null);
    setActiveApplicationCategory(null);
    try {
      const data = await adminApiPost('/api/portal-admin/applications/round1-stats');
      setRound1StatsResult(data.stats || null);
    } catch (err) {
      setRound1StatsError(err.message || 'Could not load application status counts.');
    } finally {
      setRound1StatsLoading(false);
    }
  };

  if (!signedIn) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content portal-hub-card">
          <PortalSignInOnlyContent />
        </div>
      </PortalLayout>
    );
  }

  if (!isAdmin) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content portal-admin-card">
          <PortalSectionLinks current="admin" isAdmin={false} />
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">Admin access not detected</p>
            <p className="portal-session-banner-text">
              This account is not currently marked as an admin in the People sheet.
            </p>
          </div>
        </div>
      </PortalLayout>
    );
  }

  const thresholdLabel =
    highGradesThreshold != null
      ? highGradesThreshold
      : dashboard?.gradeThreshold != null
        ? dashboard.gradeThreshold
        : 65;

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-admin-card">
        <PortalSectionLinks current="admin" isAdmin={isAdmin} />
        <h2 className="portal-admin-title">
          Admin
          <PortalRoleBadge isAdmin className="portal-welcome-role" />
        </h2>
        <p className="portal-admin-lead">
          Live Classroom rosters, user lookup, high-grade rewards, and DingConnect+ bulk top-up export.{' '}
          <a href="/admin/emails">Bulk email →</a>
        </p>

        <PortalAdminViewAs />

        <nav className="portal-admin-tabs" aria-label="Admin sections">
          {[
            { id: 'overview', label: 'Overview' },
            { id: 'jobs', label: 'Jobs' },
            { id: 'all-classes', label: 'All classes' },
            { id: 'lookup', label: 'User Lookup' },
            { id: 'high-grades', label: `Grades above ${thresholdLabel}%` },
            { id: 'dingconnect', label: 'DingConnect+ CSV' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`portal-admin-tab${activeTab === tab.id ? ' is-active' : ''}`}
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {activeTab === 'overview' ? (
          <section className="portal-admin-panel" aria-label="Overview">
            {dashboardLoading ? <p className="portal-admin-status">Loading dashboard…</p> : null}
            {dashboardError ? (
              <p className="portal-admin-status portal-admin-status--error" role="alert">
                {dashboardError}
              </p>
            ) : null}
            {dashboard && !dashboardLoading ? (
              <dl className="portal-admin-stats">
                <div className="portal-admin-stat-row">
                  <dt>Classroom sync</dt>
                  <dd>{dashboard.classroomEnabled ? 'Enabled' : 'Disabled'}</dd>
                </div>
                <div className="portal-admin-stat-row">
                  <dt>Database cache</dt>
                  <dd>{dashboard.databaseEnabled ? 'Enabled' : 'Not configured'}</dd>
                </div>
                {dashboard.lastSyncedAt ? (
                  <div className="portal-admin-stat-row">
                    <dt>Last synced</dt>
                    <dd>{new Date(dashboard.lastSyncedAt).toLocaleString()}</dd>
                  </div>
                ) : null}
                {dashboard.backupExportKey ? (
                  <div className="portal-admin-stat-row">
                    <dt>Latest backup</dt>
                    <dd className="portal-admin-mono">{dashboard.backupExportKey}</dd>
                  </div>
                ) : null}
                <div className="portal-admin-stat-row">
                  <dt>{dashboard.rolesTab || 'Classroom Roles'} rows</dt>
                  <dd>{dashboard.rolesRows ?? '—'}</dd>
                </div>
                <div className="portal-admin-stat-row">
                  <dt>{dashboard.gradesTab || 'Classroom Grades'} rows</dt>
                  <dd>{dashboard.gradesRows ?? '—'}</dd>
                </div>
                <div className="portal-admin-stat-row">
                  <dt>Grade reward threshold</dt>
                  <dd>&gt; {dashboard.gradeThreshold ?? 65}%</dd>
                </div>
                <div className="portal-admin-stat-row">
                  <dt>DingConnect+ amount</dt>
                  <dd>{dashboard.dingConnectTopUpAmount || '—'}</dd>
                </div>
              </dl>
            ) : null}
            {dashboard?.syncHint ? <p className="portal-admin-hint">{dashboard.syncHint}</p> : null}
            <div className="portal-admin-voice-memo-sync portal-admin-application-stats">
              <h3 className="portal-admin-subheading">Application status (Round 1)</h3>
              <p className="portal-admin-hint">
                Count applicants on the <strong>Applicants</strong> sheet by the <strong>Round 1</strong>{' '}
                column (Accepted / Rejected / Pending). Voice memo counts include Round 1 accepted
                applicants with a submission and check recording length (
                {round1StatsResult?.voiceMemo?.minDurationSeconds ?? 30} sec–
                {Math.floor((round1StatsResult?.voiceMemo?.maxDurationSeconds ?? 120) / 60)} min).
                Click a number to list applicants and compose a bulk email to that group. The first
                check may take up to a minute on a large Applicants sheet.
              </p>
              {round1StatsLoading ? (
                <p className="portal-admin-status" role="status">
                  Loading Applicants sheet, scanning Drive, and checking voice memo lengths…
                </p>
              ) : null}
              <button
                type="button"
                className="portal-btn portal-btn--secondary"
                disabled={round1StatsLoading}
                onClick={runRound1StatsCheck}
              >
                {round1StatsLoading ? 'Checking application status…' : 'Check application status'}
              </button>
              {round1StatsError ? (
                <p className="portal-admin-status portal-admin-status--error" role="alert">
                  {round1StatsError}
                </p>
              ) : null}
              {round1StatsResult ? (
                <>
                <dl className="portal-admin-stats portal-admin-application-stats-panel">
                  <div className="portal-admin-stat-row">
                    <dt>Applicants sheet</dt>
                    <dd>{round1StatsResult.sheetName || 'Applicants'}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>Round 1 column</dt>
                    <dd>{round1StatsResult.round1Column || 'Round 1'}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>Total applicants</dt>
                    <dd>{round1StatsResult.total ?? 0}</dd>
                  </div>
                  <PortalAdminApplicationCategoryRow
                    categoryKey="round1Accepted"
                    label="Accepted"
                    count={round1StatsResult.accepted ?? 0}
                    activeCategory={activeApplicationCategory}
                    onSelectCategory={setActiveApplicationCategory}
                    statusClassName="portal-application-status portal-application-status--accepted"
                  />
                  <PortalAdminApplicationCategoryRow
                    categoryKey="round1Rejected"
                    label="Rejected"
                    count={round1StatsResult.rejected ?? 0}
                    activeCategory={activeApplicationCategory}
                    onSelectCategory={setActiveApplicationCategory}
                    statusClassName="portal-application-status portal-application-status--rejected"
                  />
                  <PortalAdminApplicationCategoryRow
                    categoryKey="round1Pending"
                    label="Pending"
                    count={round1StatsResult.pending ?? 0}
                    activeCategory={activeApplicationCategory}
                    onSelectCategory={setActiveApplicationCategory}
                    statusClassName="portal-application-status portal-application-status--pending"
                  />
                  {round1StatsResult.voiceMemo ? (
                    <>
                      <PortalAdminApplicationCategoryRow
                        categoryKey="voiceMemoSubmitted"
                        label="Voice memos submitted"
                        count={round1StatsResult.voiceMemo.submitted ?? 0}
                        activeCategory={activeApplicationCategory}
                        onSelectCategory={setActiveApplicationCategory}
                      />
                      <PortalAdminApplicationCategoryRow
                        categoryKey="voiceMemoValidDuration"
                        label={`Valid length (${round1StatsResult.voiceMemo.minDurationSeconds ?? 30} sec–${Math.floor((round1StatsResult.voiceMemo.maxDurationSeconds ?? 120) / 60)} min)`}
                        count={round1StatsResult.voiceMemo.validDuration ?? 0}
                        activeCategory={activeApplicationCategory}
                        onSelectCategory={setActiveApplicationCategory}
                        statusClassName="portal-application-status portal-application-status--accepted"
                      />
                      <PortalAdminApplicationCategoryRow
                        categoryKey="voiceMemoTooShort"
                        label={`Shorter than ${round1StatsResult.voiceMemo.minDurationSeconds ?? 30} sec`}
                        count={round1StatsResult.voiceMemo.tooShort ?? 0}
                        activeCategory={activeApplicationCategory}
                        onSelectCategory={setActiveApplicationCategory}
                        statusClassName="portal-application-status portal-application-status--rejected"
                      />
                      <PortalAdminApplicationCategoryRow
                        categoryKey="voiceMemoTooLong"
                        label={`Longer than ${Math.floor((round1StatsResult.voiceMemo.maxDurationSeconds ?? 120) / 60)} min`}
                        count={round1StatsResult.voiceMemo.tooLong ?? 0}
                        activeCategory={activeApplicationCategory}
                        onSelectCategory={setActiveApplicationCategory}
                        statusClassName="portal-application-status portal-application-status--rejected"
                      />
                      {(round1StatsResult.voiceMemo.unknownDuration ?? 0) > 0 ? (
                        <PortalAdminApplicationCategoryRow
                          categoryKey="voiceMemoUnknownDuration"
                          label="Duration unknown"
                          count={round1StatsResult.voiceMemo.unknownDuration ?? 0}
                          activeCategory={activeApplicationCategory}
                          onSelectCategory={setActiveApplicationCategory}
                          statusClassName="portal-application-status portal-application-status--pending"
                        />
                      ) : null}
                    </>
                  ) : null}
                </dl>
                <PortalAdminApplicationIssuesPanel
                  lists={round1StatsResult.lists}
                  onEmailGroup={openBulkEmailForApplicantList}
                />
                {activeApplicationCategory &&
                round1StatsResult.lists &&
                !APPLICATION_STAT_ISSUE_CATEGORIES.includes(activeApplicationCategory) ? (
                  <PortalAdminApplicationCategoryPanel
                    categoryKey={activeApplicationCategory}
                    people={round1StatsResult.lists[activeApplicationCategory] || []}
                    onEmailGroup={openBulkEmailForApplicantList}
                  />
                ) : null}
                </>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeTab === 'jobs' ? <PortalAdminJobsTab mirrorCacheStatus={mirrorCacheStatus} /> : null}

        {activeTab === 'all-classes' ? (
          <section className="portal-admin-panel" aria-label="All classes">
            <PortalAdminAllClassesRoster />
          </section>
        ) : null}

        {activeTab === 'lookup' ? (
          <section className="portal-admin-panel" aria-label="User Lookup">
            <div className="portal-admin-lookup-form">
              <label htmlFor="portal-admin-lookup" className="portal-admin-lookup-label">
                Search by name, AESOP ID, or email
              </label>
              <div className="portal-admin-lookup-row">
                <input
                  id="portal-admin-lookup"
                  type="search"
                  className="portal-admin-lookup-input"
                  value={lookupQuery}
                  onChange={(e) => setLookupQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      runLookup();
                    }
                  }}
                  placeholder="e.g. student name or AESOP ID"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="portal-admin-action"
                  onClick={runLookup}
                  disabled={lookupLoading}
                >
                  {lookupLoading ? 'Searching…' : 'Search'}
                </button>
              </div>
            </div>
            {lookupError ? (
              <p className="portal-admin-status portal-admin-status--error" role="alert">
                {lookupError}
              </p>
            ) : null}
            {lookupResult?.matches?.length > 1 ? (
              <p className="portal-admin-hint">
                Showing detail for the best match ({lookupResult.matches.length} found).
              </p>
            ) : null}
            {lookupResult?.detail ? (
              <div className="portal-admin-lookup-detail">
                <h3 className="portal-admin-subheading">{lookupResult.detail.name || 'Student'}</h3>
                <PortalAdminImpersonateActions targetUserId={lookupResult.detail.id} />
                <dl className="portal-admin-stats">
                  <div className="portal-admin-stat-row">
                    <dt>AESOP ID</dt>
                    <dd className="portal-admin-mono">{lookupResult.detail.id || '—'}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>Email</dt>
                    <dd>{lookupResult.detail.email || '—'}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>Ding number</dt>
                    <dd className="portal-admin-mono">{lookupResult.detail.dingNumber || '—'}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>Role</dt>
                    <dd>{lookupResult.detail.role || '—'}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>Reviewer</dt>
                    <dd>{lookupResult.detail.isReviewer ? 'Yes' : 'No'}</dd>
                  </div>
                </dl>
                <div className="portal-admin-lookup-section">
                  <div className="portal-admin-lookup-row">
                    {lookupResult.detail.isReviewer ? (
                      <button
                        type="button"
                        className="portal-admin-action portal-btn--secondary"
                        onClick={() => setReviewerAccess(false)}
                        disabled={reviewerActionLoading}
                      >
                        {reviewerActionLoading ? 'Updating…' : 'Remove reviewer access'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="portal-admin-action"
                        onClick={() => setReviewerAccess(true)}
                        disabled={reviewerActionLoading}
                      >
                        {reviewerActionLoading ? 'Updating…' : 'Grant reviewer access'}
                      </button>
                    )}
                  </div>
                  {reviewerActionError ? (
                    <p className="portal-admin-status portal-admin-status--error" role="alert">
                      {reviewerActionError}
                    </p>
                  ) : null}
                  {reviewerActionSuccess ? (
                    <p className="portal-admin-status" role="status">
                      {reviewerActionSuccess}
                    </p>
                  ) : null}
                </div>
                {lookupResult.detail.classGrades?.length > 0 ? (
                  <div className="portal-admin-lookup-section">
                    <h4 className="portal-admin-subheading-sm">Grades by course</h4>
                    <table className="portal-admin-table">
                      <thead>
                        <tr>
                          <th scope="col">Course</th>
                          <th scope="col">Grade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lookupResult.detail.classGrades.map((row) => (
                          <tr key={row.classSection || row.calculatedGrade}>
                            <td>{row.classSection || '—'}</td>
                            <td>{row.calculatedGrade || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : lookupResult.detail.classSection || lookupResult.detail.calculatedGrade ? (
                  <dl className="portal-admin-stats">
                    <div className="portal-admin-stat-row">
                      <dt>Class</dt>
                      <dd>{lookupResult.detail.classSection || '—'}</dd>
                    </div>
                    <div className="portal-admin-stat-row">
                      <dt>Grade</dt>
                      <dd>{lookupResult.detail.calculatedGrade || '—'}</dd>
                    </div>
                  </dl>
                ) : null}
                {lookupResult.detail.dingHistory?.length > 0 ? (
                  <div className="portal-admin-lookup-section">
                    <h4 className="portal-admin-subheading-sm">Recent Ding changes</h4>
                    <table className="portal-admin-table">
                      <thead>
                        <tr>
                          <th scope="col">When</th>
                          <th scope="col">Ding number</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lookupResult.detail.dingHistory.map((row, i) => (
                          <tr key={`${row.atMs}-${row.dingNumber}-${i}`}>
                            <td>{formatPortalDingHistoryAt(row.atMs)}</td>
                            <td className="portal-admin-mono">{row.dingNumber}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {lookupResult.detail.liveClasses?.length > 0 ? (
                  <div className="portal-admin-lookup-section">
                    <h4 className="portal-admin-subheading-sm">Live assignment grades</h4>
                    {lookupResult.detail.liveClasses.map((cls) => (
                      <div key={cls.label || cls.courseId} className="portal-admin-live-class">
                        <p className="portal-admin-live-class-name">{cls.label}</p>
                        <PortalAssignmentTable assignments={cls.assignments || []} />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {lookupResult && !lookupResult.detail && !lookupLoading && !lookupError ? (
              <p className="portal-admin-status">No students matched that search.</p>
            ) : null}
          </section>
        ) : null}

        {activeTab === 'high-grades' ? (
          <section className="portal-admin-panel" aria-label="High grade students">
            <p className="portal-admin-hint">
              Students with a calculated grade strictly above {thresholdLabel}% from the Classroom Grades sheet.
            </p>
            {highGradesLoading ? <p className="portal-admin-status">Loading students…</p> : null}
            {highGradesError ? (
              <p className="portal-admin-status portal-admin-status--error" role="alert">
                {highGradesError}
              </p>
            ) : null}
            {!highGradesLoading && !highGradesError && highGrades.length === 0 ? (
              <p className="portal-admin-status">No students above the threshold right now.</p>
            ) : null}
            {!highGradesLoading && highGrades.length > 0 ? (
              <div className="portal-admin-table-wrap">
                <table className="portal-admin-table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Ding number</th>
                      <th scope="col">Grade</th>
                      <th scope="col">Class</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {highGrades.map((student) => (
                      <tr key={student.email || student.userId || student.name}>
                        <td>{student.name || '—'}</td>
                        <td className="portal-admin-mono">{student.dingNumber || '—'}</td>
                        <td>{student.calculatedGrade || '—'}</td>
                        <td>{student.classSection || '—'}</td>
                        <td>
                          {student.userId ? (
                            <PortalAdminImpersonateActions targetUserId={student.userId} compact />
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeTab === 'dingconnect' ? (
          <section className="portal-admin-panel" aria-label="DingConnect plus export">
            <p className="portal-admin-hint">
              Download a CSV with columns <strong>Number</strong>, <strong>Amount</strong>, and <strong>Sku</strong>{' '}
              for eligible students (grade &gt; {thresholdLabel}% with a Ding number on file).
            </p>
            {exportLoading ? <p className="portal-admin-status">Loading export preview…</p> : null}
            {exportError ? (
              <p className="portal-admin-status portal-admin-status--error" role="alert">
                {exportError}
              </p>
            ) : null}
            {exportPreview && !exportLoading ? (
              <>
                <dl className="portal-admin-stats portal-admin-stats--compact">
                  <div className="portal-admin-stat-row">
                    <dt>Rows in CSV</dt>
                    <dd>{exportPreview.rowCount ?? 0}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>Skipped (no Ding)</dt>
                    <dd>{exportPreview.skippedWithoutDing ?? 0}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>Amount</dt>
                    <dd>{exportPreview.amount || '—'}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>SKU</dt>
                    <dd className="portal-admin-mono">{exportPreview.sku || '—'}</dd>
                  </div>
                </dl>
                <div className="portal-admin-actions">
                  <button
                    type="button"
                    className="portal-admin-action portal-admin-action--primary"
                    onClick={handleDownloadCsv}
                    disabled={exportDownloading || !(exportPreview.rowCount > 0)}
                  >
                    {exportDownloading ? 'Downloading…' : 'Download CSV'}
                  </button>
                </div>
                {exportPreview.students?.length > 0 ? (
                  <div className="portal-admin-table-wrap">
                    <h4 className="portal-admin-subheading-sm">Preview</h4>
                    <table className="portal-admin-table">
                      <thead>
                        <tr>
                          <th scope="col">Number</th>
                          <th scope="col">Amount</th>
                          <th scope="col">Sku</th>
                        </tr>
                      </thead>
                      <tbody>
                        {exportPreview.students.map((row) => (
                          <tr key={row.userId || row.dingNumber || row.name}>
                            <td className="portal-admin-mono">{row.dingNumber}</td>
                            <td>{exportPreview.amount}</td>
                            <td className="portal-admin-mono">{exportPreview.sku}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
      </div>
    </PortalLayout>
  );
}

const EMAIL_IDENTITY_PLACEHOLDERS = new Set(['aesop id', 'name', 'email']);

function extractEmailPlaceholders(subject, body) {
  const found = new Set();
  const re = /\[\[([^\]]+)\]\]|\{\{([^}]+)\}\}/g;
  for (const text of [subject, body]) {
    if (typeof text !== 'string') {
      continue;
    }
    let match;
    const copy = new RegExp(re.source, 'g');
    while ((match = copy.exec(text)) !== null) {
      const name = String(match[1] || match[2] || '').trim();
      if (name) {
        found.add(name);
      }
    }
  }
  return Array.from(found);
}

function detectGlobalEmailPlaceholders(subject, body, rowColumnLabels) {
  const rowSet = new Set((rowColumnLabels || []).map((label) => String(label).trim().toLowerCase()));
  return extractEmailPlaceholders(subject, body).filter((name) => {
    const lower = name.toLowerCase();
    return !EMAIL_IDENTITY_PLACEHOLDERS.has(lower) && !rowSet.has(lower);
  });
}

function buildEmailFilterPayload(filterAll, filterColumn, filterValue, aesopIds = null) {
  if (Array.isArray(aesopIds) && aesopIds.length > 0) {
    return { aesopIds };
  }
  if (filterAll || !filterColumn || !filterValue) {
    return null;
  }
  return { column: filterColumn, values: [filterValue] };
}

function storeAdminEmailRecipientList({ aesopIds, label }) {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  const ids = Array.isArray(aesopIds)
    ? [...new Set(aesopIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) {
    return;
  }
  sessionStorage.setItem(
    PORTAL_ADMIN_EMAIL_RECIPIENT_LIST_KEY,
    JSON.stringify({
      aesopIds: ids,
      label: String(label || '').trim() || 'Selected applicants',
      at: Date.now(),
    }),
  );
}

function readAdminEmailRecipientList() {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }
  const raw = sessionStorage.getItem(PORTAL_ADMIN_EMAIL_RECIPIENT_LIST_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const aesopIds = Array.isArray(parsed?.aesopIds)
      ? parsed.aesopIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    if (aesopIds.length === 0) {
      return null;
    }
    return {
      aesopIds,
      label: String(parsed?.label || '').trim() || 'Selected applicants',
    };
  } catch {
    return null;
  } finally {
    sessionStorage.removeItem(PORTAL_ADMIN_EMAIL_RECIPIENT_LIST_KEY);
  }
}

function openBulkEmailForApplicantList(people, label) {
  const aesopIds = (people || [])
    .map((person) => String(person?.aesopId || person?.id || '').trim())
    .filter(Boolean);
  if (aesopIds.length === 0) {
    return;
  }
  storeAdminEmailRecipientList({ aesopIds, label });
  window.location.assign('/admin/emails');
}

const EMAIL_BODY_MARKDOWN_LINK_RE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s<>)}"']+|www\.[^\s<>)}"']+)\)/g;
const EMAIL_BODY_BARE_URL_RE = /\b(https?:\/\/[^\s<>\]\)}"']+|www\.[^\s<>\]\)}"']+)/gi;

function escapeEmailBodyHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeClipboardLinkHref(href) {
  const raw = String(href || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const url = new URL(raw);
    if (
      (url.hostname === 'www.google.com' || url.hostname === 'google.com') &&
      url.pathname === '/url'
    ) {
      const target = url.searchParams.get('q') || url.searchParams.get('url');
      if (target && /^https?:\/\//i.test(target)) {
        return target;
      }
    }
  } catch {
    // keep raw href
  }
  return raw;
}

function isExternalHttpHref(href) {
  const normalized = normalizeClipboardLinkHref(href);
  return /^https?:\/\//i.test(normalized);
}

function createEmailBodyLinkElement(doc, href, label) {
  const normalizedHref = normalizeClipboardLinkHref(href);
  const anchor = doc.createElement('a');
  anchor.href = normalizedHref;
  anchor.textContent = label;
  anchor.className = 'portal-admin-emails-inline-link';
  anchor.setAttribute('data-email-link', '1');
  anchor.contentEditable = 'false';
  return anchor;
}

function renderEmailBodyInlineMarkdown(text) {
  let html = '';
  let lastIndex = 0;
  EMAIL_BODY_MARKDOWN_LINK_RE.lastIndex = 0;
  let match;
  while ((match = EMAIL_BODY_MARKDOWN_LINK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      html += renderEmailBodyBareUrls(text.slice(lastIndex, match.index));
    }
    const href = match[2].startsWith('www.') ? `https://${match[2]}` : match[2];
    html += `<a href="${escapeEmailBodyHtml(href)}" class="portal-admin-emails-inline-link" data-email-link="1" contenteditable="false">${escapeEmailBodyHtml(match[1])}</a>`;
    lastIndex = EMAIL_BODY_MARKDOWN_LINK_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    html += renderEmailBodyBareUrls(text.slice(lastIndex));
  }
  return html;
}

function renderEmailBodyBareUrls(text) {
  let html = '';
  let lastIndex = 0;
  EMAIL_BODY_BARE_URL_RE.lastIndex = 0;
  let match;
  while ((match = EMAIL_BODY_BARE_URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      html += escapeEmailBodyHtml(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    const href = url.startsWith('www.') ? `https://${url}` : url;
    html += `<a href="${escapeEmailBodyHtml(href)}" class="portal-admin-emails-inline-link" data-email-link="1" contenteditable="false">${escapeEmailBodyHtml(url)}</a>`;
    lastIndex = EMAIL_BODY_BARE_URL_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    html += escapeEmailBodyHtml(text.slice(lastIndex));
  }
  return html;
}

function emailBodyMarkdownToHtml(markdown) {
  const normalized = String(markdown || '');
  if (!normalized.trim()) {
    return '';
  }
  return normalized
    .split(/\n\n+/)
    .map((paragraph) => {
      const lines = paragraph.split('\n').map((line) => renderEmailBodyInlineMarkdown(line));
      const dir = paragraphDirection(paragraph);
      return `<div class="portal-admin-emails-body-block" dir="${dir}">${lines.join('<br />')}</div>`;
    })
    .join('');
}

function serializeEmailBodyFromHtmlNode(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent || '';
    } else if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    } else if (child.nodeName === 'A') {
      const href = normalizeClipboardLinkHref(child.getAttribute('href') || '');
      const label = (child.textContent || '').replace(/\s+/g, ' ').trim();
      if (isExternalHttpHref(href) && label) {
        out += `[${label}](${href})`;
      } else {
        out += child.textContent || '';
      }
    } else if (child.nodeName === 'BR') {
      out += '\n';
    } else if (
      child.nodeName === 'P' ||
      child.nodeName === 'DIV' ||
      child.nodeName === 'LI' ||
      child.classList?.contains('portal-admin-emails-body-block')
    ) {
      if (out && !out.endsWith('\n\n')) {
        out += out.endsWith('\n') ? '\n' : '\n\n';
      }
      out += serializeEmailBodyFromHtmlNode(child);
    } else {
      out += serializeEmailBodyFromHtmlNode(child);
    }
  }
  return out;
}

function emailBodyElementToMarkdown(root) {
  return serializeEmailBodyFromHtmlNode(root).replace(/\u00a0/g, ' ').trimEnd();
}

function clipboardHtmlHasExternalLinks(html) {
  if (!html || typeof html !== 'string') {
    return false;
  }
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const anchors = doc.body?.querySelectorAll('a[href]') || [];
    for (const anchor of anchors) {
      if (isExternalHttpHref(anchor.getAttribute('href') || '')) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function appendEmailBodyNodesFromHtml(parent, sourceNode, doc) {
  for (const child of sourceNode.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent || '';
      if (text) {
        parent.appendChild(doc.createTextNode(text));
      }
    } else if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    } else if (child.nodeName === 'A') {
      const href = child.getAttribute('href') || '';
      const label = (child.textContent || '').replace(/\s+/g, ' ').trim();
      if (isExternalHttpHref(href) && label) {
        parent.appendChild(createEmailBodyLinkElement(doc, href, label));
      } else if (child.textContent) {
        parent.appendChild(doc.createTextNode(child.textContent));
      }
    } else if (child.nodeName === 'BR') {
      parent.appendChild(doc.createElement('br'));
    } else if (child.nodeName === 'P' || child.nodeName === 'DIV' || child.nodeName === 'LI') {
      if (parent.childNodes.length > 0) {
        parent.appendChild(doc.createElement('br'));
        parent.appendChild(doc.createElement('br'));
      }
      appendEmailBodyNodesFromHtml(parent, child, doc);
    } else {
      appendEmailBodyNodesFromHtml(parent, child, doc);
    }
  }
}

function buildClipboardDocumentFragment(html) {
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const wrapper = document.createElement('div');
    appendEmailBodyNodesFromHtml(wrapper, parsed.body, document);
    const fragment = document.createDocumentFragment();
    while (wrapper.firstChild) {
      fragment.appendChild(wrapper.firstChild);
    }
    return fragment.childNodes.length ? fragment : null;
  } catch {
    return null;
  }
}

function insertDocumentFragmentAtSelection(fragment) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(fragment);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function AdminEmailBodyEditor({ id, value, onChange, placeholder }) {
  const editorRef = useRef(null);
  const lastValueRef = useRef(value);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    if (value === lastValueRef.current && editor.innerHTML) {
      return;
    }
    if (document.activeElement === editor) {
      lastValueRef.current = value;
      return;
    }
    lastValueRef.current = value;
    editor.innerHTML = value.trim() ? emailBodyMarkdownToHtml(value) : '';
  }, [value]);

  const syncToMarkdown = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const markdown = emailBodyElementToMarkdown(editor);
    lastValueRef.current = markdown;
    onChange(markdown);
  }, [onChange]);

  const handlePaste = (event) => {
    const html = event.clipboardData?.getData('text/html');
    if (html && clipboardHtmlHasExternalLinks(html)) {
      const fragment = buildClipboardDocumentFragment(html);
      if (fragment) {
        event.preventDefault();
        insertDocumentFragmentAtSelection(fragment);
        syncToMarkdown();
        return;
      }
    }
    requestAnimationFrame(syncToMarkdown);
  };

  return (
    <div
      id={id}
      ref={editorRef}
      className="portal-admin-emails-textarea portal-admin-emails-body-editor"
      dir="auto"
      contentEditable
      role="textbox"
      aria-multiline="true"
      data-placeholder={placeholder}
      onInput={syncToMarkdown}
      onPaste={handlePaste}
      onBlur={syncToMarkdown}
      onClick={(event) => {
        if (event.target.closest('a[data-email-link]')) {
          event.preventDefault();
        }
      }}
    />
  );
}

function rowMatchesAdmissionsFilter(fields, filter) {
  if (!filter?.column || !Array.isArray(filter.values) || filter.values.length === 0) {
    return true;
  }
  const cell = fields?.[filter.column];
  if (cell == null) {
    return false;
  }
  const want = new Set(
    filter.values.map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean),
  );
  return want.has(String(cell).trim().toLowerCase());
}

function filterDuplicateSkipsForScope(skips, filter) {
  if (!Array.isArray(skips) || skips.length === 0) {
    return [];
  }
  if (!filter) {
    return skips;
  }
  return skips.filter((skip) => rowMatchesAdmissionsFilter(skip.fields, filter));
}

function resolvePanelDuplicateSkips(recipientStats, stats, activeFilter) {
  if (recipientStats) {
    return Array.isArray(recipientStats.duplicateEmailSkips)
      ? recipientStats.duplicateEmailSkips
      : [];
  }
  return filterDuplicateSkipsForScope(stats?.duplicateEmailSkips, activeFilter);
}

function resolvePanelDuplicateGroups(recipientStats, stats, activeFilter) {
  if (recipientStats) {
    return Array.isArray(recipientStats.duplicateEmailGroups)
      ? recipientStats.duplicateEmailGroups
      : [];
  }
  const fromStats = Array.isArray(stats?.duplicateEmailGroups) ? stats.duplicateEmailGroups : [];
  if (!activeFilter) {
    return fromStats;
  }
  return fromStats
    .map((group) => ({
      email: group.email,
      rows: (group.rows || []).filter((row) => rowMatchesAdmissionsFilter(row.fields, activeFilter)),
    }))
    .filter((group) => group.rows.length > 1);
}

function resolvePanelExcludedRows(recipientStats) {
  if (!recipientStats) {
    return [];
  }
  const fromPreview = Array.isArray(recipientStats.excludedFromSend)
    ? recipientStats.excludedFromSend
    : [];
  if (fromPreview.length > 0) {
    return fromPreview;
  }
  const skippedNoEmail = Array.isArray(recipientStats.skippedFromSend)
    ? recipientStats.skippedFromSend.filter((row) => row.reason === 'no-email')
    : [];
  return skippedNoEmail;
}

function formatRecipientSkipRow(row) {
  const id = row.id ? `AESOP ID ${row.id}` : 'No AESOP ID';
  const name = row.name || '(no name)';
  if (row.reason === 'no-email') {
    return `${id} — ${name} (Email column is empty)`;
  }
  if (row.reason === 'duplicate-email' && row.sharedWith) {
    const keptId = row.sharedWith.id ? `AESOP ID ${row.sharedWith.id}` : 'another row';
    const keptName = row.sharedWith.name || row.sharedWith.email || keptId;
    return `${id} — ${name} (same email as ${keptName}, ${row.email})`;
  }
  return `${id} — ${name}`;
}

function ApplicantsSheetDebugPanel({
  stats,
  recipientStats,
  recipientCount,
  previewLoading,
  previewError,
}) {
  if (!stats) {
    return null;
  }

  if (!stats.sheetFound) {
    return (
      <div className="portal-admin-emails-debug" role="status">
        <p className="portal-admin-emails-debug-title">Sheet debug</p>
        <p>
          Tab <strong>{stats.configuredSheetName || 'Applicants'}</strong> was not found in the
          spreadsheet.
        </p>
        {stats.similarTabs?.length ? (
          <p>
            Similar tab names: {stats.similarTabs.join(', ')}
          </p>
        ) : null}
        {stats.availableTabs?.length ? (
          <p className="portal-admin-emails-debug-tabs">
            Available tabs ({stats.availableTabs.length}): {stats.availableTabs.join(', ')}
          </p>
        ) : null}
      </div>
    );
  }

  const mapping = stats.columnMapping || {};
  const activeFilter = recipientStats?.filter ?? null;
  const previewReady = !previewLoading && !previewError;
  const matchedCount =
    recipientStats?.rowsAfterFilter ??
    (previewReady && !activeFilter ? stats.rowsWithEmail : null);
  const sendCount =
    recipientStats?.recipientCount ?? (previewReady ? recipientCount : null);
  const sendGap =
    matchedCount != null && sendCount != null ? Math.max(0, matchedCount - sendCount) : 0;
  const hasReliableGap = previewReady && recipientStats != null && sendGap > 0;
  const duplicateSkips = resolvePanelDuplicateSkips(recipientStats, stats, activeFilter);
  const duplicateGroups = resolvePanelDuplicateGroups(recipientStats, stats, activeFilter);
  const excludedRows = resolvePanelExcludedRows(recipientStats);
  const excludedNoEmail = excludedRows.filter((row) => row.reason === 'no-email');
  const excludedDuplicates = excludedRows.filter((row) => row.reason === 'duplicate-email');

  return (
    <div className="portal-admin-emails-debug" role="status">
      <p className="portal-admin-emails-debug-title">Sheet debug</p>
      <ul className="portal-admin-emails-debug-list">
        <li>
          Tab <strong>{stats.configuredSheetName}</strong>, header row {stats.headerRowNum ?? 1}
        </li>
        <li>
          Column mapping: AESOP ID = {mapping.id || 'A'}, Name = {mapping.name || 'C'}, Email ={' '}
          {mapping.email || 'D'}
          {mapping.specialEmail ? (
            <>
              , Special emails (group filter) = {mapping.specialEmail}
            </>
          ) : null}
        </li>
        {stats.headerLabels?.length ? (
          <li>Headers read: {stats.headerLabels.join(' · ')}</li>
        ) : null}
        <li>
          <strong>{stats.dataRowsRead ?? 0}</strong> data row(s) read from the sheet
        </li>
        <li>
          <strong>{stats.rowsWithEmail ?? 0}</strong> row(s) with a non-empty email (column{' '}
          {mapping.email || 'D'})
        </li>
        {(stats.rowsSkippedNoEmail ?? 0) > 0 ? (
          <li>
            <strong>{stats.rowsSkippedNoEmail}</strong> row(s) skipped — no email in column{' '}
            {mapping.email || 'D'}
          </li>
        ) : null}
        {previewLoading ? (
          <li>Loading recipient count…</li>
        ) : previewError ? (
          <li>Recipient count unavailable — see Review section for the error.</li>
        ) : sendCount != null ? (
          <>
            {recipientStats?.filter?.aesopIds ? (
              <li>
                Filter: <strong>{recipientStats.filter.aesopIds.length}</strong> selected AESOP ID
                {recipientStats.filter.aesopIds.length === 1 ? '' : 's'}:{' '}
                <strong>{recipientStats.rowsAfterFilter ?? 0}</strong> row(s) matched
              </li>
            ) : recipientStats?.filter ? (
              <li>
                Filter <strong>{recipientStats.filter.column}</strong> ={' '}
                {recipientStats.filter.values?.join(', ')}:{' '}
                <strong>{recipientStats.rowsAfterFilter ?? 0}</strong> row(s) matched
              </li>
            ) : null}
            <li>
              <strong>{sendCount}</strong> email{sendCount === 1 ? '' : 's'} will be sent (one per
              application row)
            </li>
            {(recipientStats?.transactionalRecipientCount ?? 0) > 0 ? (
              <li>
                Send order: <strong>{recipientStats.transactionalRecipientCount}</strong> shared-email
                row{recipientStats.transactionalRecipientCount === 1 ? '' : 's'} first (transactional
                stream), then{' '}
                <strong>{recipientStats.broadcastRecipientCount ?? 0}</strong> on the broadcast
                stream
              </li>
            ) : null}
          </>
        ) : null}
      </ul>
      {hasReliableGap ? (
        <div className="portal-admin-emails-debug-gap" role="alert">
          <p className="portal-admin-emails-debug-gap-title">
            Why {matchedCount} matched but only {sendCount} will be sent
          </p>
          <p className="portal-admin-emails-debug-gap-lead">
            <strong>{sendGap}</strong> matched row{sendGap === 1 ? '' : 's'} will not receive an
            email:
          </p>
          {excludedNoEmail.length > 0 ? (
            <>
              <p className="portal-admin-emails-debug-gap-reason">
                Empty email in column {mapping.email || 'D'}:
              </p>
              <ul className="portal-admin-emails-debug-skip-list">
                {excludedNoEmail.map((row) => (
                  <li key={`no-email-${row.id || row.name}`}>{formatRecipientSkipRow(row)}</li>
                ))}
              </ul>
            </>
          ) : null}
          {excludedDuplicates.length > 0 ? (
            <>
              <p className="portal-admin-emails-debug-gap-reason">
                Same email address as another matched row that will receive instead:
              </p>
              <ul className="portal-admin-emails-debug-skip-list">
                {excludedDuplicates.map((row) => (
                  <li key={`dup-${row.id || row.email}-${row.name}`}>
                    {formatRecipientSkipRow(row)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {excludedRows.length === 0 ? (
            <p className="portal-admin-emails-debug-gap-reason">
              The server reported {sendGap} fewer send{sendGap === 1 ? '' : 's'} than matched rows
              but did not return row details. Hard refresh this page (Shift+Reload).
            </p>
          ) : null}
        </div>
      ) : null}
      {sendGap === 0 && duplicateGroups.length > 0 ? (
        <div className="portal-admin-emails-debug-info">
          <p className="portal-admin-emails-debug-info-title">Shared email addresses</p>
          <p>
            {duplicateSkips.length} matched row{duplicateSkips.length === 1 ? '' : 's'} share an
            email with another row in this filter ({duplicateGroups.length} address
            {duplicateGroups.length === 1 ? '' : 'es'}). Each application row still gets its own
            email.
          </p>
          <details className="portal-admin-emails-debug-details">
            <summary>Show shared addresses</summary>
            <ul className="portal-admin-emails-debug-skip-list">
              {duplicateGroups.map((group) => (
                <li key={group.email}>
                  <strong>{group.email}</strong>
                  <ul>
                    {group.rows.map((row) => (
                      <li key={`${group.email}-${row.id || row.name}`}>
                        {row.id ? `AESOP ID ${row.id}` : 'No AESOP ID'} — {row.name || '(no name)'}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
      {(stats.rowsWithEmail ?? 0) <= 1 && (stats.dataRowsRead ?? 0) > 1 ? (
        <p className="portal-admin-emails-debug-note">
          Most rows have no email in column {mapping.email || 'D'}. Check that the Email column is
          actually column {mapping.email || 'D'} and that applicant emails are filled in.
        </p>
      ) : null}
    </div>
  );
}

const EMAIL_BATCH_SIZE = 100;
const EMAIL_BATCH_INTERVAL_MINUTES = 5;

function estimateBulkEmailDuration(
  recipientCount,
  batchSize = EMAIL_BATCH_SIZE,
  intervalMinutes = EMAIL_BATCH_INTERVAL_MINUTES,
) {
  if (recipientCount <= 0) {
    return null;
  }
  const batches = Math.ceil(recipientCount / batchSize);
  const totalMinutes = (batches - 1) * intervalMinutes;
  return { batches, batchSize, intervalMinutes, totalMinutes };
}

function formatDurationMinutes(totalMinutes) {
  if (totalMinutes <= 0) {
    return 'less than a minute';
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'} ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function formatBulkEmailBatchSchedule(
  recipientCount,
  batchSize = EMAIL_BATCH_SIZE,
  intervalMinutes = EMAIL_BATCH_INTERVAL_MINUTES,
) {
  if (recipientCount <= 0) {
    return null;
  }
  if (recipientCount <= batchSize) {
    return `All ${recipientCount} send in one batch.`;
  }
  return `Up to ${batchSize} send immediately, then up to ${batchSize} every ${intervalMinutes} minutes until complete.`;
}

function formatCampaignStatusLabel(status) {
  if (status === 'sending') {
    return 'Sending';
  }
  if (status === 'completed') {
    return 'Complete';
  }
  if (status === 'failed') {
    return 'Failed';
  }
  return status || '—';
}

function formatCampaignRecipientStatusLabel(status) {
  if (status === 'pending') return 'Pending';
  if (status === 'processing') return 'Sending';
  if (status === 'sent') return 'Sent';
  if (status === 'failed') return 'Failed';
  if (status === 'bounced') return 'Bounced';
  return status || '—';
}

function formatPortalDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatCampaignListDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function recipientEngagementSummary(recipient) {
  const parts = [];
  if (recipient.deliveredAt) parts.push('Delivered');
  if (recipient.openedAt) parts.push('Opened');
  if (recipient.clickedAt) parts.push('Clicked');
  if (recipient.status === 'bounced' || recipient.bouncedAt) parts.push('Bounced');
  if (recipient.status === 'failed') parts.push('Failed');
  if (parts.length === 0) {
    if (recipient.status === 'pending' || recipient.status === 'processing') {
      return 'Not sent yet';
    }
    if (recipient.sentAt) {
      return 'Sent';
    }
    return '—';
  }
  return parts.join(' · ');
}

const STATS_WINDOWS = [
  { id: '1m', label: '1 min' },
  { id: '5m', label: '5 mins' },
  { id: '15m', label: '15 mins' },
  { id: '1h', label: '1 hour' },
  { id: '6h', label: '6 hours' },
  { id: '24h', label: '24 hours' },
  { id: '3d', label: '3 days' },
  { id: '1w', label: '1 week' },
];

const STATS_PAGE_TYPE_LABELS = {
  login: 'Login',
  verify: 'Verify',
  profile: 'Profile',
  ding: 'Ding',
  admin: 'Admin',
  reviewer: 'Reviewer',
  other: 'Other',
};

const STATS_INCIDENT_LABELS = {
  magicLinkRequest: 'Magic-link requests',
  magicLinkUnknownId: 'Unknown ID',
  magicLinkSendFailed: 'Magic-link send failed',
  verifySuccess: 'Verify success',
  verifyExpired: 'Verify expired/invalid',
  verifyError: 'Verify errors',
  rateLimitHits: 'Rate-limit hits (429)',
  portalClassGradeFail: 'Class/grade failures',
  sheetsApiError: 'Sheets API errors',
};

const STATS_CHART_COLORS = {
  successful: '#1f7a6c',
  failed: '#c45c3e',
  login: '#1f7a6c',
  verify: '#3d8bfd',
  profile: '#5b6abf',
  ding: '#8a6d3b',
  admin: '#c45c3e',
  reviewer: '#6b7c85',
  other: '#9aa5ad',
  filesList: '#1f7a6c',
  filesGet: '#c45c3e',
  sheetsApi: '#3d8bfd',
  errorRate: '#c45c3e',
  magicLinkRequest: '#1f7a6c',
  magicLinkUnknownId: '#8a6d3b',
  magicLinkSendFailed: '#c45c3e',
  verifySuccess: '#2f9e44',
  verifyExpired: '#e67700',
  verifyError: '#c92a2a',
  rateLimitHits: '#9c36b5',
  portalClassGradeFail: '#364fc7',
  sheetsApiError: '#e03131',
};

function formatStatsClockTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatStatsAxisTime(iso, windowKey) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  if (windowKey === '3d' || windowKey === '1w') {
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  if (windowKey === '6h' || windowKey === '24h') {
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  return formatStatsClockTime(iso);
}

function pickStatsAxisIndexes(count, maxLabels = 5) {
  if (count <= 0) {
    return [];
  }
  if (count <= maxLabels) {
    return Array.from({ length: count }, (_, i) => i);
  }
  const indexes = [0];
  for (let i = 1; i < maxLabels - 1; i += 1) {
    indexes.push(Math.round((i * (count - 1)) / (maxLabels - 1)));
  }
  indexes.push(count - 1);
  return [...new Set(indexes)];
}

/**
 * @param {Array<{ t: string, v: number|null }>} series
 * @param {{ color?: string, height?: number, width?: number, yMax?: number|null, formatY?: (n: number) => string }} [options]
 */
function PortalStatsLineChart({ series, color = '#1f7a6c', height = 180, width = 560, yMax = null, formatY, windowKey = '5m' }) {
  const points = Array.isArray(series) ? series : [];
  const values = points.map((p) => (p && Number.isFinite(p.v) ? Number(p.v) : null)).filter((v) => v != null);
  const maxY = yMax != null && Number.isFinite(yMax) ? yMax : Math.max(1, ...values, 0);
  const padLeft = 36;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 28;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const yTicks = [0, 0.5, 1].map((ratio) => ({
    ratio,
    value: maxY * ratio,
    y: padTop + innerH - ratio * innerH,
  }));
  const xIndexes = pickStatsAxisIndexes(points.length, 5);

  const coords = points.map((point, index) => {
    const x = points.length <= 1 ? padLeft + innerW / 2 : padLeft + (index / (points.length - 1)) * innerW;
    const raw = point && Number.isFinite(point.v) ? Number(point.v) : null;
    const y = raw == null ? null : padTop + innerH - (raw / maxY) * innerH;
    return { x, y, v: raw, t: point?.t };
  });

  const pathParts = [];
  for (const coord of coords) {
    if (coord.y == null) {
      continue;
    }
    pathParts.push(`${pathParts.length === 0 ? 'M' : 'L'}${coord.x.toFixed(1)} ${coord.y.toFixed(1)}`);
  }

  const latest = values.length ? values[values.length - 1] : null;
  const yLabel = typeof formatY === 'function' && latest != null ? formatY(latest) : latest != null ? String(latest) : '—';

  return (
    <div className="portal-stats-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Time series chart" className="portal-stats-chart-svg">
        {yTicks.map((tick) => (
          <g key={`y-${tick.ratio}`}>
            <line
              x1={padLeft}
              y1={tick.y}
              x2={width - padRight}
              y2={tick.y}
              className="portal-stats-chart-grid"
            />
            <text x={padLeft - 6} y={tick.y + 3} textAnchor="end" className="portal-stats-chart-tick">
              {typeof formatY === 'function' ? formatY(tick.value) : Math.round(tick.value)}
            </text>
          </g>
        ))}
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={height - padBottom} className="portal-stats-chart-axis" />
        <line
          x1={padLeft}
          y1={height - padBottom}
          x2={width - padRight}
          y2={height - padBottom}
          className="portal-stats-chart-axis"
        />
        {pathParts.length > 1 ? (
          <path d={pathParts.join(' ')} fill="none" stroke={color} strokeWidth="2.25" strokeLinejoin="round" />
        ) : null}
        {coords.map((coord, index) =>
          coord.y == null ? null : (
            <circle key={`pt-${index}`} cx={coord.x} cy={coord.y} r="2.4" fill={color} />
          ),
        )}
        {xIndexes.map((index) => {
          const point = points[index];
          if (!point) {
            return null;
          }
          const x = points.length <= 1 ? padLeft + innerW / 2 : padLeft + (index / (points.length - 1)) * innerW;
          return (
            <text key={`x-${index}`} x={x} y={height - 8} textAnchor="middle" className="portal-stats-chart-tick">
              {formatStatsAxisTime(point.t, windowKey)}
            </text>
          );
        })}
      </svg>
      <div className="portal-stats-chart-meta">
        <span>max {typeof formatY === 'function' ? formatY(maxY) : maxY}</span>
        <span>latest {yLabel}</span>
      </div>
    </div>
  );
}

/**
 * @param {Array<{ id: string, label: string, color: string, series: Array<{ t: string, v: number|null }> }>} lines
 * @param {{ height?: number, width?: number, formatY?: (n: number) => string }} [options]
 */
function PortalStatsMultiLineChart({ lines, height = 200, width = 600, formatY, windowKey = '5m' }) {
  const safeLines = Array.isArray(lines) ? lines.filter((line) => Array.isArray(line.series) && line.series.length) : [];
  const allValues = safeLines.flatMap((line) =>
    line.series.map((p) => (p && Number.isFinite(p.v) ? Number(p.v) : null)).filter((v) => v != null),
  );
  const maxY = Math.max(1, ...allValues, 0);
  const padLeft = 36;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 28;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const pointCount = safeLines[0]?.series?.length || 0;
  const timeline = safeLines[0]?.series || [];
  const yTicks = [0, 0.5, 1].map((ratio) => ({
    ratio,
    value: maxY * ratio,
    y: padTop + innerH - ratio * innerH,
  }));
  const xIndexes = pickStatsAxisIndexes(pointCount, 5);

  return (
    <div className="portal-stats-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Multi-series chart" className="portal-stats-chart-svg">
        {yTicks.map((tick) => (
          <g key={`y-${tick.ratio}`}>
            <line
              x1={padLeft}
              y1={tick.y}
              x2={width - padRight}
              y2={tick.y}
              className="portal-stats-chart-grid"
            />
            <text x={padLeft - 6} y={tick.y + 3} textAnchor="end" className="portal-stats-chart-tick">
              {typeof formatY === 'function' ? formatY(tick.value) : Math.round(tick.value)}
            </text>
          </g>
        ))}
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={height - padBottom} className="portal-stats-chart-axis" />
        <line
          x1={padLeft}
          y1={height - padBottom}
          x2={width - padRight}
          y2={height - padBottom}
          className="portal-stats-chart-axis"
        />
        {safeLines.map((line) => {
          const pathParts = [];
          line.series.forEach((point, index) => {
            if (!Number.isFinite(point?.v)) {
              return;
            }
            const x = pointCount <= 1 ? padLeft + innerW / 2 : padLeft + (index / (pointCount - 1)) * innerW;
            const y = padTop + innerH - (Number(point.v) / maxY) * innerH;
            pathParts.push(`${pathParts.length === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
          });
          if (pathParts.length < 2) {
            return null;
          }
          return (
            <path
              key={line.id}
              d={pathParts.join(' ')}
              fill="none"
              stroke={line.color}
              strokeWidth="2.1"
              strokeLinejoin="round"
            />
          );
        })}
        {xIndexes.map((index) => {
          const point = timeline[index];
          if (!point) {
            return null;
          }
          const x = pointCount <= 1 ? padLeft + innerW / 2 : padLeft + (index / (pointCount - 1)) * innerW;
          return (
            <text key={`x-${index}`} x={x} y={height - 8} textAnchor="middle" className="portal-stats-chart-tick">
              {formatStatsAxisTime(point.t, windowKey)}
            </text>
          );
        })}
      </svg>
      <div className="portal-stats-chart-legend">
        {safeLines.map((line) => (
          <span key={line.id} className="portal-stats-chart-legend-item">
            <span className="portal-stats-chart-swatch" style={{ background: line.color }} aria-hidden="true" />
            {line.label}
          </span>
        ))}
      </div>
      <div className="portal-stats-chart-meta">
        <span>max {typeof formatY === 'function' ? formatY(maxY) : Math.round(maxY)}</span>
      </div>
    </div>
  );
}

function formatStatsPercent(rate) {
  if (!Number.isFinite(rate)) {
    return '0%';
  }
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.01 ? 2 : 1)}%`;
}

function formatStatsMs(ms) {
  if (ms == null || !Number.isFinite(ms)) {
    return '—';
  }
  return `${Math.round(ms)} ms`;
}

function PortalStatsMetricCard({ label, value, hint, tone = 'default' }) {
  return (
    <div className={`portal-stats-metric-card portal-stats-metric-card--${tone}`}>
      <p className="portal-stats-metric-label">{label}</p>
      <p className="portal-stats-metric-value">{value}</p>
      {hint ? <p className="portal-stats-metric-hint">{hint}</p> : null}
    </div>
  );
}

function PortalStatsPanel({ title, subtitle, children, wide = false }) {
  return (
    <section className={`portal-stats-panel${wide ? ' portal-stats-panel--wide' : ''}`}>
      <header className="portal-stats-panel-head">
        <h2 className="portal-stats-panel-title">{title}</h2>
        {subtitle ? <p className="portal-stats-panel-subtitle">{subtitle}</p> : null}
      </header>
      <div className="portal-stats-panel-body">{children}</div>
    </section>
  );
}

function PortalAdminStatsPage() {
  const { isAdmin } = usePortalClassGrade();
  const signedIn = isPortalSessionCompleteSync();
  const [windowKey, setWindowKey] = useState('5m');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [liveErrors, setLiveErrors] = useState([]);
  const sessionStartedAtRef = useRef(Date.now());
  const seenErrorIdsRef = useRef(new Set());

  const mergeRecentErrors = useCallback((incoming) => {
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return;
    }
    const sessionStart = sessionStartedAtRef.current;
    const fresh = incoming.filter((entry) => {
      if (!entry || entry.id == null) {
        return false;
      }
      if (seenErrorIdsRef.current.has(entry.id)) {
        return false;
      }
      const atMs = Date.parse(entry.at);
      if (!Number.isFinite(atMs) || atMs < sessionStart) {
        return false;
      }
      return true;
    });
    if (fresh.length === 0) {
      return;
    }
    for (const entry of fresh) {
      seenErrorIdsRef.current.add(entry.id);
    }
    setLiveErrors((prev) => {
      const merged = [...fresh, ...prev];
      merged.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return merged.slice(0, 1000);
    });
  }, []);

  useEffect(() => {
    if (!signedIn || !isAdmin) {
      return undefined;
    }
    let cancelled = false;
    let inFlight = false;

    const load = async () => {
      if (inFlight || cancelled) {
        return;
      }
      inFlight = true;
      setLoading(true);
      setError('');
      try {
        const data = await adminApiPost('/api/portal-admin/stats', { window: windowKey });
        if (!cancelled) {
          setStats(data);
          setLastUpdated(data.generatedAt || new Date().toISOString());
          mergeRecentErrors(data.recentErrors);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Could not load portal stats.');
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();
    const intervalId = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [signedIn, isAdmin, windowKey, mergeRecentErrors]);

  if (!isAdmin) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content portal-admin-card">
          <PortalSectionLinks current="admin-stats" isAdmin={false} />
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">Access denied</p>
            <p className="portal-session-banner-text">
              Your account is not on the admin allowlist. Contact operations if you need access.
            </p>
          </div>
        </div>
      </PortalLayout>
    );
  }

  const byType = stats?.pages?.byType || {};
  const pageTypes = Object.keys(STATS_PAGE_TYPE_LABELS);
  const incidentKeys = Object.keys(STATS_INCIDENT_LABELS);
  const incidentTotals = stats?.incidents?.totals || {};
  const loginOk = stats?.logins?.successful ?? 0;
  const loginFail = stats?.logins?.failed ?? 0;
  const pageSuccessTotal = pageTypes.reduce((sum, type) => sum + (byType[type]?.success || 0), 0);
  const pageErrorTotal = pageTypes.reduce((sum, type) => sum + (byType[type]?.error || 0), 0);
  const pageTotal = pageSuccessTotal + pageErrorTotal;
  const overallErrorRate = pageTotal > 0 ? pageErrorTotal / pageTotal : 0;
  const problemIncidentTotal =
    (incidentTotals.magicLinkSendFailed || 0) +
    (incidentTotals.verifyExpired || 0) +
    (incidentTotals.verifyError || 0) +
    (incidentTotals.rateLimitHits || 0) +
    (incidentTotals.portalClassGradeFail || 0) +
    (incidentTotals.sheetsApiError || 0);
  const latencyValues = pageTypes
    .map((type) => byType[type]?.avgLatencyMs)
    .filter((ms) => ms != null && Number.isFinite(ms));
  const avgLatencyMs =
    latencyValues.length > 0
      ? Math.round(latencyValues.reduce((sum, ms) => sum + ms, 0) / latencyValues.length)
      : null;

  const serveLines = pageTypes
    .filter(
      (type) =>
        (byType[type]?.success || 0) + (byType[type]?.error || 0) > 0 ||
        type === 'profile' ||
        type === 'admin',
    )
    .map((type) => ({
      id: type,
      label: STATS_PAGE_TYPE_LABELS[type],
      color: STATS_CHART_COLORS[type] || STATS_CHART_COLORS.other,
      series: stats?.pages?.serveSeries?.[type] || [],
    }));
  const latencyLines = pageTypes
    .filter((type) => byType[type]?.avgLatencyMs != null)
    .map((type) => ({
      id: type,
      label: STATS_PAGE_TYPE_LABELS[type],
      color: STATS_CHART_COLORS[type] || STATS_CHART_COLORS.other,
      series: stats?.pages?.latencySeries?.[type] || [],
    }));
  const incidentProblemKeys = [
    'magicLinkSendFailed',
    'verifyExpired',
    'verifyError',
    'rateLimitHits',
    'portalClassGradeFail',
    'sheetsApiError',
  ];
  const incidentLines = incidentProblemKeys.map((key) => ({
    id: key,
    label: STATS_INCIDENT_LABELS[key],
    color: STATS_CHART_COLORS[key] || STATS_CHART_COLORS.other,
    series: stats?.incidents?.series?.[key] || [],
  }));

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-admin-card portal-admin-stats-page">
        <PortalSectionLinks current="admin-stats" isAdmin={isAdmin} />

        <div className="portal-stats-hero">
          <div className="portal-stats-hero-copy">
            <h1 className="portal-admin-title">Portal dashboard</h1>
            <p className="portal-admin-lead">
              Everything happening on the portal right now — logins, pages, speed, Google APIs, and problems.
            </p>
          </div>
          <div className="portal-stats-toolbar">
            <div className="portal-stats-windows" role="tablist" aria-label="Time window">
              {STATS_WINDOWS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={windowKey === option.id}
                  className={`portal-admin-tab${windowKey === option.id ? ' is-active' : ''}`}
                  onClick={() => setWindowKey(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="portal-admin-hint portal-stats-updated">
              {loading && !stats ? 'Loading…' : null}
              {lastUpdated
                ? `Live · updated ${new Date(lastUpdated).toLocaleTimeString()}`
                : loading
                  ? null
                  : 'Waiting for data'}
            </p>
          </div>
        </div>

        {error ? (
          <p className="portal-admin-status portal-admin-status--error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="portal-stats-kpi-grid" aria-label="Key metrics">
          <PortalStatsMetricCard
            label="Successful logins"
            value={loginOk}
            hint="Verify magic link OK"
            tone="good"
          />
          <PortalStatsMetricCard
            label="Failed logins"
            value={loginFail}
            hint="Expired or invalid links"
            tone={loginFail > 0 ? 'warn' : 'default'}
          />
          <PortalStatsMetricCard
            label="Page serves"
            value={pageSuccessTotal}
            hint={`${pageErrorTotal} errors · ${formatStatsPercent(overallErrorRate)} error rate`}
          />
          <PortalStatsMetricCard
            label="Problems"
            value={problemIncidentTotal}
            hint="Send fails, 429s, verify errors, Sheets errors"
            tone={problemIncidentTotal > 0 ? 'bad' : 'good'}
          />
          <PortalStatsMetricCard
            label="Avg serve time"
            value={formatStatsMs(avgLatencyMs)}
            hint="Across page types with traffic"
          />
          <PortalStatsMetricCard
            label="Sheets API calls"
            value={stats?.sheets?.apiCalls ?? 0}
            hint={`${stats?.drive?.filesList ?? 0} Drive scans · ${stats?.drive?.filesGet ?? 0} file reads`}
          />
        </div>

        <div className="portal-stats-dashboard-grid">
          <PortalStatsPanel
            title="Problems over time"
            subtitle="Counts of login-critical incidents. Time on X, count on Y."
            wide
          >
            <div className="portal-stats-chip-row">
              {incidentKeys.map((key) => (
                <span
                  key={key}
                  className={`portal-stats-chip${(incidentTotals[key] || 0) > 0 && key !== 'magicLinkRequest' && key !== 'verifySuccess' ? ' is-hot' : ''}`}
                >
                  <span className="portal-stats-chip-label">{STATS_INCIDENT_LABELS[key]}</span>
                  <strong className="portal-stats-chip-value">{incidentTotals[key] ?? 0}</strong>
                </span>
              ))}
            </div>
            <PortalStatsMultiLineChart
              lines={incidentLines}
              formatY={(n) => String(Math.round(n))}
              windowKey={windowKey}
            />
          </PortalStatsPanel>

          <PortalStatsPanel title="Logins" subtitle="Successful vs failed verifies">
            <div className="portal-stats-mini-metrics">
              <PortalStatsMetricCard label="Successful" value={loginOk} tone="good" />
              <PortalStatsMetricCard label="Failed" value={loginFail} tone={loginFail > 0 ? 'warn' : 'default'} />
            </div>
            <PortalStatsMultiLineChart
              lines={[
                {
                  id: 'successful',
                  label: 'Successful',
                  color: STATS_CHART_COLORS.successful,
                  series: stats?.logins?.series?.successful || [],
                },
                {
                  id: 'failed',
                  label: 'Failed',
                  color: STATS_CHART_COLORS.failed,
                  series: stats?.logins?.series?.failed || [],
                },
              ]}
              formatY={(n) => String(Math.round(n))}
              windowKey={windowKey}
            />
          </PortalStatsPanel>

          <PortalStatsPanel title="Error rate" subtitle="Share of page responses that failed">
            <PortalStatsLineChart
              series={stats?.pages?.errorRateSeries || []}
              color={STATS_CHART_COLORS.errorRate}
              yMax={1}
              formatY={(n) => formatStatsPercent(n)}
              windowKey={windowKey}
            />
          </PortalStatsPanel>

          <PortalStatsPanel title="Page serves by type" subtitle="Successful responses for each area of the portal" wide>
            <div className="portal-stats-table-wrap">
              <table className="portal-stats-table">
                <thead>
                  <tr>
                    <th scope="col">Page</th>
                    <th scope="col">Success</th>
                    <th scope="col">Errors</th>
                    <th scope="col">Error rate</th>
                    <th scope="col">Avg time</th>
                  </tr>
                </thead>
                <tbody>
                  {pageTypes.map((type) => {
                    const row = byType[type] || { success: 0, error: 0, errorRate: 0, avgLatencyMs: null };
                    return (
                      <tr key={type}>
                        <td>
                          <span
                            className="portal-stats-type-swatch"
                            style={{ background: STATS_CHART_COLORS[type] || STATS_CHART_COLORS.other }}
                            aria-hidden="true"
                          />
                          {STATS_PAGE_TYPE_LABELS[type]}
                        </td>
                        <td>{row.success || 0}</td>
                        <td>{row.error || 0}</td>
                        <td>{formatStatsPercent(row.errorRate || 0)}</td>
                        <td>{formatStatsMs(row.avgLatencyMs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PortalStatsMultiLineChart
              lines={serveLines}
              formatY={(n) => String(Math.round(n))}
              windowKey={windowKey}
            />
          </PortalStatsPanel>

          <PortalStatsPanel title="Serve time by page" subtitle="How long responses take (milliseconds)">
            <div className="portal-stats-chip-row portal-stats-chip-row--compact">
              {pageTypes.map((type) => (
                <span key={type} className="portal-stats-chip">
                  <span className="portal-stats-chip-label">{STATS_PAGE_TYPE_LABELS[type]}</span>
                  <strong className="portal-stats-chip-value">{formatStatsMs(byType[type]?.avgLatencyMs)}</strong>
                </span>
              ))}
            </div>
            <PortalStatsMultiLineChart
              lines={latencyLines}
              formatY={(n) => `${Math.round(n)} ms`}
              windowKey={windowKey}
            />
          </PortalStatsPanel>

          <PortalStatsPanel title="Google APIs" subtitle="Drive folder scans, file reads, and Sheets calls">
            <div className="portal-stats-mini-metrics">
              <PortalStatsMetricCard label="Drive scans" value={stats?.drive?.filesList ?? 0} />
              <PortalStatsMetricCard label="Drive reads" value={stats?.drive?.filesGet ?? 0} />
              <PortalStatsMetricCard label="Sheets calls" value={stats?.sheets?.apiCalls ?? 0} />
            </div>
            <PortalStatsMultiLineChart
              lines={[
                {
                  id: 'filesList',
                  label: 'Drive scans',
                  color: STATS_CHART_COLORS.filesList,
                  series: stats?.drive?.series?.filesList || [],
                },
                {
                  id: 'filesGet',
                  label: 'Drive reads',
                  color: STATS_CHART_COLORS.filesGet,
                  series: stats?.drive?.series?.filesGet || [],
                },
                {
                  id: 'sheetsApi',
                  label: 'Sheets API',
                  color: STATS_CHART_COLORS.sheetsApi,
                  series: stats?.sheets?.series?.apiCalls || [],
                },
              ]}
              formatY={(n) => String(Math.round(n))}
              windowKey={windowKey}
            />
          </PortalStatsPanel>
        </div>

        <PortalStatsPanel
          title="Live error log"
          subtitle="4xx/5xx responses since you opened this page (up to 1,000). Refreshes every 10s. With multiple Fly machines, each instance keeps its own buffer."
          wide
        >
          {liveErrors.length === 0 ? (
            <p className="portal-admin-hint portal-stats-error-log-empty">
              No errors recorded yet this session. Leave this page open to collect them as they happen.
            </p>
          ) : (
            <div className="portal-stats-error-log-wrap">
              <table className="portal-stats-table portal-stats-error-log-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Status</th>
                    <th scope="col">Method</th>
                    <th scope="col">Path</th>
                    <th scope="col">Page</th>
                    <th scope="col">Time (ms)</th>
                    <th scope="col">Instance</th>
                  </tr>
                </thead>
                <tbody>
                  {liveErrors.map((entry) => (
                    <tr key={entry.id}>
                      <td>{new Date(entry.at).toLocaleTimeString()}</td>
                      <td>
                        <span
                          className={`portal-stats-status-badge portal-stats-status-badge--${entry.statusClass || '4xx'}`}
                        >
                          {entry.statusCode}
                        </span>
                      </td>
                      <td>{entry.method}</td>
                      <td className="portal-stats-error-path">{entry.path}</td>
                      <td>{STATS_PAGE_TYPE_LABELS[entry.pageType] || entry.pageType || 'Other'}</td>
                      <td>{entry.latencyMs ?? '—'}</td>
                      <td className="portal-stats-error-instance">{entry.instance || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PortalStatsPanel>
      </div>
    </PortalLayout>
  );
}

function PortalAdminCampaignsPage() {
  const { isAdmin } = usePortalClassGrade();
  const signedIn = isPortalSessionCompleteSync();

  const initialCampaignId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const raw = new URLSearchParams(window.location.search).get('campaign');
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, []);

  const [campaigns, setCampaigns] = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError] = useState('');
  const [selectedCampaignId, setSelectedCampaignId] = useState(initialCampaignId);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [recipientFilter, setRecipientFilter] = useState('all');

  const selectCampaign = useCallback((campaignId) => {
    setSelectedCampaignId(campaignId);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (campaignId) {
        url.searchParams.set('campaign', String(campaignId));
      } else {
        url.searchParams.delete('campaign');
      }
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  }, []);

  useEffect(() => {
    if (!signedIn || !isAdmin) {
      return undefined;
    }
    let cancelled = false;
    setCampaignsLoading(true);
    setCampaignsError('');
    adminApiPost('/api/portal-admin/email/campaigns')
      .then((data) => {
        if (!cancelled) {
          const rows = Array.isArray(data.campaigns) ? data.campaigns : [];
          setCampaigns(rows);
          if (!selectedCampaignId && !initialCampaignId && rows.length > 0) {
            selectCampaign(rows[0].id);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setCampaignsError(err.message || 'Could not load campaigns.');
          setCampaigns([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCampaignsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, isAdmin]);

  useEffect(() => {
    setDetail(null);
    setDetailError('');
    setDetailLoading(!!selectedCampaignId);
    setRecipientFilter('all');
  }, [selectedCampaignId]);

  useEffect(() => {
    if (!selectedCampaignId || !signedIn || !isAdmin) {
      return undefined;
    }
    let cancelled = false;
    let intervalId = 0;

    const loadDetail = () => {
      adminApiPost('/api/portal-admin/email/campaign-detail', { campaignId: selectedCampaignId })
        .then((data) => {
          if (!cancelled) {
            setDetail({
              campaign: data.campaign || null,
              status: data.status || null,
              recipients: Array.isArray(data.recipients) ? data.recipients : [],
            });
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setDetailError(err.message || 'Could not load campaign detail.');
            setDetail(null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setDetailLoading(false);
          }
        });
    };

    loadDetail();
    intervalId = window.setInterval(loadDetail, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedCampaignId, signedIn, isAdmin]);

  const filteredRecipients = useMemo(() => {
    if (!detail?.recipients) return [];
    const rows = detail.recipients;
    if (recipientFilter === 'all') return rows;
    if (recipientFilter === 'opened') return rows.filter((row) => row.openedAt);
    if (recipientFilter === 'clicked') return rows.filter((row) => row.clickedAt);
    if (recipientFilter === 'bounced') {
      return rows.filter((row) => row.status === 'bounced' || row.bouncedAt);
    }
    if (recipientFilter === 'failed') return rows.filter((row) => row.status === 'failed');
    if (recipientFilter === 'pending') {
      return rows.filter((row) => row.status === 'pending' || row.status === 'processing');
    }
    return rows;
  }, [detail, recipientFilter]);

  if (!signedIn) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content portal-hub-card">
          <PortalSignInOnlyContent />
        </div>
      </PortalLayout>
    );
  }

  if (!isAdmin) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content portal-admin-card">
          <PortalSectionLinks current="admin-campaigns" isAdmin={false} />
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">Admin access not detected</p>
            <p className="portal-session-banner-text">
              This account is not currently marked as an admin in the People sheet.
            </p>
          </div>
        </div>
      </PortalLayout>
    );
  }

  const status = detail?.status;
  const campaign = detail?.campaign;
  const totalRecipients = status?.totalRecipients ?? campaign?.totalRecipients ?? 0;
  const processedCount = status?.processedCount ?? 0;
  const progressPct =
    totalRecipients > 0 ? Math.min(100, Math.round((processedCount / totalRecipients) * 100)) : 0;

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-admin-card portal-admin-campaigns-card">
        <PortalSectionLinks current="admin-campaigns" isAdmin={isAdmin} />
        <h2 className="portal-admin-title">
          Email campaigns
          <PortalRoleBadge isAdmin className="portal-welcome-role" />
        </h2>
        <p className="portal-admin-lead">
          Review past sends, delivery stats, and per-recipient engagement (opens and link clicks).
        </p>

        <div className="portal-admin-campaigns-layout">
          <aside className="portal-admin-campaigns-sidebar" aria-label="Campaign list">
            <div className="portal-admin-campaigns-sidebar-head">
              <h3 className="portal-admin-subheading-sm">Campaigns</h3>
              <a href="/admin/emails" className="portal-admin-campaigns-compose-link">
                Compose new
              </a>
            </div>
            {campaignsLoading ? <p className="portal-admin-status">Loading campaigns…</p> : null}
            {campaignsError ? (
              <p className="portal-admin-status portal-admin-status--error" role="alert">
                {campaignsError}
              </p>
            ) : null}
            {!campaignsLoading && campaigns.length === 0 ? (
              <p className="portal-admin-hint">No campaigns yet. Send one from Compose.</p>
            ) : null}
            <ul className="portal-admin-campaigns-list">
              {campaigns.map((row) => {
                const isSelected = row.id === selectedCampaignId;
                const processed = (row.sentCount ?? 0) + (row.failedCount ?? 0);
                const total = row.totalRecipients ?? 0;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={`portal-admin-campaigns-list-item${isSelected ? ' is-selected' : ''}`}
                      onClick={() => selectCampaign(row.id)}
                    >
                      <span className="portal-admin-campaigns-list-subject">{row.subject || '(No subject)'}</span>
                      <span className="portal-admin-campaigns-list-meta">
                        <span
                          className={`portal-admin-campaigns-badge portal-admin-campaigns-badge--${row.status || 'unknown'}`}
                        >
                          {formatCampaignStatusLabel(row.status)}
                        </span>
                        <span>{formatCampaignListDate(row.createdAt)}</span>
                      </span>
                      <span className="portal-admin-campaigns-list-progress">
                        {processed} / {total} processed
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className="portal-admin-campaigns-detail" aria-label="Campaign detail">
            {!selectedCampaignId ? (
              <p className="portal-admin-hint">Select a campaign to view stats and recipients.</p>
            ) : null}
            {selectedCampaignId && detailLoading && !detail ? (
              <p className="portal-admin-status">Loading campaign…</p>
            ) : null}
            {detailError ? (
              <p className="portal-admin-status portal-admin-status--error" role="alert">
                {detailError}
              </p>
            ) : null}
            {campaign ? (
              <>
                <header className="portal-admin-campaigns-detail-head">
                  <h3 className="portal-admin-subheading">{campaign.subject || '(No subject)'}</h3>
                  <p className="portal-admin-campaigns-detail-meta">
                    Sent {formatPortalDateTime(campaign.createdAt)}
                    {campaign.completedAt ? ` · Completed ${formatPortalDateTime(campaign.completedAt)}` : ''}
                    {' · '}
                    {formatCampaignStatusLabel(campaign.status)}
                  </p>
                </header>

                {status ? (
                  <div className="portal-admin-campaigns-stats">
                    <div
                      className="portal-admin-emails-progress"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progressPct}
                      aria-label={`${processedCount} of ${totalRecipients} processed`}
                    >
                      <div
                        className="portal-admin-emails-progress-bar"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    <p className="portal-admin-emails-progress-summary">
                      <strong>{status.sentCount ?? 0}</strong> sent
                      {(status.failedCount ?? 0) > 0 ? (
                        <>
                          , <strong>{status.failedCount}</strong> failed
                        </>
                      ) : null}
                      {(status.pendingCount ?? 0) > 0 ? (
                        <>
                          , <strong>{status.pendingCount}</strong> pending
                        </>
                      ) : null}
                      {' · '}
                      {processedCount} / {totalRecipients} processed ({progressPct}%)
                    </p>
                    <dl className="portal-admin-stats portal-admin-stats--compact">
                      <div className="portal-admin-stat-row">
                        <dt>Delivered</dt>
                        <dd>{status.deliveredCount ?? 0}</dd>
                      </div>
                      <div className="portal-admin-stat-row">
                        <dt>Opened</dt>
                        <dd>{status.openedCount ?? 0}</dd>
                      </div>
                      <div className="portal-admin-stat-row">
                        <dt>Clicked</dt>
                        <dd>{status.clickedCount ?? 0}</dd>
                      </div>
                      {(status.bouncedCount ?? 0) > 0 ? (
                        <div className="portal-admin-stat-row">
                          <dt>Bounced</dt>
                          <dd>{status.bouncedCount}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                ) : null}

                <div className="portal-admin-campaigns-recipients-head">
                  <h4 className="portal-admin-subheading-sm">
                    Recipients ({filteredRecipients.length}
                    {recipientFilter !== 'all' ? ` of ${detail.recipients.length}` : ''})
                  </h4>
                  <label className="portal-admin-campaigns-filter">
                    <span className="portal-admin-emails-label">Show</span>
                    <select
                      className="portal-admin-emails-select"
                      value={recipientFilter}
                      onChange={(e) => setRecipientFilter(e.target.value)}
                    >
                      <option value="all">All</option>
                      <option value="opened">Opened</option>
                      <option value="clicked">Clicked</option>
                      <option value="bounced">Bounced</option>
                      <option value="failed">Failed</option>
                      <option value="pending">Pending</option>
                    </select>
                  </label>
                </div>

                <div className="portal-admin-campaigns-recipient-wrap">
                  <table className="portal-admin-campaigns-recipient-table">
                    <thead>
                      <tr>
                        <th scope="col">Recipient</th>
                        <th scope="col">Send status</th>
                        <th scope="col">Engagement</th>
                        <th scope="col">Sent</th>
                        <th scope="col">Opened</th>
                        <th scope="col">Clicked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecipients.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="portal-admin-campaigns-empty">
                            No recipients match this filter.
                          </td>
                        </tr>
                      ) : (
                        filteredRecipients.map((recipient) => (
                          <tr key={recipient.id}>
                            <td>
                              <div className="portal-admin-campaigns-recipient-name">
                                {recipient.name || recipient.email}
                              </div>
                              {recipient.name ? (
                                <div className="portal-admin-campaigns-recipient-email">{recipient.email}</div>
                              ) : null}
                              {recipient.aesopId ? (
                                <div className="portal-admin-campaigns-recipient-id">{recipient.aesopId}</div>
                              ) : null}
                              {recipient.error ? (
                                <div className="portal-admin-campaigns-recipient-error" title={recipient.error}>
                                  {recipient.error}
                                </div>
                              ) : null}
                            </td>
                            <td>
                              <span
                                className={`portal-admin-campaigns-badge portal-admin-campaigns-badge--${recipient.status || 'unknown'}`}
                              >
                                {formatCampaignRecipientStatusLabel(recipient.status)}
                              </span>
                            </td>
                            <td>{recipientEngagementSummary(recipient)}</td>
                            <td>{formatPortalDateTime(recipient.sentAt)}</td>
                            <td>{formatPortalDateTime(recipient.openedAt)}</td>
                            <td>{formatPortalDateTime(recipient.clickedAt)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </section>
        </div>
      </div>
    </PortalLayout>
  );
}

function PortalAdminEmailsPage() {
  const { isAdmin } = usePortalClassGrade();
  const signedIn = isPortalSessionCompleteSync();
  const adminEmail = readSessionField('studentPortalEmail').trim();

  const [group, setGroup] = useState('admissions');
  const [metadata, setMetadata] = useState(null);
  const [metadataError, setMetadataError] = useState('');
  const [metadataLoading, setMetadataLoading] = useState(false);

  const [filterAll, setFilterAll] = useState(true);
  const [filterColumn, setFilterColumn] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [aesopIdsFilter, setAesopIdsFilter] = useState(null);
  const [recipientListLabel, setRecipientListLabel] = useState('');
  const [selectedReviewerIds, setSelectedReviewerIds] = useState([]);

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [globalVars, setGlobalVars] = useState({});

  const [recipients, setRecipients] = useState([]);
  const [recipientCount, setRecipientCount] = useState(0);
  const [recipientStats, setRecipientStats] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState('');
  const [testSuccess, setTestSuccess] = useState('');
  const [lastTestHash, setLastTestHash] = useState('');
  const [testPreviewRecipient, setTestPreviewRecipient] = useState(null);

  const [sendLoading, setSendLoading] = useState(false);
  const [sendError, setSendError] = useState('');
  const [campaignId, setCampaignId] = useState(null);
  const [campaignStatus, setCampaignStatus] = useState(null);

  const admissionsFilterPayload = buildEmailFilterPayload(
    filterAll,
    filterColumn,
    filterValue,
    aesopIdsFilter,
  );
  // Preview always loads the full reviewers list; selection is applied only on test/send.
  const previewFilterPayload = group === 'reviewers' ? null : admissionsFilterPayload;
  const reviewersFilterPayload =
    selectedReviewerIds.length > 0 ? { aesopIds: selectedReviewerIds } : null;
  const filterPayload = group === 'reviewers' ? reviewersFilterPayload : admissionsFilterPayload;
  const filterColumnLabels = metadata?.filterColumns || metadata?.columns || [];
  const variableColumnLabels = metadata?.variableColumns || [];
  const globalPlaceholders = detectGlobalEmailPlaceholders(subject, body, variableColumnLabels);
  const selectedReviewerIdSet = new Set(
    selectedReviewerIds.map((id) => String(id).trim().toLowerCase()).filter(Boolean),
  );
  const selectedReviewerCount = selectedReviewerIds.length;
  const effectiveRecipientCount = group === 'reviewers' ? selectedReviewerCount : recipientCount;
  const allReviewersSelected =
    group === 'reviewers' &&
    recipients.length > 0 &&
    selectedReviewerCount > 0 &&
    recipients.every((row) => selectedReviewerIdSet.has(String(row.id || '').trim().toLowerCase()));
  const composePayload = {
    group,
    subject,
    body,
    globalVars,
    filter: filterPayload,
  };

  useEffect(() => {
    setLastTestHash('');
    setTestSuccess('');
    setTestPreviewRecipient(null);
    setTestError('');
  }, [
    subject,
    body,
    JSON.stringify(globalVars),
    filterAll,
    filterColumn,
    filterValue,
    JSON.stringify(aesopIdsFilter),
    JSON.stringify(selectedReviewerIds),
    group,
  ]);

  useEffect(() => {
    if (!signedIn || !isAdmin) {
      return undefined;
    }
    if (group !== 'admissions') {
      return undefined;
    }
    const pendingList = readAdminEmailRecipientList();
    if (!pendingList) {
      return undefined;
    }
    setFilterAll(false);
    setFilterColumn('');
    setFilterValue('');
    setAesopIdsFilter(pendingList.aesopIds);
    setRecipientListLabel(pendingList.label);
    return undefined;
  }, [signedIn, isAdmin, group]);

  useEffect(() => {
    if (!signedIn || !isAdmin) {
      return undefined;
    }
    let cancelled = false;
    setMetadataLoading(true);
    setMetadataError('');
    setMetadata(null);
    const metadataPath =
      group === 'reviewers'
        ? '/api/portal-admin/email/reviewers-metadata'
        : '/api/portal-admin/email/admissions-metadata';
    adminApiPost(metadataPath)
      .then((data) => {
        if (!cancelled) {
          setMetadata(data.metadata || null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setMetadataError(
            err.message ||
              (group === 'reviewers'
                ? 'Could not load Reviewers metadata.'
                : 'Could not load Applicants sheet.'),
          );
          setMetadata(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setMetadataLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, isAdmin, group]);

  useEffect(() => {
    if (!signedIn || !isAdmin || (group !== 'admissions' && group !== 'reviewers')) {
      return undefined;
    }
    if (
      group === 'admissions' &&
      !filterAll &&
      (!filterColumn || !filterValue) &&
      !(Array.isArray(aesopIdsFilter) && aesopIdsFilter.length > 0)
    ) {
      setRecipients([]);
      setRecipientCount(0);
      setRecipientStats(null);
      return undefined;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError('');
    adminApiPost('/api/portal-admin/email/preview', {
      group,
      filter: previewFilterPayload,
    })
      .then((data) => {
        if (!cancelled) {
          const nextRecipients = Array.isArray(data.recipients) ? data.recipients : [];
          setRecipients(nextRecipients);
          setRecipientCount(typeof data.count === 'number' ? data.count : 0);
          setRecipientStats(data.recipientStats || null);
          if (group === 'reviewers') {
            setSelectedReviewerIds(
              nextRecipients.map((row) => String(row.id || '').trim()).filter(Boolean),
            );
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPreviewError(err.message || 'Could not load recipients.');
          setRecipients([]);
          setRecipientCount(0);
          setRecipientStats(null);
          if (group === 'reviewers') {
            setSelectedReviewerIds([]);
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, isAdmin, group, filterAll, filterColumn, filterValue, JSON.stringify(aesopIdsFilter)]);

  useEffect(() => {
    if (!campaignId || !signedIn || !isAdmin) {
      return undefined;
    }
    let cancelled = false;
    let intervalId = 0;

    const poll = () => {
      adminApiPost('/api/portal-admin/email/campaign-status', { campaignId })
        .then((data) => {
          if (!cancelled) {
            setCampaignStatus(data.status || null);
          }
        })
        .catch(() => {});
    };

    poll();
    intervalId = window.setInterval(poll, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [campaignId, signedIn, isAdmin]);

  useEffect(() => {
    setGlobalVars((prev) => {
      let next = null;
      for (const name of globalPlaceholders) {
        if (Object.prototype.hasOwnProperty.call(prev, name)) {
          continue;
        }
        if (!next) {
          next = { ...prev };
        }
        next[name] =
          name.toLowerCase() === 'date'
            ? new Date().toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })
            : '';
      }
      return next || prev;
    });
  }, [globalPlaceholders.join('|')]);

  const filterValueOptions =
    filterColumn && metadata?.valuesByColumn ? metadata.valuesByColumn[filterColumn] || [] : [];

  const canSendTest =
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    effectiveRecipientCount > 0 &&
    globalPlaceholders.every((name) => String(globalVars[name] ?? '').trim().length > 0);

  const canSendBulk = canSendTest && lastTestHash.length > 0 && !sendLoading;

  function toggleReviewerSelected(aesopId, checked) {
    const id = String(aesopId || '').trim();
    if (!id) {
      return;
    }
    setSelectedReviewerIds((prev) => {
      const key = id.toLowerCase();
      const without = prev.filter((existing) => String(existing).trim().toLowerCase() !== key);
      if (!checked) {
        return without;
      }
      return [...without, id];
    });
  }

  function selectAllReviewers() {
    setSelectedReviewerIds(recipients.map((row) => String(row.id || '').trim()).filter(Boolean));
  }

  function clearReviewerSelection() {
    setSelectedReviewerIds([]);
  }

  async function handleSendTest() {
    setTestLoading(true);
    setTestError('');
    setTestSuccess('');
    try {
      const data = await adminApiPost('/api/portal-admin/email/test', composePayload);
      setLastTestHash(data.contentHash || '');
      setTestPreviewRecipient(data.previewRecipient || null);
      setTestSuccess(`Test sent to ${adminEmail}.`);
    } catch (err) {
      setTestError(err.message || 'Could not send test email.');
    } finally {
      setTestLoading(false);
    }
  }

  async function handleSendBulk() {
    const estimate = estimateBulkEmailDuration(effectiveRecipientCount);
    const durationNote = estimate
      ? `\n\nEstimated send time: about ${formatDurationMinutes(estimate.totalMinutes)} (${estimate.batches} batch${estimate.batches === 1 ? '' : 'es'}).`
      : '';
    const confirmed = window.confirm(
      `Send this message to ${effectiveRecipientCount} recipient${effectiveRecipientCount === 1 ? '' : 's'}?${durationNote}`,
    );
    if (!confirmed) {
      return;
    }
    setSendLoading(true);
    setSendError('');
    try {
      const data = await adminApiPost('/api/portal-admin/email/send', composePayload);
      setCampaignId(data.campaignId || null);
      setCampaignStatus({
        campaignId: data.campaignId,
        status: 'sending',
        totalRecipients: data.totalRecipients,
        sentCount: 0,
        failedCount: 0,
        pendingCount: data.totalRecipients,
        processedCount: 0,
        batchSize: data.batchSize,
        batchIntervalMinutes: data.batchIntervalMinutes,
        estimatedDurationMinutes: data.estimatedDurationMinutes,
      });
    } catch (err) {
      setSendError(err.message || 'Could not start send.');
    } finally {
      setSendLoading(false);
    }
  }

  if (!signedIn) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content portal-hub-card">
          <PortalSignInOnlyContent />
        </div>
      </PortalLayout>
    );
  }

  if (!isAdmin) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content portal-admin-card">
          <PortalSectionLinks current="admin-emails" isAdmin={false} />
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">Admin access not detected</p>
            <p className="portal-session-banner-text">
              This account is not currently marked as an admin in the People sheet.
            </p>
          </div>
        </div>
      </PortalLayout>
    );
  }

  const batchSize = campaignStatus?.batchSize ?? EMAIL_BATCH_SIZE;
  const batchIntervalMinutes =
    campaignStatus?.batchIntervalMinutes ?? EMAIL_BATCH_INTERVAL_MINUTES;
  const sendEstimate = estimateBulkEmailDuration(
    effectiveRecipientCount,
    batchSize,
    batchIntervalMinutes,
  );
  const batchScheduleNote = formatBulkEmailBatchSchedule(
    effectiveRecipientCount,
    batchSize,
    batchIntervalMinutes,
  );
  const campaignTotal = campaignStatus?.totalRecipients ?? recipientCount;
  const campaignSent = campaignStatus?.sentCount ?? 0;
  const campaignFailed = campaignStatus?.failedCount ?? 0;
  const campaignPending = campaignStatus?.pendingCount ?? 0;
  const campaignProcessed =
    campaignStatus?.processedCount ?? campaignSent + campaignFailed;
  const campaignProgressPct =
    campaignTotal > 0 ? Math.min(100, Math.round((campaignProcessed / campaignTotal) * 100)) : 0;

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-admin-card portal-admin-emails-card">
        <PortalSectionLinks current="admin-emails" isAdmin={isAdmin} />
        <h2 className="portal-admin-title">
          Bulk email
          <PortalRoleBadge isAdmin className="portal-welcome-role" />
        </h2>
        <p className="portal-admin-lead">
          Compose templated messages for Admissions applicants or People-sheet reviewers. Send a test
          to yourself before every bulk send.
        </p>

        <section className="portal-admin-panel portal-admin-emails-section" aria-label="Recipient group">
          <h3 className="portal-admin-emails-heading">Group</h3>
          <div className="portal-admin-emails-group-list">
            <label className="portal-admin-emails-radio">
              <input
                type="radio"
                name="email-group"
                value="admissions"
                checked={group === 'admissions'}
                onChange={() => {
                  setGroup('admissions');
                  setFilterAll(true);
                  setFilterColumn('');
                  setFilterValue('');
                  setAesopIdsFilter(null);
                  setRecipientListLabel('');
                  setSelectedReviewerIds([]);
                  setRecipients([]);
                  setRecipientCount(0);
                  setRecipientStats(null);
                }}
              />
              Admissions
            </label>
            <label className="portal-admin-emails-radio">
              <input
                type="radio"
                name="email-group"
                value="reviewers"
                checked={group === 'reviewers'}
                onChange={() => {
                  setGroup('reviewers');
                  setFilterAll(true);
                  setFilterColumn('');
                  setFilterValue('');
                  setAesopIdsFilter(null);
                  setRecipientListLabel('');
                  setSelectedReviewerIds([]);
                  setRecipients([]);
                  setRecipientCount(0);
                  setRecipientStats(null);
                }}
              />
              Reviewers
            </label>
            <label className="portal-admin-emails-radio portal-admin-emails-radio--disabled">
              <input type="radio" name="email-group" value="students" disabled />
              Students <span className="portal-admin-emails-soon">(coming soon)</span>
            </label>
          </div>
        </section>

        <section className="portal-admin-panel portal-admin-emails-section" aria-label="Recipient filter">
          <h3 className="portal-admin-emails-heading">Filter recipients</h3>
          {metadataLoading ? (
            <p className="portal-admin-status">
              {group === 'reviewers' ? 'Loading reviewers…' : 'Loading Applicants filters…'}
            </p>
          ) : null}
          {metadataError ? (
            <p className="portal-admin-status portal-admin-status--error" role="alert">
              {metadataError}
            </p>
          ) : null}
          {group === 'reviewers' ? (
            <>
              <p className="portal-admin-status">
                People Reviewer = Yes
                {typeof metadata?.totalRows === 'number' ? ` — ${metadata.totalRows} with email` : ''}
              </p>
              <p className="portal-admin-hint">
                Use the checkboxes in the recipient table to choose who gets this send. Sends to
                Associated Email when set, otherwise Current Email.
              </p>
            </>
          ) : (
            <>
          <label className="portal-admin-emails-checkbox">
            <input
              type="checkbox"
              checked={filterAll}
              onChange={(e) => {
                setFilterAll(e.target.checked);
                if (e.target.checked) {
                  setFilterColumn('');
                  setFilterValue('');
                  setAesopIdsFilter(null);
                  setRecipientListLabel('');
                }
              }}
            />
            All rows with an email
          </label>
          {Array.isArray(aesopIdsFilter) && aesopIdsFilter.length > 0 ? (
            <div className="portal-admin-emails-id-list-filter">
              <p className="portal-admin-status">
                Recipient list:{' '}
                <strong>{recipientListLabel || 'Selected applicants'}</strong> ({aesopIdsFilter.length}{' '}
                AESOP ID{aesopIdsFilter.length === 1 ? '' : 's'})
              </p>
              <button
                type="button"
                className="portal-btn portal-btn--secondary"
                onClick={() => {
                  setAesopIdsFilter(null);
                  setRecipientListLabel('');
                  setFilterAll(true);
                }}
              >
                Clear list filter
              </button>
            </div>
          ) : !filterAll ? (
            <div className="portal-admin-emails-filter-row">
              <label className="portal-admin-emails-field">
                <span className="portal-admin-emails-label">Column</span>
                <select
                  className="portal-admin-emails-select"
                  value={filterColumn}
                  onChange={(e) => {
                    setFilterColumn(e.target.value);
                    setFilterValue('');
                    setAesopIdsFilter(null);
                    setRecipientListLabel('');
                  }}
                >
                  <option value="">Select column…</option>
                  {filterColumnLabels.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="portal-admin-emails-field">
                <span className="portal-admin-emails-label">Value</span>
                <select
                  className="portal-admin-emails-select"
                  value={filterValue}
                  onChange={(e) => {
                    setFilterValue(e.target.value);
                    setAesopIdsFilter(null);
                    setRecipientListLabel('');
                  }}
                  disabled={!filterColumn}
                >
                  <option value="">Select value…</option>
                  {filterValueOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
            </>
          )}
          {!metadataLoading && !metadataError && group === 'admissions' ? (
            <ApplicantsSheetDebugPanel
              stats={metadata?.stats}
              recipientStats={recipientStats}
              recipientCount={recipientCount}
              previewLoading={previewLoading}
              previewError={previewError}
            />
          ) : null}
          {!metadataLoading && !metadataError && group === 'reviewers' && previewError ? (
            <p className="portal-admin-status portal-admin-status--error" role="alert">
              {previewError}
            </p>
          ) : null}
        </section>

        <section className="portal-admin-panel portal-admin-emails-section" aria-label="Compose message">
          <h3 className="portal-admin-emails-heading">Message</h3>
          <label className="portal-admin-emails-field" htmlFor="portal-admin-email-subject">
            <span className="portal-admin-emails-label">Subject</span>
            <textarea
              id="portal-admin-email-subject"
              className="portal-admin-emails-subject"
              dir="auto"
              rows={2}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject line (supports [[variables]] or {{variables}})"
            />
          </label>
          <label className="portal-admin-emails-field" htmlFor="portal-admin-email-body">
            <span className="portal-admin-emails-label">Body</span>
            <AdminEmailBodyEditor
              id="portal-admin-email-body"
              value={body}
              onChange={setBody}
              placeholder="Write your message. Use [[Name]], [[Applicant ID]], [[Round 2 Prompt]], or globals like [[Date]]."
            />
          </label>
          <p className="portal-admin-hint">
            Per-recipient: <code>[[AESOP ID]]</code> / <code>{'{{AESOP ID}}'}</code>,{' '}
            <code>[[Name]]</code> / <code>{'{{Name}}'}</code>, <code>[[Email]]</code> /{' '}
            <code>{'{{Email}}'}</code>
            {variableColumnLabels.length > 0 ? (
              <>
                , and sheet columns{' '}
                {variableColumnLabels.map((label, index) => (
                  <span key={label}>
                    {index > 0 ? ', ' : ''}
                    <code>{`[[${label}]]`}</code>
                  </span>
                ))}
              </>
            ) : null}
            {group === 'admissions'
              ? '. Filter by Level, Round 1, or Round 2 above — those values are still available in each row if you need them in the message. '
              : '. '}
            Paste from Google Docs to keep links — they appear blue in the editor and stay clickable
            in the sent email.
          </p>
        </section>

        {globalPlaceholders.length > 0 ? (
          <section className="portal-admin-panel portal-admin-emails-section" aria-label="Global variables">
            <h3 className="portal-admin-emails-heading">Global variables</h3>
            <div className="portal-admin-emails-vars">
              {globalPlaceholders.map((name) => (
                <label key={name} className="portal-admin-emails-field">
                  <span className="portal-admin-emails-label">{name}</span>
                  <input
                    type="text"
                    className="portal-admin-lookup-input"
                    value={globalVars[name] ?? ''}
                    onChange={(e) =>
                      setGlobalVars((prev) => ({
                        ...prev,
                        [name]: e.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          </section>
        ) : null}

        <section className="portal-admin-panel portal-admin-emails-section" aria-label="Review recipients">
          <h3 className="portal-admin-emails-heading">Review before sending</h3>
          {previewLoading ? <p className="portal-admin-status">Loading recipient list…</p> : null}
          {previewError ? (
            <p className="portal-admin-status portal-admin-status--error" role="alert">
              {previewError}
            </p>
          ) : null}
          {!previewLoading && !previewError ? (
            <>
              <p className="portal-admin-emails-count">
                <strong>{effectiveRecipientCount}</strong> email
                {effectiveRecipientCount === 1 ? '' : 's'} will be sent
                {group === 'reviewers' && recipientCount > 0 ? (
                  <>
                    {' '}
                    ({selectedReviewerCount} of {recipientCount} reviewers selected)
                  </>
                ) : null}
              </p>
              {group === 'reviewers' && recipientCount > 0 ? (
                <div className="portal-admin-lookup-row">
                  <button
                    type="button"
                    className="portal-btn portal-btn--secondary"
                    onClick={selectAllReviewers}
                    disabled={allReviewersSelected}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="portal-btn portal-btn--secondary"
                    onClick={clearReviewerSelection}
                    disabled={selectedReviewerCount === 0}
                  >
                    Clear selection
                  </button>
                </div>
              ) : null}
              {batchScheduleNote ? (
                <p className="portal-admin-hint">{batchScheduleNote}</p>
              ) : null}
              {sendEstimate && sendEstimate.totalMinutes > 0 ? (
                <p className="portal-admin-hint">
                  Estimated send time: about{' '}
                  <strong>{formatDurationMinutes(sendEstimate.totalMinutes)}</strong> (
                  {sendEstimate.batches} batch{sendEstimate.batches === 1 ? '' : 'es'}).
                </p>
              ) : null}
              {group === 'reviewers' ? (
                <p className="portal-admin-hint">
                  Check the reviewers who should receive this message.
                </p>
              ) : Array.isArray(aesopIdsFilter) && aesopIdsFilter.length > 0 ? (
                <p className="portal-admin-hint">
                  Recipient list: {recipientListLabel || 'Selected applicants'} (
                  {aesopIdsFilter.length} AESOP ID{aesopIdsFilter.length === 1 ? '' : 's'})
                </p>
              ) : !filterAll && filterColumn && filterValue ? (
                <p className="portal-admin-hint">
                  Filter: {filterColumn} = {filterValue}
                </p>
              ) : null}
              {recipientCount === 0 ? (
                <p className="portal-admin-status">No recipients match the current filter.</p>
              ) : group === 'reviewers' && selectedReviewerCount === 0 ? (
                <p className="portal-admin-status">Select at least one reviewer to send.</p>
              ) : null}
              {recipientCount > 0 ? (
                <div className="portal-admin-table-wrap portal-admin-emails-recipient-wrap">
                  <table className="portal-admin-table portal-admin-emails-recipient-table">
                    <thead>
                      <tr>
                        {group === 'reviewers' ? (
                          <th scope="col">
                            <input
                              type="checkbox"
                              checked={allReviewersSelected}
                              aria-label="Select all reviewers"
                              onChange={(e) => {
                                if (e.target.checked) {
                                  selectAllReviewers();
                                } else {
                                  clearReviewerSelection();
                                }
                              }}
                            />
                          </th>
                        ) : null}
                        <th scope="col">AESOP ID</th>
                        <th scope="col">Name</th>
                        <th scope="col">Email</th>
                        {group === 'admissions' && !filterAll && filterColumn ? (
                          <th scope="col">{filterColumn}</th>
                        ) : null}
                      </tr>
                    </thead>
                    <tbody>
                      {recipients.map((row) => {
                        const rowId = String(row.id || '').trim();
                        const rowSelected = selectedReviewerIdSet.has(rowId.toLowerCase());
                        return (
                          <tr key={`${row.id}-${row.email}`}>
                            {group === 'reviewers' ? (
                              <td>
                                <input
                                  type="checkbox"
                                  checked={rowSelected}
                                  disabled={!rowId}
                                  aria-label={`Select ${row.name || rowId || row.email}`}
                                  onChange={(e) => toggleReviewerSelected(rowId, e.target.checked)}
                                />
                              </td>
                            ) : null}
                            <td className="portal-admin-mono">{row.id || '—'}</td>
                            <td>{row.name || '—'}</td>
                            <td>{row.email}</td>
                            {group === 'admissions' && !filterAll && filterColumn ? (
                              <td>{row.fields?.[filterColumn] || '—'}</td>
                            ) : null}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        <section className="portal-admin-panel portal-admin-emails-section" aria-label="Send actions">
          <div className="portal-admin-emails-actions">
            <button
              type="button"
              className="portal-admin-action"
              onClick={handleSendTest}
              disabled={!canSendTest || testLoading}
            >
              {testLoading ? 'Sending test…' : 'Send test to me'}
            </button>
            <button
              type="button"
              className="portal-admin-action portal-admin-action--primary"
              onClick={handleSendBulk}
              disabled={!canSendBulk}
            >
              {sendLoading
                ? 'Starting send…'
                : `Send to ${effectiveRecipientCount} recipient${effectiveRecipientCount === 1 ? '' : 's'}`}
            </button>
          </div>
          {!lastTestHash ? (
            <p className="portal-admin-hint">Send a test email after any change before bulk send.</p>
          ) : null}
          {testError ? (
            <p className="portal-admin-status portal-admin-status--error" role="alert">
              {testError}
            </p>
          ) : null}
          {testSuccess ? (
            <p className="portal-admin-status" role="status">
              {testSuccess}
              {testPreviewRecipient ? (
                <>
                  {' '}
                  Preview data from {testPreviewRecipient.name || testPreviewRecipient.id || 'first row'}.
                </>
              ) : null}
            </p>
          ) : null}
          {sendError ? (
            <p className="portal-admin-status portal-admin-status--error" role="alert">
              {sendError}
            </p>
          ) : null}
        </section>

        {campaignStatus ? (
          <section className="portal-admin-panel portal-admin-emails-section" aria-label="Send progress">
            <h3 className="portal-admin-emails-heading">Send progress</h3>
            <div
              className="portal-admin-emails-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={campaignProgressPct}
              aria-label={`${campaignProcessed} of ${campaignTotal} processed`}
            >
              <div
                className="portal-admin-emails-progress-bar"
                style={{ width: `${campaignProgressPct}%` }}
              />
            </div>
            <p className="portal-admin-emails-progress-summary">
              <strong>{campaignSent}</strong> sent
              {campaignFailed > 0 ? (
                <>
                  , <strong>{campaignFailed}</strong> failed
                </>
              ) : null}
              {campaignPending > 0 ? (
                <>
                  , <strong>{campaignPending}</strong> pending
                </>
              ) : null}
              {' · '}
              {campaignProcessed} / {campaignTotal} processed ({campaignProgressPct}%)
            </p>
            <dl className="portal-admin-stats">
              <div className="portal-admin-stat-row">
                <dt>Status</dt>
                <dd>{formatCampaignStatusLabel(campaignStatus.status)}</dd>
              </div>
              <div className="portal-admin-stat-row">
                <dt>Accepted by Postmark</dt>
                <dd>
                  {campaignSent} / {campaignTotal}
                </dd>
              </div>
              <div className="portal-admin-stat-row">
                <dt>Failed</dt>
                <dd>{campaignFailed}</dd>
              </div>
              <div className="portal-admin-stat-row">
                <dt>Pending</dt>
                <dd>{campaignPending}</dd>
              </div>
              <div className="portal-admin-stat-row">
                <dt>Delivered</dt>
                <dd>{campaignStatus.deliveredCount ?? 0}</dd>
              </div>
              <div className="portal-admin-stat-row">
                <dt>Opened</dt>
                <dd>{campaignStatus.openedCount ?? 0}</dd>
              </div>
              <div className="portal-admin-stat-row">
                <dt>Clicked</dt>
                <dd>{campaignStatus.clickedCount ?? 0}</dd>
              </div>
              {(campaignStatus.bouncedCount ?? 0) > 0 ? (
                <div className="portal-admin-stat-row">
                  <dt>Bounced</dt>
                  <dd>{campaignStatus.bouncedCount}</dd>
                </div>
              ) : null}
              {campaignStatus.status === 'sending' && campaignStatus.estimatedCompletionAt ? (
                <div className="portal-admin-stat-row">
                  <dt>Estimated finish</dt>
                  <dd>{new Date(campaignStatus.estimatedCompletionAt).toLocaleString()}</dd>
                </div>
              ) : null}
              {campaignPending > 0 && campaignStatus.nextBatchAt ? (
                <div className="portal-admin-stat-row">
                  <dt>Next batch</dt>
                  <dd>{new Date(campaignStatus.nextBatchAt).toLocaleString()}</dd>
                </div>
              ) : null}
              {campaignStatus.status === 'completed' && campaignStatus.completedAt ? (
                <div className="portal-admin-stat-row">
                  <dt>Finished</dt>
                  <dd>{new Date(campaignStatus.completedAt).toLocaleString()}</dd>
                </div>
              ) : null}
            </dl>
            <p className="portal-admin-hint">
              Delivered and opened counts update from Postmark webhooks after messages are accepted.
            </p>
            <p className="portal-admin-hint">
              Duplicate protection: each batch claims recipients in the database with row locks before
              sending, and only one server can process a campaign batch at a time.
            </p>
          </section>
        ) : null}
      </div>
    </PortalLayout>
  );
}

const SCALE_0_TO_10 = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const SCALE_0_TO_10_DESC = [...SCALE_0_TO_10].reverse();
const ENGLISH_LEVEL_SCORES = SCALE_0_TO_10;
const FITNESS_CRITERIA = [
  {
    id: 'instructionFollowing',
    labelKey: 'reviews.fitness.instruction',
    rubricKey: 'instructionFollowing',
  },
  { id: 'originalThinking', labelKey: 'reviews.fitness.original', rubricKey: 'originalThinking' },
  { id: 'character', labelKey: 'reviews.fitness.character', rubricKey: 'character' },
];

const REVIEW_RUBRIC_TIERS = [
  { tierKey: 'highest', score: '10', labelKey: 'reviews.rubric.highestLabel' },
  { tierKey: 'adequate', score: '5', labelKey: 'reviews.rubric.adequateLabel' },
  { tierKey: 'low', score: '0', labelKey: 'reviews.rubric.lowLabel' },
];

const EMPTY_REVIEW_DRAFT = {
  englishLevel: '',
  suspectedAi: false,
  instructionFollowing: '',
  originalThinking: '',
  character: '',
};

function reviewDraftIsSaveable(draft) {
  if (!draft) {
    return false;
  }
  const hasEnglish = ENGLISH_LEVEL_SCORES.includes(String(draft.englishLevel ?? '').trim());
  const hasAi = draft.suspectedAi === true;
  if (!hasEnglish && !hasAi) {
    return false;
  }
  return FITNESS_CRITERIA.every((criterion) =>
    SCALE_0_TO_10.includes(String(draft[criterion.id] ?? '').trim()),
  );
}

function reviewScaleOptionLabel(score, t) {
  if (score === '0') {
    return `0 — ${t('reviews.scale.lowest')}`;
  }
  if (score === '5') {
    return `5 — ${t('reviews.scale.midpoint')}`;
  }
  if (score === '10') {
    return `10 — ${t('reviews.scale.highest')}`;
  }
  return score;
}

function PortalReviewScaleSelect({
  value,
  onChange,
  ariaLabel,
  fieldLabel,
  t,
  wide = false,
  scores = SCALE_0_TO_10_DESC,
}) {
  const placeholder = fieldLabel
    ? t('reviews.scalePlaceholderFor', { field: fieldLabel })
    : t('reviews.scalePlaceholder');

  return (
    <select
      className={`portal-review-scale-select${wide ? ' portal-review-scale-select--wide' : ''}`}
      value={value}
      aria-label={ariaLabel}
      onChange={onChange}
    >
      <option value="">{placeholder}</option>
      {scores.map((score) => (
        <option key={score} value={score}>
          {reviewScaleOptionLabel(score, t)}
        </option>
      ))}
    </select>
  );
}

function PortalReviewRubricHelp({ rubricKey, t, variant = 'fitness' }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onDocumentPointerDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onEscape = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocumentPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onDocumentPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const title =
    variant === 'english'
      ? t('reviews.rubric.englishLevel.title')
      : t(`reviews.rubric.${rubricKey}.title`);

  return (
    <span
      ref={wrapRef}
      className="portal-review-rubric-help"
      onMouseEnter={variant === 'english' ? undefined : () => setOpen(true)}
      onMouseLeave={variant === 'english' ? undefined : () => setOpen(false)}
    >
      <button
        type="button"
        className="portal-review-rubric-help-btn"
        aria-expanded={open}
        aria-label={`${t('reviews.rubric.moreInfo')}: ${title}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path fill="currentColor" d="M7.1 6.8h1.4V5.4H7.1v1.4zm0 3.8h1.4V7.8H7.1v2.8z" />
        </svg>
      </button>
      {open ? (
        <div
          className={`portal-review-rubric-popover${
            variant === 'english' ? ' portal-review-rubric-popover--english' : ''
          }`}
          role="tooltip"
        >
          <p className="portal-review-rubric-popover-title">{title}</p>
          {variant === 'english' ? (
            <div className="portal-review-rubric-popover-scroll">
              <ul className="portal-review-rubric-list">
                {SCALE_0_TO_10_DESC.map((score) => (
                  <li key={score} className="portal-review-rubric-item">
                    <div className="portal-review-rubric-item-head">
                      <span className="portal-review-rubric-tier-score">{score}</span>
                    </div>
                    <p className="portal-review-rubric-item-text">
                      {t(`reviews.rubric.englishLevel.${score}`)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="portal-review-rubric-list">
              {REVIEW_RUBRIC_TIERS.map((tier) => (
                <li key={tier.tierKey} className="portal-review-rubric-item">
                  <div className="portal-review-rubric-item-head">
                    <span className="portal-review-rubric-tier-label">{t(tier.labelKey)}</span>
                    <span className="portal-review-rubric-tier-score">{tier.score}</span>
                  </div>
                  <p className="portal-review-rubric-item-text">
                    {t(`reviews.rubric.${rubricKey}.${tier.tierKey}`)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}

function PortalReviewSuspectedAiToggle({ active, onToggle, t }) {
  return (
    <button
      type="button"
      className={`portal-review-ai-toggle${active ? ' is-flagged' : ''}`}
      aria-pressed={active === true}
      onClick={onToggle}
    >
      <span className="portal-review-ai-toggle-box" aria-hidden="true">
        {active ? (
          <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
            <path
              fill="currentColor"
              d="M13.2 4.2 6.8 10.6 3.3 7.1l-1.4 1.4 5 5 8.3-8.3-1.4-1.4z"
            />
          </svg>
        ) : null}
      </span>
      <span className="portal-review-ai-toggle-text">
        <span className="portal-review-ai-toggle-label">
          {active ? t('reviews.suspectedAiFlagged') : t('reviews.suspectedAi')}
        </span>
        {!active ? (
          <span className="portal-review-ai-toggle-hint">{t('reviews.suspectedAiOffHint')}</span>
        ) : null}
      </span>
    </button>
  );
}

function formatReviewSaveStatusLabel({ saveStatus, lastSavedAt, nowMs, t }) {
  if (saveStatus === 'pending') {
    return t('reviews.savePending');
  }
  if (saveStatus === 'saving') {
    return t('reviews.saveSaving');
  }
  if (saveStatus === 'error') {
    return t('reviews.saveStatusError');
  }
  if (saveStatus === 'saved' && lastSavedAt) {
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - lastSavedAt) / 1000));
    if (elapsedSeconds < 5) {
      return t('reviews.saveSavedJustNow');
    }
    if (elapsedSeconds < 60) {
      return t('reviews.saveSavedSecondsAgo', { seconds: elapsedSeconds });
    }
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes === 1) {
      return t('reviews.saveSavedMinutesAgo', { minutes: elapsedMinutes });
    }
    return t('reviews.saveSavedMinutesAgoPlural', { minutes: elapsedMinutes });
  }
  return '';
}

function PortalReviewSaveStatus({ saveStatus, lastSavedAt, t }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (saveStatus !== 'saved' || !lastSavedAt) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [saveStatus, lastSavedAt]);

  const label = formatReviewSaveStatusLabel({ saveStatus, lastSavedAt, nowMs, t });
  if (!label) {
    return null;
  }

  return (
    <span
      className={`portal-review-save-indicator portal-review-save-indicator--${saveStatus}`}
      role="status"
      aria-live="polite"
    >
      <span className="portal-review-save-indicator-icon" aria-hidden="true">
        {saveStatus === 'saving' || saveStatus === 'pending' ? (
          <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              d="M8 2a6 6 0 0 1 6 6"
            />
          </svg>
        ) : saveStatus === 'error' ? (
          <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
            <path
              fill="currentColor"
              d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm.75 3.5a.75.75 0 0 0-1.5 0v4a.75.75 0 0 0 1.5 0v-4zm-.75 6.25a.875.875 0 1 0 0-1.75.875.875 0 0 0 0 1.75z"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
            <path
              fill="currentColor"
              d="M11.5 1.5 14 4v8.25A1.75 1.75 0 0 1 12.25 14H3.75A1.75 1.75 0 0 1 2 12.25V3.75A1.75 1.75 0 0 1 3.75 2h5.8l1.95-1.95zm-.2 1.05-1.3 1.3H12v7.9H4V4h7.3z"
            />
          </svg>
        )}
      </span>
      <span className="portal-review-save-indicator-label">{label}</span>
    </span>
  );
}

function useReviewAutoSave({ drafts, onSaveOne }) {
  const dirtyRef = useRef(new Set());
  const draftsRef = useRef(drafts);
  const debounceTimersRef = useRef(new Map());
  const onSaveOneRef = useRef(onSaveOne);
  const [saveStatus, setSaveStatus] = useState('idle');
  const [lastSavedAt, setLastSavedAt] = useState(null);

  draftsRef.current = drafts;
  onSaveOneRef.current = onSaveOne;

  const flushApplicant = useCallback(async (applicantId) => {
    const draft = draftsRef.current[applicantId];
    if (!reviewDraftIsSaveable(draft)) {
      dirtyRef.current.delete(applicantId);
      return;
    }
    setSaveStatus('saving');
    try {
      await onSaveOneRef.current(applicantId, draft);
      dirtyRef.current.delete(applicantId);
      setLastSavedAt(Date.now());
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    }
  }, []);

  const markDirty = useCallback(
    (applicantId, draftOverride) => {
      const draft = draftOverride || draftsRef.current[applicantId];
      if (!reviewDraftIsSaveable(draft)) {
        return;
      }
      dirtyRef.current.add(applicantId);
      setSaveStatus('pending');
      const existing = debounceTimersRef.current.get(applicantId);
      if (existing) {
        window.clearTimeout(existing);
      }
      const timerId = window.setTimeout(() => {
        debounceTimersRef.current.delete(applicantId);
        flushApplicant(applicantId);
      }, 1500);
      debounceTimersRef.current.set(applicantId, timerId);
    },
    [flushApplicant],
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      for (const applicantId of Array.from(dirtyRef.current)) {
        const timer = debounceTimersRef.current.get(applicantId);
        if (timer) {
          window.clearTimeout(timer);
          debounceTimersRef.current.delete(applicantId);
        }
        flushApplicant(applicantId);
      }
    }, 30000);

    return () => {
      window.clearInterval(intervalId);
      for (const timer of debounceTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      debounceTimersRef.current.clear();
      for (const applicantId of Array.from(dirtyRef.current)) {
        flushApplicant(applicantId);
      }
    };
  }, [flushApplicant]);

  return { markDirty, saveStatus, lastSavedAt };
}

function PortalReviewPrompt({ prompt, t }) {
  const [showTranslation, setShowTranslation] = useState(false);
  const fullText = String(prompt || '').trim();

  useEffect(() => {
    setShowTranslation(false);
  }, [fullText]);

  if (!fullText) {
    return (
      <>
        <div className="portal-review-prompt-header">
          <h4 className="portal-review-field-label portal-review-prompt-label">{t('reviews.promptLabel')}</h4>
        </div>
        <p className="portal-field-hint">{t('reviews.promptMissing')}</p>
      </>
    );
  }

  const latinText = stripNonLatinLetters(fullText);
  const hasTranslation = hasNonLatinLetters(fullText);
  const displayText = showTranslation || !hasTranslation ? fullText : latinText;

  return (
    <>
      <div className="portal-review-prompt-header">
        <h4 className="portal-review-field-label portal-review-prompt-label">{t('reviews.promptLabel')}</h4>
        {hasTranslation ? (
          <button
            type="button"
            className="portal-review-prompt-toggle"
            onClick={() => setShowTranslation((current) => !current)}
            aria-expanded={showTranslation}
          >
            {showTranslation ? t('reviews.hideTranslation') : t('reviews.showTranslation')}
          </button>
        ) : null}
      </div>
      <div className="portal-review-essay portal-review-prompt-body" dir="auto">
        {displayText}
      </div>
    </>
  );
}

function PortalReviewVoicePlayer({ assignment, t, onRefreshStream }) {
  const [audioError, setAudioError] = useState('');
  const [refreshingStream, setRefreshingStream] = useState(false);

  const streamSrc = useMemo(() => {
    if (!assignment?.hasVoiceMemo || !assignment?.streamToken) {
      return '';
    }
    const params = new URLSearchParams({ st: assignment.streamToken });
    return `/api/portal-reviews/voice-memo/stream?${params.toString()}`;
  }, [assignment?.hasVoiceMemo, assignment?.streamToken]);

  const downloadHref = useMemo(() => {
    if (!streamSrc) {
      return '';
    }
    const params = new URLSearchParams({ st: assignment.streamToken, download: '1' });
    return `/api/portal-reviews/voice-memo/stream?${params.toString()}`;
  }, [streamSrc, assignment?.streamToken]);

  const canDownloadMp4 = useMemo(
    () => voiceMemoExtensionFromFileName(assignment?.driveFileName) === 'mp4',
    [assignment?.driveFileName],
  );

  useEffect(() => {
    setAudioError('');
  }, [streamSrc]);

  const handleRefreshStream = useCallback(async () => {
    if (!onRefreshStream || refreshingStream) {
      return;
    }
    setRefreshingStream(true);
    setAudioError('');
    try {
      await onRefreshStream();
    } catch (error) {
      setAudioError(error?.message || t('reviews.streamExpired'));
    } finally {
      setRefreshingStream(false);
    }
  }, [onRefreshStream, refreshingStream, t]);

  if (!assignment?.hasVoiceMemo || !streamSrc) {
    return (
      <div className="portal-review-voice-row">
        <p className="portal-field-hint">{t('reviews.voiceNotAvailable')}</p>
      </div>
    );
  }

  return (
    <div className="portal-review-voice-row">
      {assignment.durationStatus === 'too_long' ? (
        <p className="portal-field-hint portal-voice-memo-duration-ok">
          {t('reviews.durationExceeding')}
        </p>
      ) : null}
      <div className="portal-review-voice-player" aria-label={t('reviews.playVoice')}>
        <audio
          controls
          preload="none"
          className="portal-review-voice-audio"
          src={streamSrc}
          onError={() => {
            resolvePortalVoiceMemoAudioError(streamSrc, t).then((message) => {
              setAudioError(message);
            });
          }}
        >
          {t('reviews.voiceAudioUnsupported')}
        </audio>
        {audioError ? <p className="portal-field-hint portal-review-voice-error">{audioError}</p> : null}
      </div>
      <div className="portal-review-voice-actions">
        {refreshingStream ||
        audioError === t('voiceMemo.streamExpired') ||
        audioError === t('reviews.streamExpired') ? (
          <button
            type="button"
            className="portal-review-voice-btn"
            onClick={handleRefreshStream}
            disabled={refreshingStream || !onRefreshStream}
          >
            <span className="portal-review-voice-btn-label">
              {refreshingStream ? t('reviews.refreshingStream') : t('reviews.refreshStream')}
            </span>
          </button>
        ) : null}
        {downloadHref && canDownloadMp4 ? (
          <a className="portal-review-voice-btn" href={downloadHref} download>
            <span className="portal-review-voice-btn-label">{t('reviews.downloadMp4')}</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

function PortalReviewCard({
  assignment,
  draft,
  onDraftChange,
  onMarkDirty,
  onNextStudent,
  showNextStudent,
  onRefreshStream,
  t,
}) {
  const ageDisplay = assignment.age?.trim() || t('reviews.notAvailable');

  return (
    <article className="portal-review-card" aria-labelledby={`review-${assignment.applicantId}-title`}>
      <section className="portal-review-prompt-section" aria-label={t('reviews.promptLabel')}>
        <PortalReviewPrompt prompt={assignment.round2Prompt} t={t} />
      </section>

      <header className="portal-review-card-header">
        <h3 className="portal-review-card-title" id={`review-${assignment.applicantId}-title`}>
          <span className="portal-ltr portal-admin-mono">{assignment.applicantId}</span>
          <span className="portal-review-card-age">
            {t('reviews.age')}: {ageDisplay}
          </span>
        </h3>
      </header>

      <section className="portal-review-essay-section" aria-label={t('reviews.essayLabel')}>
        <h4 className="portal-review-field-label">{t('reviews.essayLabel')}</h4>
        {assignment.essay.trim() ? (
          <div className="portal-review-essay">{assignment.essay}</div>
        ) : (
          <p className="portal-field-hint">{t('reviews.essayMissing')}</p>
        )}
      </section>

      <PortalReviewVoicePlayer assignment={assignment} t={t} onRefreshStream={onRefreshStream} />

      <div className="portal-review-scoring-panel" aria-label={t('reviews.scoringAria')}>
        <section className="portal-review-scoring-section portal-review-scoring-section--english">
          <h4 className="portal-review-scoring-section-title">
            <span className="portal-review-scale-field-label-row">
              <span>{t('reviews.levelLabel')}</span>
              <PortalReviewRubricHelp variant="english" t={t} />
            </span>
          </h4>
          <div className="portal-review-scoring-section-row">
            <label className="portal-review-scale-field portal-review-scale-field--solo">
              <span className="portal-review-visually-hidden">{t('reviews.levelLabel')}</span>
              <PortalReviewScaleSelect
                wide
                t={t}
                fieldLabel={t('reviews.levelLabel')}
                value={draft.englishLevel}
                ariaLabel={t('reviews.levelLabel')}
                onChange={(event) => {
                  const nextDraft = { ...draft, englishLevel: event.target.value };
                  onDraftChange(assignment.applicantId, { englishLevel: event.target.value });
                  onMarkDirty(assignment.applicantId, nextDraft);
                }}
              />
            </label>
            <PortalReviewSuspectedAiToggle
              t={t}
              active={draft.suspectedAi === true}
              onToggle={() => {
                const nextDraft = { ...draft, suspectedAi: !draft.suspectedAi };
                onDraftChange(assignment.applicantId, { suspectedAi: nextDraft.suspectedAi });
                onMarkDirty(assignment.applicantId, nextDraft);
              }}
            />
          </div>
        </section>

        <div className="portal-review-scoring-divider" aria-hidden="true" />

        <section className="portal-review-scoring-section portal-review-scoring-section--fitness">
          <h4 className="portal-review-scoring-section-title">{t('reviews.fitnessLabel')}</h4>
          <div className="portal-review-scoring-section-row">
            {FITNESS_CRITERIA.map((criterion) => (
              <label key={criterion.id} className="portal-review-scale-field">
                <span className="portal-review-scale-field-label-row">
                  <span className="portal-review-scale-field-label">{t(criterion.labelKey)}</span>
                  <PortalReviewRubricHelp rubricKey={criterion.rubricKey} t={t} />
                </span>
                <PortalReviewScaleSelect
                  t={t}
                  fieldLabel={t(criterion.labelKey)}
                  value={draft[criterion.id]}
                  ariaLabel={t(criterion.labelKey)}
                  onChange={(event) => {
                    const nextDraft = { ...draft, [criterion.id]: event.target.value };
                    onDraftChange(assignment.applicantId, { [criterion.id]: event.target.value });
                    onMarkDirty(assignment.applicantId, nextDraft);
                  }}
                />
              </label>
            ))}
          </div>
        </section>
      </div>

      {showNextStudent ? (
        <div className="portal-review-next-row">
          <button type="button" className="portal-review-next-btn" onClick={onNextStudent}>
            {t('reviews.nextStudent')} →
          </button>
        </div>
      ) : null}
    </article>
  );
}

function PortalReviewStudentList({ assignments, drafts, selectedApplicantId, onSelect, saveStatus, lastSavedAt, t }) {
  return (
    <aside className="portal-review-sidebar" aria-label={t('reviews.studentList')}>
      <div className="portal-review-sidebar-head">
        <h3 className="portal-review-sidebar-title">{t('reviews.studentList')}</h3>
        <PortalReviewSaveStatus saveStatus={saveStatus} lastSavedAt={lastSavedAt} t={t} />
      </div>
      <ul className="portal-review-student-list">
        {assignments.map((assignment) => {
          const isSelected = assignment.applicantId === selectedApplicantId;
          const draft = drafts[assignment.applicantId] || EMPTY_REVIEW_DRAFT;
          const isComplete = reviewDraftIsSaveable(draft);
          const ageDisplay = assignment.age?.trim() || t('reviews.notAvailable');

          return (
            <li key={assignment.applicantId}>
              <button
                type="button"
                className={`portal-review-student-item${isSelected ? ' is-selected' : ''}${
                  isComplete ? ' is-complete' : ''
                }`}
                aria-current={isSelected ? 'true' : undefined}
                onClick={(event) => {
                  onSelect(assignment.applicantId);
                  event.currentTarget.focus({ preventScroll: true });
                }}
              >
                <span className="portal-review-student-name portal-ltr portal-admin-mono">
                  {assignment.applicantId}
                </span>
                <span className="portal-review-student-age portal-ltr">
                  {t('reviews.age')}: {ageDisplay}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function PortalReviewApplicationsPage() {
  const { t } = usePortalI18n();
  const { isAdmin, isReviewer } = usePortalClassGrade();
  const showAdminFeatures = isAdmin && !isPortalImpersonating();
  const signedIn = isPortalSessionCompleteSync();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [assignments, setAssignments] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [selectedApplicantId, setSelectedApplicantId] = useState('');
  const reviewDetailRef = useRef(null);

  const saveOne = useCallback(async (applicantId, draft) => {
    await portalApiPost('/api/portal-reviews/save', {
      applicantId,
      englishLevel: draft.englishLevel,
      suspectedAi: draft.suspectedAi === true,
      instructionFollowing: draft.instructionFollowing,
      originalThinking: draft.originalThinking,
      character: draft.character,
    });
  }, []);

  const { markDirty, saveStatus, lastSavedAt } = useReviewAutoSave({ drafts, onSaveOne: saveOne });

  const refreshStreamTokens = useCallback(async () => {
    const data = await portalApiPost('/api/portal-reviews/list', {}, { timeoutMs: 45000 });
    const rows = Array.isArray(data.assignments) ? data.assignments : [];
    setAssignments((prev) => {
      const byId = new Map(rows.map((row) => [row.applicantId, row]));
      return prev.map((assignment) => {
        const fresh = byId.get(assignment.applicantId);
        if (!fresh) {
          return assignment;
        }
        return {
          ...assignment,
          hasVoiceMemo: fresh.hasVoiceMemo,
          streamToken: fresh.streamToken,
          durationStatus: fresh.durationStatus,
          driveFileName: fresh.driveFileName ?? assignment.driveFileName,
        };
      });
    });
  }, []);

  useEffect(() => {
    if (!signedIn || !isReviewer) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    portalApiPost('/api/portal-reviews/list', {}, { timeoutMs: 45000 })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const rows = Array.isArray(data.assignments) ? data.assignments : [];
        setAssignments(rows);
        const nextDrafts = {};
        for (const row of rows) {
          const normalizeScale = (value) => {
            const trimmed = String(value ?? '').trim();
            return SCALE_0_TO_10.includes(trimmed) ? trimmed : '';
          };
          const englishFromApi = String(row.englishLevel ?? row.recommendedLevel ?? '').trim();
          nextDrafts[row.applicantId] = {
            englishLevel: normalizeScale(englishFromApi),
            suspectedAi: row.suspectedAi === true,
            instructionFollowing: normalizeScale(row.instructionFollowing),
            originalThinking: normalizeScale(row.originalThinking),
            character: normalizeScale(row.character),
          };
        }
        setDrafts(nextDrafts);
        const firstId = rows[0]?.applicantId ? String(rows[0].applicantId) : '';
        setSelectedApplicantId((current) =>
          current && rows.some((row) => row.applicantId === current) ? current : firstId,
        );
      })
      .catch((err) => {
        if (!cancelled) {
          const message =
            err && err.message === 'Request timed out. Please try again.'
              ? t('reviews.loadTimeout')
              : err.message || t('reviews.loadError');
          setError(message);
          setAssignments([]);
          setDrafts({});
          setSelectedApplicantId('');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [signedIn, isReviewer, t]);

  const updateDraft = useCallback((applicantId, patch) => {
    setDrafts((prev) => ({
      ...prev,
      [applicantId]: { ...prev[applicantId], ...patch },
    }));
  }, []);

  const selectedAssignment = useMemo(
    () => assignments.find((row) => row.applicantId === selectedApplicantId) || null,
    [assignments, selectedApplicantId],
  );

  const selectedDraft = selectedAssignment
    ? drafts[selectedAssignment.applicantId] || EMPTY_REVIEW_DRAFT
    : EMPTY_REVIEW_DRAFT;

  const selectedIndex = useMemo(
    () => assignments.findIndex((row) => row.applicantId === selectedApplicantId),
    [assignments, selectedApplicantId],
  );

  const goToNextStudent = useCallback(() => {
    if (selectedIndex < 0 || selectedIndex >= assignments.length - 1) {
      return;
    }
    setSelectedApplicantId(assignments[selectedIndex + 1].applicantId);
  }, [assignments, selectedIndex]);

  useEffect(() => {
    reviewDetailRef.current?.scrollTo(0, 0);
  }, [selectedApplicantId]);

  const showNextStudent =
    selectedAssignment &&
    reviewDraftIsSaveable(selectedDraft) &&
    selectedIndex >= 0 &&
    selectedIndex < assignments.length - 1;

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-review-page">
        <PortalSectionLinks
          current="reviews"
          isAdmin={showAdminFeatures}
          isReviewer={isReviewer}
          showEditDingLink={!readPortalIsApplied()}
        />

        <h2 className="portal-page-title">{t('reviews.pageTitle')}</h2>
        <p className="portal-page-lead">{t('reviews.pageLead')}</p>

        {!signedIn ? (
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-text">
              {t('profile.sessionIncompletePrefix')}{' '}
              <a href={portalHubHref()}>{t('profile.backToProfile')}</a>{' '}
              {t('profile.sessionIncompleteSuffix')}
            </p>
          </div>
        ) : null}

        {signedIn && !isReviewer ? (
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-text">{t('reviews.accessDenied')}</p>
          </div>
        ) : null}

        {signedIn && isReviewer ? (
          <>
            {loading ? <p className="portal-field-hint">{t('reviews.loading')}</p> : null}
            {error ? (
              <p className="portal-form-error" role="alert">
                {error}
              </p>
            ) : null}

            {!loading && !error && assignments.length === 0 ? (
              <p className="portal-field-hint">{t('reviews.empty')}</p>
            ) : null}

            {!loading && !error && assignments.length > 0 ? (
              <div className="portal-review-split">
                <PortalReviewStudentList
                  assignments={assignments}
                  drafts={drafts}
                  selectedApplicantId={selectedApplicantId}
                  onSelect={setSelectedApplicantId}
                  saveStatus={saveStatus}
                  lastSavedAt={lastSavedAt}
                  t={t}
                />
                <div className="portal-review-detail" ref={reviewDetailRef}>
                  {selectedAssignment ? (
                    <PortalReviewCard
                      key={selectedApplicantId}
                      assignment={selectedAssignment}
                      draft={selectedDraft}
                      onDraftChange={updateDraft}
                      onMarkDirty={markDirty}
                      onNextStudent={goToNextStudent}
                      showNextStudent={showNextStudent}
                      onRefreshStream={refreshStreamTokens}
                      t={t}
                    />
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </PortalLayout>
  );
}

function PortalShellApp() {
  useEffect(() => {
    document.body.classList.add('portal-body');
    return () => document.body.classList.remove('portal-body');
  }, []);

  useEffect(() => {
    const { pathname } = window.location;
    if (pathname === '/faq' || pathname.startsWith('/faq/')) {
      window.location.replace(portalHubHref());
    }
  }, []);

  const segment = getPortalRouteSegment();
  const signedIn = isPortalSessionCompleteSync();

  useEffect(() => {
    if (!signedIn) {
      return undefined;
    }

    let timeoutId = 0;

    const resetIdleTimer = () => {
      touchPortalSessionExpiry();
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        clearPortalSession();
        window.location.assign(portalHubHref());
      }, getPortalSessionMaxAgeMs());
    };

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'];
    const opts = { capture: true, passive: true };

    activityEvents.forEach((evt) => window.addEventListener(evt, resetIdleTimer, opts));
    window.addEventListener('scroll', resetIdleTimer, opts);

    resetIdleTimer();

    return () => {
      window.clearTimeout(timeoutId);
      activityEvents.forEach((evt) => window.removeEventListener(evt, resetIdleTimer, opts));
      window.removeEventListener('scroll', resetIdleTimer, opts);
    };
  }, [signedIn]);

  let page;
  if (segment === 'admin-emails') {
    page = <PortalAdminEmailsPage />;
  } else if (segment === 'admin-campaigns') {
    page = <PortalAdminCampaignsPage />;
  } else if (segment === 'admin-stats') {
    page = <PortalAdminStatsPage />;
  } else if (segment === 'admin') {
    page = <PortalAdminPage />;
  } else if (segment === 'reviews') {
    page = <PortalReviewApplicationsPage />;
  } else if (segment === 'profile') {
    page = signedIn ? <PortalProfilePage /> : <PortalHubPage />;
  } else {
    page = <PortalHubPage />;
  }

  return <PortalLanguageProvider>{page}</PortalLanguageProvider>;
}

function PortalProfilePage() {
  const { t } = usePortalI18n();
  const {
    studentName,
    studentEmail,
    studentUserId,
    studentPhone,
    newDingNumber,
    setNewDingNumber,
    canUpdateDing,
  } = usePortalStudentRecord();
  const { isAdmin, isReviewer } = usePortalClassGrade();
  const showAdminFeatures = isAdmin && !isPortalImpersonating();
  const sessionComplete = studentUserId.length > 0 && studentEmail.length > 0;
  const hasApplicantPortalAccess = readPortalIsApplicant();
  const isApplicantProfile = hasApplicantPortalAccess;
  const reviewerOnly = isReviewer && !hasApplicantPortalAccess;

  /** Single open accordion panel on Edit Ding (others close automatically). */
  const [activeDingPanel, setActiveDingPanel] = useState(null); // null | 'update' | 'history' | 'help'
  const [formDing, setFormDing] = useState('');
  const [formDingConfirm, setFormDingConfirm] = useState('');
  const [dingFieldError, setDingFieldError] = useState('');
  const [dingConfirmFieldError, setDingConfirmFieldError] = useState('');
  const [formStatus, setFormStatus] = useState({ type: '', text: '' });
  const [saving, setSaving] = useState(false);
  const [dingHelpPhone, setDingHelpPhone] = useState('');
  const [dingHelpNote, setDingHelpNote] = useState('');
  const [dingHelpStatus, setDingHelpStatus] = useState({ type: '', text: '' });
  const [dingHelpSubmitting, setDingHelpSubmitting] = useState(false);
  const [dingHistoryLoading, setDingHistoryLoading] = useState(false);
  const [dingHistoryError, setDingHistoryError] = useState('');
  const [dingHistoryEntries, setDingHistoryEntries] = useState([]);

  const toggleDingPanel = (panelId) => {
    setActiveDingPanel((prev) => {
      const next = prev === panelId ? null : panelId;
      if (next === 'update') {
        setFormStatus({ type: '', text: '' });
        setFormDing('');
        setFormDingConfirm('');
        setDingFieldError('');
        setDingConfirmFieldError('');
      }
      if (next === 'help') {
        setDingHelpStatus({ type: '', text: '' });
      }
      return next;
    });
  };

  useEffect(() => {
    if (activeDingPanel !== 'history' || !canUpdateDing) {
      return undefined;
    }
    let cancelled = false;
    setDingHistoryLoading(true);
    setDingHistoryError('');
    loadPortalDingHistoryFromApi({ userId: studentUserId, email: studentEmail }).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setDingHistoryError(result.errorMessage);
        setDingHistoryEntries([]);
        return;
      }
      setDingHistoryEntries(result.entries);
      setDingHistoryError('');
    }).finally(() => {
      if (!cancelled) {
        setDingHistoryLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeDingPanel, canUpdateDing, studentUserId, studentEmail]);

  useEffect(() => {
    if (sessionComplete && reviewerOnly) {
      window.location.replace('/reviews');
    }
  }, [sessionComplete, reviewerOnly]);

  const submitDingUpdate = async () => {
    if (!canUpdateDing) {
      return;
    }
    const trimmed = formDing.trim();
    const trimmedConfirm = formDingConfirm.trim();

    if (!trimmed) {
      setDingFieldError('');
      setDingConfirmFieldError('');
      setFormStatus({ type: 'error', text: 'Enter your Afghanistan phone number.' });
      return;
    }
    if (!trimmedConfirm) {
      setDingConfirmFieldError(DING_CONFIRM_REQUIRED_MESSAGE);
      setFormStatus({ type: '', text: '' });
      return;
    }
    if (!isValidAfghanistanPhoneNumber(trimmed)) {
      setDingFieldError(getAfghanistanPhoneFormatMessage(trimmed));
      setFormStatus({ type: '', text: '' });
      return;
    }
    if (!isValidAfghanistanPhoneNumber(trimmedConfirm)) {
      setDingConfirmFieldError(getAfghanistanPhoneFormatMessage(trimmedConfirm));
      setFormStatus({ type: '', text: '' });
      return;
    }
    const normalizedDing = normalizeAfghanistanPhoneDigits(trimmed);
    const normalizedConfirm = normalizeAfghanistanPhoneDigits(trimmedConfirm);
    if (normalizedDing !== normalizedConfirm) {
      setDingConfirmFieldError(DING_CONFIRM_MISMATCH_MESSAGE);
      setFormStatus({ type: '', text: '' });
      return;
    }

    setFormStatus({ type: '', text: '' });
    setDingFieldError('');
    setDingConfirmFieldError('');
    setSaving(true);
    try {
      const response = await fetch('/api/update-ding-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: studentUserId,
          email: studentEmail,
          newDingNumber: normalizedDing,
          confirmNewDingNumber: normalizedConfirm,
          displayName: studentName.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        const msg = data.error || 'Update failed. Please try again.';
        if (response.status === 400 && isAfghanPhoneFormatErrorMessage(msg)) {
          if (!isValidAfghanistanPhoneNumber(trimmed)) {
            setDingFieldError(msg);
          } else {
            setDingConfirmFieldError(msg);
          }
          setFormStatus({ type: '', text: '' });
          return;
        }
        if (response.status === 400 && msg === DING_CONFIRM_MISMATCH_MESSAGE) {
          setDingConfirmFieldError(DING_CONFIRM_MISMATCH_MESSAGE);
          setFormStatus({ type: '', text: '' });
          return;
        }
        if (response.status === 400 && msg === DING_CONFIRM_REQUIRED_MESSAGE) {
          setDingConfirmFieldError(DING_CONFIRM_REQUIRED_MESSAGE);
          setFormStatus({ type: '', text: '' });
          return;
        }
        setDingFieldError('');
        setDingConfirmFieldError('');
        setFormStatus({ type: 'error', text: msg });
        return;
      }
      if (data.success && typeof data.newDingNumber === 'string') {
        const next = data.newDingNumber.trim();
        setNewDingNumber(next);
        if (next) {
          sessionStorage.setItem('studentPortalNewDingNumber', next);
        }
      }
      setFormDing('');
      setFormDingConfirm('');
      setActiveDingPanel(null);
      setDingFieldError('');
      setDingConfirmFieldError('');
      setFormStatus({ type: 'success', text: 'Ding number updated.' });
    } catch {
      setFormStatus({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  const submitDingHelpRequest = async () => {
    if (!canUpdateDing) {
      return;
    }
    const phone = dingHelpPhone.trim();
    const note = dingHelpNote.trim();
    if (!phone && !note) {
      setDingHelpStatus({ type: 'error', text: PORTAL_DING_HELP_NEED_DETAIL_MESSAGE });
      return;
    }
    setDingHelpSubmitting(true);
    setDingHelpStatus({ type: '', text: '' });
    try {
      const response = await fetch('/api/portal-request-ding-help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: studentUserId,
          email: studentEmail,
          displayName: studentName.trim(),
          requestedPhone: phone,
          note,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setDingHelpStatus({
          type: 'error',
          text: data.error || 'Could not send request. Please try again.',
        });
        return;
      }
      setDingHelpStatus({
        type: 'success',
        text: 'Request sent. An administrator will review and update your Ding number if appropriate.',
      });
      setDingHelpPhone('');
      setDingHelpNote('');
    } catch {
      setDingHelpStatus({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setDingHelpSubmitting(false);
    }
  };

  if (sessionComplete && reviewerOnly) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content">
          <PortalSectionLinks
            current="reviews"
            isAdmin={showAdminFeatures}
            isReviewer={isReviewer}
            showEditDingLink={false}
          />
        </div>
      </PortalLayout>
    );
  }

  if (sessionComplete && !hasApplicantPortalAccess && !isReviewer) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content">
          {showAdminFeatures ? (
            <PortalSectionLinks
              current="profile"
              isAdmin={showAdminFeatures}
              showEditDingLink={false}
            />
          ) : null}
          <PortalComingSoonContent />
        </div>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="portal-card portal-content">
        <PortalSectionLinks
          current="profile"
          isAdmin={showAdminFeatures}
          isReviewer={readPortalIsReviewer()}
          showEditDingLink={!isApplicantProfile}
        />
        {!sessionComplete ? (
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">{t('profile.sessionIncompleteTitle')}</p>
            <p className="portal-session-banner-text">
              {t('profile.sessionIncompletePrefix')}{' '}
              <a href={portalHubHref()}>{t('profile.backToProfile')}</a>{' '}
              {t('profile.sessionIncompleteSuffix')}
            </p>
          </div>
        ) : null}

        {sessionComplete && isApplicantProfile ? (
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">{t('profile.applicantBlockedTitle')}</p>
            <p className="portal-session-banner-text">
              {t('profile.applicantBlockedPrefix')}{' '}
              <a href={portalHubHref()}>{t('profile.backToProfile')}</a>{' '}
              {t('profile.applicantBlockedSuffix')}
            </p>
          </div>
        ) : null}

        {canUpdateDing ? (
          <section className="portal-ding-section" aria-label="Your number on file">
            <p className="portal-ding">
              <span className="portal-ding-label">Your number</span>
              <span
                className={`portal-ding-value${newDingNumber.trim() ? '' : ' portal-ding-value-empty'}`}
              >
                {newDingNumber.trim() ? newDingNumber.trim() : 'Not set yet'}
              </span>
            </p>
            <div className="portal-ding-accordion" aria-label="Ding actions">
              <div className="portal-ding-accordion-item">
                <button
                  type="button"
                  role="tab"
                  id="ding-tab-update"
                  aria-selected={activeDingPanel === 'update'}
                  aria-controls="ding-panel-update"
                  aria-expanded={activeDingPanel === 'update'}
                  className={`portal-ding-tab${activeDingPanel === 'update' ? ' is-active' : ''}`}
                  onClick={() => toggleDingPanel('update')}
                >
                  <span className="portal-ding-tab-label">Update Ding number</span>
                  <span className="portal-ding-tab-chevron" aria-hidden="true">
                    {activeDingPanel === 'update' ? '▼' : '▶'}
                  </span>
                </button>
                {activeDingPanel === 'update' ? (
                  <div
                    id="ding-panel-update"
                    role="tabpanel"
                    aria-labelledby="ding-tab-update"
                    className="portal-ding-tab-panel"
                  >
                    <div className="portal-ding-form portal-ding-form--embedded">
                      <div className="form-group">
                        <label htmlFor="newDing">Ding number</label>
                        <input
                          id="newDing"
                          type="text"
                          inputMode="tel"
                          autoComplete="tel"
                          className={dingFieldError ? 'portal-input-invalid' : ''}
                          aria-invalid={!!dingFieldError}
                          aria-describedby={['newDing-hint', dingFieldError ? 'newDing-error' : '']
                            .filter(Boolean)
                            .join(' ')}
                          value={formDing}
                          onChange={(e) => {
                            const next = filterDingPhoneInputChars(e.target.value);
                            setFormDing(next);
                            const t = next.trim();
                            if (dingFieldError) {
                              setDingFieldError(
                                t && !isValidAfghanistanPhoneNumber(t)
                                  ? getAfghanistanPhoneFormatMessage(t)
                                  : '',
                              );
                            }
                            if (dingConfirmFieldError === DING_CONFIRM_MISMATCH_MESSAGE) {
                              setDingConfirmFieldError('');
                            }
                          }}
                          onBlur={() => {
                            const t = formDing.trim();
                            setDingFieldError(
                              t && !isValidAfghanistanPhoneNumber(t)
                                ? getAfghanistanPhoneFormatMessage(t)
                                : '',
                            );
                          }}
                          disabled={saving}
                          maxLength={24}
                          placeholder="e.g. 93701234567 or +93 70 123 4567"
                        />
                        <p id="newDing-hint" className="portal-field-hint">
                          {AFGHAN_PHONE_FORMAT_HINT}
                        </p>
                        {dingFieldError ? (
                          <p id="newDing-error" className="portal-field-error" role="alert">
                            {dingFieldError}
                          </p>
                        ) : null}
                      </div>
                      <div className="form-group">
                        <label htmlFor="newDingConfirm">Confirm Ding number</label>
                        <input
                          id="newDingConfirm"
                          type="text"
                          inputMode="tel"
                          autoComplete="off"
                          className={dingConfirmFieldError ? 'portal-input-invalid' : ''}
                          aria-invalid={!!dingConfirmFieldError}
                          aria-describedby={[
                            'newDingConfirm-hint',
                            dingConfirmFieldError ? 'newDingConfirm-error' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          value={formDingConfirm}
                          onChange={(e) => {
                            const next = filterDingPhoneInputChars(e.target.value);
                            setFormDingConfirm(next);
                            const t = next.trim();
                            if (!t) {
                              setDingConfirmFieldError('');
                              return;
                            }
                            if (dingConfirmFieldError === DING_CONFIRM_MISMATCH_MESSAGE) {
                              setDingConfirmFieldError('');
                              return;
                            }
                            if (dingConfirmFieldError === DING_CONFIRM_REQUIRED_MESSAGE) {
                              setDingConfirmFieldError('');
                              return;
                            }
                            if (isAfghanPhoneFormatErrorMessage(dingConfirmFieldError)) {
                              setDingConfirmFieldError(
                                isValidAfghanistanPhoneNumber(t) ? '' : getAfghanistanPhoneFormatMessage(t),
                              );
                            }
                          }}
                          onBlur={() => {
                            const t = formDingConfirm.trim();
                            if (!t) {
                              return;
                            }
                            if (!isValidAfghanistanPhoneNumber(t)) {
                              setDingConfirmFieldError(getAfghanistanPhoneFormatMessage(t));
                              return;
                            }
                            const na = normalizeAfghanistanPhoneDigits(formDing.trim());
                            const nb = normalizeAfghanistanPhoneDigits(t);
                            if (na && nb && na !== nb) {
                              setDingConfirmFieldError(DING_CONFIRM_MISMATCH_MESSAGE);
                            } else {
                              setDingConfirmFieldError((prev) =>
                                prev === DING_CONFIRM_MISMATCH_MESSAGE ? '' : prev,
                              );
                            }
                          }}
                          onPaste={(e) => {
                            e.preventDefault();
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                          }}
                          disabled={saving}
                          maxLength={24}
                          placeholder="Same number again"
                        />
                        <p id="newDingConfirm-hint" className="portal-field-hint">
                          Type the same number again by hand—paste is turned off here. Only digits, +,
                          spaces, and dashes are allowed.
                        </p>
                        {dingConfirmFieldError ? (
                          <p id="newDingConfirm-error" className="portal-field-error" role="alert">
                            {dingConfirmFieldError}
                          </p>
                        ) : null}
                      </div>
                      <div className="portal-ding-actions">
                        <button
                          type="button"
                          className="portal-ding-save"
                          onClick={submitDingUpdate}
                          disabled={saving}
                        >
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          className="portal-ding-cancel"
                          onClick={() => {
                            setActiveDingPanel(null);
                            setFormStatus({ type: '', text: '' });
                            setFormDing('');
                            setFormDingConfirm('');
                            setDingFieldError('');
                            setDingConfirmFieldError('');
                          }}
                          disabled={saving}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="portal-ding-accordion-item">
                <button
                  type="button"
                  role="tab"
                  id="ding-tab-history"
                  aria-selected={activeDingPanel === 'history'}
                  aria-controls="ding-panel-history"
                  aria-expanded={activeDingPanel === 'history'}
                  className={`portal-ding-tab${activeDingPanel === 'history' ? ' is-active' : ''}`}
                  onClick={() => toggleDingPanel('history')}
                >
                  <span className="portal-ding-tab-label">Ding number history</span>
                  <span className="portal-ding-tab-chevron" aria-hidden="true">
                    {activeDingPanel === 'history' ? '▼' : '▶'}
                  </span>
                </button>
                {activeDingPanel === 'history' ? (
                  <div
                    id="ding-panel-history"
                    role="tabpanel"
                    aria-labelledby="ding-tab-history"
                    className="portal-ding-tab-panel"
                  >
                    <div
                      className="portal-ding-history-panel portal-ding-history-panel--embedded"
                      role="region"
                      aria-label="Ding number change history"
                    >
                      {dingHistoryLoading ? (
                        <p className="portal-ding-history-status">Loading history…</p>
                      ) : null}
                      {dingHistoryError ? (
                        <p className="portal-field-error portal-ding-history-status" role="alert">
                          {dingHistoryError}
                        </p>
                      ) : null}
                      {!dingHistoryLoading && !dingHistoryError && dingHistoryEntries.length === 0 ? (
                        <p className="portal-field-hint portal-ding-history-status">
                          No Ding changes are recorded for your account yet.
                        </p>
                      ) : null}
                      {!dingHistoryLoading && dingHistoryEntries.length > 0 ? (
                        <div className="portal-ding-history-scroll">
                          <table className="portal-ding-history-table">
                            <thead>
                              <tr>
                                <th scope="col">Date &amp; time (your device)</th>
                                <th scope="col">Ding number</th>
                              </tr>
                            </thead>
                            <tbody>
                              {dingHistoryEntries.map((row, i) => (
                                <tr key={`${row.atMs}-${row.dingNumber}-${i}`}>
                                  <td>{formatPortalDingHistoryAt(row.atMs)}</td>
                                  <td className="portal-ding-history-num">{row.dingNumber}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="portal-ding-accordion-item">
                <button
                  type="button"
                  role="tab"
                  id="ding-tab-help"
                  aria-selected={activeDingPanel === 'help'}
                  aria-controls="ding-panel-help"
                  aria-expanded={activeDingPanel === 'help'}
                  className={`portal-ding-tab${activeDingPanel === 'help' ? ' is-active' : ''}`}
                  onClick={() => toggleDingPanel('help')}
                >
                  <span className="portal-ding-tab-label">Contact us (manual Ding update)</span>
                  <span className="portal-ding-tab-chevron" aria-hidden="true">
                    {activeDingPanel === 'help' ? '▼' : '▶'}
                  </span>
                </button>
                {activeDingPanel === 'help' ? (
                  <div
                    id="ding-panel-help"
                    role="tabpanel"
                    aria-labelledby="ding-tab-help"
                    className="portal-ding-tab-panel portal-ding-tab-panel--help"
                  >
                    <p className="portal-ding-help-intro portal-ding-help-intro--embedded">
                      If you cannot submit an Afghanistan Ding number here—for example you use a Pakistani or
                      other non-Afghan number—ask us to update it manually.
                    </p>
                    <div className="form-group">
                      <label htmlFor="dingHelpPhone">Phone number you need for Ding</label>
                      <input
                        id="dingHelpPhone"
                        type="text"
                        inputMode="tel"
                        autoComplete="tel"
                        value={dingHelpPhone}
                        onChange={(e) => setDingHelpPhone(e.target.value.slice(0, 96))}
                        disabled={dingHelpSubmitting}
                        placeholder="e.g. +92 300 1234567"
                        maxLength={96}
                      />
                      <p className="portal-field-hint">
                        Include country code if applicable. This field accepts international formats.
                      </p>
                    </div>
                    <div className="form-group">
                      <label htmlFor="dingHelpNote">Anything else we should know (optional)</label>
                      <textarea
                        id="dingHelpNote"
                        rows={4}
                        value={dingHelpNote}
                        onChange={(e) => setDingHelpNote(e.target.value.slice(0, 2000))}
                        disabled={dingHelpSubmitting}
                        maxLength={2000}
                      />
                    </div>
                    <div className="portal-ding-help-actions">
                      <button
                        type="button"
                        className="portal-ding-save"
                        onClick={submitDingHelpRequest}
                        disabled={dingHelpSubmitting}
                      >
                        {dingHelpSubmitting ? 'Sending…' : 'Send request'}
                      </button>
                      <button
                        type="button"
                        className="portal-ding-cancel"
                        onClick={() => {
                          setActiveDingPanel(null);
                          setDingHelpPhone('');
                          setDingHelpNote('');
                          setDingHelpStatus({ type: '', text: '' });
                        }}
                        disabled={dingHelpSubmitting}
                      >
                        Close
                      </button>
                    </div>
                    {dingHelpStatus.text ? (
                      <p
                        className={`portal-ding-help-feedback ${dingHelpStatus.type || ''}`}
                        role={dingHelpStatus.type === 'error' ? 'alert' : 'status'}
                      >
                        {dingHelpStatus.text}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {formStatus.text ? (
              <p className={`portal-ding-form-status ${formStatus.type || ''}`}>{formStatus.text}</p>
            ) : null}
          </section>
        ) : null}
      </div>
    </PortalLayout>
  );
}

function AppRouter() {
  if (window.location.pathname === '/verify.html') {
    return <VerifyMagicLinkApp />;
  }

  if (shouldMountPortalSpa()) {
    return <PortalShellApp />;
  }

  return <RequestMagicLinkApp />;
}

if (typeof window !== 'undefined') {
  ensurePortalSessionReady();
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<AppRouter />);
}
