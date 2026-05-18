#!/usr/bin/env bash
set -euo pipefail

# ── LocalStack auth token ─────────────────────────────────────────────────────
if [ -z "${LOCALSTACK_AUTH_TOKEN:-}" ]; then
  echo "ERROR: LOCALSTACK_AUTH_TOKEN is not set." >&2
  echo "       Get your token at https://app.localstack.cloud/workspace/auth-token" >&2
  echo "       Then run: export LOCALSTACK_AUTH_TOKEN=<your-token>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TABLE_NAME="finance-app-dev"
LOCALSTACK_READY_TIMEOUT=30
DOCKER_NETWORK="finance-local"

# ── Fake AWS credentials so the SDK doesn't complain ──────────────────────────
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1

# ── Cleanup on exit ───────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── 1. Docker network ─────────────────────────────────────────────────────────
echo "==> Ensuring Docker network '${DOCKER_NETWORK}' exists..."
docker network create "$DOCKER_NETWORK" 2>/dev/null || true

# ── 2. LocalStack ─────────────────────────────────────────────────────────────
echo "==> Starting LocalStack on network '${DOCKER_NETWORK}'..."
if ! command -v localstack &>/dev/null; then
  echo "ERROR: localstack CLI not found. Install with: pip install localstack" >&2
  exit 1
fi

localstack start -d --network "$DOCKER_NETWORK"

# LocalStack's container name on the shared network is 'localstack-main'
# so SAM Lambda containers can reach it at http://localstack-main:4566
LOCALSTACK_URL="http://localhost:4566"

echo -n "    Waiting for LocalStack to be ready"
for i in $(seq 1 $LOCALSTACK_READY_TIMEOUT); do
  if curl -s "${LOCALSTACK_URL}/_localstack/health" | grep -q '"dynamodb"'; then
    echo " ready."
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" -eq "$LOCALSTACK_READY_TIMEOUT" ]; then
    echo ""
    echo "ERROR: LocalStack did not become ready in time." >&2
    exit 1
  fi
done

# ── 3. Create DynamoDB table (idempotent) ─────────────────────────────────────
echo "==> Creating DynamoDB table '${TABLE_NAME}' in LocalStack..."
if aws dynamodb describe-table \
     --table-name "$TABLE_NAME" \
     --endpoint-url "$LOCALSTACK_URL" \
     --region "$AWS_DEFAULT_REGION" \
     &>/dev/null; then
  echo "    Table already exists, skipping."
else
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions \
      AttributeName=pk,AttributeType=S \
      AttributeName=sk,AttributeType=S \
    --key-schema \
      AttributeName=pk,KeyType=HASH \
      AttributeName=sk,KeyType=RANGE \
    --endpoint-url "$LOCALSTACK_URL" \
    --region "$AWS_DEFAULT_REGION" \
    --output text --query "TableDescription.TableStatus"
  echo "    Table created."
fi

# ── 4. SAM build + local API ──────────────────────────────────────────────────
echo "==> Building Lambda functions..."
cd "$REPO_ROOT/backend"
sam build

echo "==> Starting SAM local API on port 3001..."
sam local start-api \
  --port 3001 \
  --env-vars local-env.json \
  --docker-network "$DOCKER_NETWORK" &
PIDS+=($!)

# Give SAM a moment to start before launching the frontend
sleep 3

# ── 6. Frontend dev server ────────────────────────────────────────────────────
echo "==> Starting React dev server..."
cd "$REPO_ROOT/frontend"
npm start &
PIDS+=($!)

echo ""
echo "Local environment running:"
echo "  Backend  -> http://localhost:3001"
echo "  Frontend -> http://localhost:3000"
echo "  DynamoDB -> ${LOCALSTACK_URL}"
echo ""
echo "Press Ctrl+C to stop everything."

# Wait for all background processes
wait
