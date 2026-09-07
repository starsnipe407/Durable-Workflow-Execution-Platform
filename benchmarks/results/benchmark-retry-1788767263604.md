# Transient Failure Retry Overhead Benchmark

- **Benchmark ID**: `retry-1788767263604`
- **Timestamp**: 2026-09-07T07:47:43.604Z

## System Information

| Parameter | Value |
| --- | --- |
| Node.js | v24.11.1 |
| Platform | win32 (10.0.26200) |
| Architecture | x64 |
| CPU Model | Intel(R) Core(TM) Ultra 9 275HX |
| CPU Cores | 24 |
| Total Memory | 31.43 GB (33752997888 bytes) |
| Git Commit SHA | `3e49e550da7c1123cc21b859b395b1d62524bca6` |
| System Timestamp | 2026-09-07T07:47:42.356Z |

## Transient Failure Retry Overhead

| Failure Rate | Workflows | Duration (ms) | Workflows/Sec | P50 (ms) | P95 (ms) | Mean Attempts/Workflow |
| --- | --- | --- | --- | --- | --- | --- |
| 0% | 20 | 182.27 | 109.73 | 91 | 151 | 1 |
| 5% | 20 | 75.91 | 263.47 | 54 | 69 | 1.05 |
| 10% | 20 | 78.07 | 256.18 | 54 | 72 | 1.1 |
| 20% | 20 | 125.21 | 159.73 | 63 | 80 | 1.2 |
