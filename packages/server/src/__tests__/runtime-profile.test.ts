import { describe, expect, it } from 'vitest';
import {
  resolveRuntimeProfile,
  runtimeProfileEnablesAutonomy,
  runtimeProfileEnablesOperator,
} from '../config/runtime-profile';

describe('runtime profile', () => {
  it('defaults to api', () => {
    expect(resolveRuntimeProfile({})).toBe('api');
  });

  it('falls back to api for invalid values', () => {
    expect(resolveRuntimeProfile({ DJIMITFLO_RUNTIME_PROFILE: 'full-send' })).toBe('api');
  });

  it('enables operator and autonomous levels explicitly', () => {
    expect(runtimeProfileEnablesOperator('api')).toBe(false);
    expect(runtimeProfileEnablesOperator('operator')).toBe(true);
    expect(runtimeProfileEnablesOperator('autonomous')).toBe(true);
    expect(runtimeProfileEnablesAutonomy('operator')).toBe(false);
    expect(runtimeProfileEnablesAutonomy('autonomous')).toBe(true);
  });
});
