# Durable Workflow Engine Performance & Resilience Benchmark Suite

- **Benchmark ID**: `unified-1788732534514`
- **Timestamp**: 2026-09-06T22:08:54.514Z

## System Information

| Parameter | Value |
| --- | --- |
| Node.js | v24.11.1 |
| Platform | win32 (10.0.26200) |
| Architecture | x64 |
| CPU Model | Intel(R) Core(TM) Ultra 9 275HX |
| CPU Cores | 24 |
| Total Memory | 31.43 GB (33752997888 bytes) |
| Git Commit SHA | `e302f365fffdb55165e7a1adc240772724593c2e` |
| System Timestamp | 2026-09-06T22:08:47.092Z |

## Throughput Scaling

| Replicas | Concurrency | Total Completed | Median Workflows/Sec | P50 (ms) | P95 (ms) | P99 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5 | 50 | 74.25 | 200.4 | 326.57 | 358.02 |
| 2 | 5 | 50 | 97.08 | 168.18 | 260.7 | 292.75 |
| 4 | 5 | 50 | 94.38 | 216.16 | 279 | 310.65 |

## Chaos: Worker Crash & Recovery

| Scenario | Worker PID | Kill Signal | Lease TTL (ms) | Recovery Latency (ms) | Workflow Run ID | Duplicate Step Calls | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WORKER_SIGKILL_RECOVERY | 33040 | SIGKILL | 2000 | 2750.33 | ddba079c-4b2f-4342-9645-6580ee1f2b93 | 0 | COMPLETED |

## Redis Destruction & Reconciliation

| Scenario | Runs Submitted | Redis Command | Reconstruction Duration (ms) | Lost Runs | Duplicate Runs | Completed Runs | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REDIS_DESTRUCTION_RECONCILER | 25 | FLUSHALL | 20.38 | 0 | 0 | 25 | PASSED |
