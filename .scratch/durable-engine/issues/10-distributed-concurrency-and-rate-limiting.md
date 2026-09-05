# 10: Distributed Concurrency and Rate Limiting

**What to build:**
Distributed token-bucket rate limiting at the Fastify API ingestion boundary and distributed workflow concurrency limits (both global workflow capacity and per-key partition limits, e.g. per customer ID) executed via Redis Lua scripts with lease TTLs.

**Blocked by:** 08: Fastify Control API, Idempotency, and Client SDK

**Status:** ready-for-agent

- [ ] Implement Redis token-bucket rate limiter for API requests returning HTTP 429 and Retry-After headers when exceeded.
- [ ] Enforce fail-closed behavior (HTTP 503) when Redis is unavailable.
- [ ] Implement distributed workflow concurrency coordinator in worker runtime: acquire global and per-key slots before running.
- [ ] Concurrency locks held with TTL and released cleanly on completion or process termination.
- [ ] Integration tests verifying global and per-key concurrency limits across multiple concurrent simulated workers.
