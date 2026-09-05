# 05: Parallel Steps and Sibling Isolation

**What to build:**
Support for concurrent steps inside a single workflow replay using native Promise.all([step.run("A", ...), step.run("B", ...)]). Verifies that parallel steps run concurrently, and if one sibling fails or retries, successful siblings remain durably committed in PostgreSQL and are never re-executed on subsequent replay.

**Blocked by:** 04: Retries, Exponential Backoff, and Timeouts

**Status:** ready-for-agent

- [ ] In-flight promise tracker in WorkflowExecutor to await/settle all started sibling steps before finalizing a replay invocation.
- [ ] Ensure database claim and commit transactions handle concurrent sibling step execution without deadlocks.
- [ ] Verify that when sibling A succeeds and sibling B fails, sibling A''s output is durably committed in step_executions.
- [ ] Verify that replaying the run reuses sibling A''s memoized output while retrying sibling B.
- [ ] Integration tests asserting sibling execution concurrency, deadlock freedom, and partial failure isolation.
