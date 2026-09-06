# 10: Distributed Concurrency and Rate Limiting

**What to build:**
Distributed token-bucket rate limiting at the Fastify API ingestion boundary and distributed workflow concurrency limits (both global workflow capacity and per-key partition limits, e.g. per customer ID) executed via Redis Lua scripts with lease TTLs.

**Blocked by:** 08: Fastify Control API, Idempotency, and Client SDK

**Status:** completed

- [x] Implement Redis token-bucket rate limiter for API requests returning HTTP 429 and Retry-After headers when exceeded.
- [x] Enforce fail-closed behavior (HTTP 503) when Redis is unavailable.
- [x] Implement distributed workflow concurrency coordinator in worker runtime: acquire global and per-key slots before running.
- [x] Concurrency locks held with TTL and released cleanly on completion or process termination.
- [x] Integration tests verifying global and per-key concurrency limits across multiple concurrent simulated workers.

## Producer-to-Consumer Interface Check (Downstream: Ticket 11)
- **Downstream Ticket**: `11-real-time-sse-execution-streaming.md`
- **Interface Guarantee**:
  - `apps/api/src/plugins/rate-limit.ts` provides `exemptRoutes?: string[]` in `RateLimitOptions` to ensure long-lived SSE streaming routes (`GET /runs/:runId/events`) can be cleanly exempted from token-bucket rate limiting without exhausting token pools or prematurely terminating open connection streams.
  - Concurrency locks in `apps/worker` are held in transient Redis Sorted Sets during execution and released upon completion/suspension without modifying `execution_events` or `workflow_runs` schemas, preserving Ticket 11's event streaming, wake-up Pub/Sub, and replay mechanics intact.

