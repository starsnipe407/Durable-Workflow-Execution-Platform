# 13: Order Processing Example and Benchmarks

**What to build:**
The canonical end-to-end reference application (examples/order-processing) demonstrating order validation, payment with retries and external idempotency, and parallel confirmations, accompanied by automated benchmark and chaos suites measuring throughput, recovery latency, and Redis reconstruction.

**Blocked by:** 09: Event Ingestion and Bindings, 10: Distributed Concurrency and Rate Limiting, 12: Next.js Observability Dashboard

**Status:** in-progress

- [ ] Implement process-order workflow covering sequential steps, retries, idempotency keys, and parallel sibling steps.
- [ ] Create benchmark harness measuring completed workflows/sec across worker scaling (1, 2, 4, 8 workers).
- [ ] Create chaos benchmark measuring crash recovery latency under worker termination.
- [ ] Create Redis flush benchmark verifying 0 lost durable runs and 0 duplicate runs after reconciliation.
- [ ] Save all benchmark output and environment metadata as reproducible artifacts.
