# Ticket 12 Implementation Plan: Next.js Observability Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a responsive, real-time observability web dashboard in `apps/dashboard` (Next.js 16.3 App Router, React 19, Tailwind CSS v4, TanStack Query v5) for operators to monitor system health, inspect workflows, filter execution runs, and track real-time execution steps, attempt histories, and payloads via SSE and BFF proxying without client-side secret exposure.

**Architecture:** A Next.js App Router application in `apps/dashboard` backed by a same-origin Catch-All BFF Proxy Route (`/api/[...path]`) that injects the server-side `DURABLE_API_KEY` into upstream requests to `apps/api` and transparently pipes real-time SSE streams. The frontend renders KPI metrics, workflow catalog tables, filterable run lists, and a flagship run detail view featuring a chronological vertical step timeline with concurrent overlap badges, collapsible attempt histories, input/output JSON viewers, retry/cancel controls, and native `EventSource` live state hydration.

**Tech Stack:** Next.js 16.3 (Active LTS App Router), React 19, TypeScript, Tailwind CSS v4 (`@tailwindcss/postcss`), TanStack Query v5 (`@tanstack/react-query`), Lucide React (`lucide-react`), Fastify / Prisma / Redis on backend (`apps/api`), Vitest + React Testing Library + JSDOM for testing.

---

## Global Constraints

- **Ponytail Intensity**: FULL (lean, minimal code, standard libraries first, zero unneeded abstractions, native fetch).
- **Approved Commodity Libraries**: Next.js, React, Tailwind CSS, TanStack Query, Lucide React, Fastify, Prisma, BullMQ, ioredis, Zod.
- **Clean-Room TypeScript**: All UI components, state reducers, timeline layout calculators, and BFF proxying logic must be original, clean-room TypeScript implementations.
- **Security & Multi-Tenancy**: No client-side secret exposure (`NEXT_PUBLIC_*` or `localStorage`). All upstream API requests flow through the server-side BFF proxy injecting `DURABLE_API_KEY`.
- **Git Commits**: Author and Committer MUST be `Aztrek <starsnipe407@gmail.com>` on every commit.
- **Review Gate**: Any review findings require immediate resolution and a mandatory re-review pass with 0 findings before proceeding.

---

## Downstream Producer-to-Consumer Contract (Ticket 13)

- **Consumer**: Ticket 13 (`examples/order-processing` canonical reference app & benchmark suites).
- **API Interfaces Provided**:
  - `GET /metrics`:
    - Response: `{ activeRuns: number, completedRuns: number, failedRuns: number, cancelledRuns: number, totalRuns: number, systemStatus: 'healthy' | 'degraded' }`.
    - Used by benchmarks to verify platform health and poll terminal run counts.
  - `GET /workflows`:
    - Response: `{ workflows: Array<{ name: string, versions: string[], triggers: Array<{ eventName: string, workflowVersion: string }>, concurrency?: { globalLimit?: number; perKey: boolean }, totalRuns: number, lastRunAt?: string | null }> }`.
    - Used by test suites and operators to verify registered workflow versions and event bindings.
  - `GET /runs/:id`:
    - Enriched response: Includes `stepExecutions` ordered by `createdAt ASC`, with nested `stepAttempts` ordered by `attemptNumber ASC`.
- **UI Interfaces Provided**:
  - Web dashboard hosted at `apps/dashboard` (default `http://localhost:3001` or proxy port) rendering:
    - `/dashboard` (and `/`): Overview KPIs and System Health.
    - `/workflows`: Catalog of registered workflows and event triggers.
    - `/runs`: Searchable, filterable list of workflow runs.
    - `/runs/:id`: Flagship run detail view with real-time SSE execution timeline.

---

## File Structure & Decomposition

```
apps/api/
├── src/
│   ├── routes/
│   │   ├── metrics.ts               # GET /metrics (tenant KPI metrics + system health)
│   │   ├── workflows.ts             # GET /workflows (tenant workflow catalog + bindings)
│   │   └── runs.ts                  # Enriched GET /runs/:id with nested stepAttempts
│   └── app.ts                       # Register metrics & workflows routes
└── test/
    └── metrics-workflows.test.ts    # Integration tests for /metrics and /workflows

apps/dashboard/
├── package.json                     # @durable/dashboard (Next 16.3, React 19, Tailwind v4, TanStack Query v5)
├── tsconfig.json                    # Dashboard TypeScript configuration
├── next.config.ts                   # Next.js configuration
├── postcss.config.mjs               # PostCSS with @tailwindcss/postcss
├── vitest.config.ts                 # Vitest with JSDOM and React testing library
├── src/
│   ├── app/
│   │   ├── globals.css              # Tailwind CSS imports & theme styling
│   │   ├── layout.tsx               # Root layout with QueryClientProvider & Navigation shell
│   │   ├── page.tsx                 # Root redirect / Overview dashboard
│   │   ├── dashboard/
│   │   │   └── page.tsx             # Overview screen (KPI cards, health status, recent runs)
│   │   ├── workflows/
│   │   │   └── page.tsx             # Workflows catalog screen
│   │   ├── runs/
│   │   │   ├── page.tsx             # Runs list screen with filters & pagination
│   │   │   └── [id]/
│   │   │       └── page.tsx         # Flagship Run detail view
│   │   └── api/
│   │       └── [...path]/
│   │           └── route.ts         # BFF Catch-All Proxy (REST + SSE streaming + API key injection)
│   ├── components/
│   │   ├── layout/
│   │   │   └── Navbar.tsx           # Navigation bar with active state & system health badge
│   │   ├── dashboard/
│   │   │   ├── MetricCard.tsx       # KPI card component
│   │   │   └── SystemHealthBadge.tsx# Healthy / Degraded badge indicator
│   │   ├── runs/
│   │   │   ├── StatusBadge.tsx      # Color-coded status badge for workflow runs & steps
│   │   │   └── RunsFilterBar.tsx    # Filter bar for status, workflow name, and pagination
│   │   └── run-detail/
│   │       ├── StepTimeline.tsx     # Chronological vertical step timeline with Concurrent badge
│   │       ├── AttemptInspector.tsx # Collapsible step attempt history & error details
│   │       ├── JsonViewer.tsx       # Input/Output JSON tree viewer
│   │       └── RunActions.tsx       # Retry & Cancel buttons with optimistic status update
│   ├── hooks/
│   │   └── use-run-events.ts        # Native EventSource hook with typed SSE event reducer
│   └── lib/
│       ├── types.ts                 # Shared UI & API contract types
│       ├── query-client.tsx         # TanStack Query client & React provider
│       └── sse-reducer.ts           # Pure typed reducer for durable execution events
└── test/
    ├── bff-proxy.test.ts            # Route handler BFF proxy tests (REST + SSE streaming)
    ├── sse-reducer.test.ts          # Unit tests for pure SSE event reducer
    ├── dashboard-workflows.test.tsx # Component tests for Overview and Workflows screens
    ├── runs-list.test.tsx           # Component tests for Runs list and filters
    └── run-detail.test.tsx          # Component tests for Run detail, timeline, and actions
```

---

## Tasks

### Task 1: Backend API Endpoints (`GET /metrics` and `GET /workflows`) & Run Attempt Enrichment

**Files:**
- Create: `apps/api/src/routes/metrics.ts`
- Create: `apps/api/src/routes/workflows.ts`
- Modify: `apps/api/src/routes/runs.ts:140-145`
- Modify: `apps/api/src/app.ts:6-10,50-55`
- Test: `apps/api/test/metrics-workflows.test.ts`

**Interfaces:**
- Consumes: `PrismaClient`, `Redis`, `authenticateApiKey`.
- Produces:
  - `GET /metrics` returning:
    ```ts
    {
      activeRuns: number;
      completedRuns: number;
      failedRuns: number;
      cancelledRuns: number;
      totalRuns: number;
      systemStatus: 'healthy' | 'degraded';
    }
    ```
  - `GET /workflows` returning:
    ```ts
    {
      workflows: Array<{
        name: string;
        versions: string[];
        triggers: Array<{ eventName: string; workflowVersion: string }>;
        concurrency?: { globalLimit?: number; perKey: boolean };
        totalRuns: number;
        lastRunAt?: string | null;
      }>;
    }
    ```
  - `GET /runs/:id`: enriched with `stepExecutions.include.stepAttempts`.

- [ ] **Step 1: Write the failing integration test**
Create `apps/api/test/metrics-workflows.test.ts` testing:
1. `GET /metrics` returns correct counts for active (`RUNNING`, `PENDING`, `CANCEL_REQUESTED`), completed, failed, cancelled, and total runs scoped strictly to the authenticated tenant.
2. `GET /metrics` reports `systemStatus: 'healthy'` when Postgres and Redis respond, and `'degraded'` when Redis fails or is unreachable.
3. `GET /workflows` returns aggregated list of workflow definitions, versions, event triggers, total run counts, and last run timestamp for the authenticated tenant.
4. `GET /runs/:id` returns step executions with nested `stepAttempts` ordered by `attemptNumber ASC`.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @durable/api test test/metrics-workflows.test.ts`
Expected: FAIL with 404 on `/metrics` and `/workflows`.

- [ ] **Step 3: Implement `apps/api/src/routes/metrics.ts`**
Implement `metricsRoutes(app, options)`:
- Authenticate using `authenticateApiKey(options.prisma)`.
- Query `prisma.workflowRun.groupBy` or count by status for `request.tenantId`.
- Check database connectivity via `prisma.$queryRaw` SELECT 1.
- Check Redis connectivity via `options.redis.ping()`.
- Return status and run counts.

- [ ] **Step 4: Implement `apps/api/src/routes/workflows.ts`**
Implement `workflowsRoutes(app, options)`:
- Authenticate using `authenticateApiKey(options.prisma)`.
- Fetch `prisma.workflowDefinition.findMany({ where: { tenantId: request.tenantId } })`.
- Fetch `prisma.workflowEventBinding.findMany({ where: { tenantId: request.tenantId } })`.
- Fetch distinct run names and count/lastRunAt from `prisma.workflowRun`.
- Aggregate and return formatted workflows list.

- [ ] **Step 5: Enrich `apps/api/src/routes/runs.ts` with nested `stepAttempts`**
In `apps/api/src/routes/runs.ts`, update `GET /runs/:id` to include:
```ts
include: {
  stepExecutions: {
    orderBy: { createdAt: 'asc' },
    include: {
      stepAttempts: {
        orderBy: { attemptNumber: 'asc' },
      },
    },
  },
}
```

- [ ] **Step 6: Mount routes in `apps/api/src/app.ts`**
Register `metricsRoutes(app, options)` and `workflowsRoutes(app, options)`.

- [ ] **Step 7: Run test to verify it passes**
Run: `pnpm --filter @durable/api test test/metrics-workflows.test.ts`
Expected: PASS with 100% assertions green.

- [ ] **Step 8: Verify all api tests pass & commit**
Run: `pnpm --filter @durable/api test`
```bash
git add apps/api/src/routes/metrics.ts apps/api/src/routes/workflows.ts apps/api/src/routes/runs.ts apps/api/src/app.ts apps/api/test/metrics-workflows.test.ts
git commit --author="Aztrek <starsnipe407@gmail.com>" -m "feat(api): add metrics and workflows endpoints and enrich run step attempts"
```

---

### Task 2: `apps/dashboard` Project Scaffolding, Shared Types, & Catch-All BFF Proxy Route

**Files:**
- Create: `apps/dashboard/package.json`
- Create: `apps/dashboard/tsconfig.json`
- Create: `apps/dashboard/next.config.ts`
- Create: `apps/dashboard/postcss.config.mjs`
- Create: `apps/dashboard/src/app/globals.css`
- Create: `apps/dashboard/src/lib/types.ts`
- Create: `apps/dashboard/src/lib/query-client.tsx`
- Create: `apps/dashboard/src/app/api/[...path]/route.ts`
- Create: `apps/dashboard/vitest.config.ts`
- Test: `apps/dashboard/test/bff-proxy.test.ts`

**Interfaces:**
- Consumes: `process.env.DURABLE_API_URL`, `process.env.DURABLE_API_KEY`.
- Produces:
  - Catch-All Next.js Route Handler `GET/POST/PUT/DELETE /api/[...path]`:
    - Proxies all client requests to `apps/api`.
    - Injects `x-api-key: process.env.DURABLE_API_KEY`.
    - Forward `Last-Event-ID` header if present.
    - Transparently streams SSE if upstream responds with `text/event-stream`.
  - Shared TypeScript types in `src/lib/types.ts`.

- [ ] **Step 1: Write the failing BFF proxy test**
Create `apps/dashboard/test/bff-proxy.test.ts` testing:
1. REST request forwarding (`GET /api/runs` -> `GET ${apiUrl}/runs`) injecting `x-api-key`.
2. POST request forwarding (`POST /api/runs/:id/retry` -> `POST ${apiUrl}/runs/:id/retry`) with request body and injected key.
3. SSE streaming forwarding (`GET /api/runs/:id/events` -> upstream SSE endpoint) preserving `Content-Type: text/event-stream`, forwarding `Last-Event-ID`, and streaming chunks as a `ReadableStream`.
4. Upstream error propagation (e.g. 404 or 400 JSON responses forwarded cleanly with status code).

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @durable/dashboard test test/bff-proxy.test.ts`
Expected: FAIL (files not found / not scaffolded).

- [ ] **Step 3: Create package configuration & dependencies**
Create `apps/dashboard/package.json` with dependencies:
- `next`: `^16.3.3`
- `react`: `^19.0.0`
- `react-dom`: `^19.0.0`
- `@tanstack/react-query`: `^5.67.2`
- `lucide-react`: `^1.16.0`
- `tailwindcss`: `^4.0.9`
- `@tailwindcss/postcss`: `^4.0.9`
- devDependencies: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `typescript`, `@types/react`, `@types/node`.
Run `pnpm install` from root to link workspace dependencies.

- [ ] **Step 4: Create tsconfig, next config, postcss, globals.css, and shared types**
Create:
- `apps/dashboard/tsconfig.json` (Next.js TypeScript config with `@/*` path alias).
- `apps/dashboard/next.config.ts`.
- `apps/dashboard/postcss.config.mjs`.
- `apps/dashboard/src/app/globals.css`.
- `apps/dashboard/src/lib/types.ts` (defining `WorkflowRun`, `StepExecution`, `StepAttempt`, `WorkflowDefinition`, `MetricsResponse`, `WorkflowExecutionEvent`).
- `apps/dashboard/src/lib/query-client.tsx` (exporting `QueryProvider` client component with staleTime: 5000ms).

- [ ] **Step 5: Implement Catch-All Route Handler `apps/dashboard/src/app/api/[...path]/route.ts`**
Implement:
```ts
import { NextRequest } from 'next/server';

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleProxy(request, await params);
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleProxy(request, await params);
}
```
In `handleProxy`:
- Resolve upstream: `process.env.DURABLE_API_URL || 'http://localhost:3000'`.
- Forward path and query search string.
- Inject `x-api-key: process.env.DURABLE_API_KEY || ''`.
- Forward `Last-Event-ID` if present.
- If upstream returns `text/event-stream`, return `new Response(res.body, { status: res.status, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive' } })`.
- Otherwise return `new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' } })`.

- [ ] **Step 6: Run BFF proxy test to verify it passes**
Run: `pnpm --filter @durable/dashboard test test/bff-proxy.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add apps/dashboard
git commit --author="Aztrek <starsnipe407@gmail.com>" -m "feat(dashboard): scaffold Next.js dashboard and implement catch-all BFF proxy route"
```

---

### Task 3: Dashboard Overview (`/` and `/dashboard`) & Workflows Screen (`/workflows`)

**Files:**
- Create: `apps/dashboard/src/components/layout/Navbar.tsx`
- Create: `apps/dashboard/src/components/dashboard/MetricCard.tsx`
- Create: `apps/dashboard/src/components/dashboard/SystemHealthBadge.tsx`
- Create: `apps/dashboard/src/app/layout.tsx`
- Create: `apps/dashboard/src/app/page.tsx`
- Create: `apps/dashboard/src/app/dashboard/page.tsx`
- Create: `apps/dashboard/src/app/workflows/page.tsx`
- Test: `apps/dashboard/test/dashboard-workflows.test.tsx`

**Interfaces:**
- Consumes: `/api/metrics`, `/api/workflows`, `/api/runs?limit=5`.
- Produces:
  - Responsive Shell layout with top navigation bar.
  - Overview screen displaying KPI cards (Total Runs, Active Runs, Completed Runs, Failed Runs), System Health indicator, and recent runs table.
  - Workflows screen listing registered workflows, versions, event triggers, concurrency policy badges, and total execution counts.

- [ ] **Step 1: Write the failing component test**
Create `apps/dashboard/test/dashboard-workflows.test.tsx` testing:
1. `Navbar` renders links to `/dashboard`, `/workflows`, `/runs`, and displays the system health badge.
2. `DashboardOverview` renders metric cards with values fetched from `/api/metrics`, displays degraded status warning when health is degraded, and renders recent runs table with links to `/runs/[id]`.
3. `WorkflowsPage` renders table of workflows fetched from `/api/workflows` displaying workflow name, version pills, event trigger badges, concurrency limits, and last run timestamp.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @durable/dashboard test test/dashboard-workflows.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement Navigation Shell & Metric Components**
Create:
- `apps/dashboard/src/components/layout/Navbar.tsx`: Top navbar with brand logo, nav links (`Overview`, `Workflows`, `Runs`), and `SystemHealthBadge`.
- `apps/dashboard/src/components/dashboard/SystemHealthBadge.tsx`: Pill badge showing "Healthy" (green pulse) or "Degraded" (amber/red pulse) queried from `/api/metrics`.
- `apps/dashboard/src/components/dashboard/MetricCard.tsx`: Card component accepting label, value, icon, change/description, and color tone.
- `apps/dashboard/src/app/layout.tsx`: Root layout importing `globals.css`, wrapping children in `QueryProvider` and `Navbar`.

- [ ] **Step 4: Implement Overview Page (`/` and `/dashboard`)**
Create:
- `apps/dashboard/src/app/page.tsx` and `apps/dashboard/src/app/dashboard/page.tsx`:
  - Fetch metrics via TanStack Query: `useQuery({ queryKey: ['metrics'], queryFn: () => fetch('/api/metrics').then(r => r.json()) })`.
  - Fetch recent runs: `useQuery({ queryKey: ['runs', 'recent'], queryFn: () => fetch('/api/runs?limit=5').then(r => r.json()) })`.
  - Render 4 KPI cards: Total Runs, Active Runs, Completed Runs, Failed Runs.
  - Render Recent Runs table with quick navigation to `/runs/[id]`.

- [ ] **Step 5: Implement Workflows Catalog Page (`/workflows`)**
Create:
- `apps/dashboard/src/app/workflows/page.tsx`:
  - Fetch workflows via TanStack Query: `useQuery({ queryKey: ['workflows'], queryFn: () => fetch('/api/workflows').then(r => r.json()) })`.
  - Render table with columns:
    - Workflow Name
    - Available Versions (tags/badges)
    - Triggers / Event Bindings (event name badges)
    - Concurrency Policy (`globalLimit`, `perKey` badge)
    - Total Executions
    - Last Executed At (relative timestamp)

- [ ] **Step 6: Run component test to verify it passes**
Run: `pnpm --filter @durable/dashboard test test/dashboard-workflows.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add apps/dashboard/src/components apps/dashboard/src/app/layout.tsx apps/dashboard/src/app/page.tsx apps/dashboard/src/app/dashboard apps/dashboard/src/app/workflows apps/dashboard/test/dashboard-workflows.test.tsx
git commit --author="Aztrek <starsnipe407@gmail.com>" -m "feat(dashboard): implement navigation shell, overview dashboard, and workflows catalog"
```

---

### Task 4: Runs Explorer Screen (`/runs`) with Filters & Pagination

**Files:**
- Create: `apps/dashboard/src/components/runs/StatusBadge.tsx`
- Create: `apps/dashboard/src/components/runs/RunsFilterBar.tsx`
- Create: `apps/dashboard/src/app/runs/page.tsx`
- Test: `apps/dashboard/test/runs-list.test.tsx`

**Interfaces:**
- Consumes: `/api/runs?status=...&workflowName=...&limit=...`, `/api/workflows`.
- Produces:
  - Runs listing page with status filter pills (`ALL`, `RUNNING`, `PENDING`, `COMPLETED`, `FAILED`, `CANCELLED`), workflow name filter dropdown, limit controls, and pagination.
  - Table displaying Run ID, Workflow Name, Version, Status, Trigger Type, Duration, and Started/Created timestamp.

- [ ] **Step 1: Write the failing component test**
Create `apps/dashboard/test/runs-list.test.tsx` testing:
1. `StatusBadge` renders proper colors and text for each status (`COMPLETED` green, `RUNNING` blue, `FAILED` red, `CANCELLED` gray, `PENDING` yellow).
2. `RunsFilterBar` updates URL search params or filter state when changing status filter or workflow dropdown.
3. `RunsPage` renders table of runs, shows loading skeleton while fetching, displays empty state when no runs match filter, and navigates to `/runs/[id]` on run row click.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @durable/dashboard test test/runs-list.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `StatusBadge` and `RunsFilterBar`**
Create:
- `apps/dashboard/src/components/runs/StatusBadge.tsx`: Color-coded badge with icons for each `WorkflowRunStatus` and `StepExecutionStatus`.
- `apps/dashboard/src/components/runs/RunsFilterBar.tsx`: Filter bar with Status filter buttons, Workflow name select dropdown, search input, and Refresh button.

- [ ] **Step 4: Implement Runs Page (`apps/dashboard/src/app/runs/page.tsx`)**
Implement:
- Manage query params (`status`, `workflowName`, `page`, `limit`).
- Fetch runs via TanStack Query: `queryKey: ['runs', { status, workflowName, limit }]`.
- Render runs table with clickable rows linking to `/runs/${run.id}`.
- Render pagination controls (Next/Previous page).

- [ ] **Step 5: Run component test to verify it passes**
Run: `pnpm --filter @durable/dashboard test test/runs-list.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add apps/dashboard/src/components/runs apps/dashboard/src/app/runs/page.tsx apps/dashboard/test/runs-list.test.tsx
git commit --author="Aztrek <starsnipe407@gmail.com>" -m "feat(dashboard): implement runs explorer screen with filters and pagination"
```

---

### Task 5: Flagship Run Detail View (`/runs/[id]`) with Timeline, Attempt Inspector, JSON Viewers, Controls & SSE Hydration

**Files:**
- Create: `apps/dashboard/src/lib/sse-reducer.ts`
- Create: `apps/dashboard/src/hooks/use-run-events.ts`
- Create: `apps/dashboard/src/components/run-detail/StepTimeline.tsx`
- Create: `apps/dashboard/src/components/run-detail/AttemptInspector.tsx`
- Create: `apps/dashboard/src/components/run-detail/JsonViewer.tsx`
- Create: `apps/dashboard/src/components/run-detail/RunActions.tsx`
- Create: `apps/dashboard/src/app/runs/[id]/page.tsx`
- Test: `apps/dashboard/test/sse-reducer.test.ts`
- Test: `apps/dashboard/test/run-detail.test.tsx`

**Interfaces:**
- Consumes: `/api/runs/:id`, `/api/runs/:id/events` (via BFF proxy), `POST /api/runs/:id/retry`, `POST /api/runs/:id/cancel`.
- Produces:
  - Pure typed SSE reducer (`reduceRunEvents(currentRun, event)`).
  - Chronological vertical step timeline:
    - Calculates time overlaps between neighboring steps and flags overlapping steps with a `Concurrent` badge without guessing `Promise.all` branches.
  - Attempt Inspector:
    - Shows expanded attempt records (workerId, timestamps, lease, error metadata, retry delay).
  - JSON Viewers for input, output, and error payloads.
  - Action buttons:
    - "Retry Run" (active only on `FAILED`).
    - "Cancel Run" (active on `PENDING` or `RUNNING`).
  - Real-time native `EventSource` live hydration:
    - Connects to `/api/runs/:id/events`.
    - Patches query cache in real-time.
    - Triggers authoritative refetch on terminal event (`WORKFLOW_COMPLETED`, `WORKFLOW_FAILED`, `WORKFLOW_CANCELLED`).

- [ ] **Step 1: Write failing unit tests for `sse-reducer`**
Create `apps/dashboard/test/sse-reducer.test.ts` testing:
1. `STEP_STARTED`: updates step execution status to `RUNNING`, records `startedAt`. Does not invent or increment attempt count unless payload explicitly provides it.
2. `STEP_ATTEMPT_FAILED`: updates step status to `RETRY_WAIT` or `FAILED`, attaches error message and payload.
3. `STEP_RETRY_SCHEDULED`: updates `nextRetryAt` on the step.
4. `STEP_COMPLETED`: updates step execution status to `COMPLETED`, records `completedAt` and `output`.
5. Terminal events (`WORKFLOW_COMPLETED`, `WORKFLOW_FAILED`, `WORKFLOW_CANCELLED`): updates run status and terminal timestamp.

- [ ] **Step 2: Run reducer test to verify it fails**
Run: `pnpm --filter @durable/dashboard test test/sse-reducer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `apps/dashboard/src/lib/sse-reducer.ts`**
Implement pure function `reduceRunEvent(run: WorkflowRun, event: WorkflowExecutionEvent): WorkflowRun`.

- [ ] **Step 4: Run reducer test to verify it passes**
Run: `pnpm --filter @durable/dashboard test test/sse-reducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing component tests for Run Detail screen**
Create `apps/dashboard/test/run-detail.test.tsx` testing:
1. Renders run header with workflow name, version, status badge, trigger type, concurrency key.
2. Renders vertical step timeline in chronological order.
3. Adds `Concurrent` badge to steps that have overlapping execution windows (`startedAt` <= other `completedAt`).
4. Expanding a step opens the `AttemptInspector` displaying workerId, status, duration, and error payload.
5. Collapsible `JsonViewer` formats input and output JSON cleanly.
6. Clicking "Cancel" invokes `POST /api/runs/:id/cancel` and updates status to `CANCEL_REQUESTED` or `CANCELLED`.
7. Clicking "Retry" invokes `POST /api/runs/:id/retry` and updates status to `PENDING`.

- [ ] **Step 6: Run component test to verify it fails**
Run: `pnpm --filter @durable/dashboard test test/run-detail.test.tsx`
Expected: FAIL.

- [ ] **Step 7: Implement `use-run-events.ts` and components**
Create:
- `apps/dashboard/src/hooks/use-run-events.ts`:
  - Uses native `EventSource` connecting to `/api/runs/${runId}/events`.
  - On incoming message: parses `WorkflowExecutionEvent`, updates TanStack Query data via `queryClient.setQueryData(['run', runId], (prev) => reduceRunEvent(prev, event))`.
  - On terminal event (`WORKFLOW_COMPLETED`, `WORKFLOW_FAILED`, `WORKFLOW_CANCELLED`): closes `EventSource` and calls `queryClient.invalidateQueries({ queryKey: ['run', runId] })`.
  - Cleans up `eventSource.close()` on unmount or runId change.
- `apps/dashboard/src/components/run-detail/StepTimeline.tsx`:
  - Sorts step executions by `startedAt || createdAt` ascending.
  - Computes time overlap with previous/next steps. If overlap detected, displays `Concurrent` badge.
- `apps/dashboard/src/components/run-detail/AttemptInspector.tsx`:
  - Renders list of attempts for a step execution.
  - Shows attempt number, worker ID, execution duration, and full formatted error card if failed.
- `apps/dashboard/src/components/run-detail/JsonViewer.tsx`:
  - Renders syntax-highlighted / formatted JSON viewer with copy-to-clipboard button.
- `apps/dashboard/src/components/run-detail/RunActions.tsx`:
  - Action buttons for Retry and Cancel with loading spinners and disabled states based on current run status.
- `apps/dashboard/src/app/runs/[id]/page.tsx`:
  - Assembles header, actions, timeline, attempt inspector, and JSON viewers with `useRunEvents(id)`.

- [ ] **Step 8: Run component tests to verify they pass**
Run: `pnpm --filter @durable/dashboard test test/run-detail.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**
```bash
git add apps/dashboard/src/lib/sse-reducer.ts apps/dashboard/src/hooks apps/dashboard/src/components/run-detail apps/dashboard/src/app/runs/[id]/page.tsx apps/dashboard/test/sse-reducer.test.ts apps/dashboard/test/run-detail.test.tsx
git commit --author="Aztrek <starsnipe407@gmail.com>" -m "feat(dashboard): implement flagship run detail view with timeline, attempt inspector, json viewers, controls, and SSE live hydration"
```

---

### Task 6: Monorepo Build, Typecheck, and End-to-End Verification Gate

**Files:**
- Modify: `.scratch/durable-engine/issues/12-nextjs-observability-dashboard.md` (mark all checkboxes done, update status)
- Modify: `.superpowers/sdd/progress.md` (record Ticket 12 completion)

**Verification Steps:**
- [ ] **Step 1: Run full dashboard test suite**
Run: `pnpm --filter @durable/dashboard test`
Expected: PASS across all test files with 100% assertions green.

- [ ] **Step 2: Run monorepo-wide build**
Run: `pnpm run build`
Expected: All packages including `@durable/dashboard` (`next build`) compile cleanly with 0 TypeScript or lint errors.

- [ ] **Step 3: Run monorepo-wide test suite**
Run: `pnpm test`
Expected: All tests passing across all packages.

- [ ] **Step 4: Run end-to-end smoke test**
Run: `pnpm smoke`
Expected: PASS against live PostgreSQL and Redis.

- [ ] **Step 5: Mark issue complete and commit**
Update `.scratch/durable-engine/issues/12-nextjs-observability-dashboard.md` and `.superpowers/sdd/progress.md`.
```bash
git add .scratch/durable-engine/issues/12-nextjs-observability-dashboard.md .superpowers/sdd/progress.md
git commit --author="Aztrek <starsnipe407@gmail.com>" -m "docs: complete ticket 12 checklist and update progress tracker"
```
