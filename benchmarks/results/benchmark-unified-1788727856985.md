# Durable Workflow Engine Performance & Resilience Benchmark Suite

- **Benchmark ID**: `unified-1788727856985`
- **Timestamp**: 2026-09-06T20:50:56.985Z

## System Information

| Parameter | Value |
| --- | --- |
| Node.js | v24.11.1 |
| Platform | win32 (10.0.26200) |
| Architecture | x64 |
| CPU Model | Intel(R) Core(TM) Ultra 9 275HX |
| CPU Cores | 24 |
| Total Memory | 31.43 GB (33752997888 bytes) |
| Git Commit SHA | `b27dfb56dfd39d51acdac6ab284e49920b42dbb3` |
| System Timestamp | 2026-09-06T20:50:49.951Z |

## Throughput Scaling

| Replicas | Concurrency | Total Completed | Median Workflows/Sec | P50 (ms) | P95 (ms) | P99 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5 | 50 | 78.73 | 204.22 | 310.29 | 341.75 |
| 2 | 5 | 50 | 101.36 | 169.61 | 233.95 | 260.64 |
| 4 | 5 | 50 | 116.34 | 167.68 | 232.64 | 232.69 |

## Chaos: Worker Crash & Recovery

| Scenario | Worker PID | Kill Signal | Lease TTL (ms) | Recovery Latency (ms) | Workflow Run ID | Duplicate Step Calls | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WORKER_SIGKILL_RECOVERY | 12312 | SIGKILL | 2000 | 2665.54 | 3a559c5e-ebc8-45c9-9f61-d32b62795fda | 0 | COMPLETED |

## Redis Destruction & Reconciliation

| Scenario | Runs Submitted | Redis Command | Reconstruction Duration (ms) | Lost Runs | Duplicate Runs | Completed Runs | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REDIS_DESTRUCTION_RECONCILER | 25 | FLUSHALL | 21 | 0 | 0 | 25 | PASSED |
