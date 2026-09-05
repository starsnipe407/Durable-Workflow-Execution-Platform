# 07: Periodic Background Reconciler

**What to build:**
A dedicated, stateless background reconciler process (apps/reconciler) that continuously scans PostgreSQL using SELECT ... FOR UPDATE SKIP LOCKED to heal scheduling drift: re-enqueuing orphan PENDING runs, re-enqueuing due step retries, marking expired attempt leases as ABANDONED, and re-evaluating blocked versions.

**Blocked by:** 06: BullMQ Scheduling and Worker Daemon

**Status:** completed

- [x] Implement reconciler batch scanner using SELECT ... FOR UPDATE SKIP LOCKED with configurable polling interval (~5s default).
- [x] Scan and re-enqueue orphan PENDING workflow runs missing from BullMQ.
- [x] Scan due retries (step_executions.status = RETRY_WAIT and next_retry_at <= NOW()) and enqueue workflow replay jobs.
- [x] Scan expired attempt leases (lease_expires_at <= NOW()), atomically mark them ABANDONED, and schedule step retry.
- [x] Fault-injection test: flush Redis entirely; assert reconciler reconstructs queue and workflows finish with zero loss.
- [x] Fault-injection test: kill worker mid-step; assert reconciler marks attempt ABANDONED and retry completes.

## Producer-to-Consumer Interface Check (Downstream: Ticket 08 - Fastify Control API)
- **Downstream Consumer**: Ticket 08 (`apps/api` - Fastify Control API)
- **Interfaces Produced**: `Reconciler` class in `@durable/reconciler` (`apps/reconciler`) with `reconcileOnce()` and `start()` / `stop()` lifecycle.
- **Compatibility Verified**: Ticket 08 does not require distributed two-phase transactions between PostgreSQL and Redis. When `POST /runs` creates a `PENDING` run in PostgreSQL, the background reconciler guarantees autonomous healing and BullMQ job scheduling even if immediate enqueue fails or Redis restarts.
