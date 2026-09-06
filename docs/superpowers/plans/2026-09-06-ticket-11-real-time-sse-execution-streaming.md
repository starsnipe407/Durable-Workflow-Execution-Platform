# Ticket 11 Implementation Plan: Real-Time SSE Execution Streaming

## Overview
Implement real-time execution observability via Server-Sent Events (`GET /runs/:runId/events`) in `apps/api`. Streams durable `execution_events` from PostgreSQL with Redis Pub/Sub wake-ups and reliable replay via `Last-Event-ID` (and query parameter fallback) ensuring zero event loss across disconnections and reconnects.

## Downstream Producer-to-Consumer Contract (Ticket 12)
- **Consumer**: Ticket 12 (`apps/dashboard` - Next.js Observability Dashboard using native `EventSource`).
- **Endpoint Path**: `GET /runs/:runId/events` (also supports `:id`).
- **Authentication**: Supports query param `?apiKey=<key>` (as native `EventSource` in browsers cannot set headers) as well as standard `x-api-key` and `Authorization: Bearer <key>` headers.
- **Replay**: Supports standard `Last-Event-ID` request header (sent automatically by `EventSource` on reconnection) and query parameter fallback `?lastEventId=<id>`.
- **Event Wire Format**:
  `id: <bigintId>\n`
  `event: <eventType>\n`
  `data: {"id":"...","tenantId":"...","workflowRunId":"...","stepExecutionId":"...","stepAttemptId":"...","eventType":"...","payload":{...},"createdAt":"..."}\n\n`
- **Stream Lifecycle**:
  - Emits `: keepalive\n\n` comment every 15s to keep idle connections open through proxies.
  - When reaching a terminal status (`WORKFLOW_COMPLETED`, `WORKFLOW_FAILED`, `WORKFLOW_CANCELLED`), streams the terminal event and gracefully ends (`reply.raw.end()`).
  - On client disconnect (`request.raw.on('close')`), cleanly unsubscribes and cleans up resources without memory or socket leaks.

---

## Tasks

### Task 1: Redis Pub/Sub Wake-Up Engine, Multiplexer, & SSE Streaming Endpoint
- Add `getRunEventsChannel(runId: string)` and `publishRunEventWakeup(publisher, runId)` in `packages/shared/src/index.ts`.
- Update `apps/api/src/plugins/auth.ts` to allow `?apiKey=<key>` query parameter in addition to headers.
- Add `onEvent?: (runId: string) => Promise<void> | void` to `WorkflowExecutorOptions` in `packages/workflow-sdk/src/executor.ts` and pass through to `StepContextImpl`. Trigger `onEvent` on state mutations (`WORKFLOW_STARTED`, step claim/complete/fail, `WORKFLOW_COMPLETED`, `WORKFLOW_FAILED`).
- In `apps/worker/src/worker.ts`, wire `onEvent` using `publishRunEventWakeup` when Redis is available, and publish on `WORKFLOW_VERSION_UNAVAILABLE`.
- In `apps/api/src/routes/runs.ts` and `apps/api/src/routes/events.ts`, publish wake-up after run creation, retry, and cancellation.
- Create `RunEventsMultiplexer` in `apps/api/src/services/run-events-multiplexer.ts` using a single duplicated Redis subscriber connection for all active SSE streams.
- Implement `GET /runs/:runId/events` in `apps/api/src/routes/runs.ts`:
  - Tenant auth check and run existence check (404 for missing/unauthorized).
  - SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`).
  - Keepalive ping timer.
  - Replay from PostgreSQL where `id > lastSentId` ordered by `id ASC`.
  - Redis Pub/Sub wake-up subscription with concurrency-safe loop (`isFetching` / `hasPendingWakeup`).
  - Clean stream closure on terminal event or client disconnect.
- Update `rateLimitPlugin` default exempt routes to include `/runs/:runId/events`.
- Extend `packages/client` with `client.runs.streamEvents(runId, options)` async generator using native `fetch`.
- Verify with strict TDD in `apps/api/test/sse-streaming.test.ts`.

### Task 2: End-to-End SSE Replay & Streaming Integration Tests
- Write comprehensive tests in `apps/api/test/sse-streaming.test.ts` verifying:
  - Durable replay of existing events on connection.
  - Real-time event streaming via Redis Pub/Sub wake-up as worker executes workflow steps.
  - Disconnection and reconnection with `Last-Event-ID` replaying only missed events (asserting zero duplicate events).
  - Stream termination upon `WORKFLOW_COMPLETED` and `WORKFLOW_FAILED`.
  - Multi-tenant isolation (tenant B cannot stream tenant A's run).
  - Query parameter authentication (`?apiKey=...`).
  - Graceful connection cleanup on client disconnect without unhandled rejections or leaked intervals.
- Full test pass across all packages.

### Task 3: Issue Completion & Verification Gate
- Run all monorepo checks (`pnpm build`, `pnpm test`).
- Mark all Ticket 11 checklist items complete in `.scratch/durable-engine/issues/11-real-time-sse-execution-streaming.md`.
- Update `.superpowers/sdd/progress.md`.
- Prepare branch diff package for two-axis review (Standards + Spec).
