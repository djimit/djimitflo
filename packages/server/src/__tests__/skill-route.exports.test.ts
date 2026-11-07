import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { experimentDefs } from '../services/experiment-registry';
import { isSkillCapability, recordSkillBoundary, skillBlockLines } from '../services/skill-route';

/**
 * Exports of services/skill-route.ts that no other test names directly:
 * recordSkillBoundary, isSkillCapability, skillBlockLines. Pure / DB-only, no env flags.
 */
const BOUNDARY_DDL = `CREATE TABLE IF NOT EXISTS experiment_period_boundaries (experiment_id TEXT NOT NULL, env_name TEXT NOT NULL,
  previous TEXT, current TEXT, at TEXT NOT NULL, PRIMARY KEY (experiment_id, env_name, at))`;

const oraclePopulationIds = (): string[] => experimentDefs().filter((d) => d.population === 'oracle_goals').map((d) => d.id);

describe('isSkillCapability', () => {
  it('is true only when the parsed metadata source is skill_from_repair', () => {
    expect(isSkillCapability(JSON.stringify({ source: 'skill_from_repair' }))).toBe(true);
  });

  it('is false for any other source', () => {
    expect(isSkillCapability(JSON.stringify({ source: 'factory' }))).toBe(false);
    expect(isSkillCapability(JSON.stringify({ source: 'genome' }))).toBe(false);
    expect(isSkillCapability(JSON.stringify({}))).toBe(false);
  });

  it('is false for missing, empty or unparseable metadata (treated as data, never thrown)', () => {
    expect(isSkillCapability(null)).toBe(false);
    expect(isSkillCapability(undefined)).toBe(false);
    expect(isSkillCapability('')).toBe(false);
    expect(isSkillCapability('not-json')).toBe(false);
    expect(isSkillCapability('[1, 2]')).toBe(false); // array, not an object
  });
});

describe('skillBlockLines', () => {
  const cap = { id: 'skill:oracle-gate', version: '0123456789ab', name: 'oracle-gate',
    script_path: 'scripts/skills/oracle-gate.mjs', artifact_digest: 'sha256:deadbeef', oracle: 'daemon check scripts exit 0' };

  it('starts with the skill heading and names the registered id, version and digest', () => {
    const lines = skillBlockLines(cap);
    expect(lines[0]).toBe('## Skill: oracle-gate');
    expect(lines.join('\n')).toContain('skill:oracle-gate@0123456789ab');
    expect(lines.join('\n')).toContain('sha256:deadbeef');
  });

  it('tells the maker to run the script once from the repo root, with no mutants, diffs or line hints (NE-013)', () => {
    const lines = skillBlockLines(cap);
    expect(lines).toContain('    node scripts/skills/oracle-gate.mjs');
    const block = lines.join('\n').toLowerCase();
    expect(block).not.toMatch(/surviv|mutatorname|replacement|location|@@/);
    expect(block).not.toMatch(/diff(?!erent)/);
  });

  it('records the oracle string, falling back to the default when empty', () => {
    expect(skillBlockLines(cap).join('\n')).toContain('Oracle: daemon check scripts exit 0');
    const withEmpty = skillBlockLines({ ...cap, oracle: '' });
    expect(withEmpty.join('\n')).toContain('Oracle: the daemon check scripts exit 0');
  });

  it('returns a non-empty array of strings for a minimal capability', () => {
    const lines = skillBlockLines({ id: 'skill:x', version: 'v1', name: 'x', script_path: 'scripts/skills/x.mjs', artifact_digest: 'sha256:1', oracle: 'pass:true' });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => typeof l === 'string')).toBe(true);
  });
});

describe('recordSkillBoundary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(BOUNDARY_DDL);
  });

  const rows = () => db.prepare('SELECT experiment_id, env_name, previous, current, at FROM experiment_period_boundaries ORDER BY experiment_id, env_name, at').all() as Array<{
    experiment_id: string; env_name: string; previous: string; current: string; at: string;
  }>;

  it('writes one row per oracle-population experiment and returns that count', () => {
    const expected = oraclePopulationIds();
    expect(expected.length).toBeGreaterThan(0);
    const n = recordSkillBoundary(db, 'skill:oracle-gate', '0123456789ab', 'candidate', 'validated', Date.parse('2026-11-06T00:00:00Z'));
    expect(n).toBe(expected.length);
    const written = rows();
    expect(written).toHaveLength(expected.length);
    expect(written.map((r) => r.experiment_id).sort()).toEqual([...expected].sort());
    expect(written.every((r) => r.env_name === 'capability:skill:oracle-gate' && r.previous === 'candidate'
      && r.current === 'validated@0123456789ab' && r.at === '2026-11-06T00:00:00.000Z')).toBe(true);
  });

  it('is idempotent: a second call at the same instant inserts nothing and returns 0', () => {
    const at = Date.parse('2026-11-06T00:00:00Z');
    const first = recordSkillBoundary(db, 'skill:oracle-gate', 'v', 'candidate', 'validated', at);
    expect(first).toBeGreaterThan(0);
    expect(recordSkillBoundary(db, 'skill:oracle-gate', 'v', 'candidate', 'validated', at)).toBe(0);
    expect(rows()).toHaveLength(first);
  });

  it('writes a new boundary at a different instant (a later transition is a new row)', () => {
    const at1 = Date.parse('2026-11-06T00:00:00Z');
    const at2 = Date.parse('2026-11-07T00:00:00Z');
    const first = recordSkillBoundary(db, 'skill:oracle-gate', 'v1', 'candidate', 'validated', at1);
    const second = recordSkillBoundary(db, 'skill:oracle-gate', 'v2', 'validated', 'deprecated', at2);
    expect(second).toBe(first); // one row per oracle experiment again
    const written = rows();
    expect(written).toHaveLength(first + second);
    expect(written.filter((r) => r.at === '2026-11-07T00:00:00.000Z').every((r) => r.previous === 'validated' && r.current === 'deprecated@v2')).toBe(true);
  });

  it('records a distinct env_name per capability id', () => {
    recordSkillBoundary(db, 'skill:a', 'v', 'candidate', 'validated', Date.parse('2026-11-06T00:00:00Z'));
    recordSkillBoundary(db, 'skill:b', 'v', 'candidate', 'validated', Date.parse('2026-11-06T00:00:00Z'));
    const envs = new Set(rows().map((r) => r.env_name));
    expect(envs).toEqual(new Set(['capability:skill:a', 'capability:skill:b']));
  });
});
