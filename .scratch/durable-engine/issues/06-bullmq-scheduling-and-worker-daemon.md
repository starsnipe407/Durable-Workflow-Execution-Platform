# 06: BullMQ Scheduling and Worker Daemon

**What to build:**
Asynchronous workflow run scheduling using Redis and BullMQ (apps/worker). Decouples run triggering from worker execution. BullMQ jobs carry minimal descriptors (runId, workflowName, workflowVersion, tenantId), and worker processes pull jobs, execute the workflow replay loop, and acknowledge completion.

**Blocked by:** 05: Parallel Steps and Sibling Isolation

**Status:** completed

- [x] Implement queue producer for enqueuing workflow run replay jobs into BullMQ.
- [x] Implement apps/worker daemon running BullMQ worker consumers.
- [x] Worker loads authoritative run state from PostgreSQL; no-ops if run is terminal (COMPLETED / FAILED / CANCELLED).
- [x] Worker dispatches to local registered workflow definition matching exact name and version.
- [x] If version is missing locally, worker marks locked_reason = WORKFLOW_VERSION_UNAVAILABLE and keeps run PENDING.
- [x] Integration tests proving end-to-end async execution: enqueue BullMQ job -> worker picks up -> workflow completes.

## Producer-to-Consumer Interface Check (Ticket 07: Periodic Background Reconciler)
- **Downstream Consumer**: Ticket 07 (`apps/reconciler`)
- **Interfaces Produced**: `createWorkflowQueue`, `enqueueWorkflowRun`, `WORKFLOW_QUEUE_NAME = "workflow-runs"`, `WorkflowRunJobData`
- **Compatibility Verified**: Ticket 07 can directly import queue producer utilities from `@durable/worker` to re-enqueue orphan runs and due step retries into BullMQ.
