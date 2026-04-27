// src/auth/AuthContext.tsx
// Manages Cognito session state for the whole app.
// Provides: currentUser, idToken, login, logout, changePassword.
//
// Tokens are kept in CognitoUserPool's built-in localStorage persistence —
// the same mechanism Amplify uses under the hood. No manual localStorage
// management needed.

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
  CognitoUserPool,
  CognitoUserSession,
  IAuthenticationCallback,
} from 'amazon-cognito-identity-js';

// ── Pool config ───────────────────────────────────────────────────────────────
// These values are NOT secrets — they are public identifiers embedded in every
// web app that uses Cognito. Security is enforced by the User Pool itself.
const poolData = {
  UserPoolId: process.env.REACT_APP_COGNITO_USER_POOL_ID ?? '',
  ClientId: process.env.REACT_APP_COGNITO_CLIENT_ID ?? '',
};

const userPool = new CognitoUserPool(poolData);

// ── Types ─────────────────────────────────────────────────────────────────────

export type LoginResult =
  | { type: 'success' }
  | { type: 'newPasswordRequired' }
  | { type: 'error'; message: string };

interface AuthContextValue {
  // null = not logged in / not yet checked
  idToken: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  // Called when Cognito forces a new password on first login
  completeNewPassword: (newPassword: string) => Promise<LoginResult>;
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
  // Held across the newPasswordRequired challenge
  const [pendingUser, setPendingUser] = useState<CognitoUser | null>(null);

  // On mount: restore session from localStorage if present
  useEffect(() => {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) {
      setLoading(false);
      return;
    }
    cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session?.isValid()) {
        setLoading(false);
        return;
      }
      setIdToken(session.getIdToken().getJwtToken());
      setLoading(false);
    });
  }, []);

  const login = useCallback(
    (email: string, password: string): Promise<LoginResult> =>
      new Promise((resolve) => {
        const cognitoUser = new CognitoUser({ Username: email, Pool: userPool });
        const authDetails = new AuthenticationDetails({
          Username: email,
          Password: password,
        });

        const callbacks: IAuthenticationCallback = {
          onSuccess: (session: CognitoUserSession) => {
            setIdToken(session.getIdToken().getJwtToken());
            setPendingUser(null);
            resolve({ type: 'success' });
          },
          onFailure: (err: Error) => {
            resolve({ type: 'error', message: err.message });
          },
          newPasswordRequired: (_userAttributes, _requiredAttributes) => {
            // Admin-created users must set a new password on first login
            setPendingUser(cognitoUser);
            resolve({ type: 'newPasswordRequired' });
          },
        };

        cognitoUser.authenticateUser(authDetails, callbacks);
      }),
    []
  );

  const completeNewPassword = useCallback(
    (newPassword: string): Promise<LoginResult> =>
      new Promise((resolve) => {
        if (!pendingUser) {
          resolve({ type: 'error', message: 'No pending challenge' });
          return;
        }
        pendingUser.completeNewPasswordChallenge(newPassword, {}, {
          onSuccess: (session: CognitoUserSession) => {
            setIdToken(session.getIdToken().getJwtToken());
            setPendingUser(null);
            resolve({ type: 'success' });
          },
          onFailure: (err: Error) => {
            resolve({ type: 'error', message: err.message });
          },
        });
      }),
    [pendingUser]
  );

  const logout = useCallback(() => {
    const cognitoUser = userPool.getCurrentUser();
    cognitoUser?.signOut();
    setIdToken(null);
    setPendingUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ idToken, loading, login, completeNewPassword, logout }}>
      {children}
    </AuthContext.Provider>
  );
};
