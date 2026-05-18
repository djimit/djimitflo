/**
 * In-memory IP-based rate limiter for login attempts
 *
 * Limits failed login attempts per IP address within a configurable time window.
 * Successful logins reset or reduce the failure counter for that IP.
 *
 * NOTE: This is in-memory only and not horizontally scalable.
 * For multi-instance deployments, use a Redis-backed rate limiter instead.
 */

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private attempts: Map<string, RateLimitEntry> = new Map();
  private maxAttempts: number;
  private windowMs: number;

  constructor(maxAttempts = MAX_ATTEMPTS, windowMs = WINDOW_MS) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  check(ip: string): { allowed: boolean; retryAfterMs: number } {
    this.cleanup();
    const entry = this.attempts.get(ip);
    if (!entry) {
      return { allowed: true, retryAfterMs: 0 };
    }
    if (Date.now() >= entry.resetAt) {
      this.attempts.delete(ip);
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.count >= this.maxAttempts) {
      return { allowed: false, retryAfterMs: entry.resetAt - Date.now() };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  recordFailure(ip: string): void {
    const entry = this.attempts.get(ip);
    if (!entry || Date.now() >= entry.resetAt) {
      this.attempts.set(ip, {
        count: 1,
        resetAt: Date.now() + this.windowMs,
      });
    } else {
      entry.count += 1;
    }
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.attempts) {
      if (now >= entry.resetAt) {
        this.attempts.delete(ip);
      }
    }
  }
}

export const loginRateLimiter = new RateLimiter();