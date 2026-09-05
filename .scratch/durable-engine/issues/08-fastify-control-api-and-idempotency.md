# 08: Fastify Control API, Idempotency, and Client SDK

**What to build:**
The HTTP Control API (pps/api) built on Fastify providing API-key authentication, tenant resolution, run creation (POST /runs), run inspection (GET /runs/:id, GET /runs), and manual retry/cancel commands with Idempotency-Key deduplication. Also implements the foundational packages/client SDK package providing createWorkflowClient({ baseUrl, apiKey }) with un(), uns.get(), uns.list(), uns.retry(), and uns.cancel().

**Blocked by:** 07: Periodic Background Reconciler

**Status:** ready-for-agent

- [ ] Implement API-key authentication plugin resolving 	enant_id from secure key hash.
- [ ] Implement POST /runs endpoint with Zod schema validation and atomic database transaction creating workflow_runs(PENDING) and WORKFLOW_CREATED event.
- [ ] Implement request idempotency via idempotency_keys table / equest_idempotency_key preventing duplicate runs on retry.
- [ ] Implement GET /runs/:id and GET /runs with tenant-scoped filtering.
- [ ] Implement POST /runs/:id/retry (atomic transition FAILED -> PENDING) and POST /runs/:id/cancel endpoints.
- [ ] Implement packages/client with createWorkflowClient(), client.run(), and client.runs.* methods.
- [ ] Integration tests verifying API-key auth, tenant isolation, request idempotency, and client SDK methods.
