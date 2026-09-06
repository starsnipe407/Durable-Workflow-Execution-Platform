# 09: Event Ingestion and Bindings

**What to build:**
Event-driven workflow execution via POST /events. Ingests producer events with mandatory producer-supplied event IDs for per-tenant deduplication, atomically matches exact event-to-workflow bindings, creates resulting workflow runs in PostgreSQL, and enqueues BullMQ jobs. Extends packages/client with client.sendEvent({ id, name, data }).

**Blocked by:** 08: Fastify Control API, Idempotency, and Client SDK

**Status:** completed

- [x] Implement POST /events endpoint accepting { id, name, data }.
- [x] Enforce event deduplication via UNIQUE(tenant_id, event_id) on ingested_events.
- [x] Implement workflow event bindings matching exact event_name to active workflow definitions.
- [x] Atomically insert event, resolve bindings, create workflow_runs, and enqueue execution jobs.
- [x] Extend packages/client with client.sendEvent().
- [x] Integration tests asserting concurrent duplicate events produce exactly one logical run per binding.

## Producer-to-Consumer Interface Check (Downstream: Ticket 10)
- **Downstream Ticket**: `10-distributed-concurrency-and-rate-limiting.md`
- **Interface Guarantee**:
  - `POST /events` atomically inserts `ingested_events`, matches `workflow_event_bindings`, creates `workflow_runs(status: PENDING, triggerType: EVENT, triggerEventId: event.id)` and `WORKFLOW_CREATED` execution events, and enqueues BullMQ replay jobs via `enqueueWorkflowRun`.
  - `packages/client` provides `client.sendEvent({ id, name, data })` returning `{ status, eventId, runs }`.
  - Ticket 10 worker concurrency limiter and tenant rate limiter cleanly wrap BullMQ processing and lease acquisition without requiring schema changes to `ingested_events` or `workflow_event_bindings`.

