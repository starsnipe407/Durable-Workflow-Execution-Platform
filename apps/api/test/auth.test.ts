import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { PrismaClient } from '@durable/database';
import { createApp } from '../src/app';
import { hashApiKey } from '../src/plugins/auth';
import { FastifyInstance } from 'fastify';

const prisma = new PrismaClient();
let app: FastifyInstance;

beforeAll(async () => {
  app = createApp({ prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('API Key Authentication Plugin', () => {
  it('should return 401 Missing API key if no header provided', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/test',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized', message: 'Missing API key' });
  });

  it('should return 401 Invalid or revoked API key if key is invalid', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/test',
      headers: { 'x-api-key': 'invalid_key' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized', message: 'Invalid or revoked API key' });
  });

  it('should return 401 Invalid or revoked API key if key is revoked', async () => {
    const tenant = await prisma.tenant.create({
      data: { name: 'Test Tenant Revoked' },
    });
    const key = 'revoked_key_123';
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(key),
        tenantId: tenant.id,
        revokedAt: new Date(),

        label: 'test',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/auth/test',
      headers: { 'x-api-key': key },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized', message: 'Invalid or revoked API key' });

    await prisma.apiKey.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
  });

  it('should populate request.tenantId and return 200 for valid x-api-key header', async () => {
    const tenant = await prisma.tenant.create({
      data: { name: 'Test Tenant Valid Header' },
    });
    const key = 'valid_key_123';
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(key),
        tenantId: tenant.id,
        label: 'test',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/auth/test',
      headers: { 'x-api-key': key },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tenantId: tenant.id });

    await prisma.apiKey.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
  });

  it('should populate request.tenantId and return 200 for valid Bearer token', async () => {
    const tenant = await prisma.tenant.create({
      data: { name: 'Test Tenant Valid Bearer' },
    });
    const key = 'valid_bearer_123';
    await prisma.apiKey.create({
      data: {
        keyHash: hashApiKey(key),
        tenantId: tenant.id,

        label: 'test',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/auth/test',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tenantId: tenant.id });

    await prisma.apiKey.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
  });
});
