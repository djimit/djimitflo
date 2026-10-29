import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ensureSkillCardTable } from '../services/skill-distillation';
import { playbookFor, playbookLanes, playbookNote, type Playbook } from '../services/lane-playbook';

let db: Database.Database;
const fresh = () => { const d = new Database(':memory:'); d.pragma('foreign_keys = OFF'); d.exec(schema); runMigrations(d); ensureSkillCardTable(d); return d; };
const T = '2026-10-17T01:00:00Z';
const card = (runId: string, kind: 'skill' | 'anti_pattern', lane: string, status: string, body: Record<string, unknown>) =>
  db.prepare(`INSERT INTO skill_cards (run_id, kind, lane, status, card_json, content_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'sha', ?, ?)`).run(runId, kind, lane, status, JSON.stringify(body), T, T);
const skill = (pattern: string) => ({ target_pattern: [pattern], diff_shape: { files_changed: 1, diff_lines: 10, test_only: true }, checks_passed: ['test'] });

beforeEach(() => { db = fresh(); });
afterEach(() => db.close());

// playbookLanes: preferred lanes first (preserving order), then lanes by usable card count desc, then name; deduped.
describe('playbookLanes', () => {
  it('returns only the preferred lanes (deduped) when the skill_cards table has no usable cards', () => {
    expect(playbookLanes(db, ['b', 'a', 'b'])).toEqual(['b', 'a']);
  });

  it('keeps preferred lanes first, then appends other lanes ordered by usable card count desc, then name', () => {
    card('c1', 'skill', 'few', 'survived', skill('a/*.ts'));
    card('c2', 'skill', 'many', 'survived', skill('b/*.ts'));
    card('c3', 'skill', 'many', 'candidate', skill('c/*.ts'));
    card('c4', 'anti_pattern', 'many', 'candidate', { failure: { gate: 'lint', error_class: 'x' } });
    card('c5', 'skill', 'many', 'regressed', skill('d/*.ts'));
    // preferred 'few' comes first; 'many' (3 usable) follows; regressed does not count
    expect(playbookLanes(db, ['few'])).toEqual(['few', 'many']);
  });

  it('dedupes a preferred lane that also appears by card count (no duplicate)', () => {
    card('c1', 'skill', 'shared', 'survived', skill('a/*.ts'));
    expect(playbookLanes(db, ['shared'])).toEqual(['shared']);
  });

  it('orders byCount ties by lane name ascending', () => {
    card('c1', 'skill', 'zeta', 'survived', skill('a/*.ts'));
    card('c2', 'skill', 'alpha', 'survived', skill('b/*.ts'));
    expect(playbookLanes(db, [])).toEqual(['alpha', 'zeta']);
  });

  it('ignores NULL lanes in the byCount portion (WHERE lane IS NOT NULL)', () => {
    card('c1', 'skill', null as unknown as string, 'survived', skill('a/*.ts'));
    card('c2', 'skill', 'real', 'survived', skill('b/*.ts'));
    expect(playbookLanes(db, [])).toEqual(['real']);
  });

  it('returns the preferred lanes unchanged when the skill_cards table is absent (fail-soft)', () => {
    db.exec('DROP TABLE skill_cards');
    expect(playbookLanes(db, ['x', 'y'])).toEqual(['x', 'y']);
  });
});

// playbookNote: deterministic dedupe key — lane (sanitized) and content hash.
describe('playbookNote', () => {
  it('formats lane and sha256 into the documented note string', () => {
    const p: Playbook = { lane: 'test-gap', lines: ['a'], cites: [], cards: 3, sha256: 'abc123' };
    expect(playbookNote(p)).toBe('lane playbook test-gap sha256 abc123');
  });

  it('strips non path/identifier characters from the lane (untrusted data never injected verbatim)', () => {
    const p: Playbook = { lane: 'ev"il; rm -rf /', lines: [], cites: [], cards: 0, sha256: 'deadbeef' };
    expect(playbookNote(p)).toBe('lane playbook evilrm-rf/ sha256 deadbeef');
  });

  it('caps the lane at 80 characters', () => {
    const long = 'a'.repeat(120);
    const p: Playbook = { lane: long, lines: [], cites: [], cards: 0, sha256: 'h' };
    expect(playbookNote(p).split(' ')[2]).toHaveLength(80);
  });

  it('matches the note shape produced for a real playbookFor result', () => {
    card('c1', 'skill', 'test-gap', 'survived', skill('a/*.ts'));
    card('c2', 'skill', 'test-gap', 'survived', skill('b/*.ts'));
    card('c3', 'anti_pattern', 'test-gap', 'candidate', { failure: { gate: 'lint', error_class: 'x' } });
    const p = playbookFor(db, 'test-gap')!;
    expect(playbookNote(p)).toBe(`lane playbook test-gap sha256 ${p.sha256}`);
  });
});