import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { failureSignature } from './intelligence-metrics';
import { parseOutcome, settlementState } from './merge-survival';
import { testOnlyChange } from './loop-worker-executor-service';
import { markRun } from './scheduler-registry';

/**
 * K4 (batch EVO-K, 16-10): skill distillation from verified evolution — RECORD ONLY. agent_skills is an agent↔skill
 * assignment table that the skill loader reads, so cards live in their own additive table (skill_cards) and are read by
 * nobody but GET /api/health/skills and the /knowledge page. Cards are NEVER injected into any maker, checker or panel
 * context (ACE-001 is running on that surface).
 *
 * SKILL_DISTILLATION_MODE=off|shadow (default off). In shadow, once a day:
 *  - every run whose run-level outcome_attribution is `verified` gets one skill card (status 'candidate'): lane, task kind,
 *    target file pattern, diff shape, checks that passed, checker verdicts, runtime/model, genome, provenance ids, sha256;
 *  - every `maker_failure` run gets one anti-pattern card (failure signature, the gate that failed);
 *  - reviewer_failure / environment_failure runs get nothing (not the maker's knowledge, E2);
 *  - a candidate card moves to 'survived' / 'regressed' when merge survival settles SETTLED_SURVIVED / SETTLED_REGRESSED.
 * One card per run (run_id primary key): a re-run is a no-op apart from the status upgrade. Missing inputs are null, never 0.
 */
export type SkillDistillationMode = 'off' | 'shadow';
export const skillDistillationMode = (env: NodeJS.ProcessEnv = process.env): SkillDistillationMode =>
  ((env.SKILL_DISTILLATION_MODE || '').trim().toLowerCase() === 'shadow' ? 'shadow' : 'off');
export const SKILL_DISTILLATION_INTERVAL_MS = 86_400_000;

export type CardKind = 'skill' | 'anti_pattern';
export type CardStatus = 'candidate' | 'survived' | 'regressed';

export interface SkillCard {
  kind: CardKind; lane: string | null; task_kind: string | null; target_pattern: string[] | null;
  diff_shape: { files_changed: number | null; diff_lines: number | null; lines_added: number | null; lines_removed: number | null; test_only: boolean | null };
  checks_passed: string[] | null;
  checker_verdict: { checker: string | null; security_checker: string | null };
  runtime: string | null; model: string | null; genome_id: string | null;
  provenance: { proposal_id: string | null; run_id: string; lease_id: string | null; pr_url: string | null; attribution_id: string };
  failure?: { signature: string | null; key: string | null; gate: string | null; error_class: string | null };
}

export function ensureSkillCardTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS skill_cards (run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, lane TEXT, status TEXT NOT NULL,
    card_json TEXT NOT NULL, content_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_skill_cards_lane_status ON skill_cards(lane, status)`);
}

const parse = (s: string | null | undefined): Record<string, unknown> => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `dir/*<ext>` per changed file (multi-part extensions such as `.test.ts` kept), unique and sorted; null when unknown. */
export function targetPattern(files: unknown): string[] | null {
  if (!Array.isArray(files) || !files.length) return null;
  const out = new Set<string>();
  for (const f of files) {
    if (typeof f !== 'string' || !f) continue;
    const i = f.lastIndexOf('/'); const dir = i >= 0 ? f.slice(0, i) : '.'; const base = f.slice(i + 1);
    const ext = /(\.(test|spec|d))?\.[A-Za-z0-9]+$/.exec(base)?.[0] ?? '';
    out.add(`${dir}/*${ext}`);
  }
  return out.size ? [...out].sort() : null;
}

/** The card of one attributed run, from loop_runs, worker_leases, goals and self_improvements (pure read). */
export function buildSkillCard(db: Database, runId: string, outcome: 'verified' | 'maker_failure', attributionId: string, attributionReason: string | null): SkillCard | null {
  const run = db.prepare(`SELECT r.loop_name, r.metadata, g.improvement_id, (SELECT type FROM self_improvements s WHERE s.id = g.improvement_id) AS task_kind
    FROM loop_runs r LEFT JOIN goals g ON g.id = r.goal_id WHERE r.id = ?`).get(runId) as { loop_name: string | null; metadata: string | null; improvement_id: string | null; task_kind: string | null } | undefined;
  if (!run) return null;
  const meta = parse(run.metadata);
  const leases = db.prepare('SELECT id, role, runtime, status, metadata FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at, rowid').all(runId) as Array<{ id: string; role: string; runtime: string; status: string; metadata: string }>;
  // the active maker (not superseded), as merge survival attributes it
  const makers = leases.filter((l) => l.role === 'maker' && !parse(l.metadata).superseded_by_maker_lease_id);
  const maker = makers.filter((l) => l.status === 'completed').pop() ?? makers.pop() ?? null;
  const m = parse(maker?.metadata);
  const verdict = (role: string) => {
    const r = leases.filter((l) => l.role === role && (!maker || parse(l.metadata).maker_lease_id === undefined || parse(l.metadata).maker_lease_id === maker.id)).pop();
    return r ? str(parse(r.metadata).verdict) : null;
  };
  const files = Array.isArray(m.changed_files) ? (m.changed_files as unknown[]).filter((f): f is string => typeof f === 'string') : null;
  const checks = Array.isArray(m.deterministic_checks) ? m.deterministic_checks as Array<{ name?: unknown; status?: unknown }> : null;
  const genome = m.genome as { id?: unknown } | undefined;
  const failedGates = Array.isArray(meta.failed_gates) ? meta.failed_gates.map(String) : [];
  const card: SkillCard = {
    kind: outcome === 'verified' ? 'skill' : 'anti_pattern',
    lane: run.loop_name ?? null, task_kind: run.task_kind ?? null, target_pattern: targetPattern(files),
    diff_shape: { files_changed: files ? files.length : null, diff_lines: num(m.diff_lines), lines_added: num(m.lines_added), lines_removed: num(m.lines_removed),
      test_only: files ? testOnlyChange(files) : null },
    checks_passed: checks ? checks.filter((c) => c?.status === 'pass' && typeof c.name === 'string').map((c) => String(c.name)) : null,
    checker_verdict: { checker: verdict('checker'), security_checker: verdict('security_checker') },
    runtime: maker?.runtime ?? null, model: str(m.model) ?? str(m.model_id), genome_id: str(m.genome_id) ?? str(genome?.id),
    provenance: { proposal_id: run.improvement_id ?? null, run_id: runId, lease_id: maker?.id ?? null, pr_url: str(meta.pr_url), attribution_id: attributionId },
  };
  if (outcome === 'maker_failure') {
    const sig = failureSignature({ lane: `${run.loop_name ?? 'unknown'}:${maker?.runtime ?? 'unknown'}`, failed_gates: failedGates, reasons: [str(m.failure_reason), attributionReason] });
    card.failure = { signature: sig?.signature ?? null, key: sig?.key ?? null, gate: sig?.gate ?? null, error_class: sig?.error_class ?? null };
  }
  return card;
}

export const cardSha256 = (card: SkillCard): string => createHash('sha256').update(JSON.stringify(card)).digest('hex');

/**
 * One distillation pass: cards for newly attributed verified / maker_failure runs, then status upgrades for candidate skill
 * cards whose PR settled. Returns counts; writes nothing when the mode is off.
 */
export function distillSkills(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): { mode: SkillDistillationMode; created: number; anti_patterns: number; upgraded: number } {
  const mode = skillDistillationMode(env);
  if (mode === 'off') return { mode, created: 0, anti_patterns: 0, upgraded: 0 };
  ensureSkillCardTable(db);
  const at = new Date(now).toISOString();
  // newest run-level attribution per run (operator annotations on the run win as they are newer); runs already carded skip
  const pending = db.prepare(`SELECT j.id, j.subject_id AS run_id, j.decision, j.reason FROM judgments j
    WHERE j.judgment = 'outcome_attribution' AND j.subject_type = 'loop_run'
      AND j.created_at = (SELECT MAX(x.created_at) FROM judgments x WHERE x.judgment = 'outcome_attribution' AND x.subject_type = 'loop_run' AND x.subject_id = j.subject_id)
      AND j.decision IN ('verified', 'maker_failure')
      AND NOT EXISTS (SELECT 1 FROM skill_cards c WHERE c.run_id = j.subject_id)
    GROUP BY j.subject_id ORDER BY j.created_at LIMIT 500`).all() as Array<{ id: string; run_id: string; decision: 'verified' | 'maker_failure'; reason: string | null }>;
  const ins = db.prepare(`INSERT OR IGNORE INTO skill_cards (run_id, kind, lane, status, card_json, content_sha256, created_at, updated_at) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?)`);
  let created = 0; let antiPatterns = 0;
  for (const p of pending) {
    const card = buildSkillCard(db, p.run_id, p.decision, p.id, p.reason);
    if (!card) continue;
    const json = JSON.stringify(card);
    if (ins.run(p.run_id, card.kind, card.lane, json, cardSha256(card), at, at).changes) { if (card.kind === 'skill') created++; else antiPatterns++; }
  }
  // status upgrade: merge survival settled the run's PR
  let upgraded = 0;
  const open = db.prepare(`SELECT c.run_id, r.created_at, json_extract(r.metadata, '$.pr_outcome') AS o FROM skill_cards c JOIN loop_runs r ON r.id = c.run_id
    WHERE c.kind = 'skill' AND c.status = 'candidate' AND json_extract(r.metadata, '$.pr_outcome.settled_at') IS NOT NULL`).all() as Array<{ run_id: string; created_at: string; o: string | null }>;
  const upd = db.prepare("UPDATE skill_cards SET status = ?, updated_at = ? WHERE run_id = ? AND status = 'candidate'");
  for (const c of open) {
    const s = settlementState(c.created_at, parseOutcome(c.o), now).state;
    const status: CardStatus | null = s === 'SETTLED_SURVIVED' ? 'survived' : s === 'SETTLED_REGRESSED' ? 'regressed' : null;
    if (status) upgraded += upd.run(status, at, c.run_id).changes;
  }
  return { mode, created, anti_patterns: antiPatterns, upgraded };
}

/** GET /api/health/skills: counts by lane / kind / status and the latest cards. Table absent = unknown (null), never 0. */
export function skillCardsView(db: Database, env: NodeJS.ProcessEnv = process.env, limit = 20) {
  const mode = skillDistillationMode(env);
  const note = 'record-only: cards are never injected into any maker, checker or panel context';
  const exists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_cards'").get();
  if (!exists) return { mode, total: null, by_lane: [], latest: [], reason: 'no cards recorded yet (SKILL_DISTILLATION_MODE has not run)', note };
  const by_lane = db.prepare(`SELECT COALESCE(lane, 'unknown') AS lane, kind, status, COUNT(*) AS n FROM skill_cards GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`).all() as Array<{ lane: string; kind: CardKind; status: CardStatus; n: number }>;
  const latest = (db.prepare(`SELECT run_id, kind, status, card_json, content_sha256, created_at, updated_at FROM skill_cards ORDER BY created_at DESC, run_id LIMIT ?`)
    .all(Math.max(1, Math.min(100, limit))) as Array<{ run_id: string; kind: CardKind; status: CardStatus; card_json: string; content_sha256: string; created_at: string; updated_at: string }>)
    .map((r) => ({ run_id: r.run_id, kind: r.kind, status: r.status, content_sha256: r.content_sha256, created_at: r.created_at, updated_at: r.updated_at, card: parse(r.card_json) as unknown as SkillCard }));
  return { mode, total: by_lane.reduce((a, r) => a + r.n, 0), by_lane, latest, reason: null, note };
}
export type SkillCardsView = ReturnType<typeof skillCardsView>;

/** Daily pass when SKILL_DISTILLATION_MODE=shadow (first run 20 min after boot). */
export function startSkillDistillation(db: Database, env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (skillDistillationMode(env) === 'off') return null;
  const tick = () => {
    try {
      const r = distillSkills(db, env); markRun('skill_distillation');
      if (r.created || r.anti_patterns || r.upgraded) console.log(`🧠 skill distillation (shadow): ${r.created} card(s), ${r.anti_patterns} anti-pattern(s), ${r.upgraded} status upgrade(s)`);
    } catch (e) { markRun('skill_distillation', e); console.warn('skill distillation failed:', e instanceof Error ? e.message : String(e)); }
  };
  const first = setTimeout(tick, 20 * 60_000); first.unref?.();
  const timer = setInterval(tick, SKILL_DISTILLATION_INTERVAL_MS); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
