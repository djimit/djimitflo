import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateEnv } from '../config/env';

describe('startup environment validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.JWT_SECRET = 'test-secret-key-that-is-long-enough-for-testing-purposes-1234567890';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('requires JWT_SECRET in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = '';

    expect(() => validateEnv()).toThrow('JWT_SECRET (required in production)');
  });

  it('accepts a production JWT secret', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateEnv()).not.toThrow();
  });

  it('allows the development fallback', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = '';
    expect(() => validateEnv()).not.toThrow();
  });
});
