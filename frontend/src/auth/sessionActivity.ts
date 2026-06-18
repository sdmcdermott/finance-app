// src/auth/sessionActivity.ts
//
// Tracks the timestamp of the last successful API response so that
// AuthContext can enforce a client-side inactivity timeout.
//
// Using localStorage means inactivity persists across tab close/reopen,
// so a user who closes the browser for >1 hour will be logged out on return.

const ACTIVITY_KEY = 'finance_last_activity';

/** One hour in milliseconds — the client-side inactivity timeout. */
export const INACTIVITY_MS = 60 * 60 * 1000;

/** Record "now" as the last activity time. Called by the Axios response interceptor. */
export const touchActivity = (): void => {
  localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
};

/** Returns milliseconds since the last recorded activity, or Infinity if never set. */
export const millisSinceActivity = (): number => {
  const raw = localStorage.getItem(ACTIVITY_KEY);
  if (!raw) return Infinity;
  return Date.now() - Number(raw);
};

/** Clear the stored activity timestamp. Called on logout. */
export const clearActivity = (): void => {
  localStorage.removeItem(ACTIVITY_KEY);
};
