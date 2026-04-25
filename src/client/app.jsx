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
          if (nameFromApi) {
            sessionStorage.setItem('studentPortalName', nameFromApi);
          } else {
            sessionStorage.removeItem('studentPortalName');
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

  useEffect(() => {
    const storedName = sessionStorage.getItem('studentPortalName') || '';
    setStudentName(storedName);
  }, []);

  return (
    <div className="portal-page">
      <header className="portal-header">
        <h1>AESOP Student Portal</h1>
      </header>
      <main className="portal-content">
        <h2>{`Welcome, ${studentName || 'Student'}`}</h2>
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
