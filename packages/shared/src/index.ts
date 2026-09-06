// ponytail: using Math.random for initial ID generation; crypto.randomUUID or nanoid can replace if collision resistance under heavy concurrency is required
export function generateId(prefix: string): string {
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${randomPart}`;
}

export function getRunEventsChannel(runId: string): string {
  return 'workflow:events:' + runId;
}

export async function publishRunEventWakeup(
  publisher: { publish(channel: string, message: string): Promise<number> },
  runId: string
): Promise<void> {
  const channel = getRunEventsChannel(runId);
  const message = JSON.stringify({ runId, timestamp: Date.now() });
  await publisher.publish(channel, message);
}
