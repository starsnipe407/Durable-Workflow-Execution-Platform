# 12: Next.js Observability Dashboard

**What to build:**
A responsive web dashboard (pps/dashboard) built with Next.js, React, Tailwind CSS, and TanStack Query. Features overview metrics, workflow lists, run filters, and a flagship run detail view with a vertical execution timeline, attempt inspector, and manual retry/cancellation controls hydrated live via SSE.

**Blocked by:** 11: Real-Time SSE Execution Streaming

**Status:** ready-for-agent

- [ ] Build /dashboard overview screen displaying active runs, completed/failed counts, and system status.
- [ ] Build /workflows listing registered workflows, versions, triggers, and concurrency policies.
- [ ] Build /runs listing runs with status, version, and date-range filters.
- [ ] Build /runs/:id flagship detail screen with vertical step timeline, parallel sibling grouping, attempt histories, errors, and input/output JSON viewers.
- [ ] Wire live status updates using native EventSource connected to the API SSE endpoint.
- [ ] Add manual retry and cancellation buttons hooked to API endpoints.
