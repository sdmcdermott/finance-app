# ── Variables ──────────────────────────────────────────────────────────────────
STAGE        ?= dev
PLAID_ENV    ?= sandbox
AWS_REGION   ?= us-east-1
STACK_NAME    = finance-app-$(STAGE)
AWS_ACCOUNT_ID   = $(shell aws sts get-caller-identity --query "Account" --output text --region $(AWS_REGION) 2>/dev/null)
S3_BUCKET     = $(STACK_NAME)-sam-artifacts-$(AWS_ACCOUNT_ID)

# ── Helpers ────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo ""
	@echo "  make setup          One-time: create S3 bucket + SSM params"
	@echo "  make build          Build all Go Lambda functions"
	@echo "  make deploy         Build + deploy backend via SAM"
	@echo "  make dev            Run SAM locally (requires Docker)"
	@echo "  make frontend-dev   Start React dev server"
	@echo "  make frontend-build Build React app for production"
	@echo "  make frontend-deploy Deploy React build to S3 + invalidate CloudFront"
	@echo "  make logs fn=<name> Tail Lambda logs (e.g. make logs fn=sync-transactions)"
	@echo "  make destroy        Tear down the CloudFormation stack"
	@echo ""

# ── One-time setup ─────────────────────────────────────────────────────────────
.PHONY: setup
setup:
	@echo "Creating SAM artifact bucket..."
	aws s3 mb s3://$(S3_BUCKET) --region $(AWS_REGION) 2>/dev/null || true
	@echo ""
	@echo "Storing Plaid and PayrollTaxAPI credentials in SSM Parameter Store..."
	@read -p "Plaid Client ID: " PLAID_CLIENT_ID; \
	aws ssm put-parameter \
		--name "/finance-app/$(STAGE)/plaid-client-id" \
		--value "$$PLAID_CLIENT_ID" \
		--type String \
		--overwrite \
		--region $(AWS_REGION)
	@read -sp "Plaid Secret: " PLAID_SECRET; echo; \
	aws ssm put-parameter \
		--name "/finance-app/$(STAGE)/plaid-secret" \
		--value "$$PLAID_SECRET" \
		--type String \
		--overwrite \
		--region $(AWS_REGION)
	@read -sp "PayrollTaxAPI Key: " PAYROLLTAXAPI_KEY; echo; \
	aws ssm put-parameter \
		--name "/finance-app/$(STAGE)/payrolltax-api-key" \
		--value "$$PAYROLLTAXAPI_KEY" \
		--type String \
		--overwrite \
		--region $(AWS_REGION)
		
	@echo "Setup complete."

# ── Backend ────────────────────────────────────────────────────────────────────
.PHONY: build
build:
	cd backend && sam build

.PHONY: deploy
deploy: build
	cd backend && sam deploy \
		--stack-name $(STACK_NAME) \
		--s3-bucket $(S3_BUCKET) \
		--region $(AWS_REGION) \
		--capabilities CAPABILITY_IAM \
		--parameter-overrides Stage=$(STAGE) PlaidEnv=$(PLAID_ENV) \
		--no-fail-on-empty-changeset

.PHONY: dev
dev:
	cd backend && sam local start-api \
		--port 3001 \
		--env-vars local-env.json \
		--docker-network host

# ── Frontend ───────────────────────────────────────────────────────────────────
.PHONY: frontend-dev
frontend-dev:
	cd frontend && npm start

.PHONY: frontend-build
frontend-build:
	cd frontend && npm run build

.PHONY: frontend-deploy
frontend-deploy: frontend-build
	$(eval BUCKET := $(shell aws cloudformation describe-stacks \
		--stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
		--output text --region $(AWS_REGION) 2>/dev/null))
	$(eval CF_ID := $(shell aws cloudformation describe-stacks \
		--stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='CloudFrontDistributionId'].OutputValue" \
		--output text --region $(AWS_REGION) 2>/dev/null))
	aws s3 sync frontend/build s3://$(BUCKET) --delete
	@if [ -n "$(CF_ID)" ]; then \
		aws cloudfront create-invalidation --distribution-id $(CF_ID) --paths "/*"; \
	fi

# ── Utilities ──────────────────────────────────────────────────────────────────
.PHONY: logs
logs:
	aws logs tail /aws/lambda/finance-app-$(STAGE)-$(fn) --follow --region $(AWS_REGION)

.PHONY: api-url
api-url:
	@aws cloudformation describe-stacks \
		--stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
		--output text \
		--region $(AWS_REGION)

.PHONY: destroy
destroy:
	aws cloudformation delete-stack --stack-name $(STACK_NAME) --region $(AWS_REGION)
	@echo "Stack deletion initiated."
