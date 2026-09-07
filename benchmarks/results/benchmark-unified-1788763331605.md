# Durable Workflow Engine Performance & Resilience Benchmark Suite

- **Benchmark ID**: `unified-1788763331605`
- **Timestamp**: 2026-09-07T06:42:11.605Z

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
| System Timestamp | 2026-09-07T06:42:02.922Z |

## Throughput Scaling

| Replicas | Concurrency | Total Completed | Median Workflows/Sec | P50 (ms) | P95 (ms) | P99 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5 | 50 | 65.92 | 216.39 | 385.47 | 385.5 |
| 2 | 5 | 50 | 86.45 | 197.5 | 323.99 | 324.02 |
| 4 | 5 | 50 | 108.27 | 185.9 | 248.29 | 248.3 |
| 8 | 5 | 50 | 108.55 | 212.23 | 251.6 | 251.64 |

## Chaos: Worker Crash & Recovery

| Scenario | Worker PID | Kill Signal | Lease TTL (ms) | Recovery Latency (ms) | Workflow Run ID | Duplicate Step Calls | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WORKER_SIGKILL_RECOVERY | 9324 | SIGKILL | 2000 | 2674.65 | 1d9bb41c-4515-4104-acfc-9e154fbc7e65 | 0 | COMPLETED |

## Redis Destruction & Reconciliation

| Scenario | Runs Submitted | Redis Command | Reconstruction Duration (ms) | Lost Runs | Duplicate Runs | Completed Runs | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REDIS_DESTRUCTION_RECONCILER | 25 | FLUSHALL | 20.95 | 0 | 0 | 25 | PASSED |
