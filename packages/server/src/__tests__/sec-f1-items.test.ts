import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// SEC-F1 amendment 1 (docs/research/eco/SEC-F1_PROTOCOL.md): the 46 items are verbatim upstream
// diffs. This test pins the manifest so an item cannot drift or be hand-edited after registration.
const DIR = path.resolve(__dirname, '../../../../docs/research/eco/sec-f1');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const sources = JSON.parse(fs.readFileSync(path.join(DIR, 'sources.json'), 'utf8'));
type Item = {
  id: string; source: string; variant: 'vulnerable' | 'benign_fix' | 'decoy'; class: string | null; repo: string; license: string;
  upstream_commit: string; ghsa: string | null; base_sha: string; files: string[]; changed_lines: number;
  patch_sha256: string; finding: Record<string, unknown>; finding_sha256: string;
};
const items: Item[] = manifest.items;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const patchOf = (i: Item) => fs.readFileSync(path.join(DIR, 'items', `${i.id}.patch`), 'utf8');
const lines = (p: string, sign: '+' | '-') =>
  p.split('\n').filter((l) => l.startsWith(sign) && !l.startsWith(`${sign}${sign}${sign} `)).map((l) => l.slice(1)).sort();
const CLASSES = ['secret_exposure', 'command_injection', 'path_traversal', 'auth_bypass', 'unsafe_eval'];

describe('SEC-F1 items (amendment 1: real upstream fixes)', () => {
  it('has 20 vulnerable (4 per class), 20 benign fixes and 6 decoys', () => {
    expect(items).toHaveLength(46);
    expect(items.filter((i) => i.variant === 'benign_fix')).toHaveLength(20);
    expect(items.filter((i) => i.variant === 'decoy')).toHaveLength(6);
    for (const c of CLASSES) expect(items.filter((i) => i.variant === 'vulnerable' && i.class === c)).toHaveLength(4);
    expect(items.filter((i) => i.variant !== 'vulnerable').every((i) => i.class === null)).toBe(true);
  });

  it('ids are opaque and reproducible, patches match their hashes, no stray files', () => {
    for (const i of items) {
      expect(i.id).toBe(sha256(`20261021|${i.source}|${i.variant}`).slice(0, 10));
      expect(sha256(patchOf(i))).toBe(i.patch_sha256);
      expect(sha256(JSON.stringify(i.finding))).toBe(i.finding_sha256);
    }
    expect(fs.readdirSync(path.join(DIR, 'items')).sort()).toEqual(items.map((i) => `${i.id}.patch`).sort());
  });

  it('only permissive licenses, every fix has an advisory, decoys are not advisory commits', () => {
    for (const i of items) expect(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']).toContain(i.license);
    for (const i of items.filter((x) => x.variant !== 'decoy')) expect(i.ghsa).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    const fixShas = new Set(sources.fixes.map((f: { fix_commit: string }) => f.fix_commit));
    for (const i of items.filter((x) => x.variant === 'decoy')) {
      expect(i.ghsa).toBeNull();
      expect(fixShas.has(i.upstream_commit)).toBe(false);
    }
    expect(new Set(sources.decoys.map((d: { repo: string }) => d.repo)).size).toBe(6);
  });

  it('each vulnerable item is the exact inverse of its benign fix, on the fix commit', () => {
    for (const fix of sources.fixes) {
      const pair = items.filter((i) => i.upstream_commit === fix.fix_commit);
      const vuln = pair.find((i) => i.variant === 'vulnerable')!;
      const benign = pair.find((i) => i.variant === 'benign_fix')!;
      expect(vuln.class).toBe(fix.class);
      expect(vuln.base_sha).toBe(fix.fix_commit);
      expect(benign.base_sha).toBe(fix.parent);
      expect(vuln.files).toEqual(benign.files);
      expect(vuln.finding).toEqual(benign.finding);
      const v = patchOf(vuln);
      const b = patchOf(benign);
      expect(lines(v, '+')).toEqual(lines(b, '-'));
      expect(lines(v, '-')).toEqual(lines(b, '+'));
    }
  });

  it('diffs are small, non-test JS/TS source only', () => {
    for (const i of items) {
      expect(i.changed_lines).toBeGreaterThan(0);
      expect(i.changed_lines).toBeLessThanOrEqual(40);
      for (const f of i.files) {
        expect(f).toMatch(/\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/);
        expect(f).not.toMatch(/(^|\/)(test|tests|__tests__|spec|fixtures?)\/|\.(test|spec)\.|\.d\.ts$/);
      }
    }
  });

  it('decoys carry a keyword on an added line', () => {
    for (const i of items.filter((x) => x.variant === 'decoy')) {
      expect(lines(patchOf(i), '+').some((l) => /token|secret|deploy|exec/i.test(l))).toBe(true);
    }
  });

  it('the reviewer-facing finding never leaks a label or a class', () => {
    const leak = /vulnerab|planted|benign|decoy|inject|travers|bypass|eval|secret|exposure|advisory|GHSA|CVE/i;
    for (const i of items) expect(JSON.stringify(i.finding)).not.toMatch(leak);
  });
});
