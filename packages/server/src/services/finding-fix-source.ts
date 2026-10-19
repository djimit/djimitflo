import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { SelfImprovementService } from './self-improvement-service';
import { markRun } from './scheduler-registry';
import { SENSITIVE_SERVICE } from './gym-task-miner';

/**
 * Finding-fix lane (design G2.1 → G2.2, 19-10): Djimitflo proposes fixing one static-analysis finding at a time in its own
 * packages/server. The finding source and the oracle are the same Djimitflo-held script, scripts/finding-fix-gate.mjs:
 * ESLint rule pack v1 (preserve-caught-error, no-useless-escape, no-useless-assignment; no-unused-vars only for JS repos),
 * inline config ignored, stable finding id = sha256(scanner version | rule | path | normalized flagged line | occurrence).
 * FINDING_FIX_LANE=off|shadow|on (default off):
 *   off    — nothing is scanned;
 *   shadow — the scan runs and a `finding_fix_candidates` judgments row records the counts, the top ids and the proposals
 *            the lane would make. No self_improvements row is written, so nothing can reach a maker;
 *   on     — proposals via generateFromGroundedGap within FINDING_FIX_MAX_PER_DAY (default 2) and 1 in flight per repo.
 *            Normal risk like the dead-code lane: the panel stays, never auto-approved, the maker approval and merge are human.
 * Every finding-fix run gets the in-code check `test:finding-fix` (Djimitflo's copy of the gate, cwd = the worktree);
 * a missing gate, scanner or input FAILS it (never skipped).
 * TODO(G2.2): the security-review-commons scanner as a "no new security finding" regression gate — it is not in the
 * image (no dependency, no vendored copy), so v1 has no such gate; add it when it ships without new dependencies.
 */
export type FindingFixMode = 'off' | 'shadow' | 'on';
export const findingFixMode = (env: NodeJS.ProcessEnv = process.env): FindingFixMode =>
  env.FINDING_FIX_LANE === 'on' ? 'on' : env.FINDING_FIX_LANE === 'shadow' ? 'shadow' : 'off';
export const FINDING_FIX_CHECK = 'test:finding-fix';
export const FINDING_FIX_SCOPE = 'packages/server/src';
/** Maker diff cap for this lane (the gate's own cap is 30 changed lines; headers need room). */
export const FINDING_FIX_DIFF_MAX = 60;
const RULE_PRIORITY = ['preserve-caught-error', 'no-useless-escape', 'no-unused-vars', 'no-useless-assignment'];
/** TG-001 r2 frozen surface: never offered to a maker. */
const FROZEN = /(^|\/)(tg-001\.ts|remote-gym-service\.ts|gym-worker\.mjs)$/;

export interface Finding { id: string; rule: string; file: string; line: number; snippet: string; occurrence: number; message: string }
export type ScanResult =
  | { ok: true; scannerVersion: string; packSha: string; rules: string[]; ruleDocs: Record<string, string>; fileLines: Record<string, number>; findings: Finding[] }
  | { ok: false; error: string };

/** Djimitflo's own gate script (never the maker worktree's copy). */
export const gateScript = (env: NodeJS.ProcessEnv = process.env): string =>
  env.FINDING_FIX_GATE_SCRIPT || path.resolve(__dirname, '../../../../scripts/finding-fix-gate.mjs');

/** The scanner's environment: nothing from the host (no ESLINT_*, NODE_OPTIONS, SECURITY_REVIEW_*) but PATH and the inputs. */
function cleanEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: os.tmpdir(), ...(env.FINDING_FIX_ESLINT_FROM ? { FINDING_FIX_ESLINT_FROM: env.FINDING_FIX_ESLINT_FROM } : {}), ...extra };
}

export function scanFindings(repoPath: string, env: NodeJS.ProcessEnv = process.env): ScanResult {
  const script = gateScript(env);
  if (!fs.existsSync(script)) return { ok: false, error: `gate script missing: ${script}` };
  const r = spawnSync(process.execPath, [script, '--discover', repoPath, '--scope', FINDING_FIX_SCOPE], { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, env: cleanEnv(env, {}) });
  let out: Record<string, unknown>;
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { return { ok: false, error: `scan output unreadable (exit ${r.status ?? 'signal'})` }; }
  if (typeof out.error === 'string' || !Array.isArray(out.findings)) return { ok: false, error: typeof out.error === 'string' ? out.error : `scan failed (exit ${r.status ?? 'signal'})` };
  return { ok: true, scannerVersion: String(out.scanner_version), packSha: String(out.pack_sha), rules: out.rules as string[], ruleDocs: (out.rule_docs ?? {}) as Record<string, string>, fileLines: (out.file_lines ?? {}) as Record<string, number>, findings: out.findings as Finding[] };
}

/** Lane candidates in proposal order: smallest file first, then rule priority; sensitive and frozen files excluded. */
export function candidates(scan: Extract<ScanResult, { ok: true }>): Finding[] {
  const prio = (r: string) => { const i = RULE_PRIORITY.indexOf(r); return i < 0 ? RULE_PRIORITY.length : i; };
  return scan.findings
    .filter((f) => !FROZEN.test(f.file) && !SENSITIVE_SERVICE.test(path.basename(f.file).replace(/\.[^.]+$/, '')))
    .sort((a, b) => (scan.fileLines[a.file] ?? 0) - (scan.fileLines[b.file] ?? 0) || prio(a.rule) - prio(b.rule) || a.file.localeCompare(b.file) || a.line - b.line);
}

/** FINDING_FIX_* for a finding-fix run, else {}. A missing ref yields an empty value, which the gate fails on. */
export function findingFixCheckEnv(db: Database, goalId: string | null | undefined): Record<string, string> {
  if (!goalId) return {};
  let refs: string[] = [];
  try {
    const row = db.prepare('SELECT s.evidence_refs_json AS refs FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?').get(goalId) as { refs: string | null } | undefined;
    refs = JSON.parse(row?.refs || '[]');
  } catch { return {}; }
  const ref = (prefix: string) => refs.find((r) => typeof r === 'string' && r.startsWith(prefix))?.slice(prefix.length) ?? '';
  const id = ref('finding-fix:');
  if (!refs.some((r) => typeof r === 'string' && r.startsWith('finding-fix:'))) return {};
  return { FINDING_FIX_ID: id.split('/').pop() ?? '', FINDING_FIX_RULE: ref('finding-rule:'), FINDING_FIX_FILE: ref('finding-file:'), FINDING_FIX_PACK: ref('finding-pack:') };
}

/** The deterministic check record of a finding-fix run (null for every other run). Runs Djimitflo's gate in the worktree. */
export function findingFixCheck(db: Database, goalId: string | null | undefined, worktree: string, outputDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  const inputs = findingFixCheckEnv(db, goalId);
  if (!Object.keys(inputs).length) return null;
  const stdoutPath = path.join(outputDir, `${FINDING_FIX_CHECK}.stdout.log`);
  const stderrPath = path.join(outputDir, `${FINDING_FIX_CHECK}.stderr.log`);
  const script = gateScript(env);
  if (!fs.existsSync(script)) {
    fs.writeFileSync(stdoutPath, '', 'utf8'); fs.writeFileSync(stderrPath, `gate script missing: ${script}\n`, 'utf8');
    return { name: FINDING_FIX_CHECK, status: 'fail', reason: 'missing_gate', exit_status: null, stdout_path: stdoutPath, stderr_path: stderrPath };
  }
  const r = spawnSync(process.execPath, [script], { cwd: worktree, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env: cleanEnv(env, inputs) });
  fs.writeFileSync(stdoutPath, r.stdout || '', 'utf8');
  fs.writeFileSync(stderrPath, r.stderr || r.error?.message || '', 'utf8');
  const exit = typeof r.status === 'number' ? r.status : null;
  return { name: FINDING_FIX_CHECK, status: exit === 0 ? 'pass' : 'fail', exit_status: exit, stdout_path: stdoutPath, stderr_path: stderrPath };
}

export class FindingFixSourceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database) {}

  start(intervalMs = 12 * 3600_000): void {
    if (this.timer || findingFixMode() === 'off') return;
    const run = () => { markRun('finding_fix_lane'); try { const r = this.run(); if (r.created) console.log(`🔧 finding-fix lane: ${r.created} proposal(s) created`); } catch (err) { console.warn('Finding-fix lane failed:', err instanceof Error ? err.message : String(err)); } };
    this.timer = setInterval(run, intervalMs); this.timer.unref?.();
    setTimeout(run, 150_000).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  run(now = new Date(), env: NodeJS.ProcessEnv = process.env): { created: number; skipped: string; found: number | null } {
    const mode = findingFixMode(env);
    if (mode === 'off') return { created: 0, skipped: 'disabled', found: null };
    const repo = env.TEST_GAP_REPO_PATH || env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { created: 0, skipped: 'no repository path', found: null };
    const max = Number(env.FINDING_FIX_MAX_PER_DAY) || 2;
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    const createdToday = (this.db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%\"finding-fix:%' AND created_at >= ?").get(day) as { n: number }).n;
    // v1 has one repo (the primary), so "1 in flight per repo" is 1 in flight
    const inFlight = (this.db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%\"finding-fix:%' AND status IN ('proposed', 'scheduled', 'executing')").get() as { n: number }).n;
    const scan = scanFindings(repo, env);
    const fresh = scan.ok ? candidates(scan).filter((f) => !this.db.prepare('SELECT 1 FROM self_improvements WHERE evidence_refs_json LIKE ? LIMIT 1').get(`%"finding-fix:primary/${f.id}"%`)) : [];
    const room = Math.max(0, Math.min(max - createdToday, 1 - inFlight));
    if (mode === 'shadow') {
      this.recordShadow(scan, fresh.slice(0, room), now);
      return { created: 0, skipped: scan.ok ? 'shadow' : scan.error, found: scan.ok ? scan.findings.length : null };
    }
    if (!scan.ok) return { created: 0, skipped: scan.error, found: null };
    if (createdToday >= max) return { created: 0, skipped: 'daily cap reached', found: scan.findings.length };
    if (inFlight >= 1) return { created: 0, skipped: 'one in flight', found: scan.findings.length };
    const improvements = new SelfImprovementService(this.db);
    let created = 0;
    for (const f of fresh) {
      if (created >= room) break;
      if (this.propose(improvements, scan, f)) created += 1;
    }
    return { created, skipped: created ? '' : 'no new finding', found: scan.findings.length };
  }

  private propose(improvements: SelfImprovementService, scan: Extract<ScanResult, { ok: true }>, f: Finding): boolean {
    const command = `FINDING_FIX_ID=${f.id} FINDING_FIX_RULE=${f.rule} FINDING_FIX_FILE=${f.file} FINDING_FIX_PACK=${scan.packSha} npm run test:finding-fix:grounded`;
    const budget = 'one maker lease, <= 10 minutes, <= 30k tokens, one checker lease; one file, <= 30 changed lines';
    const description = `Fix only finding ${f.rule} at ${f.file}:${f.line}. Rule: ${scan.ruleDocs[f.rule] ?? f.rule}. `
      + `Flagged line (occurrence ${f.occurrence + 1} of this text in the file): \`${f.snippet}\` — ${f.message} `
      + `Edit only ${f.file}. Do not add suppression comments (eslint-disable, @ts-ignore, nosec, codeql[...]), do not touch tests, configs, ignore files or other files, and do not delete unrelated code. `
      + `RUNTIME COMMAND: from the repository root run \`${command}\` — it exits 0 when this finding is gone, the ${f.rule} count in the file dropped, no new finding of any pack rule appears in the file `
      + `and the diff stays within 30 changed / 15 removed lines; lint, type-check and the changed tests run as the usual checks. ARTIFACT: the command's JSON line plus the one-file diff. BUDGET: ${budget}.`;
    return Boolean(improvements.generateFromGroundedGap({
      type: 'refactor',
      title: `Fix only finding ${f.rule} at ${f.file}:${f.line}`,
      description,
      rationale: `${scan.scannerVersion} (${f.rule}) flags ${f.file}:${f.line}; a one-file fix is verified by one command that re-scans the file with the pinned pack.`,
      evidenceRef: `finding-fix:primary/${f.id}`,
      extraEvidenceRefs: [`finding-rule:${f.rule}`, `finding-file:${f.file}`, `finding-occ:${f.occurrence}`, `finding-pack:${scan.packSha}`],
      grounding: { target: f.file, acceptanceTest: command, runtimeCommand: command, artifactPath: f.file, budget },
    }));
  }

  /** Shadow: what the lane found and would propose, as one judgments row. A failed scan is `insufficient`, never 0 findings. */
  private recordShadow(scan: ScanResult, wouldPropose: Finding[], now: Date): void {
    try {
      const byRule: Record<string, number> = {};
      if (scan.ok) for (const f of scan.findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
      const answers = scan.ok
        ? { scanner_version: scan.scannerVersion, pack_sha: scan.packSha, scope: FINDING_FIX_SCOPE, total: scan.findings.length, by_rule: byRule, files: Object.keys(scan.fileLines).length,
          top: candidates(scan).slice(0, 10).map((f) => ({ id: f.id, rule: f.rule, file: f.file, line: f.line })), would_propose: wouldPropose.map((f) => f.id) }
        : { scanner_version: null, pack_sha: null, scope: FINDING_FIX_SCOPE, total: null, by_rule: null, error: scan.error };
      this.db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
        VALUES (?, 'finding_fix_candidates', 'repo', 'primary', ?, 'shadow', ?, ?, ?, ?)`)
        .run(randomUUID(), scan.ok ? scan.packSha : 'scan-failed', scan.ok ? 'recorded' : 'insufficient',
          scan.ok ? `${scan.findings.length} finding(s): ${Object.entries(byRule).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}` : `scan failed: ${scan.error}`,
          JSON.stringify(answers), now.toISOString());
    } catch { /* evidence only */ }
  }
}
