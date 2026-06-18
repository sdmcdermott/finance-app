// src/auth/AuthContext.tsx
// Manages Cognito session state for the whole app.
// Provides: idToken, login, logout, completeNewPassword, verifyTotp, setupTotp.
//
// MFA flow (TOTP):
//   1. First-time users: login → mfaSetupRequired → setupTotp (scan QR) →
//      verifyTotp (confirm code) → success
//   2. Enrolled users: login → totpRequired → verifyTotp (enter code) → success
//
// Tokens are kept in CognitoUserPool's built-in localStorage persistence.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserSession,
  IAuthenticationCallback,
} from 'amazon-cognito-identity-js';
import { AUTH_DISABLED, userPool } from './cognitoPool';
import {
  clearActivity,
  INACTIVITY_MS,
  millisSinceActivity,
  touchActivity,
} from './sessionActivity';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LoginResult =
  | { type: 'success' }
  | { type: 'newPasswordRequired' }
  | { type: 'totpRequired' }
  | { type: 'mfaSetupRequired'; secretCode: string; qrCodeUrl: string }
  | { type: 'error'; message: string };

interface AuthContextValue {
  idToken: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  completeNewPassword: (newPassword: string) => Promise<LoginResult>;
  // Submit a TOTP code during login (SOFTWARE_TOKEN_MFA challenge)
  verifyTotp: (code: string) => Promise<LoginResult>;
  // Confirm TOTP enrollment with a code from the authenticator app
  confirmTotpSetup: (code: string) => Promise<LoginResult>;
  logout: () => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};

// ── Provider ──────────────────────────────────────────────────────────────────

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [idToken, setIdToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingUser, setPendingUser] = useState<CognitoUser | null>(null);

  // On mount: restore session from localStorage
  useEffect(() => {
    if (AUTH_DISABLED) {
      setIdToken('local-dev-no-auth');
      setLoading(false);
      return;
    }
    const cognitoUser = userPool!.getCurrentUser();
    if (!cognitoUser) { setLoading(false); return; }
    cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session?.isValid()) { setLoading(false); return; }
      touchActivity();
      setIdToken(session.getIdToken().getJwtToken());
      setLoading(false);
    });
  }, []);

  const login = useCallback(
    (email: string, password: string): Promise<LoginResult> => {
      if (AUTH_DISABLED) {
        setIdToken('local-dev-no-auth');
        return Promise.resolve({ type: 'success' });
      }
      return new Promise((resolve) => {
        const cognitoUser = new CognitoUser({ Username: email, Pool: userPool! });
        const authDetails = new AuthenticationDetails({ Username: email, Password: password });

        const         callbacks: IAuthenticationCallback = {
          onSuccess: (session: CognitoUserSession) => {
            touchActivity();
            setIdToken(session.getIdToken().getJwtToken());
            setPendingUser(null);
            resolve({ type: 'success' });
          },
          onFailure: (err: Error) => {
            resolve({ type: 'error', message: err.message });
          },
          newPasswordRequired: () => {
            setPendingUser(cognitoUser);
            resolve({ type: 'newPasswordRequired' });
          },
          // Called when the user has already enrolled TOTP
          totpRequired: () => {
            setPendingUser(cognitoUser);
            resolve({ type: 'totpRequired' });
          },
          // Called when Cognito requires MFA setup (first time with MFA enabled)
          mfaSetup: () => {
            setPendingUser(cognitoUser);
            // Associate a software token to get the secret
            cognitoUser.associateSoftwareToken({
              associateSecretCode: (secretCode: string) => {
                const email = encodeURIComponent(cognitoUser.getUsername());
                const qrCodeUrl = `otpauth://totp/FinanceApp:${email}?secret=${secretCode}&issuer=FinanceApp`;
                resolve({ type: 'mfaSetupRequired', secretCode, qrCodeUrl });
              },
              onFailure: (err: Error) => {
                resolve({ type: 'error', message: err.message });
              },
            });
          },
        };

        cognitoUser.authenticateUser(authDetails, callbacks);
      });
    },
    []
  );

  const completeNewPassword = useCallback(
    (newPassword: string): Promise<LoginResult> =>
      new Promise((resolve) => {
        if (!pendingUser) { resolve({ type: 'error', message: 'No pending challenge' }); return; }
        pendingUser.completeNewPasswordChallenge(newPassword, {}, {
          onSuccess: (session: CognitoUserSession) => {
            touchActivity();
            setIdToken(session.getIdToken().getJwtToken());
            setPendingUser(null);
            resolve({ type: 'success' });
          },
          onFailure: (err: Error) => resolve({ type: 'error', message: err.message }),
          // After setting a new password MFA setup may follow
          mfaSetup: () => {
            pendingUser.associateSoftwareToken({
              associateSecretCode: (secretCode: string) => {
                const email = encodeURIComponent(pendingUser.getUsername());
                const qrCodeUrl = `otpauth://totp/FinanceApp:${email}?secret=${secretCode}&issuer=FinanceApp`;
                resolve({ type: 'mfaSetupRequired', secretCode, qrCodeUrl });
              },
              onFailure: (err: Error) => resolve({ type: 'error', message: err.message }),
            });
          },
          totpRequired: () => resolve({ type: 'totpRequired' }),
        });
      }),
    [pendingUser]
  );

  // Verify a TOTP code during a SOFTWARE_TOKEN_MFA challenge
  const verifyTotp = useCallback(
    (code: string): Promise<LoginResult> =>
      new Promise((resolve) => {
        if (!pendingUser) { resolve({ type: 'error', message: 'No pending challenge' }); return; }
        pendingUser.sendMFACode(code, {
          onSuccess: (session: CognitoUserSession) => {
            touchActivity();
            setIdToken(session.getIdToken().getJwtToken());
            setPendingUser(null);
            resolve({ type: 'success' });
          },
          onFailure: (err: Error) => resolve({ type: 'error', message: err.message }),
        }, 'SOFTWARE_TOKEN_MFA');
      }),
    [pendingUser]
  );

  // Confirm TOTP enrollment — call after the user scans the QR and enters a code
  const confirmTotpSetup = useCallback(
    (code: string): Promise<LoginResult> =>
      new Promise((resolve) => {
        if (!pendingUser) { resolve({ type: 'error', message: 'No pending challenge' }); return; }
        pendingUser.verifySoftwareToken(code, 'FinanceApp', {
          onSuccess: () => {
            // After enrollment Cognito requires a fresh login — prompt the user
            // to sign in again with their code.
            setPendingUser(null);
            resolve({ type: 'totpRequired' });
          },
          onFailure: (err: Error) => resolve({ type: 'error', message: err.message }),
        });
      }),
    [pendingUser]
  );

  const logout = useCallback(() => {
    if (!AUTH_DISABLED) {
      const cognitoUser = userPool!.getCurrentUser();
      cognitoUser?.signOut();
    }
    clearActivity();
    setIdToken(null);
    setPendingUser(null);
  }, []);

  // Inactivity guard: poll every 30 s while logged in. If the last successful
  // API response was >1 hour ago (including across tab close/reopen via
  // localStorage), force logout. The Axios response interceptor keeps
  // touchActivity() current, so any API activity resets the clock.
  useEffect(() => {
    if (AUTH_DISABLED || !idToken) return;

    // Immediate check on mount — catches stale sessions after tab reopen.
    if (millisSinceActivity() > INACTIVITY_MS) {
      logout();
      return;
    }

    const timer = setInterval(() => {
      if (millisSinceActivity() > INACTIVITY_MS) {
        logout();
      }
    }, 30_000);

    return () => clearInterval(timer);
  }, [idToken, logout]);

  return (
    <AuthContext.Provider value={{ idToken, loading, login, completeNewPassword, verifyTotp, confirmTotpSetup, logout }}>
      {children}
    </AuthContext.Provider>
  );
};
