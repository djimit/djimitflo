import { expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * B29: the negative-evidence registry (docs/research/negative-evidence) is permanent. Its schema is checked here, and an
 * entry with a closing verdict forbids its `forbidden_code_patterns` in the server source, so a rejected approach
 * (NE-001: jev cascade routing of the proposal pre-screen) cannot be silently rebuilt.
 */
const repo = path.resolve(__dirname, '../../../..');
const REGISTRY = path.join(repo, 'docs/research/negative-evidence/NEGATIVE_EVIDENCE.yaml');
const VERDICTS = ['REJECT', 'NO_GO', 'FALSIFIED', 'INCONCLUSIVE'];
const CLOSED = ['REJECT', 'NO_GO', 'FALSIFIED'];
type Entry = { id: string; hypothesis: string; verdict: string; evidence: string[]; reopen_condition: string; forbidden_code_patterns?: string[] };
// JSON is valid YAML 1.2; the registry is kept in that subset so no YAML dependency is needed
const registry = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as { version: number; entries: Entry[] };

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === '__tests__' || d.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.(ts|tsx|mjs|js)$/.test(d.name) ? [p] : [];
  });
}

it('B29: every negative-evidence entry has an id, hypothesis, verdict, evidence refs and a reopen condition', () => {
  const { entries } = registry();
  expect(entries.length).toBeGreaterThan(0);
  const ids = new Set<string>();
  for (const e of entries) {
    expect(e.id).toMatch(/^NE-\d{3}$/);
    expect(ids.has(e.id)).toBe(false); ids.add(e.id);
    expect(typeof e.hypothesis === 'string' && e.hypothesis.length > 10).toBe(true);
    expect(VERDICTS).toContain(e.verdict);
    expect(Array.isArray(e.evidence) && e.evidence.length > 0).toBe(true);
    expect(typeof e.reopen_condition === 'string' && e.reopen_condition.length > 10).toBe(true);
  }
  const ne1 = entries.find((e) => e.id === 'NE-001');
  expect(ne1?.verdict).toBe('REJECT');
  expect(ne1?.evidence.join(' ')).toContain('fbc9c5d180929c43844ec8beca26bd5fbd7a62ca43b472c3efc369c0b08bbab1');
});

it('B29: a rejected approach cannot be rebuilt — forbidden code patterns of closed entries are absent from the source', () => {
  const files = [...sourceFiles(path.join(repo, 'packages/server/src')), ...sourceFiles(path.join(repo, 'packages/dashboard/src')), path.join(repo, 'docs/runbooks/self-improvement-loop-operations.md')]
    .filter((f) => fs.existsSync(f));
  const hits: string[] = [];
  for (const e of registry().entries.filter((x) => CLOSED.includes(x.verdict))) {
    for (const pattern of e.forbidden_code_patterns ?? []) {
      for (const f of files) if (fs.readFileSync(f, 'utf8').includes(pattern)) hits.push(`${e.id}: ${pattern} in ${path.relative(repo, f)}`);
    }
  }
  expect(hits).toEqual([]);
});
