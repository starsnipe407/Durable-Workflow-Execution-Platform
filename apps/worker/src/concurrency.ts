import type { Redis } from "ioredis";
import type { WorkflowConcurrencyConfig } from "@durable/workflow-sdk";

export interface ConcurrencySlot {
  acquired: boolean;
  release: () => Promise<void>;
}

interface ActiveLease {
  runId: string;
  globalKey: string;
  partitionKey: string;
  ttlSeconds: number;
  timer?: NodeJS.Timeout;
}

const ACQUIRE_SCRIPT = `
local globalKey = KEYS[1]
local partitionKey = KEYS[2]
local runId = ARGV[1]
local now = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local globalLimit = tonumber(ARGV[4])
local keyLimit = tonumber(ARGV[5])
local keyExpireSec = tonumber(ARGV[6])

-- 1. Check global limit
if globalKey ~= "" and globalLimit > 0 then
  redis.call('ZREMRANGEBYSCORE', globalKey, 0, now)
  local existingScore = redis.call('ZSCORE', globalKey, runId)
  if not existingScore then
    local count = redis.call('ZCARD', globalKey)
    if count >= globalLimit then
      return 0
    end
  end
end

-- 2. Check partition key limit
if partitionKey ~= "" and keyLimit > 0 then
  redis.call('ZREMRANGEBYSCORE', partitionKey, 0, now)
  local existingScore = redis.call('ZSCORE', partitionKey, runId)
  if not existingScore then
    local count = redis.call('ZCARD', partitionKey)
    if count >= keyLimit then
      return 0
    end
  end
end

-- 3. Both limits have capacity: register slot
local expiry = now + ttl

if globalKey ~= "" and globalLimit > 0 then
  redis.call('ZADD', globalKey, expiry, runId)
  redis.call('EXPIRE', globalKey, keyExpireSec)
end

if partitionKey ~= "" and keyLimit > 0 then
  redis.call('ZADD', partitionKey, expiry, runId)
  redis.call('EXPIRE', partitionKey, keyExpireSec)
end

return 1
`;

const RELEASE_SCRIPT = `
local globalKey = KEYS[1]
local partitionKey = KEYS[2]
local runId = ARGV[1]

if globalKey ~= "" then
  redis.call('ZREM', globalKey, runId)
end

if partitionKey ~= "" then
  redis.call('ZREM', partitionKey, runId)
end

return 1
`;

const RENEW_SCRIPT = `
local globalKey = KEYS[1]
local partitionKey = KEYS[2]
local runId = ARGV[1]
local now = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local keyExpireSec = tonumber(ARGV[4])
local expiry = now + ttl

local hasGlobal = globalKey ~= ""
local hasPartition = partitionKey ~= ""

if hasGlobal and not redis.call('ZSCORE', globalKey, runId) then
  return 0
end

if hasPartition and not redis.call('ZSCORE', partitionKey, runId) then
  return 0
end

if hasGlobal then
  redis.call('ZADD', globalKey, 'XX', expiry, runId)
  redis.call('EXPIRE', globalKey, keyExpireSec)
end

if hasPartition then
  redis.call('ZADD', partitionKey, 'XX', expiry, runId)
  redis.call('EXPIRE', partitionKey, keyExpireSec)
end

return 1
`;

export class ConcurrencyCoordinator {
  private readonly redis: Redis;
  private readonly activeLeases = new Map<string, ActiveLease>();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  public async tryAcquire(
    runId: string,
    config: WorkflowConcurrencyConfig<any>,
    input: any,
    workflowName: string = "workflow",
    tenantId: string = "default",
    fallbackKey?: string
  ): Promise<ConcurrencySlot> {
    const rawKey =
      typeof config.key === "function" ? config.key({ input }) : undefined;
    const partitionKeyValue =
      rawKey !== undefined && rawKey !== null && rawKey !== ""
        ? rawKey
        : fallbackKey !== undefined && fallbackKey !== null && fallbackKey !== ""
        ? fallbackKey
        : undefined;

    const hasPartitionKey = partitionKeyValue !== undefined;
    const globalLimit = typeof config.limit === "number" && config.limit > 0 ? config.limit : 0;
    const keyLimit =
      typeof config.keyLimit === "number" && config.keyLimit > 0
        ? config.keyLimit
        : hasPartitionKey
        ? 1
        : 0;

    if (globalLimit === 0 && (!hasPartitionKey || keyLimit === 0)) {
      return {
        acquired: true,
        release: async () => {},
      };
    }

    const globalKey = globalLimit > 0 ? `concurrency:global:${tenantId}:${workflowName}` : "";
    const partitionKey =
      hasPartitionKey && keyLimit > 0
        ? `concurrency:key:${tenantId}:${workflowName}:${partitionKeyValue}`
        : "";

    const ttlSeconds = config.ttlSeconds ?? 30;
    const now = Date.now();
    const ttlMs = ttlSeconds * 1000;
    const keyExpireSec = Math.max(Math.ceil(ttlSeconds * 2), 60);

    const result = (await this.redis.eval(
      ACQUIRE_SCRIPT,
      2,
      globalKey,
      partitionKey,
      runId,
      now,
      ttlMs,
      globalLimit,
      keyLimit,
      keyExpireSec
    )) as number;

    if (result !== 1) {
      return {
        acquired: false,
        release: async () => {},
      };
    }

    const existing = this.activeLeases.get(runId);
    if (existing?.timer) {
      clearInterval(existing.timer);
    }

    const intervalMs = Math.max(100, Math.floor((ttlSeconds * 1000) / 2));
    let isRenewing = false;
    const timer = setInterval(() => {
      if (isRenewing) return;
      isRenewing = true;
      this.renew(runId)
        .catch(() => {})
        .finally(() => {
          isRenewing = false;
        });
    }, intervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    this.activeLeases.set(runId, {
      runId,
      globalKey,
      partitionKey,
      ttlSeconds,
      timer,
    });

    return {
      acquired: true,
      release: () => this.release(runId),
    };
  }

  public async renew(runId: string): Promise<boolean> {
    const lease = this.activeLeases.get(runId);
    if (!lease) {
      return false;
    }
    const { globalKey, partitionKey, ttlSeconds } = lease;
    if (!globalKey && !partitionKey) {
      return false;
    }

    const now = Date.now();
    const ttlMs = ttlSeconds * 1000;
    const keyExpireSec = Math.max(Math.ceil(ttlSeconds * 2), 60);

    const result = (await this.redis.eval(
      RENEW_SCRIPT,
      2,
      globalKey,
      partitionKey,
      runId,
      now,
      ttlMs,
      keyExpireSec
    )) as number;

    return result === 1;
  }

  public async release(runId: string): Promise<void> {
    const lease = this.activeLeases.get(runId);
    if (lease) {
      if (lease.timer) {
        clearInterval(lease.timer);
      }
      this.activeLeases.delete(runId);
      await this.redis.eval(
        RELEASE_SCRIPT,
        2,
        lease.globalKey,
        lease.partitionKey,
        runId
      );
    }
  }

  /**
   * @internal
   * Clears active heartbeat timers and drops lease tracking without calling
   * release scripts on Redis, simulating an abrupt worker process crash.
   */
  public simulateCrash(): void {
    for (const lease of this.activeLeases.values()) {
      if (lease.timer) {
        clearInterval(lease.timer);
      }
    }
    this.activeLeases.clear();
  }

  public async close(): Promise<void> {
    const leases = Array.from(this.activeLeases.values());
    for (const lease of leases) {
      if (lease.timer) {
        clearInterval(lease.timer);
      }
      this.activeLeases.delete(lease.runId);
    }
    await Promise.all(
      leases.map((lease) =>
        this.redis
          .eval(RELEASE_SCRIPT, 2, lease.globalKey, lease.partitionKey, lease.runId)
          .catch(() => {})
      )
    );
  }
}
