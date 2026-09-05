# 02: Database Schema and Fenced Persistence

**What to build:**
The core PostgreSQL persistence layer (packages/database) using Prisma for schema definitions/migrations, coupled with encapsulated raw SQL transactional repositories. Implements atomic attempt claiming, lease renewal, fenced completion on WHERE active_attempt_id = attemptId (where zero rows updated indicates a stale attempt), and the durable execution_events append primitive that records execution audit logs atomically alongside state mutations.

**Blocked by:** 01: Monorepo Tooling and Test Infrastructure

**Status:** ready-for-agent

- [ ] Define Prisma models: 	enants, pi_keys, workflow_definitions, workflow_runs, step_executions, step_attempts, idempotency_keys, ingested_events, workflow_event_bindings, and execution_events.
- [ ] Apply initial migration to the test database.
- [ ] Implement short-lived claimStepAttempt() transaction: inspects status, checks lease validity, advances attempt counter, updates ctive_attempt_id, and appends STEP_STARTED event.
- [ ] Implement short-lived completeStepAttempt() transaction: conditionally updates step_executions matching ctive_attempt_id, appends STEP_COMPLETED event, and throws StaleAttemptError on zero rows updated.
- [ ] Implement heartbeat lease renewal transaction updating lease_expires_at.
- [ ] Implement atomic ecordExecutionEvent() helper for appending durable events in state-change transactions.
- [ ] Unit/integration tests verifying atomic attempt claiming, fenced commit rejection, and durable event persistence.
