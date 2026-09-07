# Redis Destruction & Reconciler Resilience Benchmark

- **Benchmark ID**: `reconciliation-1788727847081`
- **Timestamp**: 2026-09-06T20:50:47.081Z

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
| System Timestamp | 2026-09-06T20:50:46.227Z |

## Redis Destruction & Reconciliation

| Scenario | Runs Submitted | Redis Command | Reconstruction Duration (ms) | Lost Runs | Duplicate Runs | Completed Runs | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REDIS_DESTRUCTION_RECONCILER | 20 | FLUSHALL | 22.75 | 0 | 0 | 20 | PASSED |
