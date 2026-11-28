/**
 * Engineering project room (COMMONS_PROJECT_ROOM_MODE = off | shadow | on, default off) inside Agent Commons.
 *
 *   goal (metadata.task_profile = 'project_room') → architecture review → implementation plan → the EXISTING maker,
 *   checks and checker → the same dossier.
 *
 * What is new here is only the connection: two read-only profile calls, an immutable versioned plan (plan-artifact.ts) and a
 * projection over records that already exist (goals, loop_runs, worker_leases, tasks, skill_outcomes). Goals, dispatch,
 * budgets, leases, authorisation and verdicts stay where they are. No scheduler, no message store, no task state machine.
 *
 *   off     nothing here runs; assignments, packets and budgets are byte-identical to before.
 *   shadow  no profile call, no change to any maker text: an assignment for a selected goal records `project_room_shadow`
 *           with the plan it would have carried (or why none).
 *   on      a selected goal gets its room before its run starts; its maker assignment and packet carry the plan, the lease is
 *           bound to plan version + digest, and a selected goal WITHOUT a valid fresh plan is not handed over (fail closed,
 *           for this workflow only).
 *
 * Evidence levels, kept apart: DELIVERED (the plan block's receipt is on the lease), LOADED (the prompt the executor actually
 * sent contains the plan digest; says nothing about use), OUTCOME_VERIFIED (independent checks settled the run).
 * Limits enforced BEFORE a call: calls per goal, calls per room, per-call timeout, remaining goal token budget > 0.
 * Enforced AFTER a call: its token use (a runtime reports it only at the end), counted against the goal's budget.
 * ponytail: a profile call is a read-only one-shot, so recovery after a crash is "mark the stale call unknown and call
 * again" — no reconciliation of mutations is needed here; the maker path keeps its own.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { ExecutionEngine } from '../execution/execution-engine';
import type { ExecutorKind } from '../execution/types';
import { AgentAssuranceService } from './agent-assurance-service';
import { parseOutcome, settlementState } from './merge-survival';
import { withoutHiddenChecks } from './fail-before-pass-after';
import {
  artifactDigest, digestMatches, extractJson, PLAN_SCHEMA_VERSION, planContent, PROFILE_VERSION, profilePrompt, reviewContent, sha256, validatePlanDraft, validateReviewDraft,
  type PlanArtifact, type PlanDraft, type Provenance, type RefResolver, type ReviewArtifact, type ReviewDraft, type RoomProfile, type Snapshot, type SourceRef,
} from './plan-artifact';

export type RoomMode = 'off' | 'shadow' | 'on';
export const projectRoomMode = (env: NodeJS.ProcessEnv = process.env): RoomMode => (env.COMMONS_PROJECT_ROOM_MODE === 'on' ? 'on' : env.COMMONS_PROJECT_ROOM_MODE === 'shadow' ? 'shadow' : 'off');
const int = (v: unknown, fallback: number, min: number, max: number) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, n)) : fallback; };
/** Content revisions after the first plan (default 1), calls per goal over its lifetime (default 6), per-call timeout. */
export const roomLimits = (env: NodeJS.ProcessEnv = process.env) => ({ revisions: int(env.PROJECT_ROOM_MAX_REVISIONS, 1, 0, 2), calls: int(env.PROJECT_ROOM_MAX_CALLS, 6, 1, 20), timeoutMs: int(env.PROJECT_ROOM_TIMEOUT_MS, 600_000, 1_000, 1_800_000) });

type Json = Record<string, unknown>;
const json = (text: unknown): Json => { try { const v = JSON.parse(String(text ?? '')) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}; } catch { return {}; } };
const list = (text: unknown): string[] => { try { const v = JSON.parse(String(text ?? '')) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
type Git = (cwd: string, args: string[]) => string;
const defaultGit: Git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

interface GoalRow { id: string; objective: string; constraints: string[]; acceptance_criteria: string[]; budget: Json; status: string; metadata: Json; improvement_id: string | null }
function goalRow(db: Database, id: string): GoalRow | null {
  const r = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const metadata = json(r.metadata);
  return { id, objective: String(r.objective ?? ''), constraints: list(r.constraints_json), acceptance_criteria: list(r.acceptance_criteria_json), budget: json(r.budget_json), status: String(r.status ?? ''),
    metadata, improvement_id: typeof r.improvement_id === 'string' ? r.improvement_id : typeof metadata.improvement_id === 'string' ? metadata.improvement_id : null };
}
/** The route is chosen per goal, explicitly. Nothing selects it automatically. */
export const roomSelected = (metadata: Json): boolean => metadata.task_profile === 'project_room';
/** 'two_stage' = architecture reviewer then planner (default); 'single' = one planner call, same plan schema. */
export const roomVariant = (metadata: Json): 'two_stage' | 'single' => (json(JSON.stringify(metadata.project_room ?? {})).variant === 'single' ? 'single' : 'two_stage');

// ── snapshot and source references ──────────────────────────────────────────────────────────────────────────────────────
/** The commit plus, when tracked files differ from it, a digest of exactly those changes — never an unnamed moving tree. */
export function repoSnapshot(repoRoot: string, git: Git = defaultGit): Snapshot {
  const base = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  const dirty = git(repoRoot, ['status', '--porcelain', '--untracked-files=no']); // tracked changes: an untracked file is not part of any commit a plan reads
  let slug = path.basename(repoRoot);
  try { slug = git(repoRoot, ['config', '--get', 'remote.origin.url']).trim().replace(/^.*[:/]([^/:]+\/[^/]+?)(\.git)?$/, '$1') || slug; } catch { /* no remote: the directory name */ }
  return { slug, base_commit: base, local_changes_digest: dirty.trim() ? sha256(`${dirty}\n${git(repoRoot, ['diff', 'HEAD'])}`) : null };
}
/** A reference resolves when the path is a file in the pinned commit and, if a symbol is named, that file contains it. */
export function refResolver(repoRoot: string, commit: string, git: Git = defaultGit): RefResolver {
  return (ref: SourceRef) => { try { const text = git(repoRoot, ['show', `${commit}:${ref.path}`]); return ref.symbol ? text.includes(ref.symbol) : true; } catch { return false; } };
}
/** Fresh = the plan's commit is an ancestor of the checkout and no file it read or will touch changed since. */
export function planFreshness(plan: PlanArtifact, repoRoot: string, git: Git = defaultGit): { fresh: boolean; reason: string | null } {
  try {
    const head = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    if (head === plan.repository.base_commit) return { fresh: true, reason: null };
    try { git(repoRoot, ['merge-base', '--is-ancestor', plan.repository.base_commit, head]); } catch { return { fresh: false, reason: `plan commit ${plan.repository.base_commit.slice(0, 12)} is not an ancestor of ${head.slice(0, 12)}` }; }
    const files = [...new Set([...plan.sources.map((s) => s.path), ...plan.steps.flatMap((s) => s.scope)])];
    const changed = git(repoRoot, ['diff', '--name-only', plan.repository.base_commit, head, '--', ...files]).split('\n').filter(Boolean);
    return changed.length ? { fresh: false, reason: `changed since the plan was made: ${changed.slice(0, 5).join(', ')}` } : { fresh: true, reason: null };
  } catch (error) { return { fresh: false, reason: `source base not readable: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}` }; }
}

// ── immutable artifacts ─────────────────────────────────────────────────────────────────────────────────────────────────
type Kind = 'architecture_review' | 'plan';
interface ArtifactRow { id: string; goal_id: string; kind: Kind; version: number; digest: string; payload_json: string; created_at: string }
function readArtifact<T extends PlanArtifact | ReviewArtifact>(row: ArtifactRow | undefined): T | null {
  if (!row) return null;
  const payload = json(row.payload_json);
  return digestMatches(payload) && payload.digest === row.digest ? payload as unknown as T : null; // a row that no longer matches its digest is not a plan
}
export function latestArtifact<T extends PlanArtifact | ReviewArtifact>(db: Database, goalId: string, kind: Kind): T | null {
  return readArtifact<T>(db.prepare('SELECT * FROM project_room_artifacts WHERE goal_id = ? AND kind = ? ORDER BY version DESC LIMIT 1').get(goalId, kind) as ArtifactRow | undefined);
}
export function planVersion(db: Database, goalId: string, version: number): PlanArtifact | null {
  return readArtifact<PlanArtifact>(db.prepare("SELECT * FROM project_room_artifacts WHERE goal_id = ? AND kind = 'plan' AND version = ?").get(goalId, version) as ArtifactRow | undefined);
}
/**
 * Issue the next version. Versions are never updated (a database trigger refuses UPDATE and DELETE); a revision is a new row.
 * `expectedVersion` is the version the caller built on: a concurrent issue makes it stale → PROJECT_ROOM_VERSION_CONFLICT.
 */
export function issueArtifact<T extends PlanArtifact | ReviewArtifact>(db: Database, goalId: string, kind: Kind, body: Omit<T, 'version' | 'digest'>, expectedVersion: number): T {
  return db.transaction(() => {
    const current = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM project_room_artifacts WHERE goal_id = ? AND kind = ?').get(goalId, kind) as { v: number }).v;
    if (current !== expectedVersion) throw new Error('PROJECT_ROOM_VERSION_CONFLICT');
    const payload = { ...body, version: current + 1 } as unknown as Json;
    payload.digest = artifactDigest(payload);
    db.prepare('INSERT INTO project_room_artifacts (id, goal_id, kind, version, digest, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), goalId, kind, current + 1, payload.digest, JSON.stringify(payload), new Date().toISOString());
    return payload as unknown as T;
  }).immediate();
}

// ── profile calls ───────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ProfileRequest { goalId: string; profile: RoomProfile; prompt: string; repoRoot: string; baseCommit: string; timeoutMs: number }
export interface ProfileResult { stdout: string; runtime: string; model: string | null; tokens: number | null; harness: string;
  /** how read-only was enforced for this call, and whether the tree was untouched afterwards */
  read_only: { enforced_by: string; tree_clean: boolean } }
export type ProfileRunner = (request: ProfileRequest) => Promise<ProfileResult>;

/**
 * Which runtime may run a read-only profile. Only a runtime whose write access is switched off by the runtime itself counts:
 * today that is codex with `--sandbox read-only` and no permission bypass. Every other adapter passes the same flags to a
 * planner as to a maker (a prompt line and a working directory are not an access restriction), so it is refused with a reason.
 */
export function profileRuntimeGate(runtime: string, env: NodeJS.ProcessEnv = process.env): { allowed: boolean; enforced_by: string | null; reason: string | null } {
  if (runtime !== 'codex') return { allowed: false, enforced_by: null, reason: `PROJECT_ROOM_RUNTIME_NOT_READ_ONLY: ${runtime} has no runtime-enforced read-only mode in its adapter` };
  for (const k of ['RUNTIME_ALLOW_SKIP_PERMISSIONS', 'CODEX_SKIP_PERMISSIONS']) if (env[k] === 'true') return { allowed: false, enforced_by: null, reason: `PROJECT_ROOM_RUNTIME_NOT_READ_ONLY: ${k}=true lets codex bypass its sandbox` };
  return { allowed: true, enforced_by: 'codex --sandbox read-only', reason: null };
}

/**
 * `codex exec --json` prints NDJSON events; the answer is the text of the last completed agent message. Output that is not
 * such a stream (plain text mode, a test adapter) is returned unchanged.
 */
export function finalMessage(stdout: string): string {
  let last: string | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { const e = JSON.parse(line) as { type?: string; item?: { type?: string; text?: unknown } }; if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') last = e.item.text; } catch { /* not an event line */ }
  }
  return last ?? stdout;
}

/**
 * The production runner: one task through the existing ExecutionEngine (same admission, approvals, model routing and
 * credentials as any worker) in a throwaway detached worktree at the pinned commit, with codexSandbox 'read-only' and no
 * permission bypass. Afterwards the tree must be untouched; a dirty tree fails the call.
 */
export function engineProfileRunner(db: Database, engine?: ExecutionEngine, env: NodeJS.ProcessEnv = process.env, git: Git = defaultGit): ProfileRunner {
  return async (request) => {
    const runtime = env.PROJECT_ROOM_RUNTIME || 'codex';
    const gate = profileRuntimeGate(runtime, env);
    if (!gate.allowed) throw new Error(gate.reason ?? 'PROJECT_ROOM_RUNTIME_NOT_READ_ONLY');
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'project-room-'));
    try {
      git(request.repoRoot, ['worktree', 'add', '--detach', '--force', worktree, request.baseCommit]);
      const taskId = `project-room-${request.profile}-${randomUUID().slice(0, 8)}`; const now = new Date().toISOString();
      db.prepare(`INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 'medium', 'low', 'local', ?, ?, ?, ?)`).run(taskId, `${request.profile} for goal ${request.goalId}`, request.prompt,
        JSON.stringify(['project-room', request.profile, runtime]),
        JSON.stringify({ project_room: { goal_id: request.goalId, profile: request.profile }, workingDirectory: worktree, timeoutMs: request.timeoutMs, skipPermissions: false, codexSandbox: 'read-only' }), now, now);
      const execution = await (engine ?? new ExecutionEngine(db)).executeTask(taskId, runtime as ExecutorKind);
      if (!execution.completion) {
        // not started (denied, or waiting for an approval): its worktree is about to go, so the task must not be startable later
        db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'queued', 'awaiting_approval')").run(new Date().toISOString(), taskId);
        throw new Error(`PROJECT_ROOM_CALL_NOT_STARTED: ${execution.reason || execution.status}`);
      }
      const done = await execution.completion;
      // a fallback or retry switches the executor, and only codex honours the read-only sandbox: any attempt on another
      // executor (or a second attempt, whose process may still be using this worktree) voids the call
      // the engine writes one 'admitted' event per attempt (and a second, 'started', event that also names the executor)
      const events = (db.prepare("SELECT metadata FROM execution_events WHERE task_id = ? AND json_extract(metadata, '$.executorKind') IS NOT NULL").all(taskId) as Array<{ metadata: string }>).map((e) => json(e.metadata));
      const kinds = events.map((e) => String(e.executorKind));
      if (events.filter((e) => e.phase === 'admitted').length > 1 || kinds.some((k) => k !== runtime)) throw new Error(`PROJECT_ROOM_READ_ONLY_UNPROVEN: the engine used ${[...new Set(kinds)].join(' then ')} in ${events.filter((e) => e.phase === 'admitted').length} attempts for a ${runtime} read-only call`);
      if (done.status !== 'completed') throw new Error(`PROJECT_ROOM_CALL_FAILED: ${(done.error || done.message || done.status).slice(0, 200)}`);
      const clean = git(worktree, ['status', '--porcelain']).trim() === '';
      if (!clean) throw new Error('PROJECT_ROOM_READ_ONLY_VIOLATED: the profile changed its working tree');
      const model = (db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId) as { metadata: string } | undefined)?.metadata;
      return { stdout: finalMessage(done.stdout ?? ''), runtime, model: typeof json(model).model === 'string' ? String(json(model).model) : null, tokens: typeof done.metrics?.tokenUsage === 'number' ? done.metrics.tokenUsage : null,
        harness: `execution-engine/${runtime}`, read_only: { enforced_by: gate.enforced_by ?? 'none', tree_clean: clean } };
    } finally {
      try { git(request.repoRoot, ['worktree', 'remove', '--force', worktree]); } catch { fs.rmSync(worktree, { recursive: true, force: true }); }
    }
  };
}

interface CallRow { id: string; goal_id: string; profile: string; status: string; runtime: string | null; tokens: number | null; error: string | null; started_at: string; finished_at: string | null }
const calls = (db: Database, goalId: string) => db.prepare('SELECT * FROM project_room_calls WHERE goal_id = ? ORDER BY started_at, rowid').all(goalId) as CallRow[];
/** Tokens the room's calls reported for this goal (unreported calls count as 0 and are listed as unknown in the dossier). */
export function roomTokens(db: Database, goalId: string): number {
  try { return (db.prepare('SELECT COALESCE(SUM(tokens), 0) AS t FROM project_room_calls WHERE goal_id = ?').get(goalId) as { t: number }).t; } catch { return 0; }
}
/** The same sum, or null when a call that ran did not report its tokens: an unmeasured cost is unknown, not zero. */
export function roomTokensKnown(db: Database, goalId: string): number | null {
  const unknown = (db.prepare("SELECT COUNT(*) AS n FROM project_room_calls WHERE goal_id = ? AND status != 'refused' AND tokens IS NULL").get(goalId) as { n: number }).n;
  return unknown ? null : roomTokens(db, goalId);
}
function goalTokensUsed(db: Database, goalId: string): number {
  const leases = db.prepare('SELECT l.metadata FROM worker_leases l JOIN loop_runs r ON r.id = l.loop_run_id WHERE r.goal_id = ?').all(goalId) as Array<{ metadata: string }>;
  return roomTokens(db, goalId) + leases.reduce((sum, l) => sum + (Number(json(json(l.metadata).runtime_usage as string | undefined ? JSON.stringify(json(l.metadata).runtime_usage) : '{}').total_tokens) || 0), 0);
}

/** Blocks that pass on their own or after an operator fix: the goal waits, it has not failed. */
export const ROOM_WAIT = /^PROJECT_ROOM_(IN_PROGRESS|DIRTY_SOURCE|CALL_NOT_STARTED|RUNTIME_NOT_READ_ONLY|VERSION_CONFLICT)/;
export type RoomResult = { status: 'issued' | 'exists'; plan: PlanArtifact } | { status: 'blocked'; reason: string };

/**
 * Run the room for one goal: at most one review, one plan and `revisions` plan revisions. Idempotent: a fresh plan for the
 * current snapshot is returned as-is, and a second caller while a call is running is refused.
 */
export async function runProjectRoom(db: Database, goalId: string, repoRoot: string, runner: ProfileRunner, env: NodeJS.ProcessEnv = process.env, git: Git = defaultGit): Promise<RoomResult> {
  try { return await runRoom(db, goalId, repoRoot, runner, env, git); } catch (error) {
    // e.g. a concurrent issue (PROJECT_ROOM_VERSION_CONFLICT) or an unreadable repository: a reason, never an unhandled throw
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'blocked', reason: message.startsWith('PROJECT_ROOM_') ? message : `PROJECT_ROOM_FAILED: ${message.slice(0, 200)}` };
  }
}
async function runRoom(db: Database, goalId: string, repoRoot: string, runner: ProfileRunner, env: NodeJS.ProcessEnv, git: Git): Promise<RoomResult> {
  if (projectRoomMode(env) !== 'on') return { status: 'blocked', reason: 'PROJECT_ROOM_NOT_ACTIVE: COMMONS_PROJECT_ROOM_MODE is not on (shadow starts no profile call)' };
  const goal = goalRow(db, goalId);
  if (!goal) return { status: 'blocked', reason: 'PROJECT_ROOM_GOAL_NOT_FOUND' };
  if (!roomSelected(goal.metadata)) return { status: 'blocked', reason: "PROJECT_ROOM_NOT_SELECTED: the goal's metadata.task_profile is not 'project_room'" };
  const limits = roomLimits(env);
  const existing = latestArtifact<PlanArtifact>(db, goalId, 'plan');
  if (existing && planFreshness(existing, repoRoot, git).fresh) return { status: 'exists', plan: existing };
  // a call left 'running' by a crashed process is unknown, not running: read-only, so calling again is safe
  db.prepare("UPDATE project_room_calls SET status = 'unknown', error = 'no result recorded (process ended)', finished_at = ? WHERE goal_id = ? AND status = 'running' AND started_at < ?")
    .run(new Date().toISOString(), goalId, new Date(Date.now() - limits.timeoutMs - 60_000).toISOString());
  if (calls(db, goalId).some((c) => c.status === 'running')) return { status: 'blocked', reason: 'PROJECT_ROOM_IN_PROGRESS' };

  const snapshot = repoSnapshot(repoRoot, git);
  if (snapshot.local_changes_digest) return { status: 'blocked', reason: 'PROJECT_ROOM_DIRTY_SOURCE: the checkout has local changes; a plan is made for a commit' };
  const resolve = refResolver(repoRoot, snapshot.base_commit, git);
  const maxTokens = Number(goal.budget.max_tokens) || 0;

  const call = async (profile: RoomProfile, prompt: string): Promise<{ result: ProfileResult; provenance: Provenance } | { blocked: string }> => {
    if (calls(db, goalId).filter((c) => c.status !== 'refused').length >= limits.calls) return { blocked: `PROJECT_ROOM_CALL_LIMIT: ${limits.calls} profile calls already made for this goal` };
    if (maxTokens && goalTokensUsed(db, goalId) >= maxTokens) return { blocked: 'PROJECT_ROOM_BUDGET_EXHAUSTED: the goal token budget is used up' };
    const id = randomUUID();
    db.prepare("INSERT INTO project_room_calls (id, goal_id, profile, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(id, goalId, profile, new Date().toISOString());
    const finish = db.prepare('UPDATE project_room_calls SET status = ?, runtime = ?, tokens = ?, error = ?, read_only_json = ?, finished_at = ? WHERE id = ?');
    try {
      const result = await runner({ goalId, profile, prompt, repoRoot, baseCommit: snapshot.base_commit, timeoutMs: limits.timeoutMs });
      if (!result.read_only.tree_clean) throw new Error('PROJECT_ROOM_READ_ONLY_VIOLATED: the profile changed its working tree');
      finish.run('completed', result.runtime, result.tokens, null, JSON.stringify(result.read_only), new Date().toISOString(), id);
      return { result, provenance: { profile, profile_version: PROFILE_VERSION, prompt_sha256: sha256(prompt), runtime: result.runtime, model: result.model, harness: result.harness } };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
      // refused = no model session was started (no read-only runtime, or the engine did not start the task): not counted against the call limit
      finish.run(/^PROJECT_ROOM_(RUNTIME_NOT_READ_ONLY|CALL_NOT_STARTED)/.test(message) ? 'refused' : 'failed', null, null, message, null, new Date().toISOString(), id);
      return { blocked: message };
    }
  };

  let review: ReviewArtifact | null = null;
  if (roomVariant(goal.metadata) === 'two_stage') {
    const r = await call('architecture-reviewer', profilePrompt('architecture-reviewer', goal, null));
    if ('blocked' in r) return { status: 'blocked', reason: r.blocked };
    const draft = extractJson(r.result.stdout);
    const errors = validateReviewDraft(draft);
    if (errors.length) return { status: 'blocked', reason: `PROJECT_ROOM_REVIEW_INVALID: ${errors.slice(0, 5).join('; ')}` };
    const content = reviewContent(draft as ReviewDraft); // content fields only
    const expected = (db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM project_room_artifacts WHERE goal_id = ? AND kind = 'architecture_review'").get(goalId) as { v: number }).v;
    review = issueArtifact<ReviewArtifact>(db, goalId, 'architecture_review', { ...content, kind: 'architecture_review', schema_version: PLAN_SCHEMA_VERSION, goal_id: goalId, repository: snapshot, provenance: r.provenance,
      claims: content.claims.map((c) => ({ ...c, refs_resolved: c.refs.length > 0 && c.refs.every(resolve) })) }, expected);
  }

  const planner: RoomProfile = review ? 'implementation-planner' : 'single-planner';
  let errors: string[] = [];
  for (let attempt = 0; attempt <= limits.revisions; attempt += 1) {
    const r = await call(planner, profilePrompt(planner, goal, review, errors));
    if ('blocked' in r) return { status: 'blocked', reason: r.blocked };
    const draft = extractJson(r.result.stdout);
    errors = validatePlanDraft(draft, resolve, review ? review.claims.map((c) => c.id) : []);
    if (errors.length) continue;
    const expected = (db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM project_room_artifacts WHERE goal_id = ? AND kind = 'plan'").get(goalId) as { v: number }).v;
    const budget = Object.fromEntries(Object.entries(goal.budget).filter((e): e is [string, number] => typeof e[1] === 'number')); // inherited, never set by a profile
    // content first, control-plane fields after it: nothing a profile wrote can replace identity, mandate, snapshot or budget
    const plan = issueArtifact<PlanArtifact>(db, goalId, 'plan', { ...planContent(draft as PlanDraft), kind: 'plan', schema_version: PLAN_SCHEMA_VERSION, plan_id: `plan:${goalId}`, goal_id: goalId,
      investigation_thread: goal.improvement_id ? `proposal:${goal.improvement_id}` : null, proposal_ids: goal.improvement_id ? [goal.improvement_id] : [], review_digest: review?.digest ?? null,
      repository: snapshot, objective: goal.objective, constraints: goal.constraints, acceptance_criteria: goal.acceptance_criteria, budget, provenance: r.provenance }, expected);
    return { status: 'issued', plan };
  }
  return { status: 'blocked', reason: `PROJECT_ROOM_PLAN_INVALID after ${limits.revisions} revision(s): ${errors.slice(0, 5).join('; ')}` };
}

// ── delivery to the existing maker path ─────────────────────────────────────────────────────────────────────────────────
export interface PlanRef { plan_id: string; version: number; digest: string; base_commit: string }
export const planRef = (plan: PlanArtifact): PlanRef => ({ plan_id: plan.plan_id, version: plan.version, digest: plan.digest, base_commit: plan.repository.base_commit });
export type Delivery = { state: 'none' } | { state: 'shadow'; plan: PlanArtifact | null; reason: string | null } | { state: 'deliver'; plan: PlanArtifact } | { state: 'blocked'; reason: string };

/** What an assignment for this run carries. off / not selected → none. Never throws. */
export function planDelivery(db: Database, run: { goal_id: string | null }, checkoutPath: string, env: NodeJS.ProcessEnv = process.env, git: Git = defaultGit): Delivery {
  const mode = projectRoomMode(env);
  if (mode === 'off' || !run.goal_id) return { state: 'none' };
  try {
    const goal = goalRow(db, run.goal_id);
    if (!goal || !roomSelected(goal.metadata)) return { state: 'none' };
    const plan = latestArtifact<PlanArtifact>(db, run.goal_id, 'plan');
    const fresh = plan ? planFreshness(plan, checkoutPath, git) : null;
    const reason = !plan ? 'PROJECT_ROOM_PLAN_REQUIRED: no valid issued plan for this goal' : !fresh!.fresh ? `PROJECT_ROOM_PLAN_STALE: ${fresh!.reason}` : null;
    if (mode === 'shadow') return { state: 'shadow', plan: reason ? null : plan, reason };
    return reason ? { state: 'blocked', reason } : { state: 'deliver', plan: plan! };
  } catch (error) { return mode === 'on' ? { state: 'blocked', reason: `PROJECT_ROOM_PLAN_UNREADABLE: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}` } : { state: 'none' }; }
}
/** Before a maker is prepared for a selected goal in mode on: no plan, a stale plan or an unreadable plan stops the hand-over. */
export function requirePlanForRun(db: Database, run: { goal_id: string | null; repository_path?: string | null }, env: NodeJS.ProcessEnv = process.env): void {
  if (projectRoomMode(env) !== 'on' || !run.repository_path) return;
  const d = planDelivery(db, run, run.repository_path, env);
  if (d.state === 'blocked') throw new Error(d.reason);
}
/** LOADED: the prompt the executor is about to send contains this lease's plan digest. Proves inclusion, not use. */
export function planLoaded(leaseMetadata: Json, prompt: string): { plan_id: string; version: number; digest: string; prompt_sha256: string } | null {
  const ref = leaseMetadata.plan_ref as PlanRef | undefined;
  return ref && typeof ref.digest === 'string' && prompt.includes(`sha256:${ref.digest}`) ? { plan_id: ref.plan_id, version: ref.version, digest: ref.digest, prompt_sha256: sha256(prompt) } : null;
}

// ── dossier: a projection of durable records ────────────────────────────────────────────────────────────────────────────
export interface DossierGap { what: string; reason: string; next_action: string }
// ── wiring: who ran, with what, allowed by what, traced where ───────────────────────────────────────────────────────────
// Every reader tolerates a table that is missing or empty: an absent record is null or [], never a pass and never a zero.
function all<T>(db: Database, sql: string, ...args: unknown[]): T[] { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } }
function one<T>(db: Database, sql: string, ...args: unknown[]): T | undefined { try { return db.prepare(sql).get(...args) as T | undefined; } catch { return undefined; } }
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
function agentOf(db: Database, agentId: string | null | undefined) {
  const a = agentId ? one<{ id: string; name: string; capabilities: string | null }>(db, 'SELECT id, name, capabilities FROM agents WHERE id = ?', agentId) : undefined;
  if (!a) return null;
  let capabilities: string[] = []; try { const c = JSON.parse(a.capabilities ?? '[]') as unknown; if (Array.isArray(c)) capabilities = c.map(String); } catch { /* unreadable = none listed */ }
  return { id: a.id, name: a.name, capabilities };
}
/** The engine's own event log for one task: how many events, how many errors, and the runtime-admission decision if recorded. */
function taskTrace(db: Database, taskId: string) {
  const c = one<{ n: number; errors: number }>(db, "SELECT COUNT(*) AS n, COALESCE(SUM(level = 'error'), 0) AS errors FROM execution_events WHERE task_id = ?", taskId);
  const admission = one<{ message: string }>(db, "SELECT message FROM execution_events WHERE task_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.source') = 'runtime-admission' ORDER BY rowid DESC LIMIT 1", taskId);
  return { task_id: taskId, events: c?.n ?? null, errors: c?.errors ?? null, admission: admission?.message ?? null };
}
function leaseWiring(db: Database, runId: string, l: { id: string; role: string; capability_id: string | null }, m: Json, taskId: string | null) {
  const task = taskId ? one<{ agent_id: string | null }>(db, 'SELECT agent_id FROM tasks WHERE id = ?', taskId) : undefined;
  const blocks = obj(obj(m.assignment_receipt).blocks); const route = obj(m.skill_route); const genome = obj(m.genome);
  const traceId = str(m.trace_id) ?? `loop-${runId}-${l.role === 'maker' ? 'worker' : 'checker'}-${l.id}`;
  const spans = all<{ span_type: string; name: string; status: string }>(db, 'SELECT span_type, name, status FROM agent_trace_spans WHERE trace_id = ? ORDER BY created_at, rowid', traceId);
  const manifest = one<{ action: string; blocked_reasons_json: string }>(db, 'SELECT action, blocked_reasons_json FROM swarm_runner_manifests WHERE lease_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', l.id);
  let blocked: string[] = []; try { const b = JSON.parse(manifest?.blocked_reasons_json ?? '[]') as unknown; if (Array.isArray(b)) blocked = b.map(String); } catch { /* unreadable = none listed */ }
  return {
    agent: agentOf(db, task?.agent_id),
    identity: { model: str(m.model_id) ?? str(m.model), provider: str(m.provider), model_family: str(m.model_family), genome_id: str(genome.genome_id) ?? str(genome.id) },
    // what the assignment carried, per block (delivery receipts: proof of delivery, not of use); the plan block is shown above
    context: Object.entries(blocks).filter(([name]) => name !== 'plan').map(([name, b]) => ({ name, ids: Array.isArray(obj(b).ids) ? (obj(b).ids as unknown[]).map(String) : [] })),
    // the skill the assignment routed to, and whether the transcript shows the maker ran it (null = no route recorded)
    skill: str(route.capability_id) ? { capability_id: String(route.capability_id), version: route.version == null ? null : String(route.version), state: str(route.state), invoked: typeof route.invoked === 'boolean' ? route.invoked : null } : null,
    capability: { credited_id: l.capability_id, runner_decision: manifest ? { action: manifest.action, blocked_reasons: blocked } : null },
    trace: { id: traceId, spans: spans.length, span_errors: spans.filter((x) => x.status === 'error' || x.status === 'blocked').length, steps: spans.slice(0, 40), task: taskId ? taskTrace(db, taskId) : null },
  };
}

export function projectDossier(db: Database, goalId: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const goal = goalRow(db, goalId);
  if (!goal) return null;
  const plan = latestArtifact<PlanArtifact>(db, goalId, 'plan'); const review = latestArtifact<ReviewArtifact>(db, goalId, 'architecture_review');
  const versions = db.prepare("SELECT version, digest, created_at FROM project_room_artifacts WHERE goal_id = ? AND kind = 'plan' ORDER BY version").all(goalId) as Array<{ version: number; digest: string; created_at: string }>;
  const runs = db.prepare('SELECT id, status, metadata, created_at FROM loop_runs WHERE goal_id = ? ORDER BY created_at').all(goalId) as Array<{ id: string; status: string; metadata: string; created_at: string }>;
  const gaps: DossierGap[] = [];
  const execution = runs.map((r) => {
    const leases = (db.prepare('SELECT id, role, runtime, status, capability_id, metadata, created_at FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at').all(r.id) as Array<{ id: string; role: string; runtime: string; status: string; capability_id: string | null; metadata: string; created_at: string }>).map((l) => {
      const m = json(l.metadata); const ref = m.plan_ref as PlanRef | undefined;
      const receipt = json(JSON.stringify((json(JSON.stringify(m.assignment_receipt ?? {})).blocks as Json | undefined)?.plan ?? {}));
      const taskId = typeof m.execution_task_id === 'string' ? m.execution_task_id : null;
      const task = taskId ? db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined : undefined;
      const checks = Array.isArray(m.deterministic_checks) ? withoutHiddenChecks(m.deterministic_checks as Json[]).map((c) => ({ name: String(c.name ?? '?'), status: String(c.status ?? 'unknown') })) : null;
      return { id: l.id, role: l.role, runtime: l.runtime, status: l.status, superseded: typeof m.superseded_by_maker_lease_id === 'string',
        // a lease can still read 'prepared' while its engine task runs (approval resume): show both, claim neither
        task: taskId ? { id: taskId, status: task?.status ?? null } : null,
        plan: ref ? { plan_id: ref.plan_id, version: ref.version, delivered: Array.isArray(receipt.ids) && typeof receipt.sha256 === 'string', loaded: m.plan_loaded ? true : null } : null,
        checks, verdict: typeof m.verdict === 'string' ? m.verdict : typeof json(JSON.stringify(m.checker_verdict ?? {})).verdict === 'string' ? String(json(JSON.stringify(m.checker_verdict)).verdict) : null,
        maker_lease_id: typeof m.maker_lease_id === 'string' ? m.maker_lease_id : null,
        ...leaseWiring(db, r.id, l, m, taskId) };
    });
    const meta = json(r.metadata); const pr = typeof meta.pr_url === 'string' ? meta.pr_url : null;
    const settled = pr ? settlementState(r.created_at, parseOutcome(meta.pr_outcome === undefined ? null : JSON.stringify(meta.pr_outcome)), now).state : null;
    return { run_id: r.id, status: r.status, leases, pr_url: pr, events: all<{ type: string; n: number }>(db, 'SELECT event_type AS type, COUNT(*) AS n FROM loop_events WHERE loop_run_id = ? GROUP BY event_type ORDER BY n DESC, event_type', r.id),
      // the run's own terminal status after its gates: certified, not certified, or not settled yet (null, never false)
      outcome_verified: ['completed', 'ready_for_human_merge'].includes(r.status) ? true : ['failed', 'blocked', 'escalated', 'cancelled'].includes(r.status) ? false : null,
      // immediate verification and later survival are different facts: PENDING until settled, UNKNOWN without a PR to observe
      survival: !pr ? 'UNKNOWN' : settled === 'SETTLED_SURVIVED' ? 'SURVIVED' : settled === 'SETTLED_REGRESSED' ? 'REGRESSED' : 'PENDING' };
  });
  const mode = projectRoomMode(env); const selected = roomSelected(goal.metadata);
  if (!selected) gaps.push({ what: 'route', reason: "this goal does not use the project room (metadata.task_profile is not 'project_room')", next_action: 'none: the direct route applies' });
  else if (mode === 'off') gaps.push({ what: 'mode', reason: 'COMMONS_PROJECT_ROOM_MODE is off', next_action: 'operator: set the flag in a development or experiment environment' });
  if (selected && !review && roomVariant(goal.metadata) === 'two_stage') gaps.push({ what: 'architecture review', reason: 'no review issued', next_action: mode === 'on' ? 'runs before the next maker for this goal' : 'needs mode on' });
  if (selected && !plan) gaps.push({ what: 'plan', reason: 'no valid plan issued', next_action: mode === 'on' ? 'runs before the next maker for this goal' : 'needs mode on' });
  const failed = calls(db, goalId).filter((c) => c.status !== 'completed').slice(-1)[0];
  if (failed) gaps.push({ what: `${failed.profile} call`, reason: failed.error ?? failed.status, next_action: failed.status === 'running' ? 'wait for the call to finish' : 'fix the cause; the next room run calls again within the call limit' });
  if (plan && !execution.some((e) => e.leases.some((l) => l.plan))) gaps.push({ what: 'execution', reason: 'no worker lease carries this plan yet', next_action: 'the existing loop starts a maker for the goal' });
  return {
    mode, selected, variant: roomVariant(goal.metadata),
    goal: { id: goal.id, objective: goal.objective, constraints: goal.constraints, acceptance_criteria: goal.acceptance_criteria, status: goal.status, budget: goal.budget, proposal_id: goal.improvement_id,
      source: plan ? plan.repository : review ? review.repository : null, tokens_used_by_room: roomTokens(db, goalId), max_tokens: Number(goal.budget.max_tokens) || null },
    review: review ? { version: review.version, claims: review.claims, reusable_components: review.reusable_components, interfaces: review.interfaces, invariants: review.invariants, failure_modes: review.failure_modes,
      assumptions: review.assumptions, open_questions: review.open_questions, proposal: review.proposal, provenance: review.provenance } : null,
    plan: plan ? { plan_id: plan.plan_id, version: plan.version, digest: plan.digest, versions, decisions: plan.decisions, assumptions: plan.assumptions, uncertainties: plan.uncertainties, open_questions: plan.open_questions,
      findings_review: plan.findings_review, steps: plan.steps, stop_conditions: plan.stop_conditions, recovery: plan.recovery, sources: plan.sources, provenance: plan.provenance } : null,
    calls: calls(db, goalId).map((c) => ({ profile: c.profile, status: c.status, runtime: c.runtime, tokens: c.tokens, error: c.error, started_at: c.started_at, finished_at: c.finished_at })),
    // the engine tasks behind the room's own calls: each has its execution events (the trace of that planner or reviewer call)
    call_tasks: all<{ id: string; status: string; agent_id: string | null; profile: string | null }>(db, `SELECT id, status, agent_id, json_extract(metadata, '$.project_room.profile') AS profile FROM tasks
      WHERE id LIKE 'project-room-%' AND json_valid(metadata) AND json_extract(metadata, '$.project_room.goal_id') = ? ORDER BY created_at`, goalId).map((t) => ({ ...t, agent: agentOf(db, t.agent_id), trace: taskTrace(db, t.id) })),
    // decisions the authority gate recorded for this goal, and the Commons thread that reviewed its proposal (null = none recorded)
    authority_events: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM authority_events WHERE correlation_id = ?', goalId)?.n ?? null,
    commons_review: goal.improvement_id ? one<{ thread_id: string; status: string; reply_count: number }>(db, 'SELECT thread_id, status, reply_count FROM commons_proposal_reviews WHERE improvement_id = ?', goal.improvement_id) ?? null : null,
    execution,
    candidates: (db.prepare("SELECT id, lesson, status FROM reflection_candidates WHERE source_ref LIKE ? ORDER BY created_at").all(`project-room:${goalId}:%`) as Array<{ id: string; lesson: string; status: string }>),
    gaps,
  };
}
/** Goals an operator can still route through the room: open, not selected yet. */
export function roomCandidates(db: Database, limit = 50) {
  return db.prepare(`SELECT id, objective, status FROM goals WHERE status NOT IN ('completed', 'failed', 'cancelled', 'archived')
    AND COALESCE(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.task_profile') END, '') != 'project_room' ORDER BY updated_at DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit))) as Array<{ id: string; objective: string; status: string }>;
}
/**
 * Operator choice: route one goal through the room, or back to the direct route. Only the goal's own metadata changes; what
 * happens next is decided by COMMONS_PROJECT_ROOM_MODE (off: nothing, shadow: a record, on: review and plan before the maker).
 */
export function selectRoom(db: Database, goalId: string, selected: boolean, variant: 'single' | 'two_stage' = 'two_stage'): boolean {
  const now = new Date().toISOString();
  const sql = selected
    ? "UPDATE goals SET metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.task_profile', 'project_room', '$.project_room.variant', ?), updated_at = ? WHERE id = ?"
    : "UPDATE goals SET metadata = json_remove(metadata, '$.task_profile'), updated_at = ? WHERE id = ? AND json_valid(metadata)";
  return (selected ? db.prepare(sql).run(variant, now, goalId) : db.prepare(sql).run(now, goalId)).changes > 0;
}
export function listRooms(db: Database, limit = 50) {
  return db.prepare(`SELECT g.id, g.objective, g.status, g.updated_at,
      (SELECT MAX(version) FROM project_room_artifacts a WHERE a.goal_id = g.id AND a.kind = 'plan') AS plan_version,
      (SELECT COUNT(*) FROM loop_runs r WHERE r.goal_id = g.id) AS runs
    FROM goals g WHERE (CASE WHEN json_valid(g.metadata) THEN json_extract(g.metadata, '$.task_profile') END) = 'project_room' OR EXISTS (SELECT 1 FROM project_room_artifacts a WHERE a.goal_id = g.id)
    ORDER BY g.updated_at DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit))) as Array<{ id: string; objective: string; status: string; updated_at: string; plan_version: number | null; runs: number }>;
}

/**
 * Candidate knowledge from a room, only after an independently verified outcome: each architecture claim the planner
 * rejected against the source becomes one reflection candidate (candidate only, promotion not allowed here). Messages,
 * agreement, a finished call or a delivered plan earn nothing. Idempotent per goal, plan version and claim.
 */
export function proposeRoomCandidates(db: Database, goalId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (projectRoomMode(env) !== 'on') return [];
  const dossier = projectDossier(db, goalId, env);
  const verified = dossier?.execution.find((e) => e.outcome_verified === true && e.leases.some((l) => l.plan && !l.superseded));
  if (!dossier?.plan || !dossier.review || !verified) return [];
  const version = verified.leases.find((l) => l.plan)!.plan!.version;
  const plan = planVersion(db, goalId, version);
  const out: string[] = [];
  for (const f of plan?.findings_review ?? []) {
    if (f.status !== 'rejected') continue;
    const ref = `project-room:${goalId}:v${version}:${f.claim_id}`;
    if (db.prepare('SELECT 1 FROM reflection_candidates WHERE source_ref = ?').get(ref)) continue;
    const claim = dossier.review.claims.find((c) => c.id === f.claim_id);
    out.push(new AgentAssuranceService(db).createReflection({ source_type: 'loop', source_ref: ref, lesson: `Architecture assumption rejected against the source: "${claim?.claim ?? f.claim_id}" — ${f.note}`.slice(0, 600),
      evidence_refs: [`loop_run:${verified.run_id}`, `plan:${goalId}@${version}`], metadata: { candidate_only: true, promotion_allowed: false, project_room: { goal_id: goalId, plan_version: version, profile_version: PROFILE_VERSION } } }).id);
  }
  return out;
}
