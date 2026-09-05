# 06: BullMQ Scheduling and Worker Daemon

**What to build:**
Asynchronous workflow run scheduling using Redis and BullMQ (pps/worker). Decouples run triggering from worker execution. BullMQ jobs carry minimal descriptors (unId, workflowName, workflowVersion, 	enantId), and worker processes pull jobs, execute the workflow replay loop, and acknowledge completion.

**Blocked by:** 05: Parallel Steps and Sibling Isolation

**Status:** ready-for-agent

- [ ] Implement queue producer for enqueuing workflow run replay jobs into BullMQ.
- [ ] Implement pps/worker daemon running BullMQ worker consumers.
- [ ] Worker loads authoritative run state from PostgreSQL; no-ops if run is terminal (COMPLETED / FAILED / CANCELLED).
- [ ] Worker dispatches to local registered workflow definition matching exact name and version.
- [ ] If version is missing locally, worker marks locked_reason = WORKFLOW_VERSION_UNAVAILABLE and keeps run PENDING.
- [ ] Integration tests proving end-to-end async execution: enqueue BullMQ job -> worker picks up -> workflow completes.
