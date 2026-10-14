import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

vi.mock('../services/memory-template-dedup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/memory-template-dedup')>();
  return { ...actual, findTemplateMatches: vi.fn(actual.findTemplateMatches), recordTemplateDuplicate: vi.fn(actual.recordTemplateDuplicate) };
});

import * as dedup from '../services/memory-template-dedup';
import { MemoryCandidateService } from '../services/memory-candidate-service';

const lesson = (run: string) => `Loop ${run} closed with score 0.82 as baseline; preserve checker evidence, gates and runtime artifacts for the next run.`;
const count = (db: Database.Database) => (db.prepare('SELECT COUNT(*) AS n FROM memory_candidates').get() as { n: number }).n;
const errors = (db: Database.Database) => db.prepare("SELECT * FROM judgments WHERE judgment = 'memory_template_dedup_error'").all() as Array<Record<string, any>>;

describe('MEMORY_TEMPLATE_DEDUP_MODE fails open', () => {
  let db: Database.Database;
  let svc: MemoryCandidateService;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    svc = new MemoryCandidateService(db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.mocked(dedup.findTemplateMatches).mockReset(); vi.mocked(dedup.recordTemplateDuplicate).mockReset(); vi.restoreAllMocks(); db?.close(); });

  it('shadow: a throwing lookup still creates the candidate and records memory_template_dedup_error', () => {
    vi.stubEnv('MEMORY_TEMPLATE_DEDUP_MODE', 'shadow');
    vi.mocked(dedup.findTemplateMatches).mockImplementation(() => { throw new Error('lookup boom'); });
    const created = svc.create({ title: 'Loop learning', content: lesson('11111111-1111-1111-1111-111111111111') });
    expect(count(db)).toBe(1);
    expect(errors(db)).toMatchObject([{ subject_id: created.id, mode: 'shadow', decision: 'fail_open', error: 'lookup boom' }]);
  });

  it('shadow: a throwing judgment insert still creates the candidate', () => {
    vi.stubEnv('MEMORY_TEMPLATE_DEDUP_MODE', 'shadow');
    vi.mocked(dedup.findTemplateMatches).mockReturnValue([{ id: 'existing', status: 'promoted' }]);
    vi.mocked(dedup.recordTemplateDuplicate).mockImplementation(() => { throw new Error('insert boom'); });
    const created = svc.create({ title: 'Loop learning', content: lesson('22222222-2222-2222-2222-222222222222') });
    expect(svc.get(created.id).content).toContain('preserve checker evidence');
    expect(count(db)).toBe(1);
    expect(errors(db)).toMatchObject([{ subject_id: created.id, error: 'insert boom' }]);
  });

  it('enforce: a throwing lookup creates the candidate (never skipped)', () => {
    vi.stubEnv('MEMORY_TEMPLATE_DEDUP_MODE', 'enforce');
    svc.create({ title: 'Loop learning', content: lesson('33333333-3333-3333-3333-333333333333') });
    vi.mocked(dedup.findTemplateMatches).mockImplementation(() => { throw new Error('lookup boom'); });
    const second = svc.create({ title: 'Loop learning', content: lesson('44444444-4444-4444-4444-444444444444') });
    expect(count(db)).toBe(2);
    expect(errors(db)).toMatchObject([{ subject_id: second.id, mode: 'enforce' }]);
  });

  it('enforce: a match whose row cannot be read creates the candidate (never skipped)', () => {
    vi.stubEnv('MEMORY_TEMPLATE_DEDUP_MODE', 'enforce');
    vi.mocked(dedup.findTemplateMatches).mockReturnValue([{ id: 'vanished', status: 'candidate' }]);
    svc.create({ title: 'Loop learning', content: lesson('55555555-5555-5555-5555-555555555555') });
    expect(count(db)).toBe(1);
    expect(errors(db)).toHaveLength(1);
  });

  it('off: never calls the lookup', () => {
    svc.create({ title: 'Loop learning', content: lesson('66666666-6666-6666-6666-666666666666') });
    svc.create({ title: 'Loop learning', content: lesson('77777777-7777-7777-7777-777777777777') });
    expect(dedup.findTemplateMatches).not.toHaveBeenCalled();
    expect(count(db)).toBe(2);
    expect(errors(db)).toHaveLength(0);
  });
});
