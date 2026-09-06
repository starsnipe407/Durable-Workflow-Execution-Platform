import { describe, it, expect } from 'vitest';
import { generateId, getRunEventsChannel, publishRunEventWakeup } from '../src/index.js';

describe('shared utilities', () => {
  it('generates a prefixed id', () => {
    const id = generateId('run');
    expect(id).toMatch(/^run_[a-z0-9]+$/);
  });

  it('formats run events channel name', () => {
    expect(getRunEventsChannel('run-123')).toBe('workflow:events:run-123');
  });

  it('publishes run event wake up message with json payload', async () => {
    const published: Array<{ channel: string; message: string }> = [];
    const mockPublisher = {
      publish: async (channel: string, message: string) => {
        published.push({ channel, message });
        return 1;
      },
    };

    await publishRunEventWakeup(mockPublisher, 'run-abc');
    expect(published.length).toBe(1);
    expect(published[0].channel).toBe('workflow:events:run-abc');
    const parsed = JSON.parse(published[0].message);
    expect(parsed.runId).toBe('run-abc');
    expect(typeof parsed.timestamp).toBe('number');
  });
});
