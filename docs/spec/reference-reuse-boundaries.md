# Reference Repositories and Reuse Boundaries

The project is informed by three primary references but does not fork one wholesale.

## 1. Reference Repositories

### 1.1 OpenWorkflow
Repository: `https://github.com/openworkflowdev/openworkflow`

Study primarily for:
- code-first durable/resumable workflow semantics;
- step boundaries;
- replay/resume concepts;
- worker/runtime separation;
- architecture and benchmark organization.

The project must independently implement its own PostgreSQL state model, step/attempt state machines, lease/fencing mechanism, BullMQ reconciliation, and associated tests.

### 1.2 Inngest
Repository: `https://github.com/inngest/inngest`

Study primarily for:
- event ingestion → run creation → queue → executor separation;
- scheduling/execution boundaries;
- event-driven invocation;
- concurrency concepts;
- run observability.

Do not attempt to reproduce the full Inngest system.

### 1.3 Trigger.dev
Repository: `https://github.com/triggerdotdev/trigger.dev`

Study primarily for:
- TypeScript workflow developer experience;
- retry/queue/concurrency ergonomics;
- execution dashboard presentation;
- attempt/error observability;
- deployment/workflow product UX.

Use it mainly as a developer-experience/product reference, not as a runtime implementation template.

---

## 2. Reuse Commodity Infrastructure

Reuse established packages strictly for:
- Queue mechanics: **BullMQ**;
- General ORM/migrations: **Prisma**;
- HTTP API: **Fastify**;
- Schema validation: **Zod**;
- UI framework: **Next.js / React**;
- Server-state cache: **TanStack Query**;
- Database/Cache clients: **pg / ioredis**.

---

## 3. Implement as Original Project Contribution

The project itself must implement and understand from scratch (clean-room TypeScript):
- workflow state machine (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`);
- step and attempt state machines (`RUNNING`, `RETRY_WAIT`, `COMPLETED`, `FAILED`, `TIMED_OUT`);
- replay/memoization engine (`defineWorkflow`, `WorkflowExecutor`);
- stable step identity (`(workflow_run_id, step_key)`);
- worker leases/heartbeats;
- fencing/stale-result rejection (`active_attempt_id = attemptId` throwing `StaleAttemptError`);
- retry orchestration semantics with exponential backoff and bounded jitter;
- reconciler (periodic repair loop aligning PostgreSQL with BullMQ);
- workflow version pinning (`v1` vs `v2` worker compatibility);
- exact event matching/deduplication;
- request idempotency;
- internal step idempotency model;
- distributed workflow concurrency policy;
- distributed token-bucket algorithm;
- durable execution event model (`execution_events`);
- SSE durable replay behavior;
- failure-injection tests and benchmarks.

Reference code may be studied for architecture, test ideas, and patterns. Core contribution code should not be copied wholesale. Any actual reused code must obey its license and be clearly attributable.