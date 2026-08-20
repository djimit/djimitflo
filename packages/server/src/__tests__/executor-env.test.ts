import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { buildExecutorEnv } from '../execution/executors/executor-env';

describe('buildExecutorEnv', () => {
  const savedPassthrough = process.env.RUNTIME_ENV_PASSTHROUGH;

  beforeEach(() => { delete process.env.RUNTIME_ENV_PASSTHROUGH; });
  afterEach(() => {
    if (savedPassthrough) process.env.RUNTIME_ENV_PASSTHROUGH = savedPassthrough;
    else delete process.env.RUNTIME_ENV_PASSTHROUGH;
  });

  it('only includes allowlisted env vars', () => {
    process.env.PATH = '/usr/bin';
    process.env.SECRET_SHOULD_NOT_LEAK = 'leaked';
    const env = buildExecutorEnv();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
  });

  it('includes extra vars from RUNTIME_ENV_PASSTHROUGH', () => {
    process.env.MY_EXTRA = 'extra-value';
    process.env.RUNTIME_ENV_PASSTHROUGH = 'MY_EXTRA';
    const env = buildExecutorEnv();
    expect(env.MY_EXTRA).toBe('extra-value');
  });

  it('overrides take precedence over allowlisted values', () => {
    process.env.PATH = '/usr/bin';
    const env = buildExecutorEnv({ PATH: '/custom/bin' });
    expect(env.PATH).toBe('/custom/bin');
  });

  it('does not leak unallowlisted process.env keys via overrides', () => {
    const env = buildExecutorEnv({ CUSTOM_KEY: 'val' });
    expect(env.CUSTOM_KEY).toBe('val');
  });
});