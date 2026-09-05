# 03: Core SDK and Replay Walking Skeleton

**What to build:**
The developer-facing workflow SDK (packages/workflow-sdk) and execution engine proving the core durable guarantee: a two-step workflow (step-1 -> step-2) where step-1 commits, the worker crashes, and a fresh replay executes step-2 while returning the memoized result of step-1 (call count = 1). Emits durable WORKFLOW_CREATED, WORKFLOW_STARTED, STEP_STARTED, STEP_COMPLETED, and WORKFLOW_COMPLETED execution events atomically with state transitions.

**Blocked by:** 02: Database Schema and Fenced Persistence

**Status:** ready-for-agent

- [ ] Implement defineWorkflow supporting standard sync ({ input, step }) => { ... } handlers.
- [ ] Implement step.run(key, fn) with in-memory Set<string> duplicate key detection throwing DuplicateStepKeyError.
- [ ] Implement WorkflowSuspendedError sentinel thrown when encountering incomplete/waiting steps during replay to unwind the stack cleanly.
- [ ] Implement WorkflowExecutor that loads run state, coordinates step execution/replay, and invokes user handlers outside open database transactions.
- [ ] Append durable execution events (WORKFLOW_STARTED, STEP_COMPLETED, WORKFLOW_COMPLETED) atomically during state mutations.
- [ ] Provide end-to-end integration test proving the crash and replay invariant with memoized step outputs and verifying corresponding execution events are recorded.
