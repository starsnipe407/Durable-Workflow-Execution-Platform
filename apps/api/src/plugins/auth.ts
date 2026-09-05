import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { PrismaClient } from '@durable/database';

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function authenticateApiKey(prisma: PrismaClient) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let apiKey = request.headers['x-api-key'] as string | undefined;

    if (!apiKey && request.headers.authorization) {
      const match = request.headers.authorization.match(/^Bearer\s+(.+)$/i);
      if (match) {
        apiKey = match[1];
      }
    }

    if (!apiKey) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Missing API key' });
    }

    const keyHash = hashApiKey(apiKey);
    const apiKeyRecord = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: { tenant: true },
    });

    if (!apiKeyRecord || apiKeyRecord.revokedAt !== null) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or revoked API key' });
    }

    request.tenantId = apiKeyRecord.tenantId;
    
    // Fire-and-forget update lastUsedAt
    prisma.apiKey.update({
      where: { id: apiKeyRecord.id },
      data: { lastUsedAt: new Date() }
    }).catch(console.error);
  };
}
