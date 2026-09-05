// ponytail: using Math.random for initial ID generation; crypto.randomUUID or nanoid can replace if collision resistance under heavy concurrency is required
export function generateId(prefix: string): string {
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${randomPart}`;
}
