# 05: Parallel Steps and Sibling Isolation

**What to build:**
Support for concurrent steps inside a single workflow replay using native Promise.all([step.run("A", ...), step.run("B", ...)]). Verifies that parallel steps run concurrently, and if one sibling fails or retries, successful siblings remain durably committed in PostgreSQL and are never re-executed on subsequent replay.

**Blocked by:** 04: Retries, Exponential Backoff, and Timeouts

**Status:** completed

- [x] In-flight promise tracker in WorkflowExecutor to await/settle all started sibling steps before finalizing a replay invocation.
- [x] Ensure database claim and commit transactions handle concurrent sibling step execution without deadlocks.
- [x] Verify that when sibling A succeeds and sibling B fails, sibling A's output is durably committed in step_executions.
- [x] Verify that replaying the run reuses sibling A's memoized output while retrying sibling B.
- [x] Integration tests asserting sibling execution concurrency, deadlock freedom, and partial failure isolation.

## Producer-to-Consumer Interface Check (Ticket 06: BullMQ Scheduling and Worker Daemon)
- **Downstream Consumer**: Ticket 06 implements the BullMQ worker daemon that schedules workflow replays and calls WorkflowExecutor.execute(workflow, runId).
- **Interfaces Produced**: WorkflowExecutor.execute() returns Promise<TOutput | undefined> (undefined when suspended), safely settling all concurrent sibling promises before returning.
- **Compatibility Verified**: When BullMQ worker jobs invoke executor.execute(), parallel steps execute concurrently with individual database claims and commits, avoiding connection leaks, dangling background promises, and deadlocks.
