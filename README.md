# Personal Finance App

A self-hosted personal finance tracker backed by Plaid, AWS Lambda (Go), API Gateway, and DynamoDB. The frontend is a React/TypeScript single-page app.

**Features**

- Connect bank accounts and credit cards via Plaid Link
- Daily transaction sync with cursor-based incremental updates
- Custom categories with color coding and auto-assignment rules
- Goal and checkbook budgets with period tracking, rollover, and surplus transfer
- Inline reference links on transactions (manual or via Amazon Order CSV import)
- Amazon Order History CSV import with confident/ambiguous/unmatched matching

---

## Repository layout

```
finance-app/
├── backend/          # Go Lambda functions + SAM template
│   ├── template.yaml
│   ├── go.mod
│   ├── local-env.json
│   └── functions/
│       └── <function-name>/main.go   (one directory per Lambda)
└── frontend/         # React/TypeScript SPA
    ├── package.json
    └── src/
```

---

## Prerequisites

### Required for all workflows

| Tool | Version | Install |
|------|---------|---------|
| [Go](https://go.dev/dl/) | 1.22+ | `brew install go` |
| [Node.js](https://nodejs.org/) | 18 LTS+ | `brew install node` |
| [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) | v2 | `brew install awscli` |
| [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) | 1.115+ | `brew tap aws/tap && brew install aws-sam-cli` |
| [Docker](https://docs.docker.com/get-docker/) | 24+ | Download from docker.com or `brew install --cask docker` |

> Docker is required by SAM CLI to build and run Lambda functions locally.

### Required for local development only

| Tool | Install |
|------|---------|
| [LocalStack](https://docs.localstack.cloud/getting-started/installation/) | `pip install localstack` or `brew install localstack/tap/localstack-cli` |
| [awslocal](https://github.com/localstack/awscli-local) | `pip install awscli-local` |

Verify installations:

```bash
go version          # go1.22+
node --version      # v18+
sam --version       # SAM CLI, version 1.115+
docker --version
localstack --version
```

---

## Plaid account setup

The app uses Plaid's free **Trial** tier (up to 10 connected Items at no cost).

1. Go to [https://dashboard.plaid.com/signup](https://dashboard.plaid.com/signup) and create a free account.
2. After signing in, open the **Team Settings → Keys** page.
3. Note your **Client ID** and the **Sandbox secret** (the Trial/free tier uses the Sandbox environment).
4. The app is configured to use `sandbox` by default — no credit card is required and Plaid provides test credentials for all major institutions.
5. When you are ready to connect real accounts you will need to request **Development** access from the Plaid dashboard (still free, up to 100 Items) and obtain the Development secret.

> **Never commit your Plaid credentials.** They are stored in AWS SSM Parameter Store in production and in `local-env.json` (which is `.gitignore`d) for local development.

---

## Local development

Local development uses:

- **LocalStack** to emulate DynamoDB (free Community tier is sufficient — only DynamoDB is needed)
- **SAM CLI (`sam local start-api`)** to run the Lambda functions and API Gateway locally
- **`npm start`** for the React dev server with hot reload

### 1. Install frontend dependencies

```bash
cd frontend
npm install
```

### 2. Start LocalStack

```bash
localstack start -d   # -d runs it as a background daemon
```

Wait a few seconds, then verify DynamoDB is available:

```bash
awslocal dynamodb list-tables
# Expected: { "TableNames": [] }
```

### 3. Create the DynamoDB table in LocalStack

```bash
awslocal dynamodb create-table \
  --table-name finance-app-dev \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=sk,AttributeType=S \
  --key-schema \
    AttributeName=pk,KeyType=HASH \
    AttributeName=sk,KeyType=RANGE
```

### 4. Configure local-env.json

Edit `backend/local-env.json` and fill in your Plaid sandbox credentials:

```json
{
  "CreateLinkTokenFunction": {
    "PLAID_CLIENT_ID": "<your-plaid-client-id>",
    "PLAID_SECRET":    "<your-plaid-sandbox-secret>",
    "PLAID_ENV":       "sandbox",
    "USER_ID":         "default-user",
    "DYNAMODB_TABLE":  "finance-app-dev",
    "STAGE":           "dev"
  },
  ...
}
```

The `PLAID_CLIENT_ID` and `PLAID_SECRET` entries only matter for the functions that call Plaid (`CreateLinkTokenFunction`, `ExchangeTokenFunction`, `SyncTransactionsFunction`). All other functions only need `DYNAMODB_TABLE`.

### 5. Build the Lambda functions

```bash
cd backend
sam build
```

SAM compiles each Go function into a `bootstrap` binary inside `.aws-sam/build/`.

### 6. Start the local API

```bash
cd backend
sam local start-api \
  --env-vars local-env.json \
  --docker-network host \
  --port 3001
```

- `--docker-network host` lets the Lambda containers reach LocalStack on `localhost:4566`.
- The API will be available at `http://localhost:3001`.

> **Note on DynamoDB endpoint:** By default the Go SDK resolves DynamoDB to the real AWS endpoint. The `local-env.json` sets `DYNAMODB_TABLE` but does not automatically redirect to LocalStack. You need to ensure the backend code uses a custom endpoint when running locally. See the [backend configuration note](#backend-dynamodb-endpoint-for-local-development) below.

#### Backend DynamoDB endpoint for local development

The `internal/db/db.go` client needs to point at `http://localhost:4566` when running locally. The recommended way is to check for an env var:

If `AWS_ENDPOINT_URL` is set, the AWS SDK v2 automatically uses it as the endpoint for all services (this is the [standard environment-based endpoint override](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html) added in SDK v2). Add it to every function entry in `local-env.json`:

```json
"GetTransactionsFunction": {
  "AWS_ENDPOINT_URL": "http://localhost:4566",
  "USER_ID":          "default-user",
  "DYNAMODB_TABLE":   "finance-app-dev",
  "STAGE":            "dev"
}
```

You can do this in bulk by adding `"AWS_ENDPOINT_URL": "http://localhost:4566"` to each block in `local-env.json`.

Also set dummy AWS credentials so the SDK does not complain (LocalStack does not validate them):

```bash
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
```

Or add them to your `~/.aws/credentials` under a `[localstack]` profile and pass `--profile localstack` to SAM.

### 7. Configure the frontend to hit the local API

Create `frontend/.env.local`:

```
REACT_APP_API_BASE_URL=http://localhost:3001/dev
```

The `client.ts` axios instance should read this variable as its `baseURL`. If it is currently hardcoded, update `frontend/src/api/client.ts`:

```ts
const api = axios.create({
  baseURL: process.env.REACT_APP_API_BASE_URL ?? 'http://localhost:3001/dev',
});
```

### 8. Start the frontend dev server

```bash
cd frontend
npm start
```

The app opens at [http://localhost:3000](http://localhost:3000). API calls proxy to `http://localhost:3001/dev`.

### Local development summary

```
Terminal 1:  localstack start
Terminal 2:  cd backend && sam build && sam local start-api --env-vars local-env.json --docker-network host --port 3001
Terminal 3:  cd frontend && npm start
```

---

## Build

### Backend

```bash
cd backend
sam build
```

This compiles all Go functions for `linux/arm64` (Graviton2) inside Docker and writes artifacts to `.aws-sam/build/`.

To verify the Go code compiles independently of SAM:

```bash
cd backend
go build ./...
```

### Frontend

```bash
cd frontend
npm install
npm run build
```

Output goes to `frontend/build/`.

---

## Deploy

### First-time setup

#### 1. Configure AWS credentials

```bash
aws configure
# Enter your AWS Access Key ID, Secret, region (e.g. us-east-1), and output format (json)
```

#### 2. Store Plaid credentials in SSM Parameter Store

```bash
aws ssm put-parameter \
  --name "/finance-app/dev/plaid-client-id" \
  --value "<your-plaid-client-id>" \
  --type SecureString

aws ssm put-parameter \
  --name "/finance-app/dev/plaid-secret" \
  --value "<your-plaid-sandbox-secret>" \
  --type SecureString
```

For production, repeat with `/finance-app/prod/...` and your Development or Production Plaid secret.

#### 3. Create an S3 bucket for SAM artifacts

SAM needs an S3 bucket to upload Lambda deployment packages. Choose a unique name:

```bash
aws s3 mb s3://your-finance-app-sam-artifacts-<your-account-id>
```

### Deploy the backend

```bash
cd backend

sam build

sam deploy \
  --stack-name finance-app-dev \
  --s3-bucket your-finance-app-sam-artifacts-<your-account-id> \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Stage=dev PlaidEnv=sandbox \
  --region us-east-1
```

On the first deploy SAM will create:

- The DynamoDB table (`finance-app-dev`)
- All Lambda functions
- The HTTP API Gateway
- IAM roles

After deploy, note the `ApiEndpoint` output:

```
Outputs:
  ApiEndpoint: https://<api-id>.execute-api.us-east-1.amazonaws.com/dev
```

For production:

```bash
sam deploy \
  --stack-name finance-app-prod \
  --s3-bucket your-finance-app-sam-artifacts-<your-account-id> \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Stage=prod PlaidEnv=development \
  --region us-east-1
```

### Deploy the frontend

The frontend is a static SPA — host it anywhere static files can be served. The simplest zero-cost option is S3 + CloudFront.

#### Option A: S3 static website (simplest, HTTP only)

```bash
# Create bucket
aws s3 mb s3://your-finance-app-frontend

# Enable static website hosting
aws s3 website s3://your-finance-app-frontend \
  --index-document index.html \
  --error-document index.html

# Build with your API endpoint
cd frontend
REACT_APP_API_BASE_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com/dev \
  npm run build

# Upload
aws s3 sync build/ s3://your-finance-app-frontend --delete

# Make public
aws s3api put-bucket-policy \
  --bucket your-finance-app-frontend \
  --policy '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":"*",
      "Action":"s3:GetObject",
      "Resource":"arn:aws:s3:::your-finance-app-frontend/*"
    }]
  }'
```

Access via `http://your-finance-app-frontend.s3-website-us-east-1.amazonaws.com`.

#### Option B: S3 + CloudFront (HTTPS, recommended)

After uploading to S3 as above, create a CloudFront distribution pointing at the S3 bucket. Set the default root object to `index.html` and add a custom error page (404 → `/index.html`, 200) to support React Router client-side navigation.

This is within the AWS free tier for low personal use (1 TB egress/month free for 12 months; after that, CloudFront pricing is ~$0.009/GB which is negligible for personal use).

### Updating after code changes

```bash
cd backend
sam build && sam deploy \
  --stack-name finance-app-dev \
  --s3-bucket your-finance-app-sam-artifacts-<your-account-id> \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Stage=dev PlaidEnv=sandbox \
  --no-confirm-changeset

cd frontend
REACT_APP_API_BASE_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com/dev \
  npm run build
aws s3 sync build/ s3://your-finance-app-frontend --delete
```

---

## Authentication

The app uses **AWS Cognito** for authentication. All API routes require a valid JWT (Cognito ID token) in the `Authorization: Bearer <token>` header. The frontend handles login and token management automatically.

### How it works

- A Cognito **User Pool** is created by the SAM template with self-registration disabled (admin-created accounts only).
- API Gateway uses a **JWT authorizer** that validates every request against the User Pool before invoking any Lambda.
- The frontend uses `amazon-cognito-identity-js` to authenticate and stores the session in `localStorage`. The ID token is attached to every API call via an axios request interceptor.
- Token refresh is handled automatically by the Cognito SDK (refresh tokens are valid for 30 days).
- **Local development**: `AUTH_DISABLED=true` in `local-env.json` bypasses the auth check inside Lambda functions. `sam local start-api` does not enforce the JWT authorizer, so no Cognito credentials are needed locally.

### Creating your user account (after first deploy)

Self-registration is disabled — you must create your account via the AWS CLI or the AWS Console. Do this after `sam deploy` completes.

**Password requirements:** at least 12 characters, must include uppercase, lowercase, and a number.

#### Option A: AWS CLI (recommended)

First, get your User Pool ID from the stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name finance-app-prod \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text
# Example output: us-east-1_Ab1Cd2Ef3
```

Then create your user and set a permanent password in one go:

```bash
# Step 1 — create the user
aws cognito-idp admin-create-user \
  --user-pool-id us-east-1_Ab1Cd2Ef3 \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --temporary-password "TempPass123!" \
  --message-action SUPPRESS

# Step 2 — immediately promote to a permanent password (skips the forced-reset on first login)
aws cognito-idp admin-set-user-password \
  --user-pool-id us-east-1_Ab1Cd2Ef3 \
  --username you@example.com \
  --password "YourRealPassword123!" \
  --permanent
```

If you skip step 2, the app will show a "Set a new password" form on your first login — that flow is handled automatically.

#### Option B: AWS Console

1. Open the [AWS Console](https://console.aws.amazon.com/cognito) and navigate to **Cognito → User pools**.
2. Click the pool named `finance-app-prod-user-pool` (or `finance-app-dev-user-pool`).
3. Go to the **Users** tab and click **Create user**.
4. Set:
   - **Invitation message**: select "Don't send an invitation"
   - **User name**: your email address
   - **Email address**: same email, mark as verified
   - **Temporary password**: choose one, or check "Generate a password"
5. Click **Create user**.
6. To set a permanent password immediately (so you are not prompted on first login):
   - Click the user you just created.
   - Click **Actions → Reset password**, then use the CLI step 2 command above — the Console does not offer a direct "set permanent password" option.

#### Resetting a forgotten password

Since there is no self-service reset UI in the app, use the CLI:

```bash
aws cognito-idp admin-set-user-password \
  --user-pool-id us-east-1_Ab1Cd2Ef3 \
  --username you@example.com \
  --password "NewPassword123!" \
  --permanent
```

#### Deleting a user

```bash
aws cognito-idp admin-delete-user \
  --user-pool-id us-east-1_Ab1Cd2Ef3 \
  --username you@example.com
```

### Frontend environment variables for auth

After `sam deploy`, note the `UserPoolId` and `UserPoolClientId` from the stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name finance-app-prod \
  --query "Stacks[0].Outputs"
```

Then update `frontend/.env.production`:

```
REACT_APP_API_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com/prod
REACT_APP_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
REACT_APP_COGNITO_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
```

Rebuild and redeploy the frontend after updating these values.

---

## Environment variables reference

### Backend (set via SSM in production, local-env.json locally)

| Variable | Description |
|----------|-------------|
| `DYNAMODB_TABLE` | DynamoDB table name (e.g. `finance-app-dev`) |
| `PLAID_CLIENT_ID` | Plaid Client ID (from dashboard) |
| `PLAID_SECRET` | Plaid secret for the target environment |
| `PLAID_ENV` | `sandbox`, `development`, or `production` |
| `USER_ID` | Single-user identifier (default: `default-user`) |
| `STAGE` | `dev` or `prod` |
| `AUTH_DISABLED` | Set to `"true"` locally only — bypasses JWT check inside Lambda |
| `AWS_ENDPOINT_URL` | Local only — set to `http://localhost:4566` to use LocalStack |

### Frontend

| Variable | Description |
|----------|-------------|
| `REACT_APP_API_URL` | Full base URL of the deployed API Gateway stage |
| `REACT_APP_COGNITO_USER_POOL_ID` | Cognito User Pool ID (from SAM outputs) |
| `REACT_APP_COGNITO_CLIENT_ID` | Cognito App Client ID (from SAM outputs) |

---

## Cost

This app is designed to run within the AWS free tier at $0/month for personal use:

| Service | Free tier allowance | Expected usage |
|---------|--------------------|----|
| Lambda | 1M requests/month, 400K GB-s compute | ~100 requests/day = well under |
| API Gateway HTTP API | 1M requests/month (first 12 months) | well under |
| DynamoDB | 25 GB storage, 25 WCU, 25 RCU (always free) | well under |
| SSM Parameter Store | 10,000 standard parameters free | 2 parameters used |
| S3 | 5 GB storage, 20K GET, 2K PUT (first 12 months) | well under |
| Cognito | 50,000 MAUs free (always free tier) | 1 user = well under |

Plaid Trial tier: up to 10 connected Items at $0.
