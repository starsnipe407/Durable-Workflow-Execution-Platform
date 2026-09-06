import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';

export const RATE_LIMIT_LUA_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

if not ttl or ttl <= 0 then
  ttl = math.ceil(capacity / refill_rate) * 2
  if ttl < 60 then ttl = 60 end
end

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local current_tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if current_tokens == nil or last_refill == nil then
  current_tokens = capacity
  last_refill = now
else
  local elapsed = math.max(0, now - last_refill)
  local tokens_to_add = elapsed * refill_rate
  current_tokens = math.min(capacity, current_tokens + tokens_to_add)
  last_refill = now
end

if current_tokens >= cost then
  local remaining = current_tokens - cost
  redis.call('HSET', key, 'tokens', remaining, 'last_refill', now)
  redis.call('EXPIRE', key, ttl)
  return {1, tostring(remaining), 0}
else
  local needed = cost - current_tokens
  local retry_after = math.ceil(needed / refill_rate)
  if retry_after < 1 then retry_after = 1 end
  redis.call('HSET', key, 'tokens', current_tokens, 'last_refill', now)
  redis.call('EXPIRE', key, ttl)
  return {0, tostring(current_tokens), retry_after}
end
`;

export interface RateLimitCheckResult {
  allowed: number;
  remaining: number;
  retryAfter: number;
}

export async function checkRateLimit(
  redis: Redis,
  key: string,
  capacity: number,
  refillRatePerSec: number,
  cost: number = 1,
  ttl?: number
): Promise<RateLimitCheckResult> {
  const now = Date.now() / 1000;
  const computedTtl = ttl ?? Math.max(60, Math.ceil(capacity / refillRatePerSec) * 2);

  const raw = (await redis.eval(
    RATE_LIMIT_LUA_SCRIPT,
    1,
    key,
    capacity,
    refillRatePerSec,
    cost,
    now,
    computedTtl
  )) as [number, string | number, number];

  const allowed = Number(raw[0]);
  const remaining = typeof raw[1] === 'number' ? raw[1] : parseFloat(raw[1]);
  const retryAfter = Number(raw[2]);

  return { allowed, remaining, retryAfter };
}

export interface RateLimitOptions {
  redis: Redis;
  capacity?: number;
  refillRate?: number;
  defaultCost?: number;
  keyPrefix?: string;
  exemptRoutes?: string[];
}

export function createRateLimitPreHandler(options: RateLimitOptions) {
  const capacity = options.capacity ?? 60;
  const refillRate = options.refillRate ?? 10;
  const defaultCost = options.defaultCost ?? 1;
  const keyPrefix = options.keyPrefix ?? 'ratelimit';

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenantId) {
      return;
    }

    try {
      const key = `${keyPrefix}:${request.tenantId}`;
      const result = await checkRateLimit(
        options.redis,
        key,
        capacity,
        refillRate,
        defaultCost
      );

      if (result.allowed === 0) {
        return reply
          .status(429)
          .header('Retry-After', result.retryAfter.toString())
          .send({
            statusCode: 429,
            error: 'Too Many Requests',
            message: 'Rate limit exceeded',
          });
      }
    } catch (err) {
      return reply.status(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Rate limiter unavailable',
      });
    }
  };
}

export const DEFAULT_EXEMPT_ROUTES = ['/runs/:runId/events', '/runs/:id/events'];

export function rateLimitPlugin(app: FastifyInstance, options: RateLimitOptions) {
  const handler = createRateLimitPreHandler(options);
  const exempt = options.exemptRoutes
    ? [...new Set([...DEFAULT_EXEMPT_ROUTES, ...options.exemptRoutes])]
    : DEFAULT_EXEMPT_ROUTES;

  app.addHook('onRoute', (routeOptions) => {
    if (exempt.includes(routeOptions.url)) {
      return;
    }

    const existing = routeOptions.preHandler
      ? Array.isArray(routeOptions.preHandler)
        ? routeOptions.preHandler
        : [routeOptions.preHandler]
      : [];

    if (existing.includes(handler)) {
      return;
    }

    routeOptions.preHandler = [...existing, handler];
  });
}
