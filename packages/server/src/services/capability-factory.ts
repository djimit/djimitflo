import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { SelfImprovementService, type ImprovementProposal } from './self-improvement-service';
import { SwarmIntelligenceService, type SwarmCapabilityRecord } from './swarm-intelligence-service';
import { swarmEventBus } from './swarm-event-bus';
import { extraRepoBySlug, goalRepoSlug, primaryRepo } from './repo-registry';

/**
 * Capability factory, slice 1 (operator directive 31-10). CAPABILITY_FACTORY_MODE=off|on (default off; off = no request is
 * accepted, nothing is registered, assignments are unchanged). No new orchestration: a request becomes ONE grounded
 * self-improvement proposal (source 'operator_request') and then rides the existing control plane — prescreen + specialist
 * panel, goal generator, human maker approval, deterministic checks, checker + security checker, verification gates, draft
 * PR, human merge. The merge-survival poller registers the merged result.
 *
 * Canonical store: swarm_capabilities (SwarmIntelligenceService.registerCapability / promoteCapability). It is the table the
 * acquisition service, the planner (worker_leases.capability_id), meta-evolution pruning, the dream cycle and federation
 * read, and the only one with a validated status and a promotion gate. Requests are recorded as `capability_request`
 * judgments (the audit table), never as a second registry.
 */
export type CapabilityFactoryMode = 'off' | 'on';
export const capabilityFactoryMode = (env: NodeJS.ProcessEnv = process.env): CapabilityFactoryMode =>
  (env.CAPABILITY_FACTORY_MODE === 'on' ? 'on' : 'off');

/** OMEGA slice 2: CAPABILITY_FACTORY_REUSE_EXECUTE=off|on (default off). On: a request with `execute: true` that matches a validated
 * capability still becomes one operator_request proposal, pinned to that capability version (`capability-reuse:<id>@<version>`). */
export const capabilityReuseExecute = (env: NodeJS.ProcessEnv = process.env): boolean => env.CAPABILITY_FACTORY_REUSE_EXECUTE === 'on';

/** OMEGA slices 3/4: CAPABILITY_LIFECYCLE_V2=off|on (default off). On: the draft PR of a factory run creates the `capfac:` candidate
 * (provenance, parent_versions, artifact digest at merge), the merge promotes that candidate through promoteCapability. */
export const capabilityLifecycleV2 = (env: NodeJS.ProcessEnv = process.env): boolean => env.CAPABILITY_LIFECYCLE_V2 === 'on';

export const FACTORY_OWNER = 'capability-factory';
const REQUEST_REF = 'capability-request:';
const REUSE_REF = 'capability-reuse:';
const DISCOVERY_CAP = 3;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const REL_PATH = /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*$/;
const NEW_FILE_ROOT = /^packages\/[A-Za-z0-9_.-]+\/src\/.+/;
// one runnable test command, no shell syntax: npm test / npm run test[:x] / npx vitest run, plus plain arguments
const TEST_COMMAND = /^(?:npm (?:run )?test(?::[\w:-]+)?|npx vitest run)(?: [\w.\/@=:-]+){0,12}$/;

export interface CapabilityRequestInput { title: string; description: string; target_file: string; acceptance: string; repo?: string;
  /** OMEGA slice 2 (CAPABILITY_FACTORY_REUSE_EXECUTE=on): run the matched capability instead of only answering `reused` */
  execute?: boolean }
export type CapabilityRequestResult =
  | { status: 'reused'; request_id: string; capability: SwarmCapabilityRecord }
  | { status: 'proposed'; request_id: string; proposal: ImprovementProposal; reuse_of?: string }
  | { status: 'duplicate'; request_id: string; proposal_id: string | null };

export class CapabilityRequestError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// ─── deterministic matching ────────────────────────────────────────────────

const STOP = new Set(['that', 'this', 'with', 'from', 'into', 'when', 'then', 'than', 'only', 'also', 'should', 'must', 'will',
  'have', 'been', 'each', 'every', 'over', 'under', 'about', 'file', 'files', 'test', 'tests', 'packages', 'server', 'services',
  'make', 'add', 'adds', 'use', 'uses', 'used', 'using', 'more', 'less', 'some', 'they', 'them', 'there', 'their', 'what', 'which']);
export function keywords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)));
}

interface CapView { id: string; version: string; status: string; title: string; files: string[]; test: string | null; repo: string | null; text: string; factory: boolean; proposalId: string | null }
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
function view(row: { id: string; version: string; status: string; owner: string; metadata: string }): CapView {
  let m: Record<string, unknown> = {};
  try { m = JSON.parse(row.metadata || '{}') as Record<string, unknown>; } catch { /* empty */ }
  const str = (k: string) => (typeof m[k] === 'string' ? m[k] as string : '');
  const files = [...new Set([...strings(m.files), ...(str('target_file') ? [str('target_file')] : [])])];
  const text = [str('title'), str('description'), str('name')].filter(Boolean).join(' ') || row.id;
  const prov = m.provenance && typeof m.provenance === 'object' ? m.provenance as Record<string, unknown> : {};
  return { id: row.id, version: row.version, status: row.status, title: str('title') || str('name') || row.id, files, test: str('test') || null, repo: str('repo') || null, text,
    factory: row.owner === FACTORY_OWNER, proposalId: typeof prov.proposal_id === 'string' ? prov.proposal_id : null };
}

/** Same file (any) wins; otherwise >= 3 shared keywords that are at least half of the smaller keyword set. 0 = no match. */
function score(task: { files: string[]; text: string }, cap: CapView): number {
  if (task.files.some((f) => cap.files.includes(f))) return 1_000;
  const a = keywords(task.text); const b = keywords(cap.text);
  let n = 0; for (const w of a) if (b.has(w)) n++;
  return n >= 3 && n * 2 >= Math.min(a.size, b.size) ? n : 0;
}

function validatedCaps(db: Database, factoryOnly = false): CapView[] {
  try {
    return (db.prepare(`SELECT id, version, status, owner, metadata FROM swarm_capabilities WHERE status = 'validated'${factoryOnly ? ' AND owner = ?' : ''}
      ORDER BY updated_at DESC, id ASC LIMIT 2000`).all(...(factoryOnly ? [FACTORY_OWNER] : [])) as Array<{ id: string; version: string; status: string; owner: string; metadata: string }>).map(view);
  } catch { return []; }
}

/** A capability belongs to the request's repo: its own `repo`, or (no repo recorded) the primary repo. */
const sameRepo = (cap: CapView, slug: string, primary: string) => (cap.repo ?? primary).toLowerCase() === slug.toLowerCase();

function bestMatches(caps: CapView[], task: { files: string[]; text: string }, limit: number): CapView[] {
  return caps.map((c) => ({ c, s: score(task, c) })).filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || x.c.id.localeCompare(y.c.id)).slice(0, limit).map((x) => x.c);
}

// ─── request ───────────────────────────────────────────────────────────────

function repoRoot(slug: string, env: NodeJS.ProcessEnv): string {
  if (slug.toLowerCase() !== primaryRepo(env).toLowerCase()) return extraRepoBySlug(slug, env)!.path;
  // services/ → src → server → packages → repo root (never the process cwd)
  return env.LOOP_DAEMON_REPOSITORY_PATH || env.TEST_GAP_REPO_PATH || env.LOOP_REPOSITORY_PATH || path.resolve(__dirname, '../../../..');
}

function resolveRepo(repo: string | undefined, env: NodeJS.ProcessEnv): string {
  const primary = primaryRepo(env);
  const r = repo?.trim();
  if (!r || r.toLowerCase() === 'djimitflo' || r.toLowerCase() === primary.toLowerCase()) return primary;
  const extra = extraRepoBySlug(r, env);
  if (!extra) throw new CapabilityRequestError('REPO_NOT_REGISTERED', `repo ${r} is not a registered repository`);
  return extra.slug;
}

/** Repo-relative, inside the checkout (symlinks resolved), and either existing or a new file under packages/<pkg>/src. */
function checkRepoPath(root: string, rel: string, what: string, allowNew: boolean): boolean {
  if (!REL_PATH.test(rel) || rel.split('/').some((seg) => seg === '..' || seg === '.')) throw new CapabilityRequestError('INVALID_PATH', `${what} must be a repo-relative path`);
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    if (allowNew && NEW_FILE_ROOT.test(rel)) return false;
    throw new CapabilityRequestError('PATH_NOT_FOUND', `${what} ${rel} does not exist${allowNew ? ' and is not a new file under packages/*/src' : ''}`);
  }
  const real = fs.realpathSync(abs); const realRoot = fs.realpathSync(root);
  if (!real.startsWith(realRoot + path.sep) || !fs.statSync(real).isFile()) throw new CapabilityRequestError('INVALID_PATH', `${what} must be a file inside the repository`);
  return true;
}

/** The command the maker runs for the acceptance test (repo root). A test file path becomes a vitest run in its package. */
function acceptanceCommand(acceptance: string): string {
  if (TEST_COMMAND.test(acceptance)) return acceptance;
  const pkg = /^packages\/([A-Za-z0-9_.-]+)\/(.+)$/.exec(acceptance);
  return pkg ? `cd packages/${pkg[1]} && npx vitest run ${pkg[2]}` : `npx vitest run ${acceptance}`;
}

function recordRequest(db: Database, requestId: string, decision: string, reason: string, answers: Record<string, unknown>): void {
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'capability_request', 'capability_request', ?, ?, 'on', ?, ?, ?, ?)`)
    .run(randomUUID(), requestId, String(answers.target_file ?? ''), decision, reason, JSON.stringify(answers), new Date().toISOString());
}

/**
 * Registry first (validated capabilities in the canonical store, deterministic match); otherwise exactly one grounded
 * operator_request proposal. Never approves anything. Throws CapabilityRequestError on invalid input.
 */
export function submitCapabilityRequest(db: Database, input: CapabilityRequestInput, actor: string, env: NodeJS.ProcessEnv = process.env): CapabilityRequestResult {
  if (capabilityFactoryMode(env) !== 'on') throw new CapabilityRequestError('CAPABILITY_FACTORY_DISABLED', 'capability factory is off (CAPABILITY_FACTORY_MODE)');
  const slug = resolveRepo(input.repo, env);
  const root = repoRoot(slug, env);
  const target = input.target_file.trim(); const acceptance = input.acceptance.trim();
  const targetExists = checkRepoPath(root, target, 'target_file', true);
  const acceptanceIsFile = !TEST_COMMAND.test(acceptance);
  if (acceptanceIsFile) {
    if (!TEST_FILE.test(acceptance)) throw new CapabilityRequestError('INVALID_ACCEPTANCE', 'acceptance must be a test file path or one test command (npm test, npm run test[:x], npx vitest run) without shell syntax');
    // the objective_scope gate holds the maker to the target file: a separate test file must already exist
    if (acceptance !== target) checkRepoPath(root, acceptance, 'acceptance', false);
  }

  const requestId = randomUUID();
  const primary = primaryRepo(env);
  const files = [target, ...(acceptanceIsFile && acceptance !== target ? [acceptance] : [])];
  const task = { files: [target], text: `${input.title}\n${input.description}` };
  const match = bestMatches(validatedCaps(db).filter((c) => sameRepo(c, slug, primary)), task, 1)[0];
  const base = { title: input.title.trim(), description: input.description.trim(), target_file: target, acceptance, repo: slug, requested_by: actor };
  const reuseOf = match && input.execute === true && capabilityReuseExecute(env) ? `${match.id}@${match.version}` : null;
  if (match && !reuseOf) {
    recordRequest(db, requestId, 'reused', `reused validated capability ${match.id}`, { ...base, capability_id: match.id });
    return { status: 'reused', request_id: requestId, capability: new SwarmIntelligenceService(db).getCapability(match.id) };
  }

  // the description carries the request id, so the proposal fingerprint never repeats: an open request for the same title and
  // target is a duplicate here
  const open = db.prepare(`SELECT id FROM self_improvements WHERE source = 'operator_request' AND title = ? AND json_extract(grounding_json, '$.target') = ?
    AND status IN ('proposed', 'scheduled', 'executing', 'verified', 'evaluating', 'needs_grounding') ORDER BY created_at DESC LIMIT 1`).get(input.title.trim(), target) as { id: string } | undefined;
  if (open) return { status: 'duplicate', request_id: requestId, proposal_id: open.id };

  const command = acceptanceCommand(acceptance);
  const budget = 'one maker lease, one checker + security checker; one file';
  const description = `${input.description.trim()}\n\nOperator capability request ${requestId} for ${slug}. `
    + `Change only ${target}${targetExists ? '' : ' (a new file)'}. `
    + `RUNTIME COMMAND: from the repository root run \`${command}\`; it must exit 0 (acceptance: ${acceptance}). `
    + `Lint, type-check and the test suite run as the usual deterministic checks. BUDGET: ${budget}.`;
  const proposal = new SelfImprovementService(db).generateFromOperatorRequest({
    title: input.title.trim(), description,
    rationale: reuseOf
      ? `Operator-requested execution (${actor}) reusing validated capability ${reuseOf} on ${target}.`
      : `Operator-requested capability (${actor}); no validated capability in swarm_capabilities matched ${target} or the request keywords.`,
    evidenceRefs: [`${REQUEST_REF}${requestId}`, ...(reuseOf ? [`${REUSE_REF}${reuseOf}`] : []), ...(slug.toLowerCase() === primary.toLowerCase() ? [] : [`repo:${slug}`])],
    grounding: { target, acceptanceTest: acceptance, runtimeCommand: command, artifactPath: target, budget },
  });
  if (!proposal) return { status: 'duplicate', request_id: requestId, proposal_id: null };
  recordRequest(db, requestId, 'proposed', `proposal ${proposal.id}`, { ...base, proposal_id: proposal.id, files, ...(reuseOf && match ? { capability_id: match.id, reuse_of: reuseOf } : {}) });
  return { status: 'proposed', request_id: requestId, proposal, ...(reuseOf ? { reuse_of: reuseOf } : {}) };
}

// ─── run lifecycle hooks (no-ops when off or not a factory run) ─────────────

interface FactoryRun { proposalId: string; requestId: string; title: string; description: string; grounding: Record<string, unknown>; goalId: string;
  /** slice 2: `<id>@<version>` this run reuses (its proposal's `capability-reuse:` ref), else null */
  reuseOf: string | null }
function factoryRun(db: Database, runId: string): FactoryRun | null {
  const row = db.prepare(`SELECT g.id AS goal_id, s.id, s.title, s.description, s.evidence_refs_json AS refs, s.grounding_json AS grounding FROM loop_runs r
    JOIN goals g ON g.id = r.goal_id JOIN self_improvements s ON s.id = COALESCE(g.improvement_id, json_extract(g.metadata, '$.improvement_id'))
    WHERE r.id = ? AND s.source = 'operator_request'`).get(runId) as { goal_id: string; id: string; title: string; description: string; refs: string | null; grounding: string | null } | undefined;
  if (!row) return null;
  let refs: unknown = []; let grounding: Record<string, unknown> = {};
  try { refs = JSON.parse(row.refs || '[]'); } catch { /* none */ }
  try { grounding = JSON.parse(row.grounding || '{}') as Record<string, unknown>; } catch { /* none */ }
  const requestId = strings(refs).find((r) => r.startsWith(REQUEST_REF))?.slice(REQUEST_REF.length);
  const reuse = reuseRef(row.refs);
  return requestId ? { proposalId: row.id, requestId, title: row.title, description: row.description, grounding, goalId: row.goal_id,
    reuseOf: reuse ? `${reuse.id}@${reuse.version}` : null } : null;
}

/** Step 4: the maker species the existing selection (LOOP_DAEMON_MAKER_RUNTIME / bandit) chose, as runtime[@model]. */
export function recordFactorySpecialist(db: Database, runId: string, makerLeaseId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (capabilityFactoryMode(env) !== 'on' || !factoryRun(db, runId)) return null;
  const lease = db.prepare("SELECT runtime, json_extract(metadata, '$.model') AS model FROM worker_leases WHERE id = ?").get(makerLeaseId) as { runtime: string; model: string | null } | undefined;
  if (!lease) return null;
  const specialist = lease.model ? `${lease.runtime}@${lease.model}` : lease.runtime;
  db.prepare("UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.specialist', ?) WHERE id = ?").run(specialist, runId);
  return specialist;
}

const capabilityId = (requestId: string) => `capfac:${requestId}`;

type CandidateInput = Parameters<SwarmIntelligenceService['createCandidate']>[0] & { id: string; allowed_actions: string[] };

/** The `capfac:` candidate of a factory run (files from the maker lease, else target + test; provenance of request/proposal/run/PR). */
function candidateInput(db: Database, runId: string, run: FactoryRun, prUrl: string, mergeSha: string | null, version: string, extra: Record<string, unknown> = {}): CandidateInput {
  const maker = db.prepare(`SELECT json_extract(metadata, '$.changed_files') AS files FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' AND status = 'completed'
    AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at DESC LIMIT 1`).get(runId) as { files: string | null } | undefined;
  let changed: string[] = []; try { changed = strings(JSON.parse(maker?.files || '[]')); } catch { /* none */ }
  const target = String(run.grounding.target ?? run.grounding.artifactPath ?? '');
  const test = String(run.grounding.acceptanceTest ?? '');
  const files = changed.length ? changed : [target, ...(TEST_FILE.test(test) && test !== target ? [test] : [])].filter(Boolean);
  const specialist = (db.prepare("SELECT json_extract(metadata, '$.specialist') AS s FROM loop_runs WHERE id = ?").get(runId) as { s: string | null } | undefined)?.s ?? null;
  const request = db.prepare("SELECT answers_json AS a FROM judgments WHERE judgment = 'capability_request' AND subject_id = ? ORDER BY created_at LIMIT 1").get(run.requestId) as { a: string | null } | undefined;
  let answers: Record<string, unknown> = {}; try { answers = JSON.parse(request?.a || '{}') as Record<string, unknown>; } catch { /* none */ }
  const provenance = { request_id: run.requestId, proposal_id: run.proposalId, run_id: runId, pr_url: prUrl, merge_sha: mergeSha, files, test };
  return {
    id: capabilityId(run.requestId), kind: 'deterministic_harness', owner: FACTORY_OWNER, version, risk_ceiling: 'low',
    input_schema_ref: `file:${target}`, output_schema_ref: `test:${test}`, allowed_actions: ['reuse_in_assignment'],
    forbidden_actions: ['deploy', 'push', 'merge'], required_evidence: ['proof:test', 'pr:merged'], removal_strategy: 'deprecate_on_merge_survival_regression',
    metadata: { capability_factory: true, title: run.title, description: typeof answers.description === 'string' ? answers.description : null, files, test,
      repo: typeof answers.repo === 'string' ? answers.repo : null, specialist, provenance, ...extra },
  };
}

// eval_score 1: its acceptance test passed the deterministic checks and a human merged the PR
const promotion = (runId: string, run: FactoryRun, pr: { url: string; mergeSha: string | null }) => ({ eval_score: 1,
  evidence_refs: [`pr:${pr.url}`, `loop_run:${runId}`, ...(pr.mergeSha ? [`merge_sha:${pr.mergeSha}`] : []), `self_improvement:${run.proposalId}`],
  validation_report: `merged ${pr.url}${pr.mergeSha ? ` at ${pr.mergeSha}` : ''}` });

/** V2 candidate: version = the verified head the reviewers saw (fixed from here on), parent_versions on a reuse run, digest unknown yet. */
function createV2Candidate(db: Database, runId: string, run: FactoryRun, prUrl: string): void {
  const head = (db.prepare("SELECT json_extract(metadata, '$.verified_head_sha') AS h FROM loop_runs WHERE id = ?").get(runId) as { h: string | null } | undefined)?.h ?? null;
  const input = candidateInput(db, runId, run, prUrl, null, head ? head.slice(0, 12) : '1', { ...(run.reuseOf ? { parent_versions: [run.reuseOf] } : {}), artifact_digest: null });
  new SwarmIntelligenceService(db).createCandidate(input);
  swarmEventBus.emit('capability_transition', { capability_id: input.id, old_status: 'none', new_status: 'candidate', reason: `capability factory: draft PR ${prUrl}` });
}

/** sha256 over the changed files' content at the merge commit (`<path>\0<bytes>\0`, paths sorted); null when any file or the sha is unavailable. */
function artifactDigest(db: Database, goalId: string, mergeSha: string | null, files: string[], env: NodeJS.ProcessEnv): string | null {
  if (!mergeSha || !/^[0-9a-f]{7,64}$/i.test(mergeSha) || !files.length || files.some((f) => !REL_PATH.test(f))) return null;
  try {
    const root = repoRoot(goalRepoSlug(db, goalId) ?? primaryRepo(env), env);
    const hash = createHash('sha256');
    for (const f of [...files].sort()) {
      const bytes = execFileSync('git', ['-C', root, 'show', `${mergeSha}:${f}`], { timeout: 10_000, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      hash.update(`${f}\0`); hash.update(bytes); hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
  } catch { return null; }
}

/**
 * OMEGA slice 3 (CAPABILITY_LIFECYCLE_V2=on), called next to the draft_pr_opened event: a factory run's draft PR creates its
 * `capfac:` candidate once. Off, or not a factory run: no-op. Idempotent; never throws into the PR service.
 */
export function onDraftPrOpened(db: Database, runId: string, prUrl: string, env: NodeJS.ProcessEnv = process.env): 'candidate' | null {
  if (capabilityFactoryMode(env) !== 'on' || !capabilityLifecycleV2(env)) return null;
  try {
    const run = factoryRun(db, runId);
    if (!run || db.prepare('SELECT 1 FROM swarm_capabilities WHERE id = ?').get(capabilityId(run.requestId))) return null;
    createV2Candidate(db, runId, run, prUrl);
    return 'candidate';
  } catch (err) {
    console.warn(`[capability-factory] candidate for run ${runId} failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Step 5, called by the merge-survival poller on every poll of a loop PR. A merged factory run registers its capability once
 * (candidate → promoteCapability → validated, the store's own promotion path); a merged PR whose survival settled as
 * regressed deprecates it (the store's downgrade status, as G1.5 does). Idempotent; never throws into the poller.
 * CAPABILITY_LIFECYCLE_V2=on: the candidate from the draft PR (created here if missing) gets the merge sha and artifact digest
 * and is promoted; its version stays the one it was reviewed at.
 */
export function onLoopPrPolled(db: Database, runId: string, pr: { url: string; mergeSha: string | null; merged: boolean; regressed: boolean }, env: NodeJS.ProcessEnv = process.env): 'registered' | 'deprecated' | null {
  if (capabilityFactoryMode(env) !== 'on' || !pr.merged) return null;
  try {
    const run = factoryRun(db, runId);
    if (!run) return null;
    const id = capabilityId(run.requestId);
    const intel = new SwarmIntelligenceService(db);
    const existing = db.prepare('SELECT status FROM swarm_capabilities WHERE id = ?').get(id) as { status: string } | undefined;
    let status = existing?.status;
    let result: 'registered' | 'deprecated' | null = null;
    if (capabilityLifecycleV2(env)) {
      if (!existing) { createV2Candidate(db, runId, run, pr.url); status = 'candidate'; }
      if (status === 'candidate') {
        const cap = intel.getCapability(id);
        const digest = artifactDigest(db, run.goalId, pr.mergeSha, strings(cap.metadata.files), env);
        const provenance = { ...(cap.metadata.provenance && typeof cap.metadata.provenance === 'object' ? cap.metadata.provenance as Record<string, unknown> : {}), merge_sha: pr.mergeSha };
        db.transaction(() => {
          // same version, actions and risk (immutable): only the merge facts are added to the candidate's metadata
          intel.createCandidate({ id, kind: cap.kind, owner: cap.owner, version: cap.version, risk_ceiling: cap.risk_ceiling, input_schema_ref: cap.input_schema_ref,
            output_schema_ref: cap.output_schema_ref, allowed_actions: cap.allowed_actions, forbidden_actions: cap.forbidden_actions, required_evidence: cap.required_evidence,
            eval_threshold: cap.eval_threshold, removal_strategy: cap.removal_strategy, metadata: { ...cap.metadata, provenance, artifact_digest: digest } });
          intel.promoteCapability(id, promotion(runId, run, pr));
        })();
        swarmEventBus.emit('capability_transition', { capability_id: id, old_status: 'candidate', new_status: 'validated', reason: `capability factory: merged ${pr.url}` });
        status = 'validated'; result = 'registered';
      }
    } else if (!existing) {
      db.transaction(() => {
        intel.createCandidate(candidateInput(db, runId, run, pr.url, pr.mergeSha, pr.mergeSha ? pr.mergeSha.slice(0, 12) : '1'));
        intel.promoteCapability(id, promotion(runId, run, pr));
      })();
      swarmEventBus.emit('capability_transition', { capability_id: id, old_status: 'none', new_status: 'validated', reason: `capability factory: merged ${pr.url}` });
      status = 'validated'; result = 'registered';
    }
    if (pr.regressed && status === 'validated') {
      db.prepare("UPDATE swarm_capabilities SET status = 'deprecated', updated_at = ? WHERE id = ? AND status = 'validated'").run(new Date().toISOString(), id);
      swarmEventBus.emit('capability_transition', { capability_id: id, old_status: 'validated', new_status: 'deprecated', reason: `merge survival regressed: ${pr.url}` });
      result = 'deprecated';
    }
    return result;
  } catch (err) {
    console.warn(`[capability-factory] registration for run ${runId} failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── discovery ─────────────────────────────────────────────────────────────

/** `capability-reuse:<id>@<version>` on a proposal's evidence refs (slice 2), split at the last '@'. */
function reuseRef(refsJson: string | null): { id: string; version: string } | null {
  let refs: unknown = []; try { refs = JSON.parse(refsJson || '[]'); } catch { /* none */ }
  const ref = strings(refs).find((r) => r.startsWith(REUSE_REF))?.slice(REUSE_REF.length);
  const at = ref ? ref.lastIndexOf('@') : -1;
  return ref && at > 0 && at < ref.length - 1 ? { id: ref.slice(0, at), version: ref.slice(at + 1) } : null;
}

/** A capability line of a maker assignment and the exact capability version behind it (OMEGA slice 1: attribution). */
export interface FactoryCapabilityLine { id: string; version: string; line: string }

/** Step 6: up to 3 factory capabilities matching the goal's proposal (files, then keywords); never the goal's own result. */
export function factoryCapabilityLines(db: Database, goalId: string | null, env: NodeJS.ProcessEnv = process.env): FactoryCapabilityLine[] {
  if (capabilityFactoryMode(env) !== 'on' || !goalId) return [];
  const row = db.prepare(`SELECT s.id, s.title, s.description, s.grounding_json AS grounding, s.evidence_refs_json AS refs FROM goals g
    JOIN self_improvements s ON s.id = COALESCE(g.improvement_id, json_extract(g.metadata, '$.improvement_id')) WHERE g.id = ?`).get(goalId) as
    { id: string; title: string; description: string; grounding: string | null; refs: string | null } | undefined;
  if (!row) return [];
  // slice 2: a reuse proposal lists its pinned capability first — the exact approved version, while still validated; never a guess
  const pinned = reuseRef(row.refs);
  const pinnedCap = pinned ? validatedCaps(db).find((c) => c.id === pinned.id && c.version === pinned.version) ?? null : null;
  let grounding: Record<string, unknown> = {}; try { grounding = JSON.parse(row.grounding || '{}') as Record<string, unknown>; } catch { /* none */ }
  const files = [grounding.target, grounding.artifactPath].filter((f): f is string => typeof f === 'string' && f.length > 0);
  const slug = goalRepoSlug(db, goalId) ?? primaryRepo(env);
  const caps = validatedCaps(db, true).filter((c) => c.proposalId !== row.id && c.id !== pinnedCap?.id && sameRepo(c, slug, primaryRepo(env)));
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);
  return [...(pinnedCap ? [pinnedCap] : []), ...bestMatches(caps, { files, text: `${row.title}\n${row.description}` }, DISCOVERY_CAP - (pinnedCap ? 1 : 0))]
    .map((c) => ({ id: c.id, version: c.version, line: `${oneLine(c.title)} — ${c.files.join(', ')} — ${oneLine(c.test ?? 'no test recorded')}` }));
}

/** GET /api/capabilities/registry?q= — validated capabilities of the canonical store whose file is q or whose title/description
 * holds every keyword of q; without q, the factory's own registrations. */
export function searchRegistry(db: Database, q: string, limit = 50): Array<Record<string, unknown>> {
  const query = q.trim(); const qk = keywords(query);
  const hit = (c: CapView) => (query ? c.files.includes(query) || (qk.size > 0 && [...qk].every((w) => keywords(c.text).has(w))) : c.factory);
  return validatedCaps(db).filter(hit).slice(0, limit)
    .map((c) => ({ id: c.id, status: c.status, title: c.title, files: c.files, test: c.test, repo: c.repo, factory: c.factory }));
}

// ─── evidence ──────────────────────────────────────────────────────────────

const REJECTED = new Set(['rejected', 'archived', 'needs_more_evidence', 'needs_grounding', 'infra_failed', 'regressed', 'no_change']);
export type FactoryRequestStatus = 'reused' | 'proposed' | 'in_progress' | 'merged' | 'registered' | 'rejected';

/** Step 7: requests by status (derived from the request judgment, its proposal, the run's PR and the store). Read-only. */
export function capabilityFactoryEvidence(db: Database, env: NodeJS.ProcessEnv = process.env): { mode: CapabilityFactoryMode; requests: Record<FactoryRequestStatus, number> | null; registered_downgraded: number | null } {
  const mode = capabilityFactoryMode(env);
  try {
    const rows = db.prepare("SELECT subject_id AS id, decision, answers_json AS a FROM judgments WHERE judgment = 'capability_request'").all() as Array<{ id: string; decision: string; a: string | null }>;
    const requests: Record<FactoryRequestStatus, number> = { reused: 0, proposed: 0, in_progress: 0, merged: 0, registered: 0, rejected: 0 };
    let downgraded = 0;
    const cap = db.prepare('SELECT status FROM swarm_capabilities WHERE id = ?');
    const proposal = db.prepare('SELECT status FROM self_improvements WHERE id = ?');
    const merged = db.prepare(`SELECT 1 FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE COALESCE(g.improvement_id, json_extract(g.metadata, '$.improvement_id')) = ?
      AND json_extract(r.metadata, '$.pr_outcome.state') = 'merged' LIMIT 1`);
    for (const r of rows) {
      if (r.decision === 'reused') { requests.reused++; continue; }
      let a: Record<string, unknown> = {}; try { a = JSON.parse(r.a || '{}') as Record<string, unknown>; } catch { /* none */ }
      const registered = cap.get(capabilityId(r.id)) as { status: string } | undefined;
      if (registered) { requests.registered++; if (registered.status !== 'validated') downgraded++; continue; }
      const pid = typeof a.proposal_id === 'string' ? a.proposal_id : '';
      if (merged.get(pid)) { requests.merged++; continue; }
      const status = (proposal.get(pid) as { status: string } | undefined)?.status;
      if (status === 'proposed') requests.proposed++;
      else if (!status || REJECTED.has(status)) requests.rejected++;
      else requests.in_progress++;
    }
    return { mode, requests, registered_downgraded: downgraded };
  } catch { return { mode, requests: null, registered_downgraded: null }; }
}
