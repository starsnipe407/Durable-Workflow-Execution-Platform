import { describe, it, expect } from 'vitest';
import { generateId } from '../src/index.js';

describe('shared utilities', () => {
  it('generates a prefixed id', () => {
    const id = generateId('run');
    expect(id).toMatch(/^run_[a-z0-9]+$/);
  });
});
