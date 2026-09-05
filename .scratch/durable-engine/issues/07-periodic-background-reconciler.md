# 07: Periodic Background Reconciler

**What to build:**
A dedicated, stateless background reconciler process (pps/reconciler) that continuously scans PostgreSQL using SELECT ... FOR UPDATE SKIP LOCKED to heal scheduling drift: re-enqueuing orphan PENDING runs, re-enqueuing due step retries, marking expired attempt leases as ABANDONED, and re-evaluating blocked versions.

**Blocked by:** 06: BullMQ Scheduling and Worker Daemon

**Status:** ready-for-agent

- [ ] Implement reconciler batch scanner using SELECT ... FOR UPDATE SKIP LOCKED with configurable polling interval (~5s default).
- [ ] Scan and re-enqueue orphan PENDING workflow runs missing from BullMQ.
- [ ] Scan due retries (step_executions.status = RETRY_WAIT and 
ext_retry_at <= NOW()) and enqueue workflow replay jobs.
- [ ] Scan expired attempt leases (lease_expires_at <= NOW()), atomically mark them ABANDONED, and schedule step retry.
- [ ] Fault-injection test: flush Redis entirely; assert reconciler reconstructs queue and workflows finish with zero loss.
- [ ] Fault-injection test: kill worker mid-step; assert reconciler marks attempt ABANDONED and retry completes.
