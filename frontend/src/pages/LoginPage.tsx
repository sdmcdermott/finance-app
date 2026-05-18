import React, { useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';

// QR code rendered client-side via the qrcode.react package (already available
// via amazon-cognito-identity-js's dependency tree; if missing add it with
// `npm install qrcode.react`).
let QRCode: React.FC<{ value: string; size: number }> | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  QRCode = require('qrcode.react').default ?? require('qrcode.react');
} catch { QRCode = null; }

type Phase = 'login' | 'newPassword' | 'totp' | 'mfaSetup';

const LoginPage: React.FC = () => {
  const { login, completeNewPassword, verifyTotp, confirmTotpSetup } = useAuth();

  const [phase, setPhase] = useState<Phase>('login');

  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [newPassword, setNewPassword]   = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpCode, setTotpCode]         = useState('');
  const [mfaSecret, setMfaSecret]       = useState('');
  const [mfaQrUrl, setMfaQrUrl]         = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const totpInputRef = useRef<HTMLInputElement>(null);

  const handleResult = (result: Awaited<ReturnType<typeof login>>) => {
    if (result.type === 'error') {
      setError(result.message);
    } else if (result.type === 'newPasswordRequired') {
      setError(null);
      setPhase('newPassword');
    } else if (result.type === 'totpRequired') {
      setError(null);
      setTotpCode('');
      setPhase('totp');
      setTimeout(() => totpInputRef.current?.focus(), 50);
    } else if (result.type === 'mfaSetupRequired') {
      setError(null);
      setMfaSecret(result.secretCode);
      setMfaQrUrl(result.qrCodeUrl);
      setTotpCode('');
      setPhase('mfaSetup');
    }
    // 'success' → AuthContext sets idToken → App re-renders automatically
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    handleResult(await login(email, password));
    setLoading(false);
  };

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (newPassword.length < 12) { setError('Password must be at least 12 characters.'); return; }
    setLoading(true);
    handleResult(await completeNewPassword(newPassword));
    setLoading(false);
  };

  const handleVerifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    handleResult(await verifyTotp(totpCode.trim()));
    setLoading(false);
  };

  const handleConfirmSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    // After confirming enrollment Cognito requires the user to re-authenticate;
    // handleResult will transition to the 'totp' phase.
    handleResult(await confirmTotpSetup(totpCode.trim()));
    setLoading(false);
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.brand}>Finance Tracker</h1>

        {/* ── Sign in ── */}
        {phase === 'login' && (
          <>
            <h2 style={styles.heading}>Sign in</h2>
            <form onSubmit={handleLogin} style={styles.form}>
              <label style={styles.label}>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                required autoFocus style={styles.input} placeholder="you@example.com" />
              <label style={styles.label}>Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                required style={styles.input} placeholder="••••••••••••" />
              {error && <div style={styles.error}>{error}</div>}
              <button type="submit" disabled={loading} style={styles.btn}>
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          </>
        )}

        {/* ── Set new password ── */}
        {phase === 'newPassword' && (
          <>
            <h2 style={styles.heading}>Set a new password</h2>
            <p style={styles.subtext}>Your account requires a new password before you can continue.</p>
            <form onSubmit={handleNewPassword} style={styles.form}>
              <label style={styles.label}>New password</label>
              <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                required autoFocus style={styles.input} placeholder="At least 12 characters" />
              <label style={styles.label}>Confirm new password</label>
              <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                required style={styles.input} placeholder="Re-enter password" />
              {error && <div style={styles.error}>{error}</div>}
              <button type="submit" disabled={loading} style={styles.btn}>
                {loading ? 'Saving...' : 'Set password & continue'}
              </button>
            </form>
          </>
        )}

        {/* ── TOTP code entry (enrolled users) ── */}
        {phase === 'totp' && (
          <>
            <h2 style={styles.heading}>Two-factor authentication</h2>
            <p style={styles.subtext}>Enter the 6-digit code from your authenticator app.</p>
            <form onSubmit={handleVerifyTotp} style={styles.form}>
              <label style={styles.label}>Authentication code</label>
              <input
                ref={totpInputRef}
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={totpCode}
                onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                required
                style={{ ...styles.input, letterSpacing: '0.35em', fontSize: '1.2rem', textAlign: 'center' }}
                placeholder="000000"
                autoComplete="one-time-code"
              />
              {error && <div style={styles.error}>{error}</div>}
              <button type="submit" disabled={loading || totpCode.length !== 6} style={styles.btn}>
                {loading ? 'Verifying...' : 'Verify'}
              </button>
              <button type="button" style={styles.ghostBtn} onClick={() => { setPhase('login'); setError(null); }}>
                ← Back to sign in
              </button>
            </form>
          </>
        )}

        {/* ── First-time MFA enrollment ── */}
        {phase === 'mfaSetup' && (
          <>
            <h2 style={styles.heading}>Set up two-factor authentication</h2>
            <p style={styles.subtext}>
              Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.),
              then enter the 6-digit code to confirm.
            </p>
            <div style={styles.qrWrap}>
              {QRCode
                ? <QRCode value={mfaQrUrl} size={180} />
                : <div style={styles.secretBox}>{mfaSecret}</div>
              }
            </div>
            <details style={styles.details}>
              <summary style={styles.detailsSummary}>Can't scan? Enter code manually</summary>
              <code style={styles.secretBox}>{mfaSecret}</code>
            </details>
            <form onSubmit={handleConfirmSetup} style={{ ...styles.form, marginTop: '1rem' }}>
              <label style={styles.label}>Confirmation code</label>
              <input
                ref={totpInputRef}
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={totpCode}
                onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                required
                style={{ ...styles.input, letterSpacing: '0.35em', fontSize: '1.2rem', textAlign: 'center' }}
                placeholder="000000"
                autoComplete="one-time-code"
              />
              {error && <div style={styles.error}>{error}</div>}
              <button type="submit" disabled={loading || totpCode.length !== 6} style={styles.btn}>
                {loading ? 'Confirming...' : 'Confirm & finish'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default LoginPage;

// ── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#e8f5f0',
  },
  card: {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: '2.5rem 2rem',
    width: '100%',
    maxWidth: 380,
    boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
  },
  brand: {
    fontSize: '1.1rem',
    fontWeight: 700,
    color: '#0d7a6b',
    marginBottom: '1.5rem',
    textAlign: 'center',
  },
  heading: {
    fontSize: '1.2rem',
    fontWeight: 600,
    color: '#1a202c',
    marginBottom: '1.25rem',
    textAlign: 'center',
  },
  subtext: {
    color: '#718096',
    fontSize: '0.875rem',
    marginBottom: '1rem',
    textAlign: 'center',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  label: {
    fontSize: '0.8rem',
    fontWeight: 600,
    color: '#4a5568',
    marginTop: '0.4rem',
  },
  input: {
    border: '1px solid #cbd5e0',
    borderRadius: 6,
    padding: '0.55rem 0.75rem',
    fontSize: '0.9rem',
    outline: 'none',
  },
  btn: {
    marginTop: '1rem',
    background: '#0d7a6b',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '0.65rem',
    fontSize: '0.9rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  ghostBtn: {
    marginTop: '0.5rem',
    background: 'none',
    color: '#718096',
    border: 'none',
    borderRadius: 6,
    padding: '0.4rem',
    fontSize: '0.82rem',
    cursor: 'pointer',
    textAlign: 'center',
  },
  error: {
    background: '#fff5f5',
    color: '#c53030',
    border: '1px solid #feb2b2',
    borderRadius: 6,
    padding: '0.6rem 0.75rem',
    fontSize: '0.8rem',
    marginTop: '0.25rem',
  },
  qrWrap: {
    display: 'flex',
    justifyContent: 'center',
    margin: '1rem 0',
  },
  secretBox: {
    background: '#f7fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    padding: '0.5rem 0.75rem',
    fontSize: '0.78rem',
    fontFamily: 'monospace',
    wordBreak: 'break-all',
    textAlign: 'center',
    display: 'block',
    marginTop: '0.5rem',
  },
  details: {
    fontSize: '0.8rem',
    color: '#718096',
    marginTop: '0.5rem',
  },
  detailsSummary: {
    cursor: 'pointer',
    color: '#0d7a6b',
    fontSize: '0.8rem',
  },
};
