import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function RequestMagicLinkApp() {
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

      if (!response.ok && response.status >= 500) {
        setStatus({ type: 'error', text: data.error || 'Internal error. Please try again.' });
        return;
      }

      setStatus({
        type: 'success',
        text: data.message || 'If your ID is registered, you will receive a magic link shortly.',
      });
    } catch (error) {
      setStatus({ type: 'error', text: 'Internal error. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="container">
      <h1>AESOP Afghanistan</h1>
      <p className="subtitle">Enter your ID to receive a magic link</p>
      <div>
        <div className="form-group">
          <label htmlFor="userId">ID</label>
          <input
            type="text"
            id="userId"
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
          Send Magic Link
        </button>
        <div className={`status ${status.type || ''}`} aria-live="polite">
          {status.text}
        </div>
      </div>
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
            window.location.assign('/portal.html');
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

function StudentPortalApp() {
  const [studentName, setStudentName] = useState('');
  const [studentEmail, setStudentEmail] = useState('');
  const [studentUserId, setStudentUserId] = useState('');
  const [studentPhone, setStudentPhone] = useState('');
  const [newDingNumber, setNewDingNumber] = useState('');
  const [showDingForm, setShowDingForm] = useState(false);
  const [formDing, setFormDing] = useState('');
  const [formName, setFormName] = useState('');
  const [formStatus, setFormStatus] = useState({ type: '', text: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const storedName = sessionStorage.getItem('studentPortalName') || '';
    const storedEmail = sessionStorage.getItem('studentPortalEmail') || '';
    const storedDing = sessionStorage.getItem('studentPortalNewDingNumber') || '';
    const storedUserId = sessionStorage.getItem('studentPortalUserId') || '';
    const storedPhone = sessionStorage.getItem('studentPortalPhone') || '';
    setStudentName(storedName);
    setStudentEmail(storedEmail);
    setNewDingNumber(storedDing);
    setStudentUserId(storedUserId);
    setStudentPhone(storedPhone);
    setFormName(storedName);
  }, []);

  const canUpdateDing = studentUserId.length > 0 && studentEmail.length > 0;

  const submitDingUpdate = async () => {
    if (!canUpdateDing) {
      return;
    }
    const trimmed = formDing.trim();
    if (!trimmed) {
      setFormStatus({ type: 'error', text: 'Enter a new ding number.' });
      return;
    }

    setFormStatus({ type: '', text: '' });
    setSaving(true);
    try {
      const response = await fetch('/api/update-ding-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: studentUserId,
          email: studentEmail,
          newDingNumber: trimmed,
          displayName: formName.trim() || studentName,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setFormStatus({ type: 'error', text: data.error || 'Update failed. Please try again.' });
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
      setShowDingForm(false);
      setFormStatus({ type: 'success', text: 'Ding number updated.' });
    } catch {
      setFormStatus({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="portal-page">
      <header className="portal-header">
        <h1>AESOP Student Portal</h1>
      </header>
      <main className="portal-content">
        <h2>{`Welcome, ${studentName || 'Student'}`}</h2>
        {studentUserId ? (
          <p className="portal-email">
            <span className="portal-email-label">Your ID</span>
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
            <span className="portal-email-label">Email on file</span>
            <span className="portal-email-value">{studentEmail}</span>
          </p>
        ) : null}

        {canUpdateDing ? (
          <section className="portal-ding-section" aria-label="Ding number">
            <p className="portal-ding">
              <span className="portal-ding-label">New ding number</span>
              <span className="portal-ding-value">{newDingNumber || '—'}</span>
            </p>
            <button
              type="button"
              className="portal-ding-button"
              onClick={() => {
                setShowDingForm((v) => !v);
                setFormStatus({ type: '', text: '' });
                setFormDing('');
                setFormName(studentName);
              }}
            >
              Update your ding number
            </button>

            {showDingForm ? (
              <div className="portal-ding-form">
                <div className="form-group">
                  <label htmlFor="newDing">New ding number</label>
                  <input
                    id="newDing"
                    type="text"
                    autoComplete="off"
                    value={formDing}
                    onChange={(e) => setFormDing(e.target.value)}
                    disabled={saving}
                    maxLength={80}
                    placeholder="Enter new number"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="dingDisplayName">Your name for this change</label>
                  <input
                    id="dingDisplayName"
                    type="text"
                    autoComplete="name"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    disabled={saving}
                    maxLength={200}
                    placeholder="Name shown in the log"
                  />
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
      </main>
    </div>
  );
}

function AppRouter() {
  if (window.location.pathname === '/verify.html') {
    return <VerifyMagicLinkApp />;
  }

  if (window.location.pathname === '/portal.html') {
    return <StudentPortalApp />;
  }

  return <RequestMagicLinkApp />;
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<AppRouter />);
}
