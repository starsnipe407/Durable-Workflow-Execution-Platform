# Durable Workflow Execution Platform

A code-first durable workflow execution engine for long-running workflows with PostgreSQL-backed durable state and transient Redis/BullMQ scheduling.

## Language

**Workflow**:
A versioned, code-first definition of an asynchronous orchestrator function whose execution progress is checkpointed durably.
_Avoid_: Job, DAG, pipeline, process

**Step**:
A discrete, named unit of durable work defined via step.run() whose successful output is memoized in PostgreSQL.
_Avoid_: Task, activity, action

**Attempt**:
A single physical invocation of a step or workflow execution bounded by a lease and heartbeat.
_Avoid_: Try, run-instance, execution-cycle

**Workflow Run**:
A single logical invocation of a workflow pinned to a specific version, holding input, output, status, and state history.
_Avoid_: Execution, instance, process-run

**Replay**:
The process of re-evaluating a workflow function where already-completed steps return memoized results from PostgreSQL instead of re-executing.
_Avoid_: Re-run, rollback, re-evaluation

**Lease**:
A time-bounded exclusive lock held on an active attempt by a worker, renewed periodically via heartbeat.
_Avoid_: Lock, mutex, reservation

**Fencing**:
A concurrency control mechanism where only the attempt ID matching active_attempt_id is permitted to commit completion to PostgreSQL.
_Avoid_: Optimistic concurrency, token validation

**Reconciler**:
A stateless repair loop that queries PostgreSQL authoritative desired state to rebuild missing BullMQ jobs, retry due steps, and abandon expired leases.
_Avoid_: Cleaner, cron job, healer, poller
