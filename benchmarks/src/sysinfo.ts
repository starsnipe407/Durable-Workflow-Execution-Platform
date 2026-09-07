import os from 'node:os';
import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@durable/database';
import type { SystemMetadata, PercentileMetrics } from './types.js';

export async function collectSystemMetadata(): Promise<SystemMetadata> {
  let gitCommitSha = 'unknown';
  try {
    const stdout = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (stdout) {
      gitCommitSha = stdout;
    }
  } catch {
    gitCommitSha = 'unknown';
  }

  const cpus = os.cpus();
  const totalMemoryBytes = os.totalmem();
  const totalMemoryGb = Number((totalMemoryBytes / 1024 ** 3).toFixed(2));

  return {
    nodeVersion: process.version,
    platform: os.platform(),
    osRelease: os.release(),
    cpuArch: os.arch(),
    cpuModel: cpus[0]?.model || 'unknown',
    cpuCores: cpus.length,
    totalMemoryBytes,
    totalMemoryGb,
    gitCommitSha,
    timestamp: new Date().toISOString(),
  };
}

export async function collectExtendedSystemMetadata(
  databaseUrl?: string,
  redisUrl?: string
): Promise<SystemMetadata> {
  const baseMeta = await collectSystemMetadata();

  const dbUrl =
    databaseUrl ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/durable_workflow_test?schema=public';
  const rUrl = redisUrl || process.env.REDIS_URL || 'redis://localhost:6380';

  let postgresVersion = 'unknown';
  let redisVersion = 'unknown';

  let prisma: PrismaClient | null = null;
  try {
    prisma = createPrismaClient(dbUrl);
    const rows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    if (rows && rows[0]?.version) {
      postgresVersion = rows[0].version;
    }
  } catch (err) {
    postgresVersion = `failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  }

  let redis: Redis | null = null;
  try {
    redis = new Redis(rUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    redis.on('error', () => {});
    await redis.connect();
    const info = await redis.info('server');
    const match = info.match(/redis_version:([^\r\n]+)/);
    if (match && match[1]) {
      redisVersion = match[1].trim();
    }
  } catch (err) {
    redisVersion = `failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (redis) {
      try {
        await redis.quit().catch(() => {});
        redis.disconnect();
      } catch {}
    }
  }

  return {
    ...baseMeta,
    postgresVersion,
    redisVersion,
  };
}

export function calculatePercentiles(samples: number[]): PercentileMetrics {
  if (samples.length === 0) {
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const avg = Number((sum / sorted.length).toFixed(2));

  const pick = (p: number): number => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
    );
    return sorted[idx]!;
  };

  return {
    min,
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    max,
    avg,
  };
}
