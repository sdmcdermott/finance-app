import { CognitoUserPool } from 'amazon-cognito-identity-js';

// When both env vars are absent the app is running in local dev mode with
// AUTH_DISABLED=true on the backend — skip constructing the pool entirely.
export const AUTH_DISABLED =
  !process.env.REACT_APP_COGNITO_USER_POOL_ID &&
  !process.env.REACT_APP_COGNITO_CLIENT_ID;

export const userPool = AUTH_DISABLED
  ? null
  : new CognitoUserPool({
      UserPoolId: process.env.REACT_APP_COGNITO_USER_POOL_ID!,
      ClientId: process.env.REACT_APP_COGNITO_CLIENT_ID!,
    });
