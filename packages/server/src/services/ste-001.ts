import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';
import { notFallbackOutcomeSql } from './ollama-outage-fallback';

/**
 * STE-001 (operator 11-10, protocol docs/research/ace/STE-001_PROTOCOL.md): does a maker template written in ASD-STE100
 * Simplified Technical English change outcomes on real oracle-lane goals? One factor, orthogonal to ACE-001 (own salt):
 *   arm 0 = MAKER_TEMPLATE_RULES (today), arm 1 = MAKER_TEMPLATE_RULES_STE — same obligations, STE wording.
 * Arm = parity of sha256('ste-001:' + goal id), so every run of a goal lands in one arm. Only the template text differs;
 * gates, checkers and the scope gate are the same in both arms. The template hash is the 'template' gene of the maker genome
 * (Y2), so outcomes also split per genome without this module.
 *   STE_001_MODE=on (default off)
 */
export const ste001On = (env: NodeJS.ProcessEnv = process.env): boolean => env.STE_001_MODE === 'on';
export const STE_001_TARGET_PER_ARM = 100; // every oracle goal is in one of 2 arms: 100/arm ≈ 44 days, same window as ACE-001 50/cell
export interface SteContext { arm: 0 | 1; template_hash: string }

export const steArm = (goalId: string): 0 | 1 => (parseInt(createHash('sha256').update(`ste-001:${goalId}`).digest('hex').slice(0, 8), 16) % 2) as 0 | 1;

/**
 * The maker rules in STE: numbered, imperative, condition first, one instruction per sentence, no vague words. The limits are
 * the ones the gates enforce: diff_under_threshold allows 400 lines when every changed file is a test (TEST_ONLY_DIFF_MAX) and
 * 200 otherwise on the test-gap/exports lanes (the mutation lane allows 400; the stricter 200 is stated so one template
 * fits every oracle lane). The checks are LOOP_DAEMON_CHECK_SCRIPTS. Every obligation of MAKER_TEMPLATE_RULES maps to a line
 * here (ste-001.test.ts pins the mapping).
 */
export const MAKER_TEMPLATE_RULES_STE = [
  '## Rules',
  '',
  '1. Change only the files that the finding names.',
  '2. If you change only test files, keep the diff at 400 lines or fewer.',
  '3. If you change other files, keep the diff at 200 lines or fewer.',
  '4. Do not merge.',
  '5. Do not push.',
  '6. Do not deploy.',
  '7. Do not change secrets.',
  '8. Do not change policy files.',
  '9. If `node_modules` is missing, run `npm ci --legacy-peer-deps`.',
  '10. Do not change `package.json`.',
  '11. The system reverts lockfile changes before the review.',
  '12. Before you stop, run `npm run test:changed`, `npm run lint` and `npm run type-check`.',
  '13. A checker must accept your change before the task is complete.',
];
/**
 * Multi-repo: the STE rules for a repo with other check scripts (EXTRA_REPO_CHECKS_<SLUG>) — only rule 12 names the scripts.
 * steRulesFor(['test:changed', 'lint', 'type-check']) is exactly MAKER_TEMPLATE_RULES_STE (ste-001.test.ts pins it).
 */
export function steRulesFor(scripts: string[]): string[] {
  const run = scripts.map((s) => `\`npm run ${s}\``);
  const list = run.length > 1 ? `${run.slice(0, -1).join(', ')} and ${run[run.length - 1]}` : run[0] ?? '';
  return MAKER_TEMPLATE_RULES_STE.map((line) => (line.startsWith('12. ') ? `12. Before you stop, run ${list}.` : line));
}
export const STE_TEMPLATE_HASH = createHash('sha256').update(MAKER_TEMPLATE_RULES_STE.join('\n')).digest('hex').slice(0, 12);

/** STE-001: the arm recorded on this run's latest assignment_context event (null when the run was not in the experiment). */
export function runSte001(db: Database, runId: string): SteContext | null {
  try {
    const event = db.prepare("SELECT metadata FROM loop_events WHERE loop_run_id = ? AND event_type = 'assignment_context' ORDER BY created_at DESC LIMIT 1").get(runId) as { metadata: string } | undefined;
    const ste = event ? (JSON.parse(event.metadata || '{}') as { ste_001?: SteContext }).ste_001 : undefined;
    return ste && (ste.arm === 0 || ste.arm === 1) ? ste : null;
  } catch { return null; }
}

/**
 * Per-arm evidence (production maker outcomes carrying `ste-001-arm:<0|1>`): n, verified, Wilson 95 %, tokens, and the
 * out-of-scope share = outcomes whose auto_approved_scope gate failed (the 'asked for a test, edited README' failure).
 */
export function ste001Evidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  let rows: Array<{ arm: string; success: number; tokens: number; out_of_scope: number }> = [];
  try {
    rows = db.prepare(`SELECT substr(r.value, 13) AS arm, o.success, o.tokens_used AS tokens,
        EXISTS (SELECT 1 FROM json_each(o.evidence_refs_json) g WHERE g.value = 'gate:auto_approved_scope:fail') AS out_of_scope
      FROM skill_outcomes o, json_each(o.evidence_refs_json) r
      WHERE r.value LIKE 'ste-001-arm:%' AND o.skill_id LIKE 'loop-maker:%' AND o.skill_id NOT LIKE 'loop-maker:gym:%' AND ${notFallbackOutcomeSql('o')} AND o.created_at >= ?`).all(since) as typeof rows;
  } catch { /* skill_outcomes absent */ }
  const arm = (a: '0' | '1') => {
    const r = rows.filter((x) => x.arm === a); const v = r.filter((x) => x.success).length; const s = r.filter((x) => x.out_of_scope).length;
    return { n: r.length, verified: v, verified_rate: r.length ? +(v / r.length).toFixed(3) : null, ci: r.length ? wilson(v, r.length) : null,
      out_of_scope: s, out_of_scope_share: r.length ? +(s / r.length).toFixed(3) : null,
      tokens_mean: r.length ? Math.round(r.reduce((t, x) => t + (x.tokens || 0), 0) / r.length) : null };
  };
  const arms = { '0': arm('0'), '1': arm('1') };
  const reached = arms['0'].n >= STE_001_TARGET_PER_ARM && arms['1'].n >= STE_001_TARGET_PER_ARM;
  return { mode: env.STE_001_MODE ?? null, target_per_arm: STE_001_TARGET_PER_ARM, ste_template_hash: STE_TEMPLATE_HASH, arms,
    diff: arms['0'].verified_rate !== null && arms['1'].verified_rate !== null ? +(arms['1'].verified_rate - arms['0'].verified_rate).toFixed(3) : null,
    status: reached ? 'analysable' as const : 'collecting' as const,
    note: 'Production maker outcomes of oracle-lane goals by STE-001 arm (0 = current template, 1 = Simplified Technical English template). Interim diffs are descriptive only; the pre-registered analysis (docs/research/ace/STE-001_PROTOCOL.md) runs once both arms reach the target.' };
}
