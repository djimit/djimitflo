import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { SwarmIntelligenceService, type SwarmCapabilityRecord } from './swarm-intelligence-service';
import { CapabilityRequestError, FACTORY_OWNER, checkRepoPath, primaryRepoRoot } from './capability-factory';
import { goalRepoSlug } from './repo-registry';
import { swarmEventBus } from './swarm-event-bus';
import { experimentDefs } from './experiment-registry';
import { buildProvenance } from '../utils/build-provenance';

/**
 * L1 skill route (M2–M8, operator 2026-11-06). SKILL_ROUTE_MODE=off|shadow|on (default off = nothing here runs; every caller
 * checks the mode first, so behaviour is today's byte for byte).
 *
 * A skill made from a real repair is an executable script in the repo (e.g. scripts/skills/oracle-gate.mjs) registered in
 * the canonical capability store (swarm_capabilities, source `skill_from_repair`, digest computed here from the deployed
 * checkout, immutable version). It is selected for oracle-lane maker assignments by lane, delivered as a short "run this"
 * block (on, treatment arm of a 50 % per-goal holdout only; shadow records what would be delivered), its invocation is read
 * from the maker's own transcript, the daemon's own check exit codes decide, and only an invoked ∧ checks-pass ∧ verified
 * run credits it. Shown, read, pasted or held-out is recorded and never credited (NE-002 / EXP-3: no credit for delivery).
 * NE-013: the block names the script and how to run it — never a mutant list, a diff or a line hint.
 */
export type SkillRouteMode = 'off' | 'shadow' | 'on';
export const skillRouteMode = (env: NodeJS.ProcessEnv = process.env): SkillRouteMode =>
  (env.SKILL_ROUTE_MODE === 'on' ? 'on' : env.SKILL_ROUTE_MODE === 'shadow' ? 'shadow' : 'off');

/**
 * SKILL_VALIDATION_REQUIRES_TESTS=off|on (default off = today for every request without `tests`). Skillware (arXiv 2611.07652):
 * a skill bundle carries its own tests and validation proves they pass for the exact artifact. on: registration requires `tests`
 * (repo-relative test files in the deployed tree; their sha256 is stored next to the artifact digest) and validation requires a
 * `test_receipt` (scripts/skill-test-receipt.mjs, run by an operator/CI in a clean checkout) for the server's built commit whose
 * test file shas equal the registered ones and the files on disk, while the script still hashes to its digest. The server
 * never runs the tests itself.
 */
export type SkillValidationTestsMode = 'off' | 'on';
export const skillValidationTestsMode = (env: NodeJS.ProcessEnv = process.env): SkillValidationTestsMode =>
  (env.SKILL_VALIDATION_REQUIRES_TESTS === 'on' ? 'on' : 'off');

export const SKILL_SOURCE = 'skill_from_repair';
export const SKILL_LANES = ['mutation-gap', 'test-gap', 'test-gap-exports'] as const;
export type SkillLane = typeof SKILL_LANES[number];
export type SkillArm = 'treatment' | 'holdout';
const SCRIPT_PATH = /^scripts\/skills\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:mjs|cjs|js)$/;
const NAME = /^[a-z0-9][a-z0-9-]{1,48}$/;
const TEST_PATH = /\.(?:test|spec)\.(?:[cm]?js|tsx?)$/;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const oneLine = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const parse = (json: string | null | undefined): Record<string, unknown> => { try { return obj(JSON.parse(json || '{}')); } catch { return {}; } };
/** `sha256:<hex>` and bare hex compare equal */
const sameDigest = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.replace(/^sha256:/i, '').toLowerCase() === b.replace(/^sha256:/i, '').toLowerCase();

/** sha256 of a file inside `root` (`sha256:<hex>`), null when it is missing or not a regular file. */
function fileDigest(root: string, rel: string): string | null {
  try {
    const abs = path.join(root, rel);
    return fs.statSync(abs).isFile() ? `sha256:${sha256(fs.readFileSync(abs))}` : null;
  } catch { return null; }
}

// ─── M2: register from a repair ───────────────────────────────────────────────

export interface SkillFromRepairInput { name: string; lanes: string[]; script_path: string; oracle: string;
  applicability?: { runtimes?: string[] }; provenance?: Record<string, unknown>;
  /** repo-relative test files that exercise the script (required with SKILL_VALIDATION_REQUIRES_TESTS=on) */
  tests?: string[] }
export interface SkillTestFile { path: string; sha256: string }
export interface SkillTestReceipt { commit: string; test_files: SkillTestFile[]; result: string; runner: string; ran_at: string }

function assertOn(env: NodeJS.ProcessEnv): void {
  if (skillRouteMode(env) === 'off') throw new CapabilityRequestError('SKILL_ROUTE_DISABLED', 'skill route is off (SKILL_ROUTE_MODE)');
}

/**
 * Register a skill capability: id `skill:<name>`, version = the first 12 hex of the script's sha256 in the deployed checkout,
 * status candidate. The same file again answers `exists`; a changed file under the same name is refused by the store's
 * immutability guard (CAPABILITY_IMMUTABLE: a new version is a new name).
 */
export function registerSkillFromRepair(db: Database, input: SkillFromRepairInput, actor: string, env: NodeJS.ProcessEnv = process.env): { status: 'registered' | 'exists'; capability: SwarmCapabilityRecord } {
  assertOn(env);
  const name = String(input.name ?? '').trim();
  if (!NAME.test(name)) throw new CapabilityRequestError('INVALID_NAME', 'name must be 2–49 characters of a-z, 0-9 and -');
  const lanes = [...new Set(strings(input.lanes))];
  if (!lanes.length || lanes.some((l) => !(SKILL_LANES as readonly string[]).includes(l))) throw new CapabilityRequestError('INVALID_LANES', `lanes must be a non-empty subset of ${SKILL_LANES.join(', ')}`);
  const script = String(input.script_path ?? '').trim();
  if (!SCRIPT_PATH.test(script)) throw new CapabilityRequestError('INVALID_PATH', 'script_path must be scripts/skills/<name>.mjs|.cjs|.js');
  const root = primaryRepoRoot(env);
  checkRepoPath(root, script, 'script_path', false);
  const digest = fileDigest(root, script);
  if (!digest) throw new CapabilityRequestError('PATH_NOT_FOUND', `script_path ${script} is not readable`);
  const oracle = oneLine(String(input.oracle ?? ''), 300);
  if (oracle.length < 5) throw new CapabilityRequestError('INVALID_ORACLE', 'oracle must describe the executed check that decides');
  const tests = [...new Set(strings(input.tests).map((t) => t.trim()))];
  if (skillValidationTestsMode(env) === 'on' && !tests.length) throw new CapabilityRequestError('SKILL_TESTS_REQUIRED', 'tests (repo-relative test files that exercise the script) are required (SKILL_VALIDATION_REQUIRES_TESTS=on)');
  const testFiles: SkillTestFile[] = tests.map((t) => {
    if (!TEST_PATH.test(t)) throw new CapabilityRequestError('INVALID_PATH', `tests: ${t} is not a *.test|spec.(m|c)js|ts file`);
    checkRepoPath(root, t, 'tests', false);
    const d = fileDigest(root, t);
    if (!d) throw new CapabilityRequestError('PATH_NOT_FOUND', `tests: ${t} is not readable`);
    return { path: t, sha256: d };
  });
  const runtimes = strings(input.applicability?.runtimes).map((r) => r.trim()).filter((r) => /^[\w@./-]{1,80}$/.test(r));
  const id = `skill:${name}`; const version = digest.slice('sha256:'.length, 'sha256:'.length + 12);
  const intel = new SwarmIntelligenceService(db);
  const existing = db.prepare('SELECT version, status FROM swarm_capabilities WHERE id = ?').get(id) as { version: string; status: string } | undefined;
  if (existing?.version === version) {
    // the test contract of a not-yet-validated skill can be (re)declared; a validated one keeps the contract it was proven with
    if (testFiles.length && existing.status === 'candidate') {
      db.prepare("UPDATE swarm_capabilities SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.tests', json(?)), updated_at = ? WHERE id = ?")
        .run(JSON.stringify(testFiles), new Date().toISOString(), id);
    }
    return { status: 'exists', capability: intel.getCapability(id) };
  }
  const capability = intel.createCandidate({
    id, kind: 'deterministic_harness', owner: FACTORY_OWNER, version, risk_ceiling: 'low',
    input_schema_ref: `lanes:${lanes.join(',')}`, output_schema_ref: `script:${script}`,
    allowed_actions: ['deliver_in_assignment'], forbidden_actions: ['deploy', 'push', 'merge'],
    required_evidence: ['transcript:invocation', 'checks:exit_0', 'run:verified'], removal_strategy: 'deprecate_on_digest_change',
    metadata: { source: SKILL_SOURCE, title: name, name, lanes, script_path: script, artifact_digest: digest, applicability: runtimes.length ? { runtimes } : {},
      oracle, provenance: obj(input.provenance), registered_by: actor, ...(testFiles.length ? { tests: testFiles } : {}) },
  });
  swarmEventBus.emit('capability_transition', { capability_id: id, old_status: 'none', new_status: 'candidate', reason: `skill route: registered from repair by ${actor}` });
  return { status: 'registered', capability };
}

/**
 * SKILL_VALIDATION_REQUIRES_TESTS=on: why `receipt` does not prove the registered tests pass for this exact artifact, or null.
 * The receipt must name the server's built commit, cover exactly the declared test files with the registered sha256 (equal to
 * the files on disk), say pass, and the script must still hash to the registered digest.
 */
export function testReceiptGap(meta: Record<string, unknown>, receipt: SkillTestReceipt | undefined, root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const declared = (Array.isArray(meta.tests) ? meta.tests : []).map(obj).filter((t) => typeof t.path === 'string' && typeof t.sha256 === 'string') as unknown as SkillTestFile[];
  if (!declared.length) return 'the skill declares no tests: register it again with tests';
  if (!receipt) return 'test_receipt is required (scripts/skill-test-receipt.mjs <tests…> in a clean checkout at the server built commit)';
  const built = buildProvenance(env).built_commit;
  if (!built) return 'the server built commit is unknown (DJIMITFLO_BUILD_COMMIT): no receipt can be tied to this artifact';
  if (String(receipt.commit).toLowerCase() !== built.toLowerCase()) return `receipt commit ${String(receipt.commit).slice(0, 40)} is not the server built commit ${built}`;
  if (receipt.result !== 'pass') return `receipt result is ${String(receipt.result).slice(0, 20)}, not pass`;
  const got = new Map((Array.isArray(receipt.test_files) ? receipt.test_files : []).map((f) => [f.path, f.sha256]));
  const missing = declared.filter((t) => !got.has(t.path)).map((t) => t.path);
  if (missing.length || got.size !== declared.length) return `receipt test_files must be exactly the declared tests (${declared.map((t) => t.path).join(', ')})`;
  for (const t of declared) {
    if (!sameDigest(got.get(t.path), t.sha256)) return `receipt sha256 of ${t.path} is not the registered ${t.sha256}`;
    if (!sameDigest(fileDigest(root, t.path), t.sha256)) return `${t.path} on disk no longer hashes to the registered ${t.sha256}`;
  }
  if (!sameDigest(fileDigest(root, String(meta.script_path ?? '')), meta.artifact_digest)) return `${String(meta.script_path)} no longer hashes to the registered digest ${String(meta.artifact_digest)}`;
  return null;
}

/**
 * Validate (activate) a registered skill: the script must still hash to the registered digest, then the store's own promotion
 * path runs and (M8) one period-boundary row is written per oracle-population experiment, since what their makers receive
 * changes without any env change. Already validated: returned as is, no second boundary.
 * SKILL_VALIDATION_REQUIRES_TESTS=on: first a test receipt must prove the declared tests pass for this artifact (testReceiptGap,
 * else 409 SKILL_TESTS_UNPROVEN, nothing changes); the receipt is recorded as `validation_test_receipt`. Off: a receipt is ignored.
 */
export function validateSkillCapability(db: Database, id: string, input: { evidence_refs: string[]; test_receipt?: SkillTestReceipt }, actor: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): SwarmCapabilityRecord {
  assertOn(env);
  const row = db.prepare('SELECT status, version, metadata FROM swarm_capabilities WHERE id = ?').get(id) as { status: string; version: string; metadata: string } | undefined;
  const meta = parse(row?.metadata);
  if (!row || meta.source !== SKILL_SOURCE) throw new CapabilityRequestError('SKILL_NOT_FOUND', `${id} is not a registered skill`);
  const intel = new SwarmIntelligenceService(db);
  if (row.status === 'validated') return intel.getCapability(id);
  if (row.status !== 'candidate') throw new CapabilityRequestError('SKILL_NOT_CANDIDATE', `${id} is ${row.status}`);
  const receipt = skillValidationTestsMode(env) === 'on' ? input.test_receipt : undefined;
  if (skillValidationTestsMode(env) === 'on') {
    const gap = testReceiptGap(meta, receipt, primaryRepoRoot(env), env);
    if (gap) throw new CapabilityRequestError('SKILL_TESTS_UNPROVEN', gap);
  }
  const now_ = fileDigest(primaryRepoRoot(env), String(meta.script_path ?? ''));
  if (!sameDigest(now_, meta.artifact_digest)) throw new CapabilityRequestError('SKILL_DIGEST_CHANGED', `${meta.script_path} no longer hashes to ${String(meta.artifact_digest)}`);
  const refs = strings(input.evidence_refs).map((r) => r.slice(0, 300)).slice(0, 20);
  const capability = db.transaction(() => {
    const promoted = intel.promoteCapability(id, { eval_score: 1, evidence_refs: refs, validation_report: `skill route: validated by ${actor}; digest ${String(meta.artifact_digest)}` });
    recordSkillBoundary(db, id, row.version, 'candidate', 'validated', now);
    if (!receipt) return promoted;
    db.prepare("UPDATE swarm_capabilities SET metadata = json_set(metadata, '$.validation_test_receipt', json(?)) WHERE id = ?").run(JSON.stringify(receiptRecord(receipt)), id);
    return intel.getCapability(id);
  })();
  swarmEventBus.emit('capability_transition', { capability_id: id, old_status: 'candidate', new_status: 'validated', reason: `skill route: validated by ${actor}`,
    ...(receipt ? { test_receipt: receiptRecord(receipt) } : {}) });
  return capability;
}

const receiptRecord = (r: SkillTestReceipt): SkillTestReceipt => ({ commit: r.commit, test_files: r.test_files.map((f) => ({ path: f.path, sha256: f.sha256 })),
  result: r.result, runner: oneLine(String(r.runner), 200), ran_at: oneLine(String(r.ran_at), 40) });

/** M8: one experiment_period_boundaries row per oracle-population experiment (env_name `capability:<id>`). */
export function recordSkillBoundary(db: Database, id: string, version: string, from: string, to: string, now = Date.now()): number {
  const ins = db.prepare('INSERT OR IGNORE INTO experiment_period_boundaries (experiment_id, env_name, previous, current, at) VALUES (?, ?, ?, ?, ?)');
  const at = new Date(now).toISOString();
  return experimentDefs().filter((d) => d.population === 'oracle_goals').reduce((n, d) => n + ins.run(d.id, `capability:${id}`, from, `${to}@${version}`, at).changes, 0);
}

// ─── M3: selection by lane ────────────────────────────────────────────────────

/** The oracle lane of a goal's proposal (its evidence refs), or null for any other goal. */
export function goalSkillLane(db: Database, goalId: string | null): SkillLane | null {
  if (!goalId) return null;
  try {
    const refs = (db.prepare('SELECT s.evidence_refs_json AS r FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?').get(goalId) as { r: string | null } | undefined)?.r ?? '';
    if (refs.includes('"mutation-gap:')) return 'mutation-gap';
    if (refs.includes('"test-gap:')) return refs.includes('#exports"') ? 'test-gap-exports' : 'test-gap';
  } catch { /* no proposal */ }
  return null;
}
/** `test-gap` covers its `#exports` sub-lane; `test-gap-exports` only that one. */
const laneMatches = (lanes: string[], lane: SkillLane) => lanes.includes(lane) || (lane === 'test-gap-exports' && lanes.includes('test-gap'));

interface SkillCap { id: string; version: string; name: string; lanes: string[]; script_path: string; artifact_digest: string; oracle: string; runtimes: string[] }
export function isSkillCapability(metadata: string | null | undefined): boolean { return parse(metadata).source === SKILL_SOURCE; }
function liveSkills(db: Database): SkillCap[] {
  try {
    return (db.prepare("SELECT id, version, metadata FROM swarm_capabilities WHERE status = 'validated' AND owner = ? ORDER BY id").all(FACTORY_OWNER) as Array<{ id: string; version: string; metadata: string }>)
      .map((r) => ({ r, m: parse(r.metadata) })).filter(({ m }) => m.source === SKILL_SOURCE && typeof m.script_path === 'string' && typeof m.artifact_digest === 'string')
      .map(({ r, m }) => ({ id: r.id, version: r.version, name: String(m.name ?? r.id), lanes: strings(m.lanes), script_path: String(m.script_path),
        artifact_digest: String(m.artifact_digest), oracle: oneLine(String(m.oracle ?? ''), 300), runtimes: strings(obj(m.applicability).runtimes) }));
  } catch { return []; }
}

// ─── M4: delivery receipt + holdout ───────────────────────────────────────────

/** 50 % per-goal holdout: sha256 of the goal id with this route's own salt (never shared with memory/ACE/STE arms). */
export function skillRouteArm(goalId: string): SkillArm {
  return parseInt(sha256(`skill-route-holdout:v1:${goalId}`).slice(0, 8), 16) / 0x1_0000_0000 < 0.5 ? 'holdout' : 'treatment';
}

export interface SkillRouteContext { mode: 'shadow' | 'on'; capability_id: string; version: string; artifact_digest: string; script_path: string; lane: SkillLane;
  arm: SkillArm; delivered: boolean; would_deliver: boolean; block_sha256: string; reason?: string;
  /** the block itself (maker text in `on`/treatment); never written to the event */
  lines?: string[] }

/** The maker-facing block: the script, how to run it, what it prints, the oracle. No mutants, diffs or line hints (NE-013). */
export function skillBlockLines(cap: Pick<SkillCap, 'id' | 'version' | 'name' | 'script_path' | 'artifact_digest' | 'oracle'>): string[] {
  return [
    `## Skill: ${cap.name}`,
    '',
    `Registered skill ${cap.id}@${cap.version} (${cap.artifact_digest}). Run it once from the repository root, as its own shell command:`,
    '',
    `    node ${cap.script_path}`,
    '',
    "It runs this goal's acceptance command and the daemon's deterministic checks once and prints one ORACLE_GATE JSON line. PASS means stop: the daemon re-runs the same checks after you. FAIL names the first failing check and its exit code.",
    `Oracle: ${cap.oracle || 'the daemon check scripts exit 0'}`,
  ];
}

/** What the route selects for this maker assignment; undefined when off, no lane, another repo or no matching live skill. */
export function skillRouteFor(db: Database, run: { goal_id: string | null }, checkoutPath: string, runtime: string | undefined, env: NodeJS.ProcessEnv = process.env): SkillRouteContext | undefined {
  const mode = skillRouteMode(env);
  if (mode === 'off' || !run.goal_id) return undefined;
  const lane = goalSkillLane(db, run.goal_id);
  if (!lane || goalRepoSlug(db, run.goal_id)) return undefined; // skills live in the primary repo's checkout
  const cap = liveSkills(db).find((c) => laneMatches(c.lanes, lane) && (!c.runtimes.length || (runtime !== undefined && c.runtimes.includes(runtime))));
  if (!cap) return undefined;
  const arm = skillRouteArm(run.goal_id);
  const lines = skillBlockLines(cap);
  const inCheckout = fileDigest(checkoutPath, cap.script_path);
  const reason = !inCheckout ? 'script_missing_in_checkout' : !sameDigest(inCheckout, cap.artifact_digest) ? 'digest_mismatch_in_checkout' : arm === 'holdout' ? 'holdout' : undefined;
  const would = arm === 'treatment' && !reason;
  const delivered = mode === 'on' && would;
  return { mode, capability_id: cap.id, version: cap.version, artifact_digest: cap.artifact_digest, script_path: cap.script_path, lane, arm,
    delivered, would_deliver: would, block_sha256: sha256(lines.join('\n')), ...(reason ? { reason } : {}), ...(delivered ? { lines } : {}) };
}

/** The receipt on the assignment_context event: the route without the block text, plus the sha256 of the LOOP_WORK.md written. */
export function skillRouteEventMeta(ctx: SkillRouteContext, assignmentText: string): Record<string, unknown> {
  const { lines: _lines, ...rest } = ctx;
  return { ...rest, assignment_sha256: sha256(assignmentText) };
}

/** The latest assignment_context receipt of a run (null when the route recorded none). */
export function latestSkillRoute(db: Database, runId: string): (Omit<SkillRouteContext, 'lines'> & { assignment_sha256?: string }) | null {
  try {
    const ev = db.prepare("SELECT metadata FROM loop_events WHERE loop_run_id = ? AND event_type = 'assignment_context' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(runId) as { metadata: string } | undefined;
    const sr = obj(parse(ev?.metadata).skill_route);
    return typeof sr.capability_id === 'string' && typeof sr.script_path === 'string' ? sr as unknown as Omit<SkillRouteContext, 'lines'> : null;
  } catch { return null; }
}

// ─── M5: invocation in the maker transcript ───────────────────────────────────

export interface OracleGateLine { pass: boolean | null; digest: string | null }
export interface InvocationScan { observable: boolean; invoked: boolean; invocations: number; exit_code: number | null; step: number | null; oracle_gate: OracleGateLine | null }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parseGateLine(output: string): OracleGateLine | null {
  const m = /ORACLE_GATE\s+(\{[^\n]*\})/.exec(output);
  if (!m) return null;
  try {
    const j = obj(JSON.parse(m[1]));
    return { pass: typeof j.pass === 'boolean' ? j.pass : null, digest: typeof j.digest === 'string' ? j.digest.slice(0, 80) : null };
  } catch { return null; }
}

/**
 * opencode `--format json` transcript (stdout JSONL): an invocation is a `bash` tool_use whose command executes the script
 * (`node [flags] [./]<path>` or `./<path>`). Reading it (cat/grep), mentioning it in text, or pasting an ORACLE_GATE line is
 * not. The last invocation's exit code, step and ORACLE_GATE line are kept. No JSON events at all = unobservable (remote).
 */
export function scanSkillInvocations(stdout: string, scriptPath: string): InvocationScan {
  const p = escapeRe(scriptPath);
  const runs = new RegExp(`(?:^|[\\s;&|(])(?:node(?:\\s+--?[\\w-]+(?:=\\S+)?)*\\s+(?:\\.\\/)?${p}|\\.\\/${p})(?=$|[\\s;&|)])`);
  const out: InvocationScan = { observable: false, invoked: false, invocations: 0, exit_code: null, step: null, oracle_gate: null };
  let steps = 0;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: { type?: unknown; part?: unknown };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    if (event.type === 'step_finish') { out.observable = true; steps++; continue; }
    if (event.type !== 'tool_use') { if (event.type === 'text' || event.type === 'step_start') out.observable = true; continue; }
    out.observable = true;
    const part = obj(event.part); const state = obj(part.state); const meta = obj(state.metadata);
    const command = typeof obj(state.input).command === 'string' ? obj(state.input).command as string : '';
    if (String(part.tool ?? '').toLowerCase() !== 'bash' || !runs.test(command)) continue;
    out.invoked = true; out.invocations++; out.step = steps + 1;
    out.exit_code = typeof meta.exit === 'number' ? meta.exit : null;
    const output = typeof state.output === 'string' ? state.output : typeof meta.output === 'string' ? meta.output : '';
    out.oracle_gate = parseGateLine(output);
  }
  return out;
}

export type SkillInvocationState = 'applied' | 'shown_unused' | 'not_delivered' | 'unobservable';
export interface SkillRouteRecord extends InvocationScan { mode: 'shadow' | 'on'; capability_id: string; version: string; artifact_digest: string; script_path: string;
  lane: SkillLane; arm: SkillArm; delivered: boolean; state: SkillInvocationState; worktree_digest: string | null; digest_ok: boolean;
  /** M6/M7, set by settleSkillRoute */
  daemon_checks?: Array<{ name: string; status: string; exit_status: number | null }>; checks_pass?: boolean; lease_completed?: boolean; run_verified?: boolean; credited?: boolean }

/**
 * After the maker: scan its transcript for the run's selected skill and verify the script in its worktree (and the digest on
 * the ORACLE_GATE line, when it prints one) against the registered digest. Null when off or nothing was selected.
 */
export function observeSkillInvocation(db: Database, runId: string, stdout: string, worktreePath: string, env: NodeJS.ProcessEnv = process.env): SkillRouteRecord | null {
  if (skillRouteMode(env) === 'off') return null;
  const route = latestSkillRoute(db, runId);
  if (!route) return null;
  const scan = scanSkillInvocations(stdout, route.script_path);
  const worktree = fileDigest(worktreePath, route.script_path);
  const digestOk = sameDigest(worktree, route.artifact_digest) && (!scan.oracle_gate?.digest || sameDigest(scan.oracle_gate.digest, route.artifact_digest));
  const state: SkillInvocationState = !scan.observable ? 'unobservable' : scan.invoked ? 'applied' : route.delivered ? 'shown_unused' : 'not_delivered';
  return { mode: route.mode, capability_id: route.capability_id, version: route.version, artifact_digest: route.artifact_digest, script_path: route.script_path,
    lane: route.lane, arm: route.arm, delivered: route.delivered === true, ...scan, state, worktree_digest: worktree, digest_ok: digestOk };
}

// ─── M6/M7: the daemon's checks decide; credit only then ─────────────────────

/** The one credit rule: on ∧ treatment ∧ delivered ∧ invoked ∧ digest ok ∧ daemon checks pass ∧ lease completed ∧ run verified. */
export function skillRouteCreditable(sr: unknown): boolean {
  const r = obj(sr);
  return r.mode === 'on' && r.arm === 'treatment' && r.delivered === true && r.invoked === true && r.digest_ok === true
    && r.checks_pass === true && r.lease_completed === true && r.run_verified === true;
}

/** Why a settled record earned nothing (or `credited`): the outcome ref `skill_route:<arm>:<this>`. */
export function skillRouteOutcomeState(sr: SkillRouteRecord): string {
  if (skillRouteCreditable(sr)) return 'credited';
  if (sr.invoked && !sr.digest_ok) return 'digest_mismatch';
  if (sr.invoked && (!sr.checks_pass || !sr.lease_completed || !sr.run_verified)) return 'invoked_failed';
  return sr.state;
}

/**
 * M6: tie the daemon's own deterministic check exit codes (the maker lease's `deterministic_checks`) and the run's verdict to
 * the capability attempt; M7: decide the credit. Patches the lease's `skill_route`; null when off or nothing was recorded.
 * Idempotent (a second daemon pass recomputes the same record).
 */
export function settleSkillRoute(db: Database, runId: string, makerLeaseId: string, runVerified: boolean, env: NodeJS.ProcessEnv = process.env): SkillRouteRecord | null {
  if (skillRouteMode(env) === 'off') return null;
  const lease = db.prepare('SELECT status, metadata FROM worker_leases WHERE id = ? AND loop_run_id = ?').get(makerLeaseId, runId) as { status: string; metadata: string } | undefined;
  const meta = parse(lease?.metadata);
  const sr = obj(meta.skill_route);
  if (!lease || typeof sr.capability_id !== 'string') return null;
  const checks = (Array.isArray(meta.deterministic_checks) ? meta.deterministic_checks : []).map(obj)
    .map((c) => ({ name: String(c.name ?? ''), status: String(c.status ?? ''), exit_status: typeof c.exit_status === 'number' ? c.exit_status : null }));
  const asgRescued = obj(obj(meta.asg).outcome).rescued === true;
  const settled = { ...sr, daemon_checks: checks, checks_pass: checks.length > 0 && checks.every((c) => c.status === 'pass'),
    lease_completed: lease.status === 'completed' && !asgRescued, run_verified: runVerified } as SkillRouteRecord;
  settled.credited = skillRouteCreditable(settled);
  db.prepare("UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.skill_route', json(?)) WHERE id = ?").run(JSON.stringify(settled), makerLeaseId);
  return settled;
}

// ─── readout ──────────────────────────────────────────────────────────────────

export interface SkillRouteCell { arm: string; lane: string; selected: number; delivered: number; invoked: number; passed: number; verified: number; credited: number }
const MIN_PER_ARM = 30;

/**
 * Evolution evidence: per arm × lane the funnel selected → delivered → invoked → passed (daemon checks) → verified → credited
 * (an outcome_credits `skill_invoked` row). The holdout contrast (verified share of settled runs per arm) is descriptive with
 * its n; no difference is reported below n 30 per arm, and none is an effect claim.
 */
export function skillRouteEvidence(db: Database, env: NodeJS.ProcessEnv, since: string) {
  const mode = skillRouteMode(env);
  const cells = new Map<string, SkillRouteCell>();
  const cell = (arm: string, lane: string) => { const k = `${arm}|${lane}`; const c = cells.get(k) ?? { arm, lane, selected: 0, delivered: 0, invoked: 0, passed: 0, verified: 0, credited: 0 }; cells.set(k, c); return c; };
  const contrast = { treatment: { n: 0, verified: 0 }, holdout: { n: 0, verified: 0 } };
  let readable = true;
  try {
    const events = db.prepare(`SELECT loop_run_id AS run, json_extract(metadata, '$.skill_route') AS sr FROM loop_events
      WHERE event_type = 'assignment_context' AND json_extract(metadata, '$.skill_route') IS NOT NULL AND created_at >= ? ORDER BY created_at, rowid`).all(since) as Array<{ run: string; sr: string }>;
    const latest = new Map<string, Record<string, unknown>>();
    for (const e of events) latest.set(e.run, parse(e.sr));
    const leases = db.prepare(`SELECT loop_run_id AS run, json_extract(metadata, '$.skill_route') AS sr FROM worker_leases
      WHERE role = 'maker' AND json_extract(metadata, '$.skill_route') IS NOT NULL AND created_at >= ?`).all(since) as Array<{ run: string; sr: string }>;
    const settled = new Map<string, Record<string, unknown>>();
    for (const l of leases) { const sr = parse(l.sr); if (typeof sr.run_verified === 'boolean' || !settled.has(l.run)) settled.set(l.run, sr); }
    // outcome_credits is created lazily on the first verified credit: absent = nothing credited yet
    let credited = new Set<string>();
    try { credited = new Set((db.prepare("SELECT DISTINCT run_id AS run FROM outcome_credits WHERE kind = 'skill_invoked' AND created_at >= ?").all(since) as Array<{ run: string }>).map((r) => r.run)); } catch { /* none yet */ }
    for (const [run, ev] of latest) {
      const c = cell(String(ev.arm ?? 'unknown'), String(ev.lane ?? 'unknown'));
      c.selected++; if (ev.delivered === true) c.delivered++;
      const s = settled.get(run);
      if (s?.invoked === true) c.invoked++;
      if (s?.checks_pass === true) c.passed++;
      if (s?.run_verified === true) c.verified++;
      if (credited.has(run)) c.credited++;
      const arm = ev.arm === 'treatment' || ev.arm === 'holdout' ? contrast[ev.arm] : null;
      if (arm && typeof s?.run_verified === 'boolean') { arm.n++; if (s.run_verified) arm.verified++; }
    }
  } catch { readable = false; /* tables absent: unknown (null), never zero */ }
  const rate = (a: { n: number; verified: number }) => (a.n ? +(a.verified / a.n).toFixed(3) : null);
  const minN = Math.min(contrast.treatment.n, contrast.holdout.n);
  const t = rate(contrast.treatment); const h = rate(contrast.holdout);
  if (!readable) return { mode, since, by_arm_lane: null, contrast: null, note: 'unreadable: loop_events / worker_leases / outcome_credits missing' };
  return { mode, since,
    by_arm_lane: [...cells.values()].sort((a, b) => a.arm.localeCompare(b.arm) || a.lane.localeCompare(b.lane)),
    contrast: { treatment: { ...contrast.treatment, rate: t }, holdout: { ...contrast.holdout, rate: h },
      difference: minN >= MIN_PER_ARM && t !== null && h !== null ? +(t - h).toFixed(3) : null,
      withheld: minN >= MIN_PER_ARM ? null : `n < ${MIN_PER_ARM} per arm (treatment ${contrast.treatment.n}, holdout ${contrast.holdout.n})` },
    note: 'Descriptive only. selected = an assignment_context receipt; delivered = the block was in LOOP_WORK.md (on, treatment); invoked = a bash run of the script in the maker transcript; passed = every daemon check passed; verified = the run passed its gates; credited = an outcome_credits skill_invoked row (invoked ∧ digest ok ∧ checks pass ∧ verified, treatment only). The contrast is the verified share of settled runs per arm; it is not an effect estimate and is withheld below n 30 per arm.' };
}
