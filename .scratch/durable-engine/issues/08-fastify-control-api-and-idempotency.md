# 08: Fastify Control API, Idempotency, and Client SDK

**What to build:**
The HTTP Control API (apps/api) built on Fastify providing API-key authentication, tenant resolution, run creation (POST /runs), run inspection (GET /runs/:id, GET /runs), and manual retry/cancel commands with Idempotency-Key deduplication. Also implements the foundational packages/client SDK package providing createWorkflowClient({ baseUrl, apiKey }) with run(), runs.get(), runs.list(), runs.retry(), and runs.cancel().

**Blocked by:** 07: Periodic Background Reconciler

**Status:** completed

- [x] Implement API-key authentication plugin resolving tenant_id from secure key hash.
- [x] Implement POST /runs endpoint with Zod schema validation and atomic database transaction creating workflow_runs(PENDING) and WORKFLOW_CREATED event.
- [x] Implement request idempotency via idempotency_keys table / request_idempotency_key preventing duplicate runs on retry.
- [x] Implement GET /runs/:id and GET /runs with tenant-scoped filtering.
- [x] Implement POST /runs/:id/retry (atomic transition FAILED -> PENDING) and POST /runs/:id/cancel endpoints.
- [x] Implement packages/client with createWorkflowClient(), client.run(), and client.runs.* methods.
- [x] Integration tests verifying API-key auth, tenant isolation, request idempotency, and client SDK methods.

## Producer-to-Consumer Interface Check (Downstream: Ticket 09 - Event Ingestion and Bindings)
- **Downstream Consumer**: Ticket 09 (`09-event-ingestion-and-bindings.md`) implements `POST /events` and extends `@durable/client` with `client.sendEvent({ id, name, data })`.
- **Interfaces Produced**:
  - `apps/api`: Modular route architecture with `createApp({ prisma, queue })` and `authenticateApiKey` preHandler hook.
  - `packages/client`: `createWorkflowClient({ baseUrl, apiKey })` returning `WorkflowClient` class with standard `request()` wrapper.
- **Compatibility Verified**: Ticket 09 can mount `POST /events` directly into the Fastify app instance under the existing auth plugin, and extend `WorkflowClient` with `sendEvent()` without altering existing method signatures.
