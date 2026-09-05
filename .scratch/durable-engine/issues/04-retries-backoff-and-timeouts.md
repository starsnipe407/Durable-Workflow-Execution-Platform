# 04: Retries, Exponential Backoff, and Timeouts

**What to build:**
Per-step failure management in step.run(key, options, fn). When a step handler throws or exceeds its timeout, the engine records the failed attempt in PostgreSQL, calculates exponential backoff with jitter, sets step_executions.status = RETRY_WAIT and next_retry_at, and throws WorkflowSuspendedError until due.

**Blocked by:** 03: Core SDK and Replay Walking Skeleton

**Status:** completed

- [x] Support StepOptions: retries, backoff (initialMs, maxMs, jitter), and timeoutMs.
- [x] Wrap handler execution with AbortController bounded by timeoutMs, marking timed-out attempts as TIMED_OUT.
- [x] Persist failed attempt errors and transition step to RETRY_WAIT with calculated next_retry_at.
- [x] Replay engine respects RETRY_WAIT and suspends workflow until next_retry_at is reached.
- [x] If retry limit is exhausted, step transitions to FAILED and fails the workflow run.
- [x] Integration tests verifying backoff calculation, timeout aborts, and retry attempt progressions.
