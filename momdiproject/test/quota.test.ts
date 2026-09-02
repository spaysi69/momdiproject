import { describe, expect, it } from 'vitest';
import { setCooldown } from '../src/quota/reservation.js';

describe('quota helpers', () => {
  it('normalizes cooldown to at least one second', async () => {
    const calls: unknown[] = [];
    const redis = { set: (...args: unknown[]) => { calls.push(args); return Promise.resolve('OK'); } } as never;
    await setCooldown(redis, 'r1', 0);
    expect(calls[0]).toEqual(['quota:r1:cooldown', '1', 'EX', 1]);
  });
});
