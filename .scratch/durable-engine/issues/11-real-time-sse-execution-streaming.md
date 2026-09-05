# 11: Real-Time SSE Execution Streaming

**What to build:**
Live streaming execution observability via Server-Sent Events (GET /runs/:runId/events). Streams already-existing durable execution_events from PostgreSQL with Redis Pub/Sub wake-ups and reliable replay via Last-Event-ID to ensure zero event loss on client reconnection.

**Blocked by:** 08: Fastify Control API, Idempotency, and Client SDK

**Status:** ready-for-agent

- [ ] Implement SSE endpoint GET /runs/:runId/events in Fastify with tenant access control.
- [ ] On connection, replay durable events from PostgreSQL starting after Last-Event-ID.
- [ ] Publish real-time event notifications via Redis Pub/Sub wake-up channel on state mutations, with subscriber fetching authoritative event payload from PostgreSQL.
- [ ] Integration tests verifying SSE replay across simulated client disconnection and reconnection.
