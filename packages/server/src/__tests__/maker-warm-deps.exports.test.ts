import { describe, expect, it, vi } from 'vitest';
import { makerWarmDepsBlocked, makerWarmDepsOn, warmDepsCacheRoot, warmDepsState } from '../services/maker-warm-deps';

describe('makerWarmDepsBlocked', () => {
  it('warns once per process and is silent on later calls', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    makerWarmDepsBlocked();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('blocked_by_experiment');
    makerWarmDepsBlocked();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('makerWarmDepsOn', () => {
  it('is true only when MAKER_WARM_DEPS is exactly "on"', () => {
    expect(makerWarmDepsOn({ MAKER_WARM_DEPS: 'on' })).toBe(true);
    expect(makerWarmDepsOn({ MAKER_WARM_DEPS: 'off' })).toBe(false);
    expect(makerWarmDepsOn({})).toBe(false);
  });
});

describe('warmDepsState', () => {
  it('is off when the flag is not on', () => {
    expect(warmDepsState({})).toBe('off');
    expect(warmDepsState({ MAKER_WARM_DEPS: 'off' })).toBe('off');
  });

  it('is on when the flag is on and MAKER-DEPS-001 is off', () => {
    expect(warmDepsState({ MAKER_WARM_DEPS: 'on' })).toBe('on');
  });

  it('is blocked_by_experiment when both MAKER_WARM_DEPS and MAKER_DEPS_001_MODE are on', () => {
    expect(warmDepsState({ MAKER_WARM_DEPS: 'on', MAKER_DEPS_001_MODE: 'on' })).toBe('blocked_by_experiment');
  });
});

describe('warmDepsCacheRoot', () => {
  it('uses the env dir when set', () => {
    expect(warmDepsCacheRoot({ MAKER_WARM_DEPS_CACHE_DIR: '/tmp/cache-x' })).toBe('/tmp/cache-x');
  });

  it('falls back to the default root', () => {
    expect(warmDepsCacheRoot({})).toBe('/data/maker-deps-cache');
  });
});