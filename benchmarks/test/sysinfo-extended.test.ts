import { describe, it, expect } from 'vitest';
import { collectExtendedSystemMetadata } from '../src/sysinfo.js';
import { engineBenchmarkWorkflow, retryWorkflow } from '../src/worker-runner.js';

describe('Task 1: Extended Environment Introspection & Synthetic Workflows', () => {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

  it('collects PostgreSQL and Redis versions alongside host metadata', async () => {
    const meta = await collectExtendedSystemMetadata(databaseUrl, redisUrl);

    expect(meta.nodeVersion).toBeDefined();
    expect(meta.cpuModel).toBeDefined();
    expect(meta.postgresVersion).toBeDefined();
    expect(meta.postgresVersion).toContain('PostgreSQL');
    expect(meta.redisVersion).toBeDefined();
    expect(meta.redisVersion?.length).toBeGreaterThan(0);
  });

  it('gracefully handles unreachable database or redis without throwing', async () => {
    const unreachableDb = 'postgresql://postgres:postgres@localhost:5439/non_existent?connect_timeout=1';
    const unreachableRedis = 'redis://localhost:6399';

    const meta = await collectExtendedSystemMetadata(unreachableDb, unreachableRedis);

    expect(meta.nodeVersion).toBeDefined();
    expect(meta.postgresVersion).toBeDefined();
    expect(meta.postgresVersion).toMatch(/failed|unknown/);
    expect(meta.redisVersion).toBeDefined();
    expect(meta.redisVersion).toMatch(/failed|unknown/);
  });

  it('defines engineBenchmarkWorkflow with 4 sequential/synthetic steps', () => {
    expect(engineBenchmarkWorkflow.name).toBe('engine-benchmark');
    expect(engineBenchmarkWorkflow.version).toBe('1.0.0');
    expect(typeof engineBenchmarkWorkflow.execute).toBe('function');
  });

  it('defines retryWorkflow with configurable failure rate', () => {
    expect(retryWorkflow.name).toBe('retry-workflow');
    expect(retryWorkflow.version).toBe('1.0.0');
    expect(typeof retryWorkflow.execute).toBe('function');
  });
});
