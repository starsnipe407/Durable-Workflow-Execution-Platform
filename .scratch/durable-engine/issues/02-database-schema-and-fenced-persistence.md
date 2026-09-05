# 02: Database Schema and Fenced Persistence

**What to build:**
The core PostgreSQL persistence layer (packages/database) using Prisma for schema definitions/migrations, coupled with encapsulated raw SQL transactional repositories. Implements atomic attempt claiming, lease renewal, fenced completion on WHERE active_attempt_id = attemptId (where zero rows updated indicates a stale attempt), and the durable execution_events append primitive that records execution audit logs atomically alongside state mutations.

**Blocked by:** 01: Monorepo Tooling and Test Infrastructure

**Status:** completed

- [x] Define Prisma models: tenants, api_keys, workflow_definitions, workflow_runs, step_executions, step_attempts, idempotency_keys, ingested_events, workflow_event_bindings, and execution_events.
- [x] Apply initial migration to the test database.
- [x] Implement short-lived claimStepAttempt() transaction: inspects status, checks lease validity, advances attempt counter, updates active_attempt_id, and appends STEP_STARTED event.
- [x] Implement short-lived completeStepAttempt() transaction: conditionally updates step_executions matching active_attempt_id, appends STEP_COMPLETED event, and throws StaleAttemptError on zero rows updated.
- [x] Implement heartbeat lease renewal transaction updating lease_expires_at.
- [x] Implement atomic recordExecutionEvent() helper for appending durable events in state-change transactions.
- [x] Unit/integration tests verifying atomic attempt claiming, fenced commit rejection, and durable event persistence.
