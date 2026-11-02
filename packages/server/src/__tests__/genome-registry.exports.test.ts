import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  dreamEvolutionEnabled,
  frozenHoldoutCommits,
  holdout,
  mutantHoldoutTiers,
  mutantTrialsEnabled,
  parseFireCheck,
  requestedHoldoutEpoch,
} from '../services/genome-registry';

const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
const TASKS = Array.from({ length: 40 }, (_, i) => TASK(`c${String(i).padStart(2, '0')}`));

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

describe('frozenHoldoutCommits', () => {
  it('returns an empty array when no holdout has been frozen yet', () => {
    expect(frozenHoldoutCommits(db)).toEqual([]);
  });

  it('returns the sorted commit SHAs of the current epoch after holdout() freezes them', () => {
    const frozen = holdout(db, TASKS);
    expect(frozenHoldoutCommits(db)).toEqual([...frozen].sort());
  });

  it('reflects only the requested epoch (RX-12)', () => {
    holdout(db, TASKS); // freeze epoch 0
    vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
    expect(frozenHoldoutCommits(db)).toEqual([]); // epoch 1 not yet frozen
    const fresh = Array.from({ length: 40 }, (_, i) => TASK(`d${String(i).padStart(2, '0')}`));
    const second = holdout(db, fresh);
    expect(frozenHoldoutCommits(db)).toEqual([...second].sort());
  });
});

describe('dreamEvolutionEnabled', () => {
  it('is false by default and true when DREAM_EVOLUTION_ENABLED=true', () => {
    delete process.env.DREAM_EVOLUTION_ENABLED;
    expect(dreamEvolutionEnabled()).toBe(false);
    vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
    expect(dreamEvolutionEnabled()).toBe(true);
  });
});

describe('requestedHoldoutEpoch', () => {
  it('defaults to 0 and parses a valid non-negative integer from GYM_HOLDOUT_EPOCH', () => {
    delete process.env.GYM_HOLDOUT_EPOCH;
    expect(requestedHoldoutEpoch()).toBe(0);
    vi.stubEnv('GYM_HOLDOUT_EPOCH', '3');
    expect(requestedHoldoutEpoch()).toBe(3);
    vi.stubEnv('GYM_HOLDOUT_EPOCH', '-1');
    expect(requestedHoldoutEpoch()).toBe(0); // negative → 0
    vi.stubEnv('GYM_HOLDOUT_EPOCH', 'abc');
    expect(requestedHoldoutEpoch()).toBe(0); // NaN → 0
  });
});

describe('mutantTrialsEnabled / mutantHoldoutTiers', () => {
  it('mutantTrialsEnabled follows DREAM_TRIAL_MUTANTS', () => {
    delete process.env.DREAM_TRIAL_MUTANTS;
    expect(mutantTrialsEnabled()).toBe(false);
    vi.stubEnv('DREAM_TRIAL_MUTANTS', 'true');
    expect(mutantTrialsEnabled()).toBe(true);
  });

  it('mutantHoldoutTiers defaults to [2,3] and honours DREAM_TRIAL_MUTANT_TIERS', () => {
    delete process.env.DREAM_TRIAL_MUTANT_TIERS;
    expect(mutantHoldoutTiers()).toEqual([2, 3]);
    vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '4,5');
    expect(mutantHoldoutTiers()).toEqual([4, 5]);
    vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '');
    expect(mutantHoldoutTiers()).toEqual([2, 3]); // empty → default
  });
});

describe('parseFireCheck', () => {
  const sha = 'a'.repeat(64);
  it('returns null for non-object or malformed input', () => {
    expect(parseFireCheck(null)).toBeNull();
    expect(parseFireCheck(undefined)).toBeNull();
    expect(parseFireCheck('string')).toBeNull();
    expect(parseFireCheck({})).toBeNull();
    expect(parseFireCheck({ goal_sha256: 'short' })).toBeNull();
  });

  it('parses a valid FireCheck object', () => {
    expect(parseFireCheck({ goal_sha256: sha, genome_lines: 3, genome_lines_found: 2 })).toEqual({
      goal_sha256: sha, genome_lines: 3, genome_lines_found: 2,
    });
  });

  it('rejects found > lines', () => {
    expect(parseFireCheck({ goal_sha256: sha, genome_lines: 1, genome_lines_found: 2 })).toBeNull();
  });
});
