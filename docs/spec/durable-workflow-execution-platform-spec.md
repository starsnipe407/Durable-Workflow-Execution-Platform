# Durable Workflow Execution Platform Specification

## Problem Statement

Modern cloud applications require executing long-running, multi-step asynchronous processes (e.g., order fulfillment, customer onboarding, payment processing, report generation) that must survive transient infrastructure failures, network partitions, worker process crashes, and unexpected restarts without data corruption or duplicate side-effects.

Traditional job queues (e.g., raw BullMQ, SQS, Celery) delegate workflow orchestration and progress tracking to custom application state machines or ad-hoc database flags. This results in fragile code, duplicated retry logic, race conditions when workers die mid-step, lost scheduling state when in-memory broker nodes fail, and an inability to inspect, replay, or manually recover workflows without re-executing previously completed side effects. Existing enterprise solutions (like Temporal) often require dedicated foreign infrastructure clusters, complex server runtimes, or steep learning curves, while hosted solutions create vendor lock-in.

Developers need a code-first, developer-friendly TypeScript platform where ordinary async functions can define durable workflows with checkpointed steps, robust worker recovery, transparent replays, event triggers, distributed concurrency controls, and real-time observability, built on standard infrastructure (PostgreSQL and Redis).

## Solution

The platform provides a TypeScript SDK, worker runtime, control API, background reconciler, and live observability dashboard designed around two primary architectural theses:

1. **PostgreSQL answers what happened and what should happen; Redis/BullMQ answers what is ready to execute right now.**
2. **Redis scheduling state is disposable; committed workflow progress is not.**

Developers define workflows as standard async functions using step.run() boundaries. Workflow progress, step executions, attempt histories, and execution events are committed durably in PostgreSQL. Completed steps are memoized and never intentionally re-executed during replay. Transient execution scheduling and concurrency tokens live in Redis/BullMQ.

Worker failures and process crashes are detected via lease timeouts and heartbeats. Stale workers waking up after lease expiration are prevented from corrupting step state using database-level fencing on ctive_attempt_id. A dedicated periodic reconciler continuously scans PostgreSQL authoritative truth to restore missing queue jobs, re-enqueue due retries, abandon expired leases, and resume blocked workflow versions. Workflows are version-pinned to prevent silent runtime mutations, and real-time step progressions are streamed via Server-Sent Events (SSE) to a live Next.js dashboard.

## User Stories

1. As a developer, I want to define code-first workflows in standard TypeScript using defineWorkflow, so that I can orchestrate complex logic without configuring static DAG JSON or YAML schemas.
2. As a developer, I want to wrap side-effecting operations in step.run(stepKey, handler), so that successful step outputs are durably memoized and checkpointed in PostgreSQL.
3. As a developer, I want replaying workflows to skip already-completed steps and return memoized results immediately, so that my external APIs are not needlessly invoked again.
4. As an operator, I want worker process crashes to be detected automatically via heartbeat leases, so that orphaned steps are marked abandoned and retried without human intervention.
5. As an operator, I want stale workers that wake up after their lease expires to be prevented from committing results (ctive_attempt_id fencing), so that split-brain worker executions cannot overwrite newer attempt results.
6. As a developer, I want to configure per-step exponential backoff, retry limits, and execution timeouts, so that transient failures are handled gracefully according to policy.
7. As a developer, I want native Promise.all([step.run(...), step.run(...)]) to execute parallel steps concurrently within the replaying worker, so that independent tasks complete with low latency.
8. As a developer, I want completed sibling steps to remain durably committed if another parallel sibling fails, so that subsequent retries only re-execute the failed branch.
9. As a developer, I want to supply stable step keys and have the engine throw a DuplicateStepKeyError if a step key is repeated within the same run invocation, so that unintentional duplicate step keys in loops do not silently corrupt replay memoization.
10. As an operator, I want to flush or lose all Redis scheduling data and have the background reconciler reconstruct all pending runs and due retries from PostgreSQL, so that no committed workflow progress is ever lost.
11. As an operator, I want a dedicated reconciler to batch scan for expired attempts and due retries using SELECT ... FOR UPDATE SKIP LOCKED, so that multiple reconciler workers do not conflict or contend.
12. As an API client, I want to trigger workflow runs directly via POST /runs with an optional Idempotency-Key header, so that client network retries do not create duplicate workflow runs.
13. As an API client, I want to ingest business events via POST /events with unique producer event IDs, so that duplicate event dispatches are deduplicated per tenant and matching workflows are triggered automatically.
14. As an administrator, I want multi-tenant isolation where all workflow definitions, runs, and events are strictly partitioned by tenant ID derived from hashed API keys, so that tenants cannot access or tamper with other tenants'' data.
15. As an operator, I want distributed token-bucket rate limiting at the API boundary, so that sudden traffic spikes do not overwhelm the execution infrastructure.
16. As a developer, I want to specify workflow concurrency limits (both global workflow limits and per-key limits derived from input), so that runs for the same customer or entity execute sequentially while runs for different keys execute in parallel.
17. As an operator, I want runs to be pinned to the exact workflow version active when they were created, so that deploying new workflow versions does not break in-flight runs.
18. As an operator, I want workflow runs whose pinned version is not registered by any running worker to enter a blocked state (WORKFLOW_VERSION_UNAVAILABLE), so that they resume automatically once a compatible worker comes online.
19. As an operator, I want to trigger a manual retry for a failed workflow run, so that the workflow re-evaluates using the same run ID without re-running previously completed steps.
20. As an operator, I want to request workflow cancellation, so that active steps are signaled via AbortController and no subsequent steps are allowed to start.
21. As a developer, I want workflow inputs and step outputs to be strictly validated and serializable JSON, so that complex non-serializable objects do not fail silently in persistence.
22. As an operator, I want execution events (WORKFLOW_STARTED, STEP_COMPLETED, etc.) to be persisted atomically in PostgreSQL alongside state mutations, so that system state and audit logs never drift.
23. As an operator, I want to connect to an SSE stream (GET /runs/:runId/events) to watch execution events live, with Redis Pub/Sub wake-ups and PostgreSQL replay via Last-Event-ID, so that disconnections do not lose execution history.
24. As an operator, I want a live Next.js dashboard showing system metrics, active workflows, run lists with status filters, and detailed execution timelines for each run, so that I can monitor and control platform health.
25. As an engineer, I want automated failure-injection tests verifying worker crashes, Redis flushes, database downtime, and concurrent idempotency, so that system invariants are verifiably validated before production release.

## Implementation Decisions

1. **Monorepo Structure**: Turborepo workspace using pnpm with Node.js 22+.
   - Packages: packages/database, packages/workflow-sdk, packages/client, packages/shared, packages/testing.
   - Applications: pps/api, pps/worker, pps/reconciler, pps/dashboard.
   - Examples & Benchmarks: examples/order-processing, enchmarks/.

2. **Persistence & Fencing**:
   - PostgreSQL is the sole authoritative source of truth.
   - Prisma ORM manages schemas and baseline migrations.
   - Core transactional invariant operations (claimStepAttempt, completeStepAttempt, bandonExpiredAttempt, etryWorkflow, reconciler batch queries) are encapsulated as explicit raw SQL transactions with row-level locks (FOR UPDATE / FOR UPDATE SKIP LOCKED).
   - Short-lived claim transactions: database locks are never held during user step handler execution.
   - Step completion is fenced by WHERE id =  AND active_attempt_id = . If zero rows are updated, the runtime throws StaleAttemptError.

3. **Replay & Suspension Mechanics**:
   - Workflows are authorable with natural async/await (defineWorkflow(config, async ({ input, step }) => { ... })).
   - When encountering a step in an uncompleted, waiting, or non-runnable state (e.g. RETRY_WAIT), step.run() throws an internal WorkflowSuspendedError sentinel to cleanly unwind the worker execution stack without marking the run failed.
   - Actively owned, claimed attempts are locally awaited until completion, timeout, or process failure.
   - Step keys are tracked in an in-memory Set<string> during each replay pass; duplicate step keys in the same run immediately throw DuplicateStepKeyError.

4. **Scheduling & Reconciliation**:
   - Redis/BullMQ is used strictly for transient, reconstructable scheduling queues. Job payloads carry minimal metadata (unId, workflowName, workflowVersion, 	enantId).
   - A dedicated, stateless periodic background reconciler scans PostgreSQL to repair missing queue jobs, re-enqueue due retries (
ext_retry_at <= NOW()), mark expired leases as ABANDONED, and re-evaluate blocked workflow versions.

5. **Concurrency & Rate Limiting**:
   - Distributed workflow concurrency limits (global limit and per-key partition) managed via Redis Lua scripts with lease TTLs.
   - Distributed token-bucket rate limiting enforced at the Fastify API layer backed by Redis Lua. Fails closed (HTTP 503) if Redis is unavailable.

6. **Control API & Observability**:
   - Fastify HTTP API providing API-key authentication, tenant resolution, request idempotency, event ingestion, and run management.
   - Real-time execution events streamed via SSE (GET /runs/:runId/events), backed by durable PostgreSQL replay and Redis Pub/Sub wake-ups.
   - Next.js web dashboard with React, Tailwind CSS, TanStack Query, and native EventSource for real-time run inspection and manual controls.

## Testing Decisions

1. **Testing Boundaries & Seams**:
   - Integration tests exercise the highest public seam possible (the WorkflowExecutor and createWorker APIs against real PostgreSQL and Redis containers).
   - Mocking of database transactions or queue operations is prohibited for invariant tests; tests must verify genuine row locking, fencing, lease expiry, and queue redelivery.
2. **Critical Invariant Test Matrix**:
   - Crash & Replay: 2-step workflow, crash after step 1, replay asserts step 1 memoized (call count = 1) and step 2 executes.
   - Fencing: Worker A loses lease; Worker B claims attempt 2 and completes; Worker A attempts to commit and is rejected with StaleAttemptError.
   - Sibling Isolation: Parallel step A completes while sibling B fails; subsequent retry preserves step A memoization.
   - Queue Redelivery: Redelivering identical BullMQ jobs does not cause duplicate execution.
   - Redis Loss & Recovery: Flush Redis scheduling state; verify reconciler reconstructs all pending runs without data loss or duplicate runs.
   - Idempotency & Deduplication: Concurrent requests with identical idempotency/event keys yield exactly one logical execution.
   - Workflow Version Pinning: v1 runs never execute on v2 workers; missing versions block until compatible workers register.

## Out of Scope (V1)

- Dynamic code uploads or untrusted sandboxing / VM isolation.
- Automatic workflow migration or code AST diffing engines.
- Generic exactly-once guarantees for non-idempotent external third-party side effects.
- Visual drag-and-drop DAG editor.
- Cron, recurring calendar schedules, or complex workflow timers beyond step retry backoff.
- Wildcard event pattern subscriptions or event payload transformation DSL.
- Multi-region replication, Kafka integration, or Kubernetes-specific operators.
- Distributed step closure dispatch across heterogeneous worker clusters (horizontal distribution is at the workflow run level).

## Further Notes

- Primary demonstration workflow: process-order (fetching order, charging payment with retries and external idempotency, parallel email confirmation and analytics updates).
- All benchmark metrics (throughput scaling, queue latency, crash recovery latency, Redis reconstruction timing) will be saved as raw reproducible artifacts.
