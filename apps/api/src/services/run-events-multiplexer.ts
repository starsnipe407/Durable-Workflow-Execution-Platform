import { Redis } from 'ioredis';
import { getRunEventsChannel } from '@durable/shared';

export class RunEventsMultiplexer {
  private readonly subRedis: Redis;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly pendingSubscriptions = new Map<string, Promise<void>>();
  private isClosed = false;

  constructor(redis: Redis) {
    this.subRedis = redis.duplicate();
    this.subRedis.on('error', () => {});
    const prefix = 'workflow:events:';

    this.subRedis.on('message', (channel: string) => {
      if (channel.startsWith(prefix)) {
        const runId = channel.slice(prefix.length);
        const runListeners = this.listeners.get(runId);
        if (runListeners) {
          for (const listener of [...runListeners]) {
            try {
              listener();
            } catch {
              // Ignore listener error
            }
          }
        }
      }
    });
  }

  async subscribe(runId: string, listener: () => void): Promise<() => Promise<void>> {
    if (this.isClosed) {
      throw new Error('RunEventsMultiplexer is closed');
    }

    const channel = getRunEventsChannel(runId);
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);

    let subPromise = this.pendingSubscriptions.get(runId);
    if (!subPromise) {
      subPromise = this.subRedis
        .subscribe(channel)
        .then(() => {})
        .finally(() => {
          this.pendingSubscriptions.delete(runId);
        });
      this.pendingSubscriptions.set(runId, subPromise);
    }

    try {
      await subPromise;
    } catch (err) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(runId);
      }
      throw err;
    }

    let unsubscribed = false;
    return async () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const currentSet = this.listeners.get(runId);
      if (currentSet) {
        currentSet.delete(listener);
        if (currentSet.size === 0) {
          this.listeners.delete(runId);
          if (!this.isClosed) {
            await this.subRedis.unsubscribe(channel).catch(() => {});
          }
        }
      }
    };
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.pendingSubscriptions.clear();
    this.listeners.clear();
    await this.subRedis.quit().catch(() => this.subRedis.disconnect());
  }
}
