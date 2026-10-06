import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { generateText, llmEndpoints } from './llm-fallback';
import { firstJsonObject } from './expert-council-service';
import { BASELINE_GENOME, dreamEvolutionEnabled, ensureBaseline, frozenHoldoutCommits, genome, holdoutEpoch, mutantHoldoutKeys, mutantHoldoutTiers, mutantTrialsEnabled, unscorable } from './genome-registry';

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
export const promotionRule = (env: NodeJS.ProcessEnv = process.env): 'mcnemar' | 'both' => (env.DREAM_PROMOTION_RULE === 'both' ? 'both' : 'mcnemar');

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

export function dreamInputs(db: Database, now = Date.now()): { failures: string[]; knowledge: string[] } {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const d1 = new Date(now - 86_400_000).toISOString(); const d30 = new Date(now - 30 * 86_400_000).toISOString();
  const gym = all<{ source: string; reason: string }>(`SELECT json_extract(metadata, '$.gym.source') AS source, json_extract(metadata, '$.gym_result.reason') AS reason
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym_result.status') = 'failure' AND created_at >= ?
      -- D3 (03-10): trial runs and holdout tasks never reach the mutation step — they did, so mutants were written from the
      -- holdout's own failures (g-e4170670: "repeated 'tests still red' … on service files")
      AND json_extract(metadata, '$.gym.genome') IS NULL AND json_extract(metadata, '$.gym.canary') IS NULL
      AND json_extract(metadata, '$.gym.commit') NOT IN (SELECT commit_sha FROM gym_holdout)
      AND json_extract(metadata, '$.gym.commit') NOT IN (SELECT key FROM gym_mutant_holdout) LIMIT 20`, d1)
    .map((r) => `gym: ${r.source} — ${r.reason}`);
  const real = all<{ reason: string; files: string }>(`SELECT json_extract(metadata, '$.failure_reason') AS reason, json_extract(metadata, '$.changed_files') AS files
    FROM worker_leases WHERE role = 'maker' AND status = 'failed' AND created_at >= ? LIMIT 20`, d1)
    .map((r) => `maker: ${r.reason || 'failed'} — changed ${r.files || '[]'}`);
  const knowledge = all<{ t: string }>(`SELECT i.canonical_name AS t FROM judgments j JOIN expert_identities i ON i.id = j.subject_id
    WHERE j.judgment = 'discovery_relevance' AND j.decision = 'yes' AND j.created_at >= ? ORDER BY j.created_at DESC LIMIT 3`, d30).map((r) => r.t);
  return { failures: [...gym, ...real].map((f) => f.slice(0, 300)), knowledge };
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
  const { failures, knowledge } = dreamInputs(db, now);
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
  const insert = db.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'dream', 'trial', ?, ?, ?)`);
  const created: string[] = [];
  for (const m of mutants.slice(0, MAX_MUTANTS)) {
    const gene = m.gene === 'anti_pattern' ? 'anti_pattern' : m.gene === 'strategy_lines' ? 'strategy_lines' : null;
    const lines = guardLines(m.lines);
    if (!gene || !lines) continue;
    const added = gene === 'anti_pattern' ? lines.map((l) => (l.toLowerCase().startsWith('avoid') ? l : `Avoid: ${l}`)) : lines;
    const id = `g-${randomUUID().slice(0, 8)}`;
    insert.run(id, parent.id, gene, JSON.stringify([...parent.lines, ...added]), String(m.rationale ?? '').slice(0, 300), iso, iso);
    created.push(id);
  }
  return { created, ...(created.length ? {} : { skipped: 'no mutant passed the guard' }) };
}

/** Settles finished trials: paired holdout results decide; at most one promotion a day; everything else retires. */
export function evaluateTrials(db: Database, speciesKey: string, holdoutCommits: string[], now = Date.now(), mutantCommits: string[] = []): Array<{ id: string; status: 'active' | 'retired'; wins: number; parentWins: number }> {
  if (!holdoutCommits.length) return [];
  const all = [...holdoutCommits, ...mutantCommits];
  const iso = new Date(now).toISOString();
  const results = db.prepare(`SELECT json_extract(metadata, '$.gym.commit') AS commit_sha, json_extract(metadata, '$.gym_result.status') AS status,
      COALESCE(json_extract(metadata, '$.gym_result.reason'), '') AS reason
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.genome') = ?
      AND status = 'completed' AND COALESCE(json_extract(metadata, '$.gym_result.reason'), '') NOT LIKE 'infra:%'`);
  const score = (genomeId: string) => {
    const rows = (results.all(speciesKey, genomeId) as Array<{ commit_sha: string; status: string; reason: string }>).filter((r) => all.includes(r.commit_sha));
    const byCommit = new Map(rows.map((r) => [r.commit_sha, r]));
    return { complete: all.every((c) => byCommit.has(c) || unscorable(db, speciesKey, genomeId, c)), wins: [...byCommit.values()].filter((r) => r.status === 'success').length,
      won: new Set([...byCommit.values()].filter((r) => r.status === 'success').map((r) => r.commit_sha)),
      outOfScope: [...byCommit.values()].filter((r) => r.reason.startsWith('out of scope')).length };
  };
  const settled: Array<{ id: string; status: 'active' | 'retired'; wins: number; parentWins: number }> = [];
  const promotedToday = () => Boolean(db.prepare("SELECT 1 FROM maker_genomes WHERE origin = 'dream' AND status = 'active' AND updated_at >= ? LIMIT 1").get(iso.slice(0, 10)));
  const trials = db.prepare("SELECT id, COALESCE(parent_id, ?) AS parent FROM maker_genomes WHERE status = 'trial' ORDER BY created_at").all(BASELINE_GENOME) as Array<{ id: string; parent: string }>;
  for (const trial of trials) {
    const mine = score(trial.id); const theirs = score(trial.parent);
    if (!mine.complete || !theirs.complete) continue;
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
    const wins = b > c && p < promotionAlpha() && mined.c - mined.b <= 1 && mine.outOfScope <= theirs.outOfScope && !promotedToday();
    const status = wins ? 'active' : 'retired';
    db.prepare('UPDATE maker_genomes SET status = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(status, `holdout ${mine.wins}/${all.length} vs parent ${theirs.wins}/${all.length}; ${mutantCommits.length ? 'mutant ' : ''}discordant ${b} vs ${c}, McNemar p=${p.toFixed(3)}${mutantCommits.length ? `; mined discordant ${mined.b} vs ${mined.c}` : ''}; out of scope ${mine.outOfScope} vs ${theirs.outOfScope}`, iso, trial.id);
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
    settled.push({ id: trial.id, status, wins: mine.wins, parentWins: theirs.wins });
  }
  return settled;
}

/** Hourly: dream (at most once a day) and settle finished trials for the gym species that runs them. */
export function startDreamEvolution(db: Database, intervalMs = 3_600_000): (() => void) | null {
  if (!dreamEvolutionEnabled()) return null;
  const species = process.env.DREAM_EVOLUTION_SPECIES || 'atomic@llama-router';
  const tick = () => {
    try {
      const commits = frozenHoldoutCommits(db); // RX-12: the current epoch's mined holdout
      const mutants = mutantTrialsEnabled() ? mutantHoldoutKeys(db) : [];
      // Z5 on but the mutant holdout not frozen yet (no claim since): don't settle a trial on the mined holdout alone
      for (const s of mutantTrialsEnabled() && !mutants.length ? [] : evaluateTrials(db, species, commits, Date.now(), mutants)) console.log(`🧬 genome ${s.id} ${s.status} (holdout ${s.wins} vs parent ${s.parentWins})`);
    } catch (e) { console.warn('dream evolution: evaluate failed:', e instanceof Error ? e.message : String(e)); }
    dreamOnce(db).then((r) => { if (r.created.length) console.log(`🧬 dreamt ${r.created.length} mutant(s): ${r.created.join(', ')}`); })
      .catch((e) => console.warn('dream evolution: dream failed:', e instanceof Error ? e.message : String(e)));
  };
  tick(); const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
