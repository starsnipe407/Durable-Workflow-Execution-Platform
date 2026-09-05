# 04: Retries, Exponential Backoff, and Timeouts

**What to build:**
Per-step failure management in step.run(key, options, fn). When a step handler throws or exceeds its timeout, the engine records the failed attempt in PostgreSQL, calculates exponential backoff with jitter, sets step_executions.status = RETRY_WAIT and 
ext_retry_at, and throws WorkflowSuspendedError until due.

**Blocked by:** 03: Core SDK and Replay Walking Skeleton

**Status:** ready-for-agent

- [ ] Support StepOptions: etries, ackoff (initialMs, maxMs, jitter), and 	imeoutMs.
- [ ] Wrap handler execution with AbortController bounded by 	imeoutMs, marking timed-out attempts as TIMED_OUT.
- [ ] Persist failed attempt errors and transition step to RETRY_WAIT with calculated 
ext_retry_at.
- [ ] Replay engine respects RETRY_WAIT and suspends workflow until 
ext_retry_at is reached.
- [ ] If retry limit is exhausted, step transitions to FAILED and fails the workflow run.
- [ ] Integration tests verifying backoff calculation, timeout aborts, and retry attempt progressions.
