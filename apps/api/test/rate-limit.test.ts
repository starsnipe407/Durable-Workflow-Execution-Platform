import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient } from '@durable/database';
import { Redis } from 'ioredis';
import { createApp } from '../src/app';
import { hashApiKey } from '../src/plugins/auth';
import { FastifyInstance } from 'fastify';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6380');

describe('API Rate Limiter & Fail-Closed Guard', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let apiKey: string;

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `Test Tenant Rate Limit ${crypto.randomUUID()}` },
    });
    tenantId = tenant.id;

    apiKey = `test_rate_limit_key_${crypto.randomUUID()}`;
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(apiKey),
        tenantId,
        label: 'test-rate-limit',
      },
    });

    app = createApp({
      prisma,
      redis,
      rateLimitOptions: {
        capacity: 3,
        refillRate: 2, // 2 tokens/second
        defaultCost: 1,
      },
    } as any);
    await app.ready();
  });

  afterAll(async () => {
    // Scoped DB cleanup
    if (tenantId) {
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
      // Scoped Redis cleanup
      await redis.del(`ratelimit:${tenantId}`);
    }

    await app.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  it('1. Rapid requests up to capacity succeed (HTTP 200)', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/test',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ tenantId });
    }
  });

  it('2. Request exceeding capacity returns HTTP 429 with Retry-After header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/test',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.json()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded',
    });
  });

  it('3. After waiting for token replenishment, request succeeds again', async () => {
    // Wait 1.1 seconds for ~2 tokens to replenish (refillRate = 2 tokens/sec)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const res = await app.inject({
      method: 'GET',
      url: '/auth/test',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId });
  });

  it('4. When Redis throws an error / is unreachable, requests return HTTP 503 fail-closed', async () => {
    // Simulate Redis failure
    const evalSpy = vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('Redis connection lost'));

    const res = await app.inject({
      method: 'GET',
      url: '/auth/test',
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Rate limiter unavailable',
    });

    evalSpy.mockRestore();
  });

  it('5. Unauthenticated endpoints like /health bypass rate limiter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
