import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import type { GymTask } from './gym-task-miner';

/**
 * Y4 (plan Phase Y): an unlimited supply of oracle-backed gym tasks once the mined fix commits are used up (prod
 * 2026-10-01: 'no untried task' for atomic@llama-router after 170+ outcomes). A mutant-repair task takes a service whose
 * test exists, applies 1–3 seeded mutations (flipped comparison or boolean, swapped && / ||, off-by-one), and asks the
 * maker to make the test pass again changing only that file. The worker first checks the mutant actually breaks the test
 * (otherwise 'task: mutant survives'); any green, source-only fix counts. The tier adapts to keep success at 30–70 %.
 */
export interface MutantTask extends GymTask { base: string; mutant: string; tier: number }

const OPERATORS: Array<[RegExp, string]> = [
  [/ === /, ' !== '], [/ !== /, ' === '], [/ >= /, ' < '], [/ <= /, ' > '], [/ > /, ' <= '], [/ < /, ' >= '],
  [/ && /, ' || '], [/ \|\| /, ' && '], [/\btrue\b/, 'false'], [/\bfalse\b/, 'true'], [/ \+ 1\b/, ' - 1'], [/ - 1\b/, ' + 1'],
];
const MAX_LINES = 400;

/** Small deterministic PRNG (mulberry32): the same seed gives the same mutant. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Applies `count` mutations on distinct code lines (never imports, comments or type-only lines); null if not possible. */
export function mutate(source: string, count: number, random: () => number): string | null {
  const lines = source.split('\n');
  const eligible = lines.map((line, i) => ({ line, i })).filter(({ line }) => {
    const t = line.trim();
    return t && !t.startsWith('import ') && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !/^(export\s+)?(type|interface)\b/.test(t)
      && OPERATORS.some(([re]) => re.test(line));
  });
  const used = new Set<number>(); let applied = 0;
  for (let tries = 0; applied < count && tries < eligible.length * 3; tries++) {
    const pick = eligible[Math.floor(random() * eligible.length)];
    if (!pick || used.has(pick.i)) continue;
    const ops = OPERATORS.filter(([re]) => re.test(lines[pick.i]));
    const [re, to] = ops[Math.floor(random() * ops.length)];
    lines[pick.i] = lines[pick.i].replace(re, to);
    used.add(pick.i); applied++;
  }
  return applied === count ? lines.join('\n') : null;
}

/** Tier from the species' last 20 mutant outcomes: above 70 % success harder, below 30 % easier (1–3). */
export function mutantTier(db: Database, speciesKey: string): number {
  let rows: Array<{ ok: number; tier: number }> = [];
  try {
    rows = db.prepare(`SELECT json_extract(metadata, '$.gym_result.status') = 'success' AS ok, COALESCE(json_extract(metadata, '$.gym.tier'), 1) AS tier
      FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.commit') LIKE 'mut:%'
        AND json_extract(metadata, '$.gym.probe') IS NULL AND json_extract(metadata, '$.gym.canary') IS NULL AND json_extract(metadata, '$.gym_result.status') IN ('success', 'failure') ORDER BY created_at DESC LIMIT 20`).all(speciesKey) as Array<{ ok: number; tier: number }>;
  } catch { return 1; }
  const current = rows[0]?.tier ?? 1;
  if (rows.length < 10) return current;
  const rate = rows.filter((r) => r.ok).length / rows.length;
  return rate > 0.7 ? Math.min(3, current + 1) : rate < 0.3 ? Math.max(1, current - 1) : current;
}

/** A fresh mutant-repair task for the species, or null when the checkout has no testable service left to mutate. */
export function mutantTask(db: Database, repo: string, speciesKey: string, tried: Set<string | null>, fixedTier?: number): MutantTask | null {
  let base = '';
  try { base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5_000 }).trim(); } catch { return null; }
  const servicesDir = path.join(repo, 'packages/server/src/services');
  let files: string[] = [];
  try { files = fs.readdirSync(servicesDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).sort(); } catch { return null; }
  const candidates = files.map((f) => ({ source: `packages/server/src/services/${f}`, test: `packages/server/src/__tests__/${f.replace(/\.ts$/, '.test.ts')}` }))
    .filter((c) => fs.existsSync(path.join(repo, c.test)));
  if (!candidates.length) return null;
  const tier = fixedTier ?? mutantTier(db, speciesKey);
  for (let seed = 1; seed <= 500; seed++) {
    const random = rng(seed * 7919 + base.charCodeAt(0));
    const pick = candidates[Math.floor(random() * candidates.length)];
    const key = `mut:${base.slice(0, 12)}:${pick.source}:${tier}:${seed}`;
    if (tried.has(key)) continue;
    const original = fs.readFileSync(path.join(repo, pick.source), 'utf8');
    const lines = original.split('\n').length;
    if (lines > MAX_LINES) continue;
    const mutant = mutate(original, tier, random);
    if (!mutant || mutant === original) continue;
    return { commit: key, base, source: pick.source, tests: [pick.test], sourceLines: lines, mutant, tier };
  }
  return null;
}
