import { describe, expect, it } from 'vitest';
import { configArea, parseDefault } from '../services/runtime-config-view';

describe('configArea', () => {
  it('classifies scheduler gating flags as schedulers first', () => {
    // SCHEDULER_FLAGS is built from config-defaults.generated; pick a known member if available,
    // otherwise rely on the area rules. We test the precedence rule directly.
    expect(configArea('STALL_WATCH_INTERVAL_MS')).toBe('schedulers');
  });

  it('classifies budget/cap names into budgets/caps', () => {
    expect(configArea('TOKEN_MAX')).toBe('budgets/caps');
    expect(configArea('HOURLY_BUDGET')).toBe('budgets/caps');
    expect(configArea('RETENTION_DAYS')).toBe('budgets/caps');
  });

  it('classifies security/auth names into security/auth', () => {
    expect(configArea('JWT_SECRET')).toBe('security/auth');
    expect(configArea('SESSION_TTL')).toBe('security/auth');
    expect(configArea('CORS_ORIGINS')).toBe('security/auth');
  });

  it('classifies scheduler-interval names into schedulers', () => {
    expect(configArea('DISK_GUARD_INTERVAL_MS')).toBe('schedulers');
    expect(configArea('SCHEDULED_DIGEST_HOUR')).toBe('schedulers');
  });

  it('classifies experiment names into experiments', () => {
    expect(configArea('DREAM_MODE')).toBe('experiments');
    expect(configArea('GENOME_ENABLED')).toBe('experiments');
    expect(configArea('TG_001_MODE')).toBe('experiments');
  });

  it('classifies model/routing names into models/routing', () => {
    expect(configArea('OLLAMA_HOST')).toBe('models/routing');
    expect(configArea('MODEL_PRIMARY')).toBe('models/routing');
    expect(configArea('OPENAI_BASE_URL')).toBe('models/routing');
  });

  it('classifies knowledge names into knowledge', () => {
    expect(configArea('QDRANT_URL')).toBe('knowledge');
    expect(configArea('MEMORY_BACKEND')).toBe('knowledge');
    expect(configArea('KB_EMBEDDING_DIM')).toBe('knowledge');
  });

  it('classifies integration names into integrations', () => {
    expect(configArea('GITHUB_TOKEN')).toBe('integrations');
    expect(configArea('TELEGRAM_BOT_TOKEN')).toBe('integrations');
    expect(configArea('DATABASE_URL')).toBe('integrations');
  });

  it('falls back to other for unrecognized names', () => {
    expect(configArea('SOMETHING_WEIRD')).toBe('other');
    expect(configArea('ZZZ_UNKNOWN')).toBe('other');
  });

  it('uses first-match-wins precedence: budget before scheduler via name pattern', () => {
    // _MAX matches budgets/caps; verify it wins over later rules
    expect(configArea('TOKEN_MAX_PER_MINUTE')).toBe('budgets/caps');
  });
});

describe('parseDefault', () => {
  it('parses "off" as off', () => {
    expect(parseDefault('off')).toEqual({ kind: 'off' });
    expect(parseDefault('off (not armed)')).toEqual({ kind: 'off' });
  });

  it('parses "unset = off" and quoted-empty-off variants as off', () => {
    expect(parseDefault('unset = off')).toEqual({ kind: 'off' });
    expect(parseDefault("'' = off")).toEqual({ kind: 'off' });
    expect(parseDefault("`''` = off")).toEqual({ kind: 'off' });
  });

  it('parses "unset" and empty-quoted as empty', () => {
    expect(parseDefault('unset')).toEqual({ kind: 'empty' });
    expect(parseDefault("''")).toEqual({ kind: 'empty' });
    expect(parseDefault("'' (operator sets)")).toEqual({ kind: 'empty' });
  });

  it('parses leading numbers as number', () => {
    expect(parseDefault('42')).toEqual({ kind: 'number', n: 42 });
    expect(parseDefault('-5')).toEqual({ kind: 'number', n: -5 });
    expect(parseDefault('3.14 (radians)')).toEqual({ kind: 'number', n: 3.14 });
    expect(parseDefault('0')).toEqual({ kind: 'number', n: 0 });
  });

  it('parses backtick-quoted strings as string', () => {
    expect(parseDefault('`ollama` is primary')).toEqual({ kind: 'string', s: 'ollama' });
  });

  it('parses bare lowercase identifiers as string', () => {
    expect(parseDefault('sqlite (default db)')).toEqual({ kind: 'string', s: 'sqlite' });
    expect(parseDefault('on')).toEqual({ kind: 'string', s: 'on' });
  });

  it('returns null for prose it cannot parse', () => {
    expect(parseDefault('the primary repo … only')).toBeNull();
    expect(parseDefault('—')).toBeNull();
  });

  it('is case-insensitive for the off keyword', () => {
    expect(parseDefault('OFF')).toEqual({ kind: 'off' });
    expect(parseDefault('Off')).toEqual({ kind: 'off' });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseDefault('  off  ')).toEqual({ kind: 'off' });
    expect(parseDefault('  100  ')).toEqual({ kind: 'number', n: 100 });
  });
});