import React, { useEffect, useMemo, useState } from 'react';
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
import './styles.css';

function isPortalHostname() {
  if (typeof window === 'undefined') return false;
  return window.location.hostname.toLowerCase().startsWith('portal.');
}

function getPortalRouteSegment() {
  const { pathname } = window.location;
  if (pathname === '/portal.html') return 'hub';
  if (pathname === '/' && isPortalHostname()) return 'hub';
  if (pathname === '/profile' || pathname.startsWith('/profile/')) return 'profile';
  if (pathname === '/faq' || pathname.startsWith('/faq/')) return 'faq';
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
    p.startsWith('/profile/') ||
    p.startsWith('/faq/');
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

/** Keys written when a student completes magic-link verification */
const PORTAL_SESSION_STORAGE_KEYS = [
  'studentPortalName',
  'studentPortalEmail',
  'studentPortalNewDingNumber',
  'studentPortalUserId',
  'studentPortalPhone',
  'studentPortalClass',
  'studentPortalGrade',
  'studentPortalIsTeacher',
  'studentPortalTeacherClasses',
];

const PORTAL_IDLE_LOGOUT_MS = 10 * 60 * 1000;

/** Dedupe concurrent class/grade fetches (header + hub both mount). */
let portalClassGradeInFlight = null;

async function loadPortalClassGradeFromApi() {
  if (typeof window === 'undefined' || !isPortalSessionCompleteSync()) {
    return Promise.resolve({
      classSection: '',
      calculatedGrade: '',
      isTeacher: false,
      teacherClasses: '',
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
        return { classSection: '', calculatedGrade: '', isTeacher: false, teacherClasses: '' };
      }
      const response = await fetch('/api/portal-class-grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, email }),
      });
      const data = await response.json();
      if (!data.success) {
        return { classSection: '', calculatedGrade: '', isTeacher: false, teacherClasses: '' };
      }
      const classSection = typeof data.classSection === 'string' ? data.classSection.trim() : '';
      const calculatedGrade =
        typeof data.calculatedGrade === 'string' ? data.calculatedGrade.trim() : '';
      const isTeacher = data.isTeacher === true;
      const teacherClasses =
        typeof data.teacherClasses === 'string' ? data.teacherClasses.trim() : '';
      sessionStorage.setItem('studentPortalClass', classSection);
      sessionStorage.setItem('studentPortalGrade', calculatedGrade);
      if (isTeacher) {
        sessionStorage.setItem('studentPortalIsTeacher', '1');
      } else {
        sessionStorage.removeItem('studentPortalIsTeacher');
      }
      if (teacherClasses) {
        sessionStorage.setItem('studentPortalTeacherClasses', teacherClasses);
      } else {
        sessionStorage.removeItem('studentPortalTeacherClasses');
      }
      return { classSection, calculatedGrade, isTeacher, teacherClasses };
    } catch {
      return { classSection: '', calculatedGrade: '', isTeacher: false, teacherClasses: '' };
    } finally {
      portalClassGradeInFlight = null;
    }
  })();
  return portalClassGradeInFlight;
}

function usePortalClassGrade() {
  const [studentClass, setStudentClass] = useState(() => readSessionField('studentPortalClass'));
  const [studentGrade, setStudentGrade] = useState(() => readSessionField('studentPortalGrade'));
  const [isTeacher, setIsTeacher] = useState(() => readSessionField('studentPortalIsTeacher') === '1');
  const [teacherClasses, setTeacherClasses] = useState(() => readSessionField('studentPortalTeacherClasses'));

  useEffect(() => {
    let cancelled = false;
    loadPortalClassGradeFromApi().then(
      ({ classSection, calculatedGrade, isTeacher: tchr, teacherClasses: teach }) => {
        if (cancelled) return;
        setStudentClass(classSection);
        setStudentGrade(calculatedGrade);
        setIsTeacher(tchr);
        setTeacherClasses(teach);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { studentClass, studentGrade, isTeacher, teacherClasses };
}

/**
 * Fetch a teacher's live per-class roster (students + grades). Only runs when
 * `isTeacher` is true and a portal session exists. Returns loading/error state
 * so the hub can render placeholders.
 */
function useTeacherRoster(isTeacher) {
  const [state, setState] = useState({ status: 'idle', classes: [], error: '' });

  useEffect(() => {
    if (!isTeacher || !isPortalSessionCompleteSync()) {
      setState({ status: 'idle', classes: [], error: '' });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading', classes: [], error: '' });
    (async () => {
      try {
        const userId = readSessionField('studentPortalUserId');
        const email = readSessionField('studentPortalEmail');
        const response = await fetch('/api/portal-teacher-roster', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, email }),
        });
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok || !data.success) {
          setState({
            status: 'error',
            classes: [],
            error: (data && data.error) || 'Could not load your class roster.',
          });
          return;
        }
        setState({ status: 'ready', classes: Array.isArray(data.classes) ? data.classes : [], error: '' });
      } catch {
        if (!cancelled) {
          setState({ status: 'error', classes: [], error: 'Could not load your class roster.' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isTeacher]);

  return state;
}

function PortalTeacherRoster({ isTeacher }) {
  const { status, classes, error } = useTeacherRoster(isTeacher);

  if (!isTeacher) {
    return null;
  }

  return (
    <section className="portal-roster" aria-label="Your classes">
      <h3 className="portal-roster-heading">Your classes</h3>
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
      {status === 'ready'
        ? classes.map((cls) => (
            <div className="portal-roster-class" key={cls.label}>
              <div className="portal-roster-class-head">
                <span className="portal-roster-class-name">{cls.label}</span>
                <span className="portal-roster-class-count">
                  {cls.students.length} {cls.students.length === 1 ? 'student' : 'students'}
                </span>
              </div>
              {cls.students.length > 0 ? (
                <table className="portal-roster-table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Email</th>
                      <th scope="col">Grade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cls.students.map((s) => (
                      <tr key={s.email}>
                        <td>{s.name || '—'}</td>
                        <td className="portal-roster-email">{s.email}</td>
                        <td className="portal-roster-grade">{s.grade || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="portal-roster-status">No students enrolled yet.</p>
              )}
            </div>
          ))
        : null}
    </section>
  );
}

function clearPortalSession() {
  if (typeof sessionStorage === 'undefined') return;
  PORTAL_SESSION_STORAGE_KEYS.forEach((key) => sessionStorage.removeItem(key));
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
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState({ type: '', text: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = useMemo(() => userId.trim().length > 0 && !isSubmitting, [userId, isSubmitting]);

  const requestMagicLink = async () => {
    const trimmedUserId = userId.trim();

    if (!trimmedUserId || trimmedUserId.length > 100) {
      setStatus({ type: 'error', text: 'Please enter a valid ID.' });
      return;
    }

    setStatus({ type: 'loading', text: 'Checking ID and sending magic link...' });
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/request-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: trimmedUserId }),
      });

      const data = await response.json();

      if (!response.ok) {
        const errText =
          response.status >= 500
            ? data.error || 'Internal error. Please try again.'
            : data.error || data.message || 'Request failed.';
        setStatus({ type: 'error', text: errText });
        return;
      }

      if (data.success === false) {
        setStatus({
          type: 'error',
          text: data.message || 'Your ID is invalid. Please enter a correct ID.',
        });
        return;
      }

      setStatus({
        type: 'success',
        text:
          data.message ||
          'Your ID is valid. A magic link has been sent to your registered email.',
      });
    } catch {
      setStatus({ type: 'error', text: 'Internal error. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="magic-link-request-inner">
      <div className="form-group">
        <label htmlFor={inputId}>AESOP ID</label>
        <input
          type="text"
          id={inputId}
          name="userId"
          required
          autoComplete="username"
          placeholder="Enter your ID"
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          disabled={isSubmitting}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              requestMagicLink();
            }
          }}
        />
      </div>
      <button type="button" onClick={requestMagicLink} disabled={!canSubmit}>
        {submitLabel}
      </button>
      <div className={`status ${status.type || ''}`} aria-live="polite">
        {status.text}
      </div>
    </div>
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
      <p className="subtitle">Enter your AESOP ID to receive a magic link</p>
      <MagicLinkRequestForm inputId="userId" submitLabel="Send Magic Link" />
    </div>
  );
}

function VerifyMagicLinkApp() {
  const [status, setStatus] = useState('Verifying magic link...');
  const [message, setMessage] = useState({ type: '', text: '' });
  const [showSpinner, setShowSpinner] = useState(true);

  useEffect(() => {
    const runVerification = async () => {
      const token = new URLSearchParams(window.location.search).get('token');

      if (!token) {
        setStatus('Invalid Link');
        setShowSpinner(false);
        setMessage({ type: 'error', text: 'No token provided. Please check your email link.' });
        return;
      }

      if (!/^[a-f0-9]{64}$/i.test(token)) {
        setStatus('Invalid Link');
        setShowSpinner(false);
        setMessage({ type: 'error', text: 'Invalid token format.' });
        return;
      }

      try {
        const response = await fetch('/api/verify-magic-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const data = await response.json();
        setShowSpinner(false);

        if (data.success) {
          setStatus('Success!');
          setMessage({ type: 'success', text: 'Magic link verified successfully. Redirecting...' });
          const nameFromApi = typeof data.name === 'string' ? data.name.trim() : '';
          const emailFromApi = typeof data.email === 'string' ? data.email.trim() : '';
          const dingFromApi =
            typeof data.newDingNumber === 'string' ? data.newDingNumber.trim() : '';
          const userIdFromApi = typeof data.userId === 'string' ? data.userId.trim() : '';
          const phoneFromApi = typeof data.phone === 'string' ? data.phone.trim() : '';
          const classFromApi = typeof data.classSection === 'string' ? data.classSection.trim() : '';
          const gradeFromApi =
            typeof data.calculatedGrade === 'string' ? data.calculatedGrade.trim() : '';
          const isTeacherFromApi = data.isTeacher === true;
          const teachingFromApi =
            typeof data.teacherClasses === 'string' ? data.teacherClasses.trim() : '';
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
          if (isTeacherFromApi) {
            sessionStorage.setItem('studentPortalIsTeacher', '1');
          } else {
            sessionStorage.removeItem('studentPortalIsTeacher');
          }
          if (teachingFromApi) {
            sessionStorage.setItem('studentPortalTeacherClasses', teachingFromApi);
          } else {
            sessionStorage.removeItem('studentPortalTeacherClasses');
          }
          window.setTimeout(() => {
            const hub =
              window.location.hostname.toLowerCase().startsWith('portal.') ? '/' : '/portal.html';
            window.location.assign(hub);
          }, 600);
          return;
        }

        setStatus('Verification Failed');
        setMessage({ type: 'error', text: data.error || 'Invalid or expired magic link.' });
      } catch (error) {
        setShowSpinner(false);
        setStatus('Error');
        setMessage({ type: 'error', text: 'An error occurred verifying the link. Please try again.' });
      }
    };

    runVerification();
  }, []);

  return (
    <div className="container verify-container">
      {showSpinner ? <div className="spinner" /> : null}
      <h2>{status}</h2>
      <div className={`message ${message.type || ''}`}>{message.text}</div>
    </div>
  );
}

/**
 * Role pill adapted from the AESOP Dashboard's RoleNav badge. Shows Teacher or
 * Student only when the role is known (from the Classroom sync / sheets).
 */
function PortalRoleBadge({ isTeacher, hasStudentCategory, className }) {
  if (!isTeacher && !hasStudentCategory) {
    return null;
  }
  const variant = isTeacher ? 'portal-role-badge--teacher' : 'portal-role-badge--student';
  const classes = ['portal-role-badge', variant, className].filter(Boolean).join(' ');
  return <span className={classes}>{isTeacher ? 'Teacher' : 'Student'}</span>;
}

function PortalLayout({ children }) {
  const portalHomeHref = portalHubHref();
  const signedIn = isPortalSessionCompleteSync();
  const fullName = readSessionField('studentPortalName').trim();
  const aesopId = readSessionField('studentPortalUserId').trim();
  const headerEmail = readSessionField('studentPortalEmail').trim();
  const { studentClass, studentGrade, isTeacher, teacherClasses } = usePortalClassGrade();

  const dash = '—';
  const fullNameDisplay = fullName || dash;
  const classDisplay = studentClass.trim() || dash;
  const gradeDisplay = studentGrade.trim() || dash;
  const teachingDisplay = teacherClasses.trim() || dash;
  const hasStudentCategory =
    !isTeacher &&
    aesopId.trim() !== '' &&
    studentClass.trim() !== '' &&
    studentGrade.trim() !== '';
  const categoryDisplay = isTeacher ? 'Teacher' : hasStudentCategory ? 'Student' : dash;

  return (
    <div className="portal-page">
      <header className="portal-header">
        <div className="portal-header-inner">
          <div className="portal-header-col portal-header-col--brand">
            <div className="portal-header-brand">
              <span className="portal-header-brand-accent" aria-hidden="true" />
              <div className="portal-header-brand-text">
                <p className="portal-header-kicker">AESOP Afghanistan</p>
                <h1 className="portal-header-title">Student Portal</h1>
                <p className="portal-header-tagline">
                  <span className="portal-header-tagline-part">Education</span>
                  <span className="portal-header-tagline-dot" aria-hidden="true">
                    ·
                  </span>
                  <span className="portal-header-tagline-part">Service</span>
                  <span className="portal-header-tagline-dot" aria-hidden="true">
                    ·
                  </span>
                  <span className="portal-header-tagline-part">Community</span>
                </p>
              </div>
            </div>
          </div>
          <div className="portal-header-col portal-header-col--logo">
            <a href={portalHomeHref} className="portal-header-logo-link" aria-label="AESOP Afghanistan Student Portal — home">
              <img
                className="portal-logo portal-logo--header-center"
                src="/images/aesop-logo.webp"
                width={280}
                height={80}
                alt=""
                decoding="async"
              />
            </a>
          </div>
          <div className="portal-header-col portal-header-col--student">
            {signedIn ? (
              <div className="portal-header-student-wrap">
                <dl className="portal-header-id-meta" aria-label="Your profile">
                  <dt className="portal-header-id-label">Full name</dt>
                  <dd className="portal-header-id-value">{fullNameDisplay}</dd>
                  <dt className="portal-header-id-label">AESOP ID</dt>
                  <dd className="portal-header-id-value portal-header-id-mono">{aesopId || dash}</dd>
                  <dt className="portal-header-id-label">Email</dt>
                  <dd className="portal-header-id-value portal-header-id-email">{headerEmail || dash}</dd>
                  <dt className="portal-header-id-label">Class</dt>
                  <dd className="portal-header-id-value">{classDisplay}</dd>
                  <dt className="portal-header-id-label">Grade</dt>
                  <dd className="portal-header-id-value">{gradeDisplay}</dd>
                  <dt className="portal-header-id-label">Teaching</dt>
                  <dd className="portal-header-id-value">{teachingDisplay}</dd>
                  <dt className="portal-header-id-label">Category</dt>
                  <dd className="portal-header-id-value">
                    {isTeacher || hasStudentCategory ? (
                      <PortalRoleBadge isTeacher={isTeacher} hasStudentCategory={hasStudentCategory} />
                    ) : (
                      categoryDisplay
                    )}
                  </dd>
                </dl>
                <button type="button" className="portal-header-logout" onClick={() => logOutPortalClient()}>
                  Log off
                </button>
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

function PortalSectionLinks({ current }) {
  const hubHref = portalHubHref();
  return (
    <nav className="portal-section-links" aria-label="Portal navigation">
      <a href={hubHref} className={current === 'hub' ? 'is-current' : undefined}>
        Profile
      </a>
      <span className="portal-section-links-sep" aria-hidden="true">
        ·
      </span>
      <a href="/profile" className={current === 'profile' ? 'is-current' : undefined}>
        Edit Ding
      </a>
      <span className="portal-section-links-sep" aria-hidden="true">
        ·
      </span>
      <a href="/faq" className={current === 'faq' ? 'is-current' : undefined}>
        FAQ
      </a>
    </nav>
  );
}

function usePortalStudentRecord() {
  const [studentName] = useState(() => readSessionField('studentPortalName'));
  const [studentEmail] = useState(() => readSessionField('studentPortalEmail'));
  const [studentUserId] = useState(() => readSessionField('studentPortalUserId'));
  const [studentPhone] = useState(() => readSessionField('studentPortalPhone'));
  const [newDingNumber, setNewDingNumber] = useState(() => readSessionField('studentPortalNewDingNumber'));

  const canUpdateDing = studentUserId.length > 0 && studentEmail.length > 0;
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

function PortalIntentNotice({ intent }) {
  if (intent !== 'profile' && intent !== 'faq') return null;
  const title = intent === 'profile' ? 'Edit Ding' : 'FAQs';
  return (
    <div className="portal-intent-banner" role="status">
      <p className="portal-intent-banner-title">
        {intent === 'profile' ? 'Sign in to manage your Ding number' : 'Sign in for account-specific help'}
      </p>
      <p className="portal-intent-banner-text">
        You opened a link related to <strong>{title}</strong>.{' '}
        <a href="#portal-magic-link-form" className="portal-intent-inline-link">
          Request a magic link
        </a>{' '}
        with your AESOP ID—we&apos;ll email you a one-time link. The{' '}
        <a href="/faq" className="portal-intent-inline-link">
          FAQs page
        </a>{' '}
        does not require signing in.
      </p>
    </div>
  );
}

function PortalHubPage() {
  const { studentName, studentUserId, studentEmail, studentPhone, newDingNumber } = usePortalStudentRecord();
  const { studentClass, studentGrade, isTeacher, teacherClasses } = usePortalClassGrade();
  const signedIn = isPortalSessionCompleteSync();
  const hasStudentCategory =
    !isTeacher &&
    studentUserId.trim() !== '' &&
    studentClass.trim() !== '' &&
    studentGrade.trim() !== '';
  const intent = typeof window !== 'undefined' ? getPortalUrlIntent() : '';
  const [aboutPortalOpenSignedIn, setAboutPortalOpenSignedIn] = useState(false);
  const [aboutPortalOpenSignout, setAboutPortalOpenSignout] = useState(false);

  useEffect(() => {
    if (!signedIn && intent) {
      document.getElementById('portal-magic-link-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [signedIn, intent]);

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-hub-card">
        {signedIn ? (
          <>
            <PortalSectionLinks current="hub" />
            <h2 className="portal-welcome">
              {`Welcome, ${studentName || 'Student'}!`}
              <PortalRoleBadge
                isTeacher={isTeacher}
                hasStudentCategory={hasStudentCategory}
                className="portal-welcome-role"
              />
            </h2>
            <dl className="portal-hub-meta portal-hub-meta-panel" aria-label="Your account">
              <div className="portal-hub-meta-row">
                <dt className="portal-hub-meta-label">AESOP ID</dt>
                <dd className="portal-hub-meta-value portal-hub-meta-mono">{studentUserId || '—'}</dd>
              </div>
              <div className="portal-hub-meta-row">
                <dt className="portal-hub-meta-label">Email</dt>
                <dd className="portal-hub-meta-value">{studentEmail || '—'}</dd>
              </div>
              <div className="portal-hub-meta-row">
                <dt className="portal-hub-meta-label">Ding number</dt>
                <dd
                  className={`portal-hub-meta-value portal-hub-meta-mono${newDingNumber.trim() ? '' : ' portal-hub-meta-empty'}`}
                >
                  {newDingNumber.trim() ? newDingNumber.trim() : 'Not set yet'}
                </dd>
              </div>
              <div className="portal-hub-meta-row">
                <dt className="portal-hub-meta-label">Class</dt>
                <dd className={`portal-hub-meta-value${studentClass.trim() ? '' : ' portal-hub-meta-empty'}`}>
                  {studentClass.trim() || '—'}
                </dd>
              </div>
              <div className="portal-hub-meta-row">
                <dt className="portal-hub-meta-label">Grade</dt>
                <dd className={`portal-hub-meta-value${studentGrade.trim() ? '' : ' portal-hub-meta-empty'}`}>
                  {studentGrade.trim() || '—'}
                </dd>
              </div>
              <div className="portal-hub-meta-row">
                <dt className="portal-hub-meta-label">Teaching</dt>
                <dd
                  className={`portal-hub-meta-value${teacherClasses.trim() ? '' : ' portal-hub-meta-empty'}`}
                >
                  {teacherClasses.trim() || '—'}
                </dd>
              </div>
              <div className="portal-hub-meta-row">
                <dt className="portal-hub-meta-label">Category</dt>
                <dd
                  className={`portal-hub-meta-value${
                    isTeacher || hasStudentCategory ? '' : ' portal-hub-meta-empty'
                  }`}
                >
                  {isTeacher || hasStudentCategory ? (
                    <PortalRoleBadge isTeacher={isTeacher} hasStudentCategory={hasStudentCategory} />
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              {studentPhone ? (
                <div className="portal-hub-meta-row">
                  <dt className="portal-hub-meta-label">Phone on file</dt>
                  <dd className="portal-hub-meta-value">{studentPhone}</dd>
                </div>
              ) : null}
            </dl>
            <PortalTeacherRoster isTeacher={isTeacher} />
            <section className="portal-hub-purpose portal-hub-purpose-collapsible" aria-label="About this portal">
              <button
                type="button"
                className="portal-hub-purpose-toggle"
                id="portal-hub-purpose-heading"
                aria-expanded={aboutPortalOpenSignedIn}
                aria-controls="portal-hub-purpose-signedin-panel"
                onClick={() => setAboutPortalOpenSignedIn((open) => !open)}
              >
                <span className="portal-hub-purpose-heading">About this portal</span>
                <span className="portal-hub-purpose-chevron" aria-hidden="true">
                  {aboutPortalOpenSignedIn ? '▼' : '▶'}
                </span>
              </button>
              <div
                id="portal-hub-purpose-signedin-panel"
                className="portal-hub-purpose-panel"
                hidden={!aboutPortalOpenSignedIn}
              >
                <p className="portal-hub-purpose-text">
                  This secure student portal is where you sign in with a magic link—there is no password to remember on this
                  site. Use it to update your Afghanistan <strong>Ding</strong> phone number when it changes (with
                  confirmation), review past Ding updates, request help if you need a non-Afghan number for Ding, and read{' '}
                  <a href="/faq">frequently asked questions</a>. Your AESOP ID, email, and Ding number above summarize what
                  we have on file—open <a href="/profile">Edit Ding</a> to change your Ding number.
                </p>
              </div>
            </section>
          </>
        ) : (
          <>
            <PortalIntentNotice intent={intent} />
            <PortalSectionLinks current="hub" />
            <h2 className="portal-welcome portal-welcome-signout">Student Portal</h2>
            <div id="portal-magic-link-form" className="portal-signin-panel">
              <h3 className="portal-signin-heading">Connect with your AESOP ID</h3>
              <p className="portal-signin-lead">
                Enter the student ID AESOP gave you. We&apos;ll email a magic link; open it on this device to finish signing
                in.
              </p>
              <MagicLinkRequestForm inputId="portalMagicUserId" submitLabel="Email me a magic link" />
            </div>
            <section className="portal-hub-purpose portal-hub-purpose-collapsible" aria-label="About this portal">
              <button
                type="button"
                className="portal-hub-purpose-toggle"
                id="portal-hub-purpose-signout-toggle"
                aria-expanded={aboutPortalOpenSignout}
                aria-controls="portal-hub-purpose-signout-panel"
                onClick={() => setAboutPortalOpenSignout((open) => !open)}
              >
                <span className="portal-hub-purpose-heading">About this portal</span>
                <span className="portal-hub-purpose-chevron" aria-hidden="true">
                  {aboutPortalOpenSignout ? '▼' : '▶'}
                </span>
              </button>
              <div
                id="portal-hub-purpose-signout-panel"
                className="portal-hub-purpose-panel"
                hidden={!aboutPortalOpenSignout}
              >
                <p className="portal-hub-purpose-text">
                  The AESOP Student Portal helps you update your Afghanistan <strong>Ding</strong> number, see Ding number
                  history after you sign in, and read <a href="/faq">FAQs</a>—using a magic link, not a password on this site.
                </p>
                <p className="portal-hub-purpose-text">
                  Portal sections: <a href={portalHubHref()}>Profile</a>, <a href="/profile">Edit Ding</a>, and{' '}
                  <a href="/faq">FAQ</a>. Not connected?{' '}
                  <a href="#portal-magic-link-form" className="portal-intent-inline-link">
                    Request a magic link
                  </a>{' '}
                  above with your AESOP ID.
                </p>
              </div>
            </section>
            <p className="portal-hub-footnote">
              Prefer the main site?{' '}
              <a href="https://aesopafghanistan.org/">aesopafghanistan.org</a>
            </p>
          </>
        )}
      </div>
    </PortalLayout>
  );
}

function PortalGuestProfilePage() {
  const intent = typeof window !== 'undefined' ? getPortalUrlIntent() : '';

  useEffect(() => {
    if (intent === 'profile') {
      document.getElementById('portal-magic-link-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [intent]);

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-hub-card">
        <PortalSectionLinks current="profile" />
        {intent === 'profile' ? <PortalIntentNotice intent="profile" /> : null}
        <p className="portal-hub-intro">
          Sign in with your magic link to update your Afghanistan Ding number, view history, or request help with a
          non-Afghan number.
        </p>
        <div id="portal-magic-link-form" className="portal-signin-panel">
          <h3 className="portal-signin-heading">Connect with your AESOP ID</h3>
          <p className="portal-signin-lead">
            Enter the student ID AESOP gave you. We&apos;ll email a magic link; open it on this device to finish signing in.
          </p>
          <MagicLinkRequestForm inputId="portalMagicUserIdProfile" submitLabel="Email me a magic link" />
        </div>
        <p className="portal-hub-footnote">
          <a href="/faq">Read FAQs</a>
          <span className="portal-footer-sep" aria-hidden="true">
            {' '}
            ·{' '}
          </span>
          <a href="https://aesopafghanistan.org/">aesopafghanistan.org</a>
        </p>
      </div>
    </PortalLayout>
  );
}

function PortalFaqPage() {
  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-faq-card">
        <PortalSectionLinks current="faq" />
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

function PortalShellApp() {
  useEffect(() => {
    document.body.classList.add('portal-body');
    return () => document.body.classList.remove('portal-body');
  }, []);

  const segment = getPortalRouteSegment();
  const signedIn = isPortalSessionCompleteSync();

  useEffect(() => {
    if (!signedIn) {
      return undefined;
    }

    let timeoutId = 0;

    const resetIdleTimer = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        clearPortalSession();
        window.location.assign(portalHubHref());
      }, PORTAL_IDLE_LOGOUT_MS);
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

  if (segment === 'faq') {
    return <PortalFaqPage />;
  }
  if (segment === 'profile') {
    if (signedIn) {
      return <PortalProfilePage />;
    }
    return <PortalGuestProfilePage />;
  }
  return <PortalHubPage />;
}

function PortalProfilePage() {
  const {
    studentName,
    studentEmail,
    studentUserId,
    studentPhone,
    newDingNumber,
    setNewDingNumber,
    canUpdateDing,
  } = usePortalStudentRecord();

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
    (async () => {
      try {
        const response = await fetch('/api/portal-ding-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: studentUserId, email: studentEmail }),
        });
        const data = await response.json();
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setDingHistoryError(data.error || 'Could not load history.');
          setDingHistoryEntries([]);
          return;
        }
        setDingHistoryEntries(Array.isArray(data.entries) ? data.entries : []);
      } catch {
        if (!cancelled) {
          setDingHistoryError('Network error. Please try again.');
          setDingHistoryEntries([]);
        }
      } finally {
        if (!cancelled) {
          setDingHistoryLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeDingPanel, canUpdateDing, studentUserId, studentEmail]);

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

  return (
    <PortalLayout>
      <div className="portal-card portal-content">
        <PortalSectionLinks current="profile" />
        {!canUpdateDing ? (
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">Session incomplete</p>
            <p className="portal-session-banner-text">
              Go back to{' '}
              <a href={portalHubHref()}>Profile</a> and connect with your AESOP ID so we can load your account.
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

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<AppRouter />);
}
