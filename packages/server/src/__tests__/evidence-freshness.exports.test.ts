import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { afterAll, expect, it } from 'vitest';
import { fingerprintAt } from '../services/evidence-freshness';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpe-'));
const wt = path.join(root, 'wt');
execFileSync('git', ['init', '-q', '-b', 'main', wt]);
const write = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true }); fs.writeFileSync(path.join(wt, rel), s); };
write('a.txt', 'hello\n');
write('pkg/b.ts', 'export const b = 2;\n');
execFileSync('git', ['-C', wt, 'add', '.']);
execFileSync('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']);
const HEAD = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('fingerprintAt: returns sha256 hashes for files present at the ref', () => {
  const fp = fingerprintAt(wt, HEAD, ['a.txt', 'pkg/b.ts']);
  expect(fp['a.txt']).toBe(hash('hello\n'));
  expect(fp['pkg/b.ts']).toBe(hash('export const b = 2;\n'));
});

it('fingerprintAt: returns "missing" for paths absent at the ref', () => {
  const fp = fingerprintAt(wt, HEAD, ['does-not-exist.txt']);
  expect(fp['does-not-exist.txt']).toBe('missing');
});

it('fingerprintAt: mixes present and absent paths in a single call', () => {
  const fp = fingerprintAt(wt, HEAD, ['a.txt', 'gone.ts', 'pkg/b.ts']);
  expect(fp).toEqual({
    'a.txt': hash('hello\n'),
    'gone.ts': 'missing',
    'pkg/b.ts': hash('export const b = 2;\n'),
  });
});

it('fingerprintAt: empty paths array yields an empty object', () => {
  expect(fingerprintAt(wt, HEAD, [])).toEqual({});
});

it('fingerprintAt: reflects content at the requested ref, not the working tree', () => {
  write('a.txt', 'changed-in-wt\n');
  const fp = fingerprintAt(wt, HEAD, ['a.txt']);
  expect(fp['a.txt']).toBe(hash('hello\n'));
});