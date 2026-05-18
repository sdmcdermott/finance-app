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
├── start-local.sh    # One-command local dev startup (see below)
├── Makefile          # Build, deploy, and utility targets
├── backend/          # Go Lambda functions + SAM template
│   ├── template.yaml
│   ├── samconfig.toml
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

- **LocalStack** to emulate DynamoDB (requires a free LocalStack account for the auth token)
- **SAM CLI (`sam local start-api`)** to run Lambda functions and API Gateway locally
- **`npm start`** for the React dev server with hot reload

The React dev server proxies all API calls to SAM on port 3001, so there are no CORS issues.

### LocalStack auth token

LocalStack requires an auth token even for free usage. To get yours:

1. Sign in or create a free account at [https://app.localstack.cloud](https://app.localstack.cloud)
2. Go to **Getting Started** at [https://app.localstack.cloud/getting-started](https://app.localstack.cloud/getting-started) to find your **Personal Auth Token**
3. Copy your token and export it in your shell (add this to your `~/.bashrc` or `~/.zshrc` to persist it):

```bash
export LOCALSTACK_AUTH_TOKEN=<your-token>
```

`start-local.sh` will exit with an error if this variable is not set.

### Quick start

```bash
export LOCALSTACK_AUTH_TOKEN=<your-token>   # if not already in your shell
./start-local.sh
```

That's it. The script handles everything:

1. Verifies `LOCALSTACK_AUTH_TOKEN` is set
2. Sets dummy AWS credentials (`AWS_ACCESS_KEY_ID=test` etc.) so the SDK doesn't complain
3. Creates a Docker network (`finance-local`) shared by LocalStack and the Lambda containers
4. Starts LocalStack on that network and waits until DynamoDB is ready
5. Creates the `finance-app-dev` table in LocalStack (idempotent — skips if it already exists)
6. Builds all Lambda functions with `sam build`
7. Starts `sam local start-api` on port 3001, attached to the shared Docker network
8. Starts the React dev server on port 3000

Press **Ctrl+C** to stop everything cleanly.

> **Prerequisites:** Docker must be running, and `localstack` must be installed (`pip install localstack` or `brew install localstack/tap/localstack-cli`).

### Architecture note

The SAM template uses `x86_64`. This works for both local dev and production deploys. If you want to switch to Graviton2 (`arm64`) for lower Lambda costs, you would need an ARM machine or cross-compilation toolchain to build and test locally.

### Manual steps (if not using start-local.sh)

```bash
# 1. Set dummy credentials
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1

# 2. Create a shared Docker network
docker network create finance-local

# 3. Start LocalStack on the shared network
localstack start -d --network finance-local

# 4. Create the DynamoDB table
aws dynamodb create-table \
  --table-name finance-app-dev \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=sk,AttributeType=S \
  --key-schema \
    AttributeName=pk,KeyType=HASH \
    AttributeName=sk,KeyType=RANGE \
  --endpoint-url http://localhost:4566

# 5. Update DYNAMODB_ENDPOINT in local-env.json to use the container hostname
#    (Lambda containers reach LocalStack via the shared network, not localhost)
#    Set every function's DYNAMODB_ENDPOINT to: http://localstack-main:4566

# 6. Build and start the backend
cd backend
sam build
sam local start-api --port 3001 --env-vars local-env.json --docker-network finance-local

# 7. Start the frontend (separate terminal)
cd frontend
npm install   # first time only
npm start
```

> **Note:** `local-env.json` already has `DYNAMODB_ENDPOINT` set to `http://localstack-main:4566`. This is the hostname Lambda containers use to reach LocalStack over the shared Docker network.

### Frontend environment for local dev

`frontend/.env.local` is already configured correctly:

```
REACT_APP_API_URL=        # empty — axios uses page origin, proxied to SAM on :3001
REACT_APP_COGNITO_USER_POOL_ID=   # empty — auth bypassed (AUTH_DISABLED=true on backend)
REACT_APP_COGNITO_CLIENT_ID=      # empty — auth bypassed
```

When both Cognito env vars are absent the frontend skips constructing the Cognito user pool entirely and treats the session as always-authenticated. The backend's `AUTH_DISABLED=true` ignores the `Authorization` header on every request.

---

## Build

### Backend

```bash
cd backend
sam build
```

This compiles all Go functions natively using the `makefile` build method, which runs `go build` from the backend root where `go.mod` lives. Artifacts go to `.aws-sam/build/`.

> Docker is no longer required for `sam build` — only for `sam local start-api`.

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

The easiest way is via the Makefile:

```bash
make deploy                          # deploys to dev (sandbox Plaid)
make deploy STAGE=prod PLAID_ENV=production
```

Or manually:

```bash
cd backend
sam build --use-container
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
REACT_APP_API_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com/dev \
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
make deploy   # or make deploy STAGE=prod

make frontend-deploy   # builds frontend and syncs to S3 + CloudFront invalidation
```

---

## Authentication

The app uses **AWS Cognito** for authentication. All API routes require a valid JWT (Cognito ID token) in the `Authorization: Bearer <token>` header. The frontend handles login and token management automatically.

### How it works

- A Cognito **User Pool** is created by the SAM template with self-registration disabled (admin-created accounts only).
- API Gateway uses a **JWT authorizer** that validates every request against the User Pool before invoking any Lambda.
- The frontend uses `amazon-cognito-identity-js` to authenticate and stores the session in `localStorage`. The ID token is attached to every API call via an axios request interceptor.
- Token refresh is handled automatically by the Cognito SDK (refresh tokens are valid for 30 days).
- **Local development**: `AUTH_DISABLED=true` in `local-env.json` bypasses the auth check inside Lambda functions. `sam local start-api` does not enforce the JWT authorizer. When `REACT_APP_COGNITO_USER_POOL_ID` and `REACT_APP_COGNITO_CLIENT_ID` are both empty in `.env.local`, the frontend skips Cognito entirely and treats the session as always-authenticated — no login screen appears locally.

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
| `DYNAMODB_ENDPOINT` | Local only — set to `http://localstack-main:4566` to route DynamoDB calls to LocalStack |

### Frontend

| Variable | Description |
|----------|-------------|
| `REACT_APP_API_URL` | Full base URL of the deployed API Gateway stage. Leave empty locally — the React dev server proxies to SAM on :3001. |
| `REACT_APP_COGNITO_USER_POOL_ID` | Cognito User Pool ID (from SAM outputs). Leave empty locally to bypass auth. |
| `REACT_APP_COGNITO_CLIENT_ID` | Cognito App Client ID (from SAM outputs). Leave empty locally to bypass auth. |

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
