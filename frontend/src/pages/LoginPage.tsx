import React, { useState } from 'react';
import { useAuth } from '../auth/AuthContext';

const LoginPage: React.FC = () => {
  const { login, completeNewPassword } = useAuth();

  // Which form to show
  const [phase, setPhase] = useState<'login' | 'newPassword'>('login');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const result = await login(email, password);
    setLoading(false);
    if (result.type === 'error') {
      setError(result.message);
    } else if (result.type === 'newPasswordRequired') {
      setPhase('newPassword');
    }
    // 'success' → AuthContext sets idToken → App re-renders
  };

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (newPassword.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    setLoading(true);
    const result = await completeNewPassword(newPassword);
    setLoading(false);
    if (result.type === 'error') {
      setError(result.message);
    }
    // 'success' → AuthContext sets idToken → App re-renders
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.brand}>Finance Tracker</h1>

        {phase === 'login' && (
          <>
            <h2 style={styles.heading}>Sign in</h2>
            <form onSubmit={handleLogin} style={styles.form}>
              <label style={styles.label}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                style={styles.input}
                placeholder="you@example.com"
              />
              <label style={styles.label}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                style={styles.input}
                placeholder="••••••••••••"
              />
              {error && <div style={styles.error}>{error}</div>}
              <button type="submit" disabled={loading} style={styles.btn}>
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          </>
        )}

        {phase === 'newPassword' && (
          <>
            <h2 style={styles.heading}>Set a new password</h2>
            <p style={styles.subtext}>
              Your account requires a new password before you can continue.
            </p>
            <form onSubmit={handleNewPassword} style={styles.form}>
              <label style={styles.label}>New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoFocus
                style={styles.input}
                placeholder="At least 12 characters"
              />
              <label style={styles.label}>Confirm new password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                style={styles.input}
                placeholder="Re-enter password"
              />
              {error && <div style={styles.error}>{error}</div>}
              <button type="submit" disabled={loading} style={styles.btn}>
                {loading ? 'Saving...' : 'Set password & sign in'}
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
    background: '#f7fafc',
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
    color: '#4f46e5',
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
    background: '#4f46e5',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '0.65rem',
    fontSize: '0.9rem',
    fontWeight: 600,
    cursor: 'pointer',
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
};
