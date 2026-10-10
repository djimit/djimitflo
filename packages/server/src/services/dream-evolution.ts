import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { redactSecrets } from './secret-patterns';
import { generateText, llmEndpoints } from './llm-fallback';
import { firstJsonObject } from './expert-council-service';
import { BASELINE_GENOME, dreamEvolutionEnabled, ensureBaseline, frozenHoldoutCommits, genome, holdoutEpoch, mutantHoldoutKeys, mutantHoldoutTiers, mutantTrialsEnabled, NOT_VOID, trialHeadroomPrecheck, unscorable, writeTestHoldoutEnabled, writeTestHoldoutKeys } from './genome-registry';
import { markRun } from './scheduler-registry';
import { HOLDOUT_REUSE_LIMIT, holdoutExposure } from './evolution-evidence';

/**
 * Y3b/Y3c (plan Phase Y, Darwin loop). Dreaming is the mutation operator: once a day the day's failed makers (real and
 * gym) and a little relevant knowledge go to one model call that proposes at most 3 mutants of the active genome, each
 * changing exactly one gene (extra strategy lines or an anti-pattern line). A guard drops any line that touches gates,
 * checks, scope, secrets, deploy or the tests themselves. Mutants run as 'trial' on the frozen holdout next to their parent
 * (genome-registry + remote gym); evaluateTrials() promotes one that wins significantly more paired holdout tasks (Z5) without more out-of-scope
 * changes (≤ 1 promotion a day) and retires the rest. Behind DREAM_EVOLUTION_ENABLED (default off). Memory-rule ideas are
 * not genes: rules only change through memory review.
 */
export type DreamCaller = (prompt: string) => Promise<string>;
export const MAX_MUTANTS = 3;
/**
 * Z5: promotion needs a significant paired win, not a margin. On a 20-task holdout at an ~80 % base rate, '+2 wins' was
 * typically 3 vs 1 discordant pairs — exact one-sided McNemar p ≈ 0.31, i.e. noise. Only discordant pairs (one genome
 * green, the other not) carry information: P(X ≥ b | n = b + c, ½) < DREAM_PROMOTION_ALPHA (default 0.05) promotes.
 */
export function mcnemarOneSided(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let p = 0; let coef = 1; // C(n, 0)
  for (let k = 0; k <= n; k++) { if (k >= b) p += coef; coef = coef * (n - k) / (k + 1); }
  return p / 2 ** n;
}
const promotionAlpha = () => Number(process.env.DREAM_PROMOTION_ALPHA) || 0.05;

/**
 * RX-4 (Phase F): how much a trial could have shown. With n discordant pairs, the fewest wins (all wins, no losses
 * needed beyond n − b) that make the one-sided McNemar significant; null when even n vs 0 is not (n = 4 at 0.05).
 */
export function minDiscordantForSignificance(n: number, alpha = promotionAlpha()): number | null {
  for (let b = 0; b <= n; b++) if (b > n - b && mcnemarOneSided(b, n - b) < alpha) return b;
  return null;
}
const binom = (n: number, p: number): number[] => {
  const out: number[] = []; let coef = 1;
  for (let k = 0; k <= n; k++) { out.push(coef * p ** k * (1 - p) ** (n - k)); coef = coef * (n - k) / (k + 1); }
  return out;
};
/**
 * RX-13 (Phase F): an anytime-valid alternative to McNemar on the discordant pairs, in shadow. The e-value of a one-sided
 * uniform(½, 1) mixture over the win probability: E(n, k) = 2^(n+1) · k!(n−k)!/(n+1)! · P(Bin(n+1, ½) ≤ k), k = mutant wins
 * among n discordant pairs. Promote iff E ≥ 1/alpha; by Ville's inequality that stays valid when looked at after every pair
 * (McNemar does not). It is exchangeable, so the final value does not depend on the pair order.
 */
const logFact = (n: number): number => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
export function eValue(n: number, k: number): number {
  if (n <= 0) return 1;
  const terms = Array.from({ length: k + 1 }, (_, i) => logFact(n + 1) - logFact(i) - logFact(n + 1 - i));
  const max = Math.max(...terms);
  const logCdf = max + Math.log(terms.reduce((a, t) => a + Math.exp(t - max), 0)) - (n + 1) * Math.LN2;
  return Math.exp((n + 1) * Math.LN2 + logFact(k) + logFact(n - k) - logFact(n + 1) + logCdf);
}
export const ePaired = (pairs: Array<1 | -1>): number => eValue(pairs.length, pairs.filter((p) => p === 1).length);
export type PromotionRule = 'mcnemar' | 'both' | 'graded';
export const promotionRule = (env: NodeJS.ProcessEnv = process.env): PromotionRule =>
  (env.DREAM_PROMOTION_RULE === 'both' ? 'both' : env.DREAM_PROMOTION_RULE === 'graded' ? 'graded' : 'mcnemar');

/**
 * SI-C: graded genome trials. On prod the parent passes 17/20 deciding tasks, so binary paired tests (McNemar, e-process)
 * see almost no discordant pairs and every trial is blind. The gym also reports a graded score per attempt (`graded:<0..1>`
 * evidence ref on its skill outcome: the share of seeded mutants killed / red tests turned green), which keeps moving where
 * pass/fail saturates. The paired test is an exact sign-flip permutation test on the per-task differences (mutant − parent):
 * under H0 each difference is as likely positive as negative, so p = share of the 2^n sign assignments whose sum is at
 * least the observed one. Exact for ≤ 20 non-zero pairs (Gray-code enumeration, O(1) per assignment), a seeded Monte-Carlo
 * estimate above (deterministic, (1 + hits) / (1 + draws)). Zero differences carry no sign and drop out exactly.
 */
export const MIN_GRADED_DIFF = 0.05;
/** SI-C: a parent whose mean graded score is below this still leaves a mutant room to win, whatever its binary failures. */
export const GRADED_HEADROOM = 0.95;
const PERM_EXACT_MAX = 20; const PERM_DRAWS = 100_000; const PERM_SEED = 0x5eed;
export function pairedPermutationTest(diffs: number[]): { pUp: number; pDown: number; mean: number; n: number; exact: boolean } {
  const n = diffs.length;
  const obs = diffs.reduce((a, x) => a + x, 0); const mean = n ? obs / n : 0;
  const d = diffs.filter((x) => x !== 0).map(Math.abs);
  if (!d.length) return { pUp: 1, pDown: 1, mean, n, exact: true };
  const top = d.reduce((a, x) => a + x, 0); const eps = 1e-9 * (1 + top); // float ties count as ties
  let up = 0; let down = 0;
  if (d.length <= PERM_EXACT_MAX) {
    const total = 2 ** d.length; const sign = d.map(() => 1); let sum = top;
    for (let i = 0; ;) {
      if (sum >= obs - eps) up++;
      if (sum <= obs + eps) down++;
      if (++i === total) break;
      const j = 31 - Math.clz32(i & -i); // Gray code: step i flips the sign of its lowest set bit
      sum -= 2 * sign[j] * d[j]; sign[j] = -sign[j];
    }
    return { pUp: up / total, pDown: down / total, mean, n, exact: true };
  }
  let state = PERM_SEED; // mulberry32
  const rand = () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let k = 0; k < PERM_DRAWS; k++) {
    let sum = 0; for (const x of d) sum += rand() < 0.5 ? x : -x;
    if (sum >= obs - eps) up++;
    if (sum <= obs + eps) down++;
  }
  return { pUp: (1 + up) / (1 + PERM_DRAWS), pDown: (1 + down) / (1 + PERM_DRAWS), mean, n, exact: false };
}
/** SI-C: promote iff the one-sided test (mutant > parent) is significant AND the mean difference is ≥ MIN_GRADED_DIFF; worse iff parent > mutant is significant. */
export function gradedDecision(diffs: number[], alpha = promotionAlpha()): 'promote' | 'worse' | 'inconclusive' {
  const t = pairedPermutationTest(diffs);
  if (t.pUp < alpha && t.mean >= MIN_GRADED_DIFF - 1e-12) return 'promote';
  return t.pDown < alpha ? 'worse' : 'inconclusive';
}
/** SI-C: an attempt's graded score — the `graded:<0..1>` ref on the skill outcome of its loop run, else success 1/0. */
function gradedScorer(db: Database): (runId: string, success: boolean) => { score: number; graded: boolean } {
  let stmt: ReturnType<Database['prepare']> | null = null;
  try { stmt = db.prepare('SELECT evidence_refs_json AS refs FROM skill_outcomes WHERE evidence_refs_json LIKE ? LIMIT 1'); } catch { /* no outcomes table yet */ }
  return (runId, success) => {
    try {
      const r = stmt?.get(`%"loop_run:${runId}"%`) as { refs: string } | undefined;
      const ref = r ? (JSON.parse(r.refs) as unknown[]).find((x): x is string => typeof x === 'string' && x.startsWith('graded:')) : undefined;
      const v = ref ? Number(ref.slice('graded:'.length)) : NaN;
      if (Number.isFinite(v) && v >= 0 && v <= 1) return { score: v, graded: true };
    } catch { /* malformed refs: fall back */ }
    return { score: success ? 1 : 0, graded: false };
  };
}
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);

/**
 * Exact power of the McNemar part of the promotion rule for a fixed parent vector: the parent fails f deciding tasks
 * and solves nSolved; the mutant fixes each failure with probability q and loses each solved task with probability l.
 * f ≤ 4 at alpha 0.05 gives exactly 0 — such a trial is blind, not a tie.
 */
export function trialPower(f: number, nSolved: number, q: number, l: number, alpha = promotionAlpha()): number {
  const pb = binom(f, q); const pc = binom(nSolved, l);
  let power = 0;
  pb.forEach((wb, b) => pc.forEach((wc, c) => { if (b > c && mcnemarOneSided(b, c) < alpha) power += wb * wc; }));
  return power;
}
export const trialDiagnosticsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.TRIAL_DIAGNOSTICS_ENABLED === 'true';
const MAX_LINES = 5;
const MAX_LINE_CHARS = 200;
// what a genome may never steer: gates, checks, scope, secrets, deploy, approvals, git history (a gym `git commit` empties the
// diff the verdict reads — first dream 2026-10-01 proposed 'commit the smallest confirmed improvement') — or the tests
const FORBIDDEN = /\b(gates?|checks?|checker|scope|secrets?|tokens?|passwords?|credentials?|deploy\w*|push\w*|merge\w*|commit\w*|stash\w*|reset|revert\w*|approv\w*|skip\w*|disable\w*|no-verify|package\.json|lock ?files?|\.github|polic(y|ies)|auth\w*)\b|\b(edit|change|modify|delete|remove|rewrite|weaken)\s+(the\s+|a\s+|any\s+)?tests?\b/i;

/** Lines a mutant may add: strings, ≤ 5, ≤ 200 chars, none touching what the guard forbids. null when anything is off. */
export function guardLines(lines: unknown): string[] | null {
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_LINES) return null;
  const clean = lines.map((l) => (typeof l === 'string' ? l.replace(/\s+/g, ' ').trim() : ''));
  return clean.every((l) => l.length > 0 && l.length <= MAX_LINE_CHARS && !FORBIDDEN.test(l)) ? clean : null;
}

export function dreamInputs(db: Database, now = Date.now()): { failures: string[]; knowledge: string[]; knowledgeRefs: string[] } {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const d1 = new Date(now - 86_400_000).toISOString(); const d30 = new Date(now - 30 * 86_400_000).toISOString();
  const gym = all<{ source: string; reason: string }>(`SELECT json_extract(metadata, '$.gym.source') AS source, json_extract(metadata, '$.gym_result.reason') AS reason
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym_result.status') = 'failure' AND created_at >= ?
      -- D3 (03-10): trial runs and holdout tasks never reach the mutation step — they did, so mutants were written from the
      -- holdout's own failures (g-e4170670: "repeated 'tests still red' … on service files")
      AND json_extract(metadata, '$.gym.genome') IS NULL AND json_extract(metadata, '$.gym.canary') IS NULL
      AND json_extract(metadata, '$.gym.commit') NOT IN (SELECT commit_sha FROM gym_holdout)
      AND json_extract(metadata, '$.gym.commit') NOT IN (SELECT key FROM gym_mutant_holdout)
      AND json_extract(metadata, '$.gym.commit') NOT IN (SELECT key FROM gym_write_test_holdout) LIMIT 20`, d1)
    .map((r) => `gym: ${r.source} — ${r.reason}`);
  const real = all<{ reason: string; files: string }>(`SELECT json_extract(metadata, '$.failure_reason') AS reason, json_extract(metadata, '$.changed_files') AS files
    FROM worker_leases WHERE role = 'maker' AND status = 'failed' AND created_at >= ? LIMIT 20`, d1)
    .map((r) => `maker: ${r.reason || 'failed'} — changed ${r.files || '[]'}`);
  // KE-3: the unit ids travel with the titles, so a mutant genome records which knowledge it was written from
  const units = all<{ t: string; id: string }>(`SELECT i.canonical_name AS t, i.id FROM judgments j JOIN expert_identities i ON i.id = j.subject_id
    WHERE j.judgment = 'discovery_relevance' AND j.decision = 'yes' AND j.created_at >= ? ORDER BY j.created_at DESC LIMIT 3`, d30);
  return { failures: [...gym, ...real].map((f) => f.slice(0, 300)), knowledge: units.map((r) => r.t), knowledgeRefs: units.map((r) => r.id) };
}

/**
 * B8 (06-10, after the ruvnet/metaharness review): evidence-or-no-op mutations. Behind DREAM_EVIDENCE_MUTATIONS (default
 * off). The day's failures are grouped into clusters (source × reason class × lane × file pattern × checker verdict) and
 * the dream sees raw, redacted excerpts per cluster instead of one flat list (Meta-Harness: summaries compress the signal
 * away). Every mutant must cite a cluster id it addresses (dream-machine ADR-0005 / metaharness RefineMutator: no cited
 * failure → no change); one mutant per cluster. Same D3 guard as dreamInputs: no trial run or holdout task gets in.
 */
export const evidenceMutationsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.DREAM_EVIDENCE_MUTATIONS === 'true';
export interface FailureCluster { id: string; source: 'gym' | 'maker'; reasonClass: string; lane: string; filePattern: string; checkerVerdict: string | null; size: number;
  excerpts: Array<{ reason: string; files: string[]; checker: string | null }> }
const PROMPT_EVIDENCE_CAP = 4_000; // characters of excerpts in the prompt
export function reasonClass(reason: string): string {
  const r = reason.toLowerCase();
  if (r.startsWith('out of scope')) return 'out_of_scope';
  if (/no change|gave up|nothing changed/.test(r)) return 'no_change';
  if (/timed? ?out|timeout|crash/.test(r)) return 'timeout';
  if (/still red|tests? (failed|red)|assert/.test(r)) return 'tests_red';
  if (/exit|runtime|spawn|enoent/.test(r)) return 'runtime_error';
  if (/diff|too large|lines/.test(r)) return 'diff_size';
  return 'other';
}
/** The directory + extension of the first file ('packages/server/src/services/*.ts'), or '(no files)'. */
export function filePattern(files: string[]): string {
  const f = files.find(Boolean);
  if (!f) return '(no files)';
  const slash = f.lastIndexOf('/'); const dot = f.lastIndexOf('.');
  return `${slash >= 0 ? f.slice(0, slash) : '.'}/*${dot > slash ? f.slice(dot) : ''}`;
}
const redact = (text: string): string => redactSecrets(text).redacted;
const filesOf = (raw: string | null): string[] => { try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v.map(String).slice(0, 10) : []; } catch { return []; } };
export function failureClusters(db: Database, now = Date.now()): FailureCluster[] {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const d1 = new Date(now - 86_400_000).toISOString();
  const rows: Array<Omit<FailureCluster, 'id' | 'size' | 'excerpts'> & { reason: string; files: string[]; checker: string | null; key: string }> = [];
  // same D3 filters as dreamInputs: trial runs, canaries and every holdout never reach the mutation step
  for (const r of all<{ source: string | null; reason: string | null; created_at: string; id: string }>(`SELECT json_extract(metadata, '$.gym.source') AS source,
      json_extract(metadata, '$.gym_result.reason') AS reason, created_at, id
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym_result.status') = 'failure' AND created_at >= ?
      AND json_extract(metadata, '$.gym.genome') IS NULL AND json_extract(metadata, '$.gym.canary') IS NULL
      AND json_extract(metadata, '$.gym.commit') NOT IN (SELECT commit_sha FROM gym_holdout)
      AND json_extract(metadata, '$.gym.commit') NOT IN (SELECT key FROM gym_mutant_holdout)
      AND json_extract(metadata, '$.gym.commit') NOT IN (SELECT key FROM gym_write_test_holdout) ORDER BY created_at, id LIMIT 40`, d1)) {
    const reason = String(r.reason ?? 'failure');
    const scoped = /^out of scope:\s*(.+)$/i.exec(reason)?.[1]?.split(/,\s*/).filter(Boolean) ?? [];
    const files = scoped.length ? scoped : r.source ? [r.source] : [];
    rows.push({ source: 'gym', reasonClass: reasonClass(reason), lane: 'gym', filePattern: filePattern(files), checkerVerdict: null, reason, files, checker: null, key: '' });
  }
  for (const r of all<{ id: string; reason: string | null; files: string | null; lane: string | null; verdict: string | null; notes: string | null }>(`SELECT l.id,
      json_extract(l.metadata, '$.failure_reason') AS reason, json_extract(l.metadata, '$.changed_files') AS files, r.loop_name AS lane,
      (SELECT json_extract(c.metadata, '$.verdict') FROM worker_leases c WHERE c.role IN ('checker', 'security_checker') AND json_extract(c.metadata, '$.maker_lease_id') = l.id ORDER BY c.created_at DESC LIMIT 1) AS verdict,
      (SELECT json_extract(c.metadata, '$.notes') FROM worker_leases c WHERE c.role IN ('checker', 'security_checker') AND json_extract(c.metadata, '$.maker_lease_id') = l.id ORDER BY c.created_at DESC LIMIT 1) AS notes
    FROM worker_leases l LEFT JOIN loop_runs r ON r.id = l.loop_run_id WHERE l.role = 'maker' AND l.status = 'failed' AND l.created_at >= ? ORDER BY l.created_at, l.id LIMIT 40`, d1)) {
    const reason = String(r.reason ?? 'failed'); const files = filesOf(r.files);
    rows.push({ source: 'maker', reasonClass: reasonClass(reason), lane: r.lane ?? 'unknown', filePattern: filePattern(files), checkerVerdict: r.verdict ?? null,
      reason, files, checker: r.notes ? String(r.notes) : null, key: '' });
  }
  const groups = new Map<string, FailureCluster>();
  for (const row of rows) {
    const key = [row.source, row.reasonClass, row.lane, row.filePattern, row.checkerVerdict ?? '-'].join('|');
    let c = groups.get(key);
    if (!c) {
      c = { id: `fc-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`, source: row.source, reasonClass: row.reasonClass, lane: row.lane, filePattern: row.filePattern,
        checkerVerdict: row.checkerVerdict, size: 0, excerpts: [] };
      groups.set(key, c);
    }
    c.size++;
    if (c.excerpts.length < 3) c.excerpts.push({ reason: redact(row.reason.replace(/\s+/g, ' ').slice(0, 200)), files: row.files.map((f) => redact(f)), checker: row.checker ? redact(row.checker.replace(/\s+/g, ' ').slice(0, 200)) : null });
  }
  return [...groups.values()].sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
}
/** The evidence block of the dream prompt: per cluster id, its shape and raw excerpts, capped in size. */
export function clusterPrompt(clusters: FailureCluster[]): string[] {
  const out: string[] = []; let used = 0;
  for (const c of clusters) {
    const head = `[${c.id}] ${c.size}× ${c.source} ${c.reasonClass} · lane ${c.lane} · files ${c.filePattern}${c.checkerVerdict ? ` · checker ${c.checkerVerdict}` : ''}`;
    const lines = [head, ...c.excerpts.map((e) => `  - ${e.reason}${e.files.length ? ` (files: ${e.files.join(', ')})` : ''}${e.checker ? ` [checker: ${e.checker}]` : ''}`)];
    const size = lines.join('\n').length;
    if (used + size > PROMPT_EVIDENCE_CAP && out.length) break;
    out.push(...lines); used += size;
  }
  return out;
}

function activeParent(db: Database): string {
  const row = db.prepare("SELECT id FROM maker_genomes WHERE status = 'active' AND id <> ? ORDER BY updated_at DESC LIMIT 1").get(BASELINE_GENOME) as { id: string } | undefined;
  return row?.id ?? BASELINE_GENOME;
}

const defaultCaller: DreamCaller = (prompt) => generateText(
  { prompt, model: process.env.DREAM_EVOLUTION_MODEL || process.env.SELF_IMPROVEMENT_REVIEW_MODEL || 'kimi-k3:cloud', temperature: 0.7, maxTokens: 1200, timeoutMs: 120_000 },
  { endpoints: llmEndpoints(process.env.OLLAMA_URL || 'https://ollama.com') },
);

export async function dreamOnce(db: Database, now = Date.now(), call: DreamCaller = defaultCaller): Promise<{ created: string[]; skipped?: string }> {
  if (!dreamEvolutionEnabled()) return { created: [], skipped: 'disabled' };
  const iso = new Date(now).toISOString();
  ensureBaseline(db, iso);
  if (db.prepare("SELECT 1 FROM maker_genomes WHERE origin = 'dream' AND created_at >= ? LIMIT 1").get(iso.slice(0, 10))) return { created: [], skipped: 'already dreamt today' };
  if (db.prepare("SELECT 1 FROM maker_genomes WHERE status = 'trial' LIMIT 1").get()) return { created: [], skipped: 'a trial is still running' };
  if (evidenceMutationsEnabled()) return dreamFromEvidence(db, now, iso, call);
  const { failures, knowledge, knowledgeRefs } = dreamInputs(db, now);
  if (!failures.length) return { created: [], skipped: 'no failures to learn from' };
  const parent = genome(db, activeParent(db))!;
  const prompt = [
    'You improve the instructions given to an autonomous coding agent ("maker") that fixes code so that given tests pass.',
    `Its current extra strategy lines: ${parent.lines.length ? parent.lines.map((l) => `"${l}"`).join('; ') : '(none)'}.`,
    'Today it failed on:', ...failures.map((f) => `- ${f}`),
    ...(knowledge.length ? ['Recent relevant research titles:', ...knowledge.map((k) => `- ${k}`)] : []),
    `Propose at most ${MAX_MUTANTS} alternative strategies. Each changes ONE thing: either new "strategy_lines" (how to approach the work)`,
    'or an "anti_pattern" line (a mistake to avoid that today\'s failures show). At most 5 short lines each. Never mention tests to edit,',
    'gates, checks, scope, approvals, secrets, deploy or merging. Return JSON only:',
    '{"mutants":[{"gene":"strategy_lines|anti_pattern","lines":["..."],"rationale":"which failure this addresses"}]}',
  ].join('\n');
  const parsed = firstJsonObject(await call(prompt));
  const mutants = Array.isArray(parsed?.mutants) ? parsed!.mutants as Array<Record<string, unknown>> : [];
  const refs = knowledgeRefs.length ? JSON.stringify(knowledgeRefs) : null;
  const insert = db.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, note, created_at, updated_at, knowledge_refs_json)
    VALUES (?, ?, ?, ?, 'dream', 'trial', ?, ?, ?, ?)`);
  const created: string[] = [];
  for (const m of mutants.slice(0, MAX_MUTANTS)) {
    const gene = m.gene === 'anti_pattern' ? 'anti_pattern' : m.gene === 'strategy_lines' ? 'strategy_lines' : null;
    const lines = guardLines(m.lines);
    if (!gene || !lines) continue;
    const added = gene === 'anti_pattern' ? lines.map((l) => (l.toLowerCase().startsWith('avoid') ? l : `Avoid: ${l}`)) : lines;
    const id = `g-${randomUUID().slice(0, 8)}`;
    insert.run(id, parent.id, gene, JSON.stringify([...parent.lines, ...added]), String(m.rationale ?? '').slice(0, 300), iso, iso, refs);
    created.push(id);
  }
  return { created, ...(created.length ? {} : { skipped: 'no mutant passed the guard' }) };
}

/**
 * B8 (metaharness ADR-250: "scaling on a saturated domain buys accuracy, not evidence"; prod 06-10 Gate A: the parent passed
 * 17/20 deciding tasks). A mutant can only win tasks its parent fails, so with f parent failures on the deciding set no
 * mutant can reach the promotion rule when f is below minWinsNeeded() — the best case is winning exactly those f tasks
 * with zero losses (McNemar 5 at α 0.05; under DREAM_PROMOTION_RULE=both the smaller of McNemar and the e-process). Such a trial is settled 'inconclusive' before any
 * of its deciding attempts are spent. TRIAL_HEADROOM_PRECHECK (default off). SI-C: under DREAM_PROMOTION_RULE=graded a parent
 * whose mean graded score is below GRADED_HEADROOM still has headroom, whatever its binary failures.
 * WT-HOLDOUT (09-10): under the graded rule the parent's failures come from its most recent GATED results (claimed with
 * GYM_PROD_GATES: prod 09-10 the gated pass rate is ~55–60 %, the old ungated holdout results 17/20) — a deciding task without
 * one leaves headroom unknown and the trial runs — and the graded mean from the write_test holdout when there is one (its
 * mutant_kill share moves; a repair score is 0/1). The parent not yet scored on that holdout: wait. Other rules: unchanged.
 */
/**
 * The fewest wins that make ANY trial significant: the best case for a mutant is to win exactly the tasks its parent
 * fails, with zero losses (discordant n = b = k). McNemar: smallest k with p(k, 0) = 0.5^k < alpha (5 at 0.05);
 * e-process: smallest k with E(k, k) ≥ 1/alpha (7 at 0.05); under 'both' the smaller of the two.
 */
export function minWinsNeeded(alpha = promotionAlpha(), rule: PromotionRule = promotionRule(), cap = 64): number {
  let mcnemar = Infinity; let eproc = Infinity;
  for (let k = 1; k <= cap && (mcnemar === Infinity || eproc === Infinity); k++) {
    if (mcnemar === Infinity && mcnemarOneSided(k, 0) < alpha) mcnemar = k;
    if (eproc === Infinity && eValue(k, k) >= 1 / alpha) eproc = k;
  }
  return rule === 'both' ? Math.min(mcnemar, eproc) : mcnemar;
}
export function settleNoHeadroom(db: Database, speciesKey: string, holdoutCommits: string[], mutantCommits: string[] = [], now = Date.now(), writeTestKeys: string[] = []): Array<{ id: string; f: number; n: number; needed: number }> {
  if (!trialHeadroomPrecheck() || !holdoutCommits.length) return [];
  const deciding = mutantCommits.length ? mutantCommits : holdoutCommits;
  const iso = new Date(now).toISOString();
  const graded = promotionRule() === 'graded';
  const latest = (gated: boolean) => db.prepare(`SELECT id, json_extract(metadata, '$.gym_result.status') AS status FROM loop_runs WHERE loop_name = 'evolution-gym'
    AND json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.genome') = ? AND json_extract(metadata, '$.gym.commit') = ?
    AND status = 'completed' AND COALESCE(json_extract(metadata, '$.gym_result.reason'), '') NOT LIKE 'infra:%' AND ${NOT_VOID}
    ${gated ? "AND json_extract(metadata, '$.gym.prod_gates') = 1" : ''} ORDER BY created_at DESC LIMIT 1`);
  const result = latest(false);
  const parentResult = graded ? latest(true) : result;
  const trials = db.prepare("SELECT id, COALESCE(parent_id, ?) AS parent FROM maker_genomes WHERE status = 'trial' ORDER BY created_at").all(BASELINE_GENOME) as Array<{ id: string; parent: string }>;
  const settled: Array<{ id: string; f: number; n: number; needed: number }> = [];
  const grade = gradedScorer(db);
  for (const trial of trials) {
    const scored = deciding.filter((c) => !unscorable(db, speciesKey, trial.parent, c));
    const parent = scored.map((c) => parentResult.get(speciesKey, trial.parent, c) as { id: string; status: string } | undefined);
    if (parent.some((r) => !r)) continue; // the parent is not fully scored yet (graded rule: no gated result yet)
    if (scored.every((c) => result.get(speciesKey, trial.id, c) || unscorable(db, speciesKey, trial.id, c))) continue; // already run: evaluateTrials decides
    const n = scored.length; const f = parent.filter((r) => r?.status !== 'success').length;
    const needed = minWinsNeeded();
    if (f >= needed) continue;
    // WT-HOLDOUT: under the graded rule the write_test holdout's mutant_kill mean is the graded headroom when there is one
    const wt = graded ? writeTestKeys.filter((k) => !unscorable(db, speciesKey, trial.parent, k)).map((k) => result.get(speciesKey, trial.parent, k) as { id: string; status: string } | undefined) : [];
    if (wt.some((r) => !r)) continue; // the parent has not run the write_test holdout yet
    const parentGraded = avg((wt.length ? wt : parent).map((r) => grade(r!.id, r!.status === 'success').score));
    if (graded && parentGraded < GRADED_HEADROOM) continue; // SI-C: graded headroom
    const shown = Number.isFinite(needed) ? needed : n + 1;
    db.prepare("UPDATE maker_genomes SET status = 'inconclusive', note = ?, updated_at = ? WHERE id = ? AND status = 'trial'")
      .run(`no_headroom: parent fails ${f} of ${n}; ≥ ${shown} needed for any significant win`, iso, trial.id);
    try {
      db.prepare(`INSERT OR REPLACE INTO genome_trial_results (trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, mined_b, mined_c, power_q8_l05, state, recorded_at, epoch, graded_mean_parent)
        VALUES (?, ?, ?, ?, ?, 0, 0, 1, 0, 0, 0, 'no_headroom', ?, ?, ?)`).run(trial.id, trial.parent, mutantCommits.length ? mutantHoldoutTiers().join(',') : 'mined', n, f, iso,
        holdoutEpoch(db, mutantCommits.length ? 'gym_mutant_holdout' : 'gym_holdout'), parentGraded);
    } catch { /* the record is fail-soft; the settlement above is what stops the attempts */ }
    console.log(`🧬 genome ${trial.id} inconclusive (no headroom: parent fails ${f} of ${n}; ≥ ${shown} needed for any significant win)`);
    settled.push({ id: trial.id, f, n, needed: shown });
  }
  return settled;
}

/** B8: the evidence path of dreamOnce — clusters in, ≤ 1 cited mutant per cluster out; uncited mutants are rejected ('no_evidence'). */
async function dreamFromEvidence(db: Database, now: number, iso: string, call: DreamCaller): Promise<{ created: string[]; skipped?: string; rejected: Array<{ reason: string }> }> {
  const clusters = failureClusters(db, now);
  if (!clusters.length) return { created: [], skipped: 'no failures to learn from', rejected: [] };
  const { knowledge, knowledgeRefs } = dreamInputs(db, now);
  const parent = genome(db, activeParent(db))!;
  const prompt = [
    'You improve the instructions given to an autonomous coding agent ("maker") that fixes code so that given tests pass.',
    `Its current extra strategy lines: ${parent.lines.length ? parent.lines.map((l) => `"${l}"`).join('; ') : '(none)'}.`,
    'Today\'s failures, grouped into clusters (id, count, shape, raw excerpts):', ...clusterPrompt(clusters),
    ...(knowledge.length ? ['Recent relevant research titles:', ...knowledge.map((k) => `- ${k}`)] : []),
    `Propose at most ${MAX_MUTANTS} alternative strategies, at most one per cluster. Each changes ONE thing: either new "strategy_lines" (how to approach the work)`,
    'or an "anti_pattern" line (a mistake to avoid that the cluster shows). At most 5 short lines each. Each MUST name the cluster id it addresses in "addresses".',
    'A mutant without a valid cluster id is discarded. Never mention tests to edit, gates, checks, scope, approvals, secrets, deploy or merging. Return JSON only:',
    '{"mutants":[{"gene":"strategy_lines|anti_pattern","lines":["..."],"addresses":["fc-…"],"rationale":"how this fixes that cluster"}]}',
  ].join('\n');
  const parsed = firstJsonObject(await call(prompt));
  const mutants = Array.isArray(parsed?.mutants) ? parsed!.mutants as Array<Record<string, unknown>> : [];
  const valid = new Set(clusters.map((c) => c.id)); const usedClusters = new Set<string>();
  const refs = knowledgeRefs.length ? JSON.stringify(knowledgeRefs) : null;
  const insert = db.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, note, created_at, updated_at, evidence_clusters, knowledge_refs_json)
    VALUES (?, ?, ?, ?, 'dream', 'trial', ?, ?, ?, ?, ?)`);
  const created: string[] = []; const rejected: Array<{ reason: string }> = [];
  for (const m of mutants) {
    if (created.length >= MAX_MUTANTS) break;
    const cites = (Array.isArray(m.addresses) ? m.addresses : [m.addresses]).map(String).filter((c) => valid.has(c));
    const fresh = cites.filter((c) => !usedClusters.has(c));
    if (!cites.length) { rejected.push({ reason: 'no_evidence' }); continue; }
    if (!fresh.length) { rejected.push({ reason: 'cluster_taken' }); continue; }
    const gene = m.gene === 'anti_pattern' ? 'anti_pattern' : m.gene === 'strategy_lines' ? 'strategy_lines' : null;
    const lines = guardLines(m.lines);
    if (!gene || !lines) { rejected.push({ reason: 'guard' }); continue; }
    const added = gene === 'anti_pattern' ? lines.map((l) => (l.toLowerCase().startsWith('avoid') ? l : `Avoid: ${l}`)) : lines;
    const id = `g-${randomUUID().slice(0, 8)}`;
    usedClusters.add(fresh[0]);
    insert.run(id, parent.id, gene, JSON.stringify([...parent.lines, ...added]), String(m.rationale ?? '').slice(0, 300), iso, iso, JSON.stringify([fresh[0]]), refs);
    created.push(id);
  }
  return { created, rejected, ...(created.length ? {} : { skipped: rejected.some((r) => r.reason === 'no_evidence') ? 'no mutant cited a failure cluster' : 'no mutant passed the guard' }) };
}

/** Settles finished trials: paired holdout results decide; at most one promotion a day; everything else retires. */
/**
 * WT-HOLDOUT: `writeTestKeys` (the frozen write_test holdout, DREAM_TRIAL_WRITE_TEST_HOLDOUT) must be scored too before a
 * trial settles; their graded mutant_kill scores join the paired graded test (decides under the graded rule, shadow columns
 * otherwise). Binary wins, McNemar, the mined no-regression check and out-of-scope stay on the repair holdouts.
 */
export function evaluateTrials(db: Database, speciesKey: string, holdoutCommits: string[], now = Date.now(), mutantCommits: string[] = [], writeTestKeys: string[] = []): Array<{ id: string; status: 'active' | 'retired' | 'inconclusive'; wins: number; parentWins: number }> {
  if (!holdoutCommits.length) return [];
  const binary = [...holdoutCommits, ...mutantCommits];
  const all = [...binary, ...writeTestKeys];
  const iso = new Date(now).toISOString();
  const results = db.prepare(`SELECT id, json_extract(metadata, '$.gym.commit') AS commit_sha, json_extract(metadata, '$.gym_result.status') AS status,
      COALESCE(json_extract(metadata, '$.gym_result.reason'), '') AS reason
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.genome') = ?
      AND status = 'completed' AND COALESCE(json_extract(metadata, '$.gym_result.reason'), '') NOT LIKE 'infra:%' AND ${NOT_VOID}`);
  // GENOME_FIRE_CHECK: VOID attempts (the genome's lines never reached the maker) are never paired; counted for the note
  const voids = db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.species') = ?
      AND json_extract(metadata, '$.gym.genome') = ? AND NOT ${NOT_VOID}`);
  const score = (genomeId: string) => {
    const rows = (results.all(speciesKey, genomeId) as Array<{ id: string; commit_sha: string; status: string; reason: string }>).filter((r) => all.includes(r.commit_sha));
    const byCommit = new Map(rows.map((r) => [r.commit_sha, r]));
    const repair = [...byCommit.values()].filter((r) => binary.includes(r.commit_sha));
    return { byCommit, complete: all.every((c) => byCommit.has(c) || unscorable(db, speciesKey, genomeId, c)), wins: repair.filter((r) => r.status === 'success').length,
      won: new Set(repair.filter((r) => r.status === 'success').map((r) => r.commit_sha)),
      outOfScope: repair.filter((r) => r.reason.startsWith('out of scope')).length };
  };
  const settled: Array<{ id: string; status: 'active' | 'retired' | 'inconclusive'; wins: number; parentWins: number }> = [];
  // Cockpit 3.0 scenario 10 (§16.11): the deciding holdout epoch, once more distinct candidates were judged on it than the contract
  // allows, no longer separates skill from repeated exposure — neither a win nor a loss on it is evidence. Default on (safety block);
  // DREAM_HOLDOUT_REUSE_LIMIT overrides the limit. A fresh epoch (GYM_HOLDOUT_EPOCH) is the operator's way out.
  const reuseLimit = Number(process.env.DREAM_HOLDOUT_REUSE_LIMIT) > 0 ? Number(process.env.DREAM_HOLDOUT_REUSE_LIMIT) : HOLDOUT_REUSE_LIMIT;
  const decidingHoldout = mutantCommits.length ? 'mutant' : 'mined';
  const exhausted = () => {
    const epoch = holdoutEpoch(db, mutantCommits.length ? 'gym_mutant_holdout' : 'gym_holdout');
    return holdoutExposure(db, process.env, reuseLimit).epochs.find((e) => e.holdout === decidingHoldout && e.epoch === epoch && e.candidates > reuseLimit);
  };
  const promotedToday = () => Boolean(db.prepare("SELECT 1 FROM maker_genomes WHERE origin = 'dream' AND status = 'active' AND updated_at >= ? LIMIT 1").get(iso.slice(0, 10)));
  const trials = db.prepare("SELECT id, COALESCE(parent_id, ?) AS parent FROM maker_genomes WHERE status = 'trial' ORDER BY created_at").all(BASELINE_GENOME) as Array<{ id: string; parent: string }>;
  const grade = gradedScorer(db);
  const voidNote = (id: string) => { const n = (voids.get(speciesKey, id) as { n: number }).n; return n ? `; void ${n} (fire check)` : ''; };
  for (const trial of trials) {
    const mine = score(trial.id); const theirs = score(trial.parent);
    if (!mine.complete || !theirs.complete) continue;
    const spent = exhausted();
    if (spent) { // symmetric on purpose: no promotion and no retirement from a spent holdout
      db.prepare("UPDATE maker_genomes SET status = 'inconclusive', note = ?, updated_at = ? WHERE id = ? AND status = 'trial'")
        .run(`holdout_exhausted: ${spent.holdout} epoch ${spent.epoch} used by ${spent.candidates} candidates (limit ${reuseLimit})`, iso, trial.id);
      console.log(`🧬 genome ${trial.id} inconclusive (holdout_exhausted: ${spent.holdout} epoch ${spent.epoch}, ${spent.candidates} candidates > ${reuseLimit})`);
      settled.push({ id: trial.id, status: 'inconclusive', wins: mine.wins, parentWins: theirs.wins });
      continue;
    }
    // paired comparison only on tasks both genomes could be scored on (a timed-out pair is unscorable, not lost)
    const discordant = (list: string[]) => {
      const scored = list.filter((h) => !unscorable(db, speciesKey, trial.id, h) && !unscorable(db, speciesKey, trial.parent, h));
      return { b: scored.filter((h) => mine.won.has(h) && !theirs.won.has(h)).length, c: scored.filter((h) => theirs.won.has(h) && !mine.won.has(h)).length };
    };
    // Z5: judged on the mutant holdout when there is one; the mined holdout may then cost at most one task net
    const deciding = mutantCommits.length ? mutantCommits : holdoutCommits;
    const { b, c } = discordant(deciding);
    const mined = mutantCommits.length ? discordant(holdoutCommits) : { b: 0, c: 0 };
    const p = mcnemarOneSided(b, c);
    // SI-C: graded scores on the same paired deciding tasks; decides under DREAM_PROMOTION_RULE=graded, recorded always
    const pairs = [...deciding, ...writeTestKeys].filter((h) => !unscorable(db, speciesKey, trial.id, h) && !unscorable(db, speciesKey, trial.parent, h))
      .map((h) => [theirs.byCommit.get(h), mine.byCommit.get(h)]).filter((x): x is [NonNullable<typeof x[0]>, NonNullable<typeof x[1]>] => Boolean(x[0] && x[1]))
      .map(([pr, mr]) => [grade(pr.id, pr.status === 'success'), grade(mr.id, mr.status === 'success')]);
    const diffs = pairs.map(([pg, mg]) => mg.score - pg.score);
    const graded = { parent: avg(pairs.map(([pg]) => pg.score)), mutant: avg(pairs.map(([, mg]) => mg.score)), p: pairedPermutationTest(diffs).pUp,
      decision: gradedDecision(diffs), refs: pairs.reduce((a, [pg, mg]) => a + Number(pg.graded) + Number(mg.graded), 0) };
    const significant = promotionRule() === 'graded' ? graded.decision === 'promote' : b > c && p < promotionAlpha();
    const wins = significant && mined.c - mined.b <= 1 && mine.outOfScope <= theirs.outOfScope && !promotedToday();
    const status = wins ? 'active' : 'retired';
    const gradedNote = promotionRule() === 'graded' ? `; graded ${graded.mutant.toFixed(3)} vs ${graded.parent.toFixed(3)}, permutation p=${graded.p.toPrecision(3)} (${graded.decision})` : '';
    db.prepare('UPDATE maker_genomes SET status = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(status, `holdout ${mine.wins}/${binary.length} vs parent ${theirs.wins}/${binary.length}; ${mutantCommits.length ? 'mutant ' : ''}discordant ${b} vs ${c}, McNemar p=${p.toFixed(3)}${gradedNote}${writeTestKeys.length ? `; write_test ${writeTestKeys.length} in the graded test` : ''}${mutantCommits.length ? `; mined discordant ${mined.b} vs ${mined.c}` : ''}; out of scope ${mine.outOfScope} vs ${theirs.outOfScope}${voidNote(trial.id)}`, iso, trial.id);
    if (trialDiagnosticsEnabled()) {
      try { // RX-4: record what this trial could have shown; never changes the decision above
        const scored = deciding.filter((h) => !unscorable(db, speciesKey, trial.id, h) && !unscorable(db, speciesKey, trial.parent, h));
        const f = scored.filter((h) => !theirs.won.has(h)).length;
        const power = trialPower(f, scored.length - f, 0.8, 0.05);
        const state = mcnemarOneSided(f, 0) >= promotionAlpha() ? 'blind' : power < 0.8 ? 'underpowered' : 'powered';
        db.prepare(`INSERT OR REPLACE INTO genome_trial_results (trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, mined_b, mined_c, power_q8_l05, state, recorded_at, epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(trial.id, trial.parent, mutantCommits.length ? mutantHoldoutTiers().join(',') : 'mined', scored.length, f, b, c, p, mined.b, mined.c,
          +power.toFixed(4), state, iso, holdoutEpoch(db, mutantCommits.length ? 'gym_mutant_holdout' : 'gym_holdout'));
      } catch { /* diagnostics are fail-soft */ }
    }
    if (promotionRule() === 'both') {
      try { // RX-13: the e-process decision next to McNemar, same side conditions; recorded only, never acted on
        const e = eValue(b + c, b);
        const eDecision = b > c && e >= 1 / promotionAlpha() && mined.c - mined.b <= 1 && mine.outOfScope <= theirs.outOfScope ? 'promote' : 'hold';
        db.prepare(`INSERT INTO genome_trial_results (trial_id, parent_id, state, recorded_at, epoch, e_value, n_discordant, e_rule_decision) VALUES (?, ?, 'e_only', ?, ?, ?, ?, ?)
          ON CONFLICT(trial_id) DO UPDATE SET e_value = excluded.e_value, n_discordant = excluded.n_discordant, e_rule_decision = excluded.e_rule_decision`)
          .run(trial.id, trial.parent, iso, holdoutEpoch(db, mutantCommits.length ? 'gym_mutant_holdout' : 'gym_holdout'), e, b + c, eDecision);
      } catch { /* shadow record is fail-soft */ }
    }
    try { // SI-C: last, so the INSERT OR REPLACE of the diagnostics row above cannot wipe it; shadow unless the rule is graded
      db.prepare(`INSERT INTO genome_trial_results (trial_id, parent_id, state, recorded_at, epoch, graded_mean_parent, graded_mean_mutant, graded_p, graded_decision, graded_refs)
        VALUES (?, ?, 'graded_only', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trial_id) DO UPDATE SET graded_mean_parent = excluded.graded_mean_parent,
        graded_mean_mutant = excluded.graded_mean_mutant, graded_p = excluded.graded_p, graded_decision = excluded.graded_decision, graded_refs = excluded.graded_refs`)
        .run(trial.id, trial.parent, iso, holdoutEpoch(db, mutantCommits.length ? 'gym_mutant_holdout' : 'gym_holdout'), graded.parent, graded.mutant, graded.p, graded.decision, graded.refs);
    } catch { /* the record is fail-soft */ }
    settled.push({ id: trial.id, status, wins: mine.wins, parentWins: theirs.wins });
  }
  return settled;
}

/** Hourly: dream (at most once a day) and settle finished trials for the gym species that runs them. */
export function startDreamEvolution(db: Database, intervalMs = 3_600_000): (() => void) | null {
  if (!dreamEvolutionEnabled()) return null;
  const species = process.env.DREAM_EVOLUTION_SPECIES || 'atomic@llama-router';
  const tick = () => {
    markRun('dream_evolution');
    try {
      const commits = frozenHoldoutCommits(db); // RX-12: the current epoch's mined holdout
      const mutants = mutantTrialsEnabled() ? mutantHoldoutKeys(db) : [];
      const writeTests = writeTestHoldoutEnabled() ? writeTestHoldoutKeys(db) : []; // WT-HOLDOUT: graded only
      // Z5 on but the mutant holdout not frozen yet (no claim since): don't settle a trial on the mined holdout alone
      if (!(mutantTrialsEnabled() && !mutants.length)) settleNoHeadroom(db, species, commits, mutants, Date.now(), writeTests);
      for (const s of mutantTrialsEnabled() && !mutants.length ? [] : evaluateTrials(db, species, commits, Date.now(), mutants, writeTests)) console.log(`🧬 genome ${s.id} ${s.status} (holdout ${s.wins} vs parent ${s.parentWins})`);
    } catch (e) { console.warn('dream evolution: evaluate failed:', e instanceof Error ? e.message : String(e)); }
    dreamOnce(db).then((r) => { if (r.created.length) console.log(`🧬 dreamt ${r.created.length} mutant(s): ${r.created.join(', ')}`); })
      .catch((e) => console.warn('dream evolution: dream failed:', e instanceof Error ? e.message : String(e)));
  };
  tick(); const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
