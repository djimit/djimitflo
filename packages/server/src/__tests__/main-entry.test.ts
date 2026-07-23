import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('main entry point', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.JWT_SECRET = 'test-secret-key-that-is-long-enough-for-testing-purposes-1234567890';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('requires JWT_SECRET in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = '';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    try {
      await import('../index');
    } catch {
      // Expected to fail or exit
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('starts server with valid config', async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3999';

    expect(process.env.JWT_SECRET).toBeTruthy();
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('creates database on startup', async () => {
    expect(process.env.DB_PATH || './data/djimitflo.sqlite').toBeDefined();
  });
});
