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
  'studentPortalIsAdmin',
];

const PORTAL_IDLE_LOGOUT_MS = 10 * 60 * 1000;

/** Dedupe concurrent class/grade fetches (header + hub both mount). */
let portalClassGradeInFlight = null;

async function adminApiPost(path, body = {}) {
  const userId = readSessionField('studentPortalUserId');
  const email = readSessionField('studentPortalEmail');
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, email, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error((data && data.error) || 'Request failed.');
  }
  return data;
}

async function loadPortalClassGradeFromApi() {
  if (typeof window === 'undefined' || !isPortalSessionCompleteSync()) {
    return Promise.resolve({
      classSection: '',
      calculatedGrade: '',
      isTeacher: false,
      teacherClasses: '',
      isAdmin: false,
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
        return { classSection: '', calculatedGrade: '', isTeacher: false, teacherClasses: '', isAdmin: false };
      }
      const response = await fetch('/api/portal-class-grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, email }),
      });
      const data = await response.json();
      if (!data.success) {
        return { classSection: '', calculatedGrade: '', isTeacher: false, teacherClasses: '', isAdmin: false };
      }
      const classSection = typeof data.classSection === 'string' ? data.classSection.trim() : '';
      const calculatedGrade =
        typeof data.calculatedGrade === 'string' ? data.calculatedGrade.trim() : '';
      const isTeacher = data.isTeacher === true;
      const isAdmin = data.isAdmin === true;
      const teacherClasses =
        typeof data.teacherClasses === 'string' ? data.teacherClasses.trim() : '';
      sessionStorage.setItem('studentPortalClass', classSection);
      sessionStorage.setItem('studentPortalGrade', calculatedGrade);
      if (isTeacher) {
        sessionStorage.setItem('studentPortalIsTeacher', '1');
      } else {
        sessionStorage.removeItem('studentPortalIsTeacher');
      }
      if (isAdmin) {
        sessionStorage.setItem('studentPortalIsAdmin', '1');
      } else {
        sessionStorage.removeItem('studentPortalIsAdmin');
      }
      if (teacherClasses) {
        sessionStorage.setItem('studentPortalTeacherClasses', teacherClasses);
      } else {
        sessionStorage.removeItem('studentPortalTeacherClasses');
      }
      return { classSection, calculatedGrade, isTeacher, teacherClasses, isAdmin };
    } catch {
      return { classSection: '', calculatedGrade: '', isTeacher: false, teacherClasses: '', isAdmin: false };
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

  const [isAdmin, setIsAdmin] = useState(() => readSessionField('studentPortalIsAdmin') === '1');

  useEffect(() => {
    let cancelled = false;
    loadPortalClassGradeFromApi().then(
      ({ classSection, calculatedGrade, isTeacher: tchr, teacherClasses: teach, isAdmin: adm }) => {
        if (cancelled) return;
        setStudentClass(classSection);
        setStudentGrade(calculatedGrade);
        setIsTeacher(tchr);
        setTeacherClasses(teach);
        setIsAdmin(adm);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { studentClass, studentGrade, isTeacher, teacherClasses, isAdmin };
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
  }, [rosterEnabled]);

  return state;
}

async function downloadAdminDingConnectCsv() {
  const userId = readSessionField('studentPortalUserId');
  const email = readSessionField('studentPortalEmail');
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
  const haystack = [student.name, student.email, student.userId]
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
    (async () => {
      try {
        const userId = readSessionField('studentPortalUserId');
        const email = readSessionField('studentPortalEmail');
        const response = await fetch('/api/portal-student-grades', {
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
            error: (data && data.error) || 'Could not load your grades.',
          });
          return;
        }
        setState({
          status: 'ready',
          classes: Array.isArray(data.classes) ? data.classes : [],
          error: '',
        });
      } catch {
        if (!cancelled) {
          setState({ status: 'error', classes: [], error: 'Could not load your grades.' });
        }
      }
    })();
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
          const isAdminFromApi = data.isAdmin === true;
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
          if (isAdminFromApi) {
            sessionStorage.setItem('studentPortalIsAdmin', '1');
          } else {
            sessionStorage.removeItem('studentPortalIsAdmin');
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
function PortalRoleBadge({ isTeacher, hasStudentCategory, isAdmin, className }) {
  if (isAdmin) {
    const classes = ['portal-role-badge', 'portal-role-badge--admin', className].filter(Boolean).join(' ');
    return <span className={classes}>Admin</span>;
  }
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
  const { studentClass, studentGrade, isTeacher, teacherClasses, isAdmin } = usePortalClassGrade();

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
                    {isTeacher || hasStudentCategory || isAdmin ? (
                      <PortalRoleBadge
                        isTeacher={isTeacher}
                        hasStudentCategory={hasStudentCategory}
                        isAdmin={isAdmin}
                      />
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

function PortalSectionLinks({ current, isAdmin }) {
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
      {isAdmin ? (
        <>
          <span className="portal-section-links-sep" aria-hidden="true">
            ·
          </span>
          <a href="/admin" className={current === 'admin' ? 'is-current' : undefined}>
            Admin
          </a>
        </>
      ) : null}
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
  const { studentClass, studentGrade, isTeacher, teacherClasses, isAdmin } = usePortalClassGrade();
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
            <PortalSectionLinks current="hub" isAdmin={isAdmin} />
            <h2 className="portal-welcome">
              {`Welcome, ${studentName || 'Student'}!`}
              <PortalRoleBadge
                isTeacher={isTeacher}
                hasStudentCategory={hasStudentCategory}
                isAdmin={isAdmin}
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
                  {isTeacher || hasStudentCategory || isAdmin ? (
                    <PortalRoleBadge
                      isTeacher={isTeacher}
                      hasStudentCategory={hasStudentCategory}
                      isAdmin={isAdmin}
                    />
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
            {isTeacher || isAdmin ? (
              <PortalTeacherRoster
                rosterEnabled={isTeacher || isAdmin}
                isAdminView={isAdmin && !isTeacher}
              />
            ) : null}
            {!isTeacher && signedIn ? <PortalStudentGrades isStudent={!isTeacher} /> : null}
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
            <PortalSectionLinks current="hub" isAdmin={isAdmin} />
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
  const { isAdmin } = usePortalClassGrade();

  useEffect(() => {
    if (intent === 'profile') {
      document.getElementById('portal-magic-link-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [intent]);

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-hub-card">
        <PortalSectionLinks current="profile" isAdmin={isAdmin} />
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

  const [highGrades, setHighGrades] = useState([]);
  const [highGradesThreshold, setHighGradesThreshold] = useState(null);
  const [highGradesLoading, setHighGradesLoading] = useState(false);
  const [highGradesError, setHighGradesError] = useState('');

  const [exportPreview, setExportPreview] = useState(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportDownloading, setExportDownloading] = useState(false);

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
    try {
      const data = await adminApiPost('/api/portal-admin/lookup', { query });
      setLookupResult(data);
    } catch (err) {
      setLookupError(err.message || 'Lookup failed.');
    } finally {
      setLookupLoading(false);
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

  if (!signedIn) {
    return (
      <PortalLayout>
        <div className="portal-card portal-content portal-admin-card">
          <PortalSectionLinks current="admin" isAdmin={false} />
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">Sign in required</p>
            <p className="portal-session-banner-text">
              Admin tools require a portal session.{' '}
              <a href={portalHubHref()}>Sign in on Profile</a> with your magic link first.
            </p>
          </div>
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
            <p className="portal-session-banner-title">Access denied</p>
            <p className="portal-session-banner-text">
              Your account is not on the admin allowlist. Contact operations if you need access.
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
          Sync status, student lookup, high-grade rewards, and DingConnect+ bulk top-up export.
        </p>

        <nav className="portal-admin-tabs" aria-label="Admin sections">
          {[
            { id: 'overview', label: 'Overview' },
            { id: 'lookup', label: 'Student lookup' },
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
                <div className="portal-admin-stat-row">
                  <dt>DingConnect+ SKU</dt>
                  <dd className="portal-admin-mono">{dashboard.dingConnectTopUpSku || '—'}</dd>
                </div>
              </dl>
            ) : null}
            {dashboard?.syncHint ? <p className="portal-admin-hint">{dashboard.syncHint}</p> : null}
          </section>
        ) : null}

        {activeTab === 'lookup' ? (
          <section className="portal-admin-panel" aria-label="Student lookup">
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
                    <dt>Class</dt>
                    <dd>{lookupResult.detail.classSection || '—'}</dd>
                  </div>
                  <div className="portal-admin-stat-row">
                    <dt>Grade</dt>
                    <dd>{lookupResult.detail.calculatedGrade || '—'}</dd>
                  </div>
                </dl>
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
                    </tr>
                  </thead>
                  <tbody>
                    {highGrades.map((student) => (
                      <tr key={student.email || student.userId || student.name}>
                        <td>{student.name || '—'}</td>
                        <td className="portal-admin-mono">{student.dingNumber || '—'}</td>
                        <td>{student.calculatedGrade || '—'}</td>
                        <td>{student.classSection || '—'}</td>
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
  if (segment === 'admin') {
    return <PortalAdminPage />;
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
  const { isTeacher, isAdmin } = usePortalClassGrade();

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
        <PortalSectionLinks current="profile" isAdmin={isAdmin} />
        {!canUpdateDing ? (
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">Session incomplete</p>
            <p className="portal-session-banner-text">
              Go back to{' '}
              <a href={portalHubHref()}>Profile</a> and connect with your AESOP ID so we can load your account.
            </p>
          </div>
        ) : null}

        {canUpdateDing && (isTeacher || isAdmin) ? (
          <PortalTeacherRoster
            rosterEnabled={isTeacher || isAdmin}
            isAdminView={isAdmin && !isTeacher}
          />
        ) : null}
        {canUpdateDing && !isTeacher ? <PortalStudentGrades isStudent /> : null}

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
