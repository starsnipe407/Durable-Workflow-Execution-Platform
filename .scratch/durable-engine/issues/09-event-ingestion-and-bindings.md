# 09: Event Ingestion and Bindings

**What to build:**
Event-driven workflow execution via POST /events. Ingests producer events with mandatory producer-supplied event IDs for per-tenant deduplication, atomically matches exact event-to-workflow bindings, creates resulting workflow runs in PostgreSQL, and enqueues BullMQ jobs. Extends packages/client with client.sendEvent({ id, name, data }).

**Blocked by:** 08: Fastify Control API, Idempotency, and Client SDK

**Status:** ready-for-agent

- [ ] Implement POST /events endpoint accepting { id, name, data }.
- [ ] Enforce event deduplication via UNIQUE(tenant_id, event_id) on ingested_events.
- [ ] Implement workflow event bindings matching exact event_name to active workflow definitions.
- [ ] Atomically insert event, resolve bindings, create workflow_runs, and enqueue execution jobs.
- [ ] Extend packages/client with client.sendEvent().
- [ ] Integration tests asserting concurrent duplicate events produce exactly one logical run per binding.
