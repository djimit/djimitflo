import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { buildCases, casePrompt, summarise } from '../scripts/checker-recall';

const FILE = 'packages/server/src/services/widget.ts';
const BASE = `export function widget(n: number): number {\n  if (n >= 10) return n - 1;\n  return n;\n}\n`;

describe('checker-recall', () => {
  let repo: string; let out: string; let db: Database.Database;
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-repo-')); out = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-out-'));
    db = new Database(':memory:'); db.exec(schema); runMigrations(db);
    git('init', '-q'); fs.mkdirSync(path.join(repo, path.dirname(FILE)), { recursive: true });
    fs.writeFileSync(path.join(repo, FILE), BASE); git('add', '.'); git('commit', '-qm', 'feat: widget');
    fs.writeFileSync(path.join(repo, FILE), `${BASE}export const label = 'widget';\n`); git('commit', '-qam', 'feat(widget): export a label');
  });
  afterEach(() => { db.close(); fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });

  it('pairs a merged change with a twin that carries one planted mutation outside the change, and builds the production checker prompt', () => {
    const cases = buildCases(repo, 5, 1);
    expect(cases.map((c) => c.label).sort()).toEqual(['clean', 'defect']); // the commit that adds the file has no base to mutate against
    const clean = cases.find((c) => c.label === 'clean')!; const defect = cases.find((c) => c.label === 'defect')!;
    expect(clean.task).toBe('feat(widget): export a label');
    const changed = defect.content.split('\n').filter((l, i) => l !== clean.content.split('\n')[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).not.toContain('label'); // never the line the commit itself added
    expect(buildCases(repo, 5, 1)).toEqual(cases); // same seed, same cases

    const { prompt } = casePrompt(new LoopService(db, path.join(out, 'evidence')), repo, defect, out);
    expect(prompt).toContain('## Maker Diff');
    expect(prompt).toContain("+export const label = 'widget';");
    expect(prompt).toContain(`+${changed[0]}`);
    expect(prompt).toContain('feat(widget): export a label');
  });

  it('scores only parsed verdicts: an unparsed case is unknown, and nothing scored gives null, not zero', () => {
    const s = summarise([
      { id: 'a', label: 'defect', verdict: 'rejected' }, { id: 'b', label: 'defect', verdict: 'accepted' }, { id: 'c', label: 'defect', verdict: null },
      { id: 'd', label: 'clean', verdict: 'accepted' }, { id: 'e', label: 'clean', verdict: 'needs_revision' },
    ]);
    expect(s.recall).toMatchObject({ n: 2, not_accepted: 1, rate: 0.5, unknown: 1 });
    expect(s.false_reject).toMatchObject({ n: 2, not_accepted: 1, rate: 0.5, unknown: 0 });
    expect(s.discrimination).toBe(0);
    const empty = summarise([{ id: 'x', label: 'defect', verdict: null }]);
    expect(empty.recall.rate).toBeNull(); expect(empty.recall.ci95).toBeNull(); expect(empty.discrimination).toBeNull();
  });
});
