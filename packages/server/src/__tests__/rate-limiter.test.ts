import { describe, it, expect } from 'vitest';
import { RateLimiter, loginRateLimiter } from '../middleware/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(5, 60000);
  });

  it('allows requests under the limit', () => {
    const result = limiter.check('192.168.1.1');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it('blocks requests after max failures', () => {
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('192.168.1.1');
    }
    const result = limiter.check('192.168.1.1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets counter on successful login', () => {
    limiter.recordFailure('192.168.1.1');
    limiter.recordFailure('192.168.1.1');
    limiter.reset('192.168.1.1');
    const result = limiter.check('192.168.1.1');
    expect(result.allowed).toBe(true);
  });

  it('does not block different IP after one IP is rate-limited', () => {
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('192.168.1.1');
    }
    expect(limiter.check('192.168.1.1').allowed).toBe(false);
    expect(limiter.check('192.168.1.2').allowed).toBe(true);
  });

  it('increments failure count correctly', () => {
    limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1').allowed).toBe(true);

    limiter.recordFailure('10.0.0.1');
    limiter.recordFailure('10.0.0.1');
    limiter.recordFailure('10.0.0.1');
    limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1').allowed).toBe(false);
  });

  it('exposes loginRateLimiter singleton', () => {
    expect(loginRateLimiter).toBeDefined();
    expect(typeof loginRateLimiter.check).toBe('function');
    expect(typeof loginRateLimiter.recordFailure).toBe('function');
    expect(typeof loginRateLimiter.reset).toBe('function');
  });
});