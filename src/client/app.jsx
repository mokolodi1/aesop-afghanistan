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

/** Guests hitting /profile or /faq land on / with ?intent= so we can explain and show the magic-link form. */
function ensurePortalGuestRedirectToHub() {
  if (typeof window === 'undefined') return;
  if (isPortalSessionCompleteSync()) return;
  const path = window.location.pathname;
  if (path === '/profile' || path.startsWith('/profile/')) {
    window.history.replaceState(null, '', '/?intent=profile');
  } else if (path === '/faq' || path.startsWith('/faq/')) {
    window.history.replaceState(null, '', '/?intent=faq');
  }
}

function getPortalUrlIntent() {
  if (typeof window === 'undefined') return '';
  const raw = new URLSearchParams(window.location.search).get('intent');
  return raw === 'profile' || raw === 'faq' ? raw : '';
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

function PortalLayout({ children }) {
  return (
    <div className="portal-page">
      <header className="portal-header">
        <div className="portal-header-inner">
          <div className="portal-header-brand">
            <p className="portal-header-kicker">AESOP Afghanistan</p>
            <h1 className="portal-header-title">Student Portal</h1>
          </div>
          <a
            className="portal-logo-wrap"
            href="https://aesopafghanistan.org/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="AESOP Afghanistan — visit main site"
          >
            <img
              className="portal-logo"
              src="/images/aesop-logo.webp"
              width={280}
              height={80}
              alt=""
              decoding="async"
            />
          </a>
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

function PortalNav({ active }) {
  const hubHref = portalHubHref();
  return (
    <nav className="portal-nav" aria-label="Portal sections">
      <a href={hubHref} className={active === 'hub' ? 'portal-nav-link is-active' : 'portal-nav-link'}>
        Home
      </a>
      <a href="/profile" className={active === 'profile' ? 'portal-nav-link is-active' : 'portal-nav-link'}>
        Edit Ding
      </a>
      <a href="/faq" className={active === 'faq' ? 'portal-nav-link is-active' : 'portal-nav-link'}>
        FAQs
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
      <p className="portal-intent-banner-title">Sign in to open this section</p>
      <p className="portal-intent-banner-text">
        You used a link to <strong>{title}</strong>.{' '}
        <a href="#portal-magic-link-form" className="portal-intent-inline-link">
          Request a magic link
        </a>{' '}
        with your AESOP ID below—we&apos;ll email you a one-time link so you can open Edit Ding, FAQs, and the rest of the
        portal.
      </p>
    </div>
  );
}

function PortalHubPage() {
  const { studentName, studentUserId, studentEmail, studentPhone } = usePortalStudentRecord();
  const signedIn = isPortalSessionCompleteSync();
  const intent = typeof window !== 'undefined' ? getPortalUrlIntent() : '';

  useEffect(() => {
    if (!signedIn && intent) {
      document.getElementById('portal-magic-link-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [signedIn, intent]);

  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-hub-card">
        <PortalNav active="hub" />
        {signedIn ? (
          <>
            <h2 className="portal-welcome">{`Welcome, ${studentName || 'Student'}!`}</h2>
            <p className="portal-hub-lead">Open a section:</p>
            <ul className="portal-hub-list">
              <li>
                <a className="portal-hub-link" href="/profile">
                  <span className="portal-hub-link-title">Edit Ding</span>
                  <span className="portal-hub-link-desc">
                    Update your Afghanistan Ding number, view history, or contact us for help.
                  </span>
                </a>
              </li>
              <li>
                <a className="portal-hub-link" href="/faq">
                  <span className="portal-hub-link-title">FAQs</span>
                  <span className="portal-hub-link-desc">Frequently asked questions (content coming soon).</span>
                </a>
              </li>
              <li>
                <a
                  className="portal-hub-link portal-hub-link-external"
                  href="https://aesopafghanistan.org/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span className="portal-hub-link-title">AESOP Afghanistan website</span>
                  <span className="portal-hub-link-desc">Visit the main organization site.</span>
                </a>
              </li>
            </ul>
            {studentUserId || studentPhone || studentEmail ? (
              <div className="portal-hub-meta">
                {studentUserId ? (
                  <p className="portal-email">
                    <span className="portal-email-label">AESOP ID</span>
                    <span className="portal-email-value">{studentUserId}</span>
                  </p>
                ) : null}
                {studentPhone ? (
                  <p className="portal-email">
                    <span className="portal-email-label">Phone on file</span>
                    <span className="portal-email-value">{studentPhone}</span>
                  </p>
                ) : null}
                {studentEmail ? (
                  <p className="portal-email">
                    <span className="portal-email-label">Contact email</span>
                    <span className="portal-email-value">{studentEmail}</span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <PortalIntentNotice intent={intent} />
            <h2 className="portal-welcome portal-welcome-signout">Student portal</h2>
            <p className="portal-hub-intro">
              This secure area is for AESOP students. After you sign in with a magic link, you can manage your Afghanistan
              Ding number and read portal FAQs—without sharing a password on this site.
            </p>
            <ul className="portal-hub-features" aria-label="What you can do after signing in">
              <li>
                <strong>Edit Ding</strong> — update your Afghanistan Ding number when it changes, with confirmation.
              </li>
              <li>
                <strong>History &amp; help</strong> — see past Ding updates or contact us if you use a non-Afghan number.
              </li>
              <li>
                <strong>FAQs</strong> — answers for common questions (we&apos;re adding more).
              </li>
            </ul>
            <p className="portal-hub-links-hint">
              Use the navigation for <strong>Edit Ding</strong> or <strong>FAQs</strong> after you&apos;re signed in. Not
              connected yet?{' '}
              <a href="#portal-magic-link-form" className="portal-intent-inline-link">
                Request a magic link
              </a>{' '}
              with your AESOP ID.
            </p>
            <div id="portal-magic-link-form" className="portal-signin-panel">
              <h3 className="portal-signin-heading">Connect with your AESOP ID</h3>
              <p className="portal-signin-lead">
                Enter the student ID AESOP gave you. We&apos;ll email a magic link; open it on this device to finish signing
                in.
              </p>
              <MagicLinkRequestForm inputId="portalMagicUserId" submitLabel="Email me a magic link" />
            </div>
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

function PortalFaqPage() {
  return (
    <PortalLayout>
      <div className="portal-card portal-content portal-faq-card">
        <PortalNav active="faq" />
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

  ensurePortalGuestRedirectToHub();

  const segment = getPortalRouteSegment();
  const signedIn = isPortalSessionCompleteSync();

  if (signedIn && segment === 'profile') {
    return <PortalProfilePage />;
  }
  if (signedIn && segment === 'faq') {
    return <PortalFaqPage />;
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

  const [showDingForm, setShowDingForm] = useState(false);
  const [formDing, setFormDing] = useState('');
  const [formDingConfirm, setFormDingConfirm] = useState('');
  const [dingFieldError, setDingFieldError] = useState('');
  const [dingConfirmFieldError, setDingConfirmFieldError] = useState('');
  const [formStatus, setFormStatus] = useState({ type: '', text: '' });
  const [saving, setSaving] = useState(false);
  const [showDingHelpForm, setShowDingHelpForm] = useState(false);
  const [dingHelpPhone, setDingHelpPhone] = useState('');
  const [dingHelpNote, setDingHelpNote] = useState('');
  const [dingHelpStatus, setDingHelpStatus] = useState({ type: '', text: '' });
  const [dingHelpSubmitting, setDingHelpSubmitting] = useState(false);
  const [showDingHistory, setShowDingHistory] = useState(false);
  const [dingHistoryLoading, setDingHistoryLoading] = useState(false);
  const [dingHistoryError, setDingHistoryError] = useState('');
  const [dingHistoryEntries, setDingHistoryEntries] = useState([]);

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
      setShowDingForm(false);
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

  const toggleDingHistory = async () => {
    if (!canUpdateDing) {
      return;
    }
    if (showDingHistory) {
      setShowDingHistory(false);
      return;
    }
    setShowDingHistory(true);
    setDingHistoryLoading(true);
    setDingHistoryError('');
    try {
      const response = await fetch('/api/portal-ding-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: studentUserId, email: studentEmail }),
      });
      const data = await response.json();
      if (!response.ok) {
        setDingHistoryError(data.error || 'Could not load history.');
        setDingHistoryEntries([]);
        return;
      }
      setDingHistoryEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch {
      setDingHistoryError('Network error. Please try again.');
      setDingHistoryEntries([]);
    } finally {
      setDingHistoryLoading(false);
    }
  };

  return (
    <PortalLayout>
      <div className="portal-card portal-content">
        <PortalNav active="profile" />
        <h2 className="portal-page-title">Edit Ding</h2>
        {!canUpdateDing ? (
          <div className="portal-session-banner" role="status">
            <p className="portal-session-banner-title">Session incomplete</p>
            <p className="portal-session-banner-text">
              Go back to <a href="/">Student portal home</a> and connect with your AESOP ID so we can load your profile.
            </p>
          </div>
        ) : null}
        {studentUserId ? (
          <p className="portal-email">
            <span className="portal-email-label">AESOP ID</span>
            <span className="portal-email-value">{studentUserId}</span>
          </p>
        ) : null}
        {studentPhone ? (
          <p className="portal-email">
            <span className="portal-email-label">Phone on file</span>
            <span className="portal-email-value">{studentPhone}</span>
          </p>
        ) : null}
        {studentEmail ? (
          <p className="portal-email">
            <span className="portal-email-label">Contact email</span>
            <span className="portal-email-value">{studentEmail}</span>
          </p>
        ) : null}

        {canUpdateDing ? (
          <section className="portal-ding-section" aria-label="Ding number">
            <p className="portal-ding">
              <span className="portal-ding-label">Ding number</span>
              <span
                className={`portal-ding-value${newDingNumber.trim() ? '' : ' portal-ding-value-empty'}`}
              >
                {newDingNumber.trim() ? newDingNumber.trim() : 'Enter Ding number'}
              </span>
            </p>
            <div className="portal-ding-toolbar">
              <button
                type="button"
                className="portal-ding-button"
                onClick={() => {
                  setShowDingForm((v) => !v);
                  setFormStatus({ type: '', text: '' });
                  setFormDing('');
                  setFormDingConfirm('');
                  setDingFieldError('');
                  setDingConfirmFieldError('');
                }}
              >
                Update Ding number
              </button>
              <button
                type="button"
                className="portal-ding-history-button"
                onClick={toggleDingHistory}
                aria-expanded={showDingHistory}
              >
                {showDingHistory ? 'Hide Ding history' : 'Ding number history'}
              </button>
            </div>

            {showDingHistory ? (
              <div
                className="portal-ding-history-panel"
                role="region"
                aria-label="Ding number change history"
              >
                {dingHistoryLoading ? <p className="portal-ding-history-status">Loading history…</p> : null}
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
                          <th scope="col">Date &amp; time</th>
                          <th scope="col">Ding number</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dingHistoryEntries.map((row, i) => (
                          <tr key={`${row.displayedAt}-${row.dingNumber}-${i}`}>
                            <td>{row.displayedAt}</td>
                            <td className="portal-ding-history-num">{row.dingNumber}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="portal-ding-help">
              <p className="portal-ding-help-intro">
                If you cannot submit an Afghanistan Ding number here—for example you use a Pakistani or other
                non-Afghan number—ask us to update it manually.
              </p>
              {!showDingHelpForm ? (
                <button
                  type="button"
                  className="portal-ding-help-open"
                  onClick={() => {
                    setShowDingHelpForm(true);
                    setDingHelpStatus({ type: '', text: '' });
                  }}
                >
                  Contact us
                </button>
              ) : (
                <div className="portal-ding-help-panel">
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
                        setShowDingHelpForm(false);
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
              )}
            </div>

            {showDingForm ? (
              <div className="portal-ding-form">
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
                          t && !isValidAfghanistanPhoneNumber(t) ? getAfghanistanPhoneFormatMessage(t) : '',
                        );
                      }
                      if (dingConfirmFieldError === DING_CONFIRM_MISMATCH_MESSAGE) {
                        setDingConfirmFieldError('');
                      }
                    }}
                    onBlur={() => {
                      const t = formDing.trim();
                      setDingFieldError(
                        t && !isValidAfghanistanPhoneNumber(t) ? getAfghanistanPhoneFormatMessage(t) : '',
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
                    aria-describedby={['newDingConfirm-hint', dingConfirmFieldError ? 'newDingConfirm-error' : '']
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
                    Type the same number again by hand—paste is turned off here. Only digits, +, spaces,
                    and dashes are allowed.
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
                      setShowDingForm(false);
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
            ) : null}
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
