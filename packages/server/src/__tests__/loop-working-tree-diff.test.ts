import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LoopPersistenceService } from '../services/loop-persistence-service';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wtdiff-'));
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'init');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

it('includes new (untracked) files, which plain git diff omits, without touching the index', () => {
  const p = new LoopPersistenceService(repo);
  fs.mkdirSync(path.join(repo, 'src/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/__tests__/a.test.ts'), "it('a', () => {});\n");
  expect(p.git(repo, ['diff', '--', '.'])).toBe('');
  const diff = p.workingTreeDiff(repo);
  expect(diff).toContain('src/__tests__/a.test.ts');
  expect(diff).toContain("+it('a', () => {});");
  expect(git('status', '--porcelain')).toContain('?? src/'); // still untracked: read-only
});

it('combines tracked edits and new files, and caps the number of new files', () => {
  const p = new LoopPersistenceService(repo);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(repo, `n${n}.ts`), `export const n = ${n};\n`);
  const diff = p.workingTreeDiff(repo, 2);
  expect(diff).toContain('-export const a = 1;');
  expect(diff).toContain('n1.ts'); expect(diff).toContain('n2.ts'); expect(diff).not.toContain('n3.ts');
  expect(diff).toContain('# 1 more new file(s) not shown');
});
