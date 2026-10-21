import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { GateStatus } from './loop-types';
import { ReviewerIndependenceService, leaseIdentity, type ReviewerIndependenceAssessment } from './reviewer-independence-service';

/**
 * Alibaba Open Code Review (OCR) as an ADDITIONAL, shadow-only reviewer: the pure parts of the adapter
 * (docs/research/ocr/ADAPTER_DESIGN.md, COVERAGE_CONTRACT.md). Nothing here spawns OCR, calls a model, touches the database,
 * posts a PR comment or feeds a merge decision. Flag OCR_SHADOW_REVIEW_MODE: off (default) | shadow; there is no acting mode.
 *
 * The coverage denominator is Djimitflo's own `git diff --name-status -z --find-renames <base> <head>` on the frozen SHAs —
 * never OCR's `selected` set, which already excludes test files, deletions, binaries, oversized and vendor paths. OCR's exit
 * code is never evidence: it exits 0 on complete, partial and skipped runs (open-code-review cmd/opencodereview/
 * review_cmd.go:330-336 at 375f64cd). Missing evidence is INSUFFICIENT_EVIDENCE / gate 'unknown' (E2), never a pass.
 */

export const OCR_ADAPTER_VERSION = 'ocr-adapter/v1';
export const OCR_MANIFEST_SCHEMA = 'ocr.run-manifest/v1';

export type OcrShadowMode = 'off' | 'shadow';
export const ocrShadowMode = (env: NodeJS.ProcessEnv = process.env): OcrShadowMode =>
  (env.OCR_SHADOW_REVIEW_MODE || '').trim().toLowerCase() === 'shadow' ? 'shadow' : 'off';

// ─── Frozen diff ────────────────────────────────────────────────────────────────────────────────────────────────────

export type DiffChange = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed';
export interface DiffItem { path: string; old_path: string | null; change: DiffChange; similarity: number | null; is_test: boolean }

/** Djimitflo's own test-file classifier (OCR's default excludes are not trusted to define what a test is). */
export function isTestPath(path: string): boolean {
  const p = path.toLowerCase();
  return /(^|\/)(__tests__|tests?|spec|testdata|fixtures)\//.test(p)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
    || /_test\.(go|py|rs|zig|nu)$/.test(p)
    || /(^|\/)test_[^/]+\.py$/.test(p);
}

const CHANGE: Record<string, DiffChange> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed' };

/** Parses `git diff --name-status -z --find-renames <base> <head>`. Unknown statuses (U, X, …) are errors, not guesses. */
export function parseNameStatusZ(raw: string): { items: DiffItem[]; errors: string[] } {
  const tokens = raw.split('\0');
  if (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();
  const items: DiffItem[] = [];
  const errors: string[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    const change = CHANGE[status.charAt(0)];
    if (!change) { errors.push(`unsupported_diff_status:${status.slice(0, 8)}`); i++; continue; }
    const twoPaths = change === 'renamed' || change === 'copied';
    const first = tokens[i++];
    const second = twoPaths ? tokens[i++] : undefined;
    if (first === undefined || (twoPaths && second === undefined)) { errors.push(`truncated_diff_record:${status}`); break; }
    const path = twoPaths ? second as string : first;
    const similarity = twoPaths && /^\d+$/.test(status.slice(1)) ? Number(status.slice(1)) : null;
    items.push({ path, old_path: twoPaths ? first : null, change, similarity, is_test: isTestPath(path) });
  }
  return { items, errors };
}

// ─── OCR output (fake in tests; the real binary is not run by this module) ────────────────────────────────────────────

interface OcrCoverageItem { item_id?: string; path: string; old_path?: string; classification?: string; reason?: string }
export interface OcrManifest {
  schema_version: string;
  run_id: string;
  parent_run_id?: string;
  terminal_state: string;
  input: { mode: string; resolved_base?: string; resolved_head?: string };
  execution: { ocr_version?: string; provider?: string; model?: string; rule_config_sha256?: string; runtime_config_sha256?: string };
  coverage: { selected: OcrCoverageItem[]; completed: OcrCoverageItem[]; reused: OcrCoverageItem[]; failed: OcrCoverageItem[]; waived: OcrCoverageItem[] };
  run_failure?: { classification: string; reason?: string };
  elapsed_ms?: number;
}
export interface OcrComment { path: string; content: string; start_line?: number; end_line?: number; category?: string; severity?: string }
export interface OcrJsonDocument {
  status: string;
  llm?: { provider?: string; model: string };
  summary?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; budget_exceeded?: boolean };
  comments: OcrComment[];
  manifest?: OcrManifest;
}

/** What the (future) process wrapper observed. `terminated_by` = Djimitflo's own wall-clock/budget/cancel kill. */
export interface OcrProcessResult {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  terminated_by: null | 'wall_timeout' | 'token_budget' | 'cancelled';
  duration_ms: number;
}

export function parseOcrJson(stdout: string): { doc: OcrJsonDocument | null; error: string | null } {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return { doc: null, error: 'ocr_output_not_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { doc: null, error: 'ocr_output_not_object' };
  const d = parsed as Partial<OcrJsonDocument>;
  if (typeof d.status !== 'string' || !Array.isArray(d.comments)) return { doc: null, error: 'ocr_output_missing_status_or_comments' };
  return { doc: d as OcrJsonDocument, error: null };
}

// ─── Trusted policy ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Comes from a pinned copy held in Djimitflo (never from the reviewed change). `trusted_rule_sha256` is OCR's own
 * execution.rule_config_sha256 for the trusted --rule with no project/global layer; it covers every rule layer and the
 * effective include/exclude, so a project `.opencodereview/rule.json` that leaked into the run changes it.
 */
export interface TrustedReviewPolicy {
  policy_ref: string;
  trusted_rule_sha256: string | null;
  /** Paths whose change alters review configuration (always includes OCR's project rule directory). */
  protected_paths: string[];
  out_of_scope: Array<{ glob: string; reason: string }>;
  trusted_waivers: Array<{ path: string; reason: string }>;
  /** OCR run ids this adapter itself recorded for the same frozen input; only these make an OCR `reused` item valid. */
  trusted_parent_runs: string[];
}
export const DEFAULT_PROTECTED_PATHS = ['.opencodereview/**'];

/** Another existing control that provably covered a diff item (e.g. a checker run that read the whole diff). */
export interface ControlCoverage { path: string; control: string; evidence_ref: string }

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. Matched case-sensitively on repo-relative paths. */
export function globMatch(glob: string, path: string): boolean {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:[^/]*/)*'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp(`${re}$`).test(path);
}

// ─── Coverage contract ──────────────────────────────────────────────────────────────────────────────────────────────

export type ItemStatus = 'reviewed' | 'validly_reused' | 'covered_by_control' | 'out_of_scope_policy' | 'unreviewed';
export interface CoverageEntry {
  path: string; old_path: string | null; change: DiffChange; is_test: boolean;
  status: ItemStatus; reason: string | null; evidence_ref: string | null;
}

const key = (path: string, oldPath: string | null | undefined) => `${oldPath || ''}\0${path}`;

export function computeCoverage(items: DiffItem[], manifest: OcrManifest | null, policy: TrustedReviewPolicy,
  controls: ControlCoverage[] = [], ocrExclusions: Record<string, string> = {}): { entries: CoverageEntry[]; outside_diff: string[] } {
  const states = new Map<string, { state: 'completed' | 'reused' | 'failed' | 'waived' | 'selected'; item: OcrCoverageItem }>();
  const byPath = new Map<string, string>();
  if (manifest) {
    for (const state of ['selected', 'completed', 'reused', 'failed', 'waived'] as const) {
      for (const it of manifest.coverage[state] ?? []) {
        const k = key(it.path, it.old_path);
        if (state !== 'selected' || !states.has(k)) states.set(k, { state, item: it });
        byPath.set(it.path, k);
      }
    }
  }
  const matched = new Set<string>();
  const entries = items.map((d): CoverageEntry => {
    const base = { path: d.path, old_path: d.old_path, change: d.change, is_test: d.is_test };
    const scope = policy.out_of_scope.find((o) => globMatch(o.glob, d.path));
    if (scope) return { ...base, status: 'out_of_scope_policy', reason: scope.reason, evidence_ref: policy.policy_ref };
    const k = states.has(key(d.path, d.old_path)) ? key(d.path, d.old_path) : byPath.get(d.path);
    const hit = k ? states.get(k) : undefined;
    if (k && hit) matched.add(k);
    const control = controls.find((c) => c.path === d.path);
    const fallback = (reason: string): CoverageEntry => control
      ? { ...base, status: 'covered_by_control', reason: `${reason}; covered by ${control.control}`, evidence_ref: control.evidence_ref }
      : { ...base, status: 'unreviewed', reason, evidence_ref: null };
    if (!hit) {
      const why = ocrExclusions[d.path] ?? (d.old_path ? ocrExclusions[d.old_path] : undefined);
      return fallback(why ? `ocr_excluded:${why}` : d.change === 'deleted' ? 'ocr_does_not_review_deletions' : 'not_in_ocr_manifest');
    }
    switch (hit.state) {
      case 'completed': return { ...base, status: 'reviewed', reason: null, evidence_ref: manifest!.run_id };
      case 'reused':
        return manifest!.parent_run_id && policy.trusted_parent_runs.includes(manifest!.parent_run_id)
          ? { ...base, status: 'validly_reused', reason: null, evidence_ref: manifest!.parent_run_id }
          : fallback('ocr_reuse_unverified');
      case 'waived': {
        const w = policy.trusted_waivers.find((x) => x.path === d.path);
        return w ? { ...base, status: 'out_of_scope_policy', reason: `trusted_waiver:${w.reason}`, evidence_ref: policy.policy_ref } : fallback('ocr_waiver_not_trusted');
      }
      case 'failed': return fallback(`ocr_failed:${hit.item.classification || 'unknown'}`);
      default: return fallback('ocr_no_terminal_item_state');
    }
  });
  const outside = [...states.keys()].filter((k) => !matched.has(k)).map((k) => k.split('\0')[1]);
  return { entries, outside_diff: [...new Set(outside)] };
}

// ─── Verdict ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type OcrShadowOutcome = 'COMPLETE' | 'PARTIAL' | 'SKIPPED' | 'FAILED' | 'INSUFFICIENT_EVIDENCE';
export interface OcrFinding { path: string; start_line: number | null; end_line: number | null; severity: string | null; category: string | null; content_sha256: string; in_diff: boolean }
export interface OcrShadowVerdict {
  outcome: OcrShadowOutcome;
  /** E2 GateStatus: only COMPLETE observes anything; every other outcome is 'unknown' (never 'skipped' = not applicable). */
  gate: GateStatus;
  /** Shadow lane: never an acceptance, whatever OCR reported. */
  accepted: false;
  reasons: string[];
  coverage: CoverageEntry[];
  counts: Record<ItemStatus, number>;
  findings: OcrFinding[];
  ocr_status: string | null;
  ocr_terminal_state: string | null;
}

export interface FrozenReviewInput { base_sha: string; head_sha: string; name_status_z: string }

export function evaluateOcrRun(input: FrozenReviewInput, run: OcrProcessResult, policy: TrustedReviewPolicy,
  controls: ControlCoverage[] = [], ocrExclusions: Record<string, string> = {}): OcrShadowVerdict {
  const reasons: string[] = [];
  const { items, errors } = parseNameStatusZ(input.name_status_z);
  reasons.push(...errors);
  const { doc, error } = run.stdout.trim() ? parseOcrJson(run.stdout) : { doc: null, error: 'ocr_no_output' };
  if (error) reasons.push(error);
  const manifest = doc?.manifest ?? null;
  const paths = new Set(items.flatMap((d) => [d.path, d.old_path].filter(Boolean) as string[]));
  const findings: OcrFinding[] = (doc?.comments ?? []).map((c) => ({
    path: c.path, start_line: c.start_line ?? null, end_line: c.end_line ?? null, severity: c.severity ?? null, category: c.category ?? null,
    content_sha256: createHash('sha256').update(String(c.content ?? '')).digest('hex'), in_diff: paths.has(c.path),
  }));
  const { entries, outside_diff } = computeCoverage(items, manifest, policy, controls, ocrExclusions);
  const counts = { reviewed: 0, validly_reused: 0, covered_by_control: 0, out_of_scope_policy: 0, unreviewed: 0 } as Record<ItemStatus, number>;
  for (const e of entries) counts[e.status]++;
  const verdict = (outcome: OcrShadowOutcome, extra: string[] = []): OcrShadowVerdict => ({
    outcome, gate: outcome === 'COMPLETE' ? (findings.length ? 'fail' : 'pass') : 'unknown', accepted: false,
    reasons: [...reasons, ...extra], coverage: entries, counts, findings, ocr_status: doc?.status ?? null, ocr_terminal_state: manifest?.terminal_state ?? null,
  });

  // Evidence preconditions: any gap is insufficient evidence, never a negative or positive verdict.
  const gaps: string[] = [];
  if (run.terminated_by) gaps.push(`terminated_by_adapter:${run.terminated_by}`);
  if (run.signal) gaps.push(`ocr_killed_by_signal:${run.signal}`);
  if (errors.length) gaps.push('frozen_diff_unparseable');
  if (doc && !manifest) gaps.push('ocr_manifest_missing');
  if (manifest && manifest.schema_version !== OCR_MANIFEST_SCHEMA) gaps.push(`ocr_manifest_schema_unknown:${String(manifest.schema_version).slice(0, 40)}`);
  if (manifest && (manifest.input?.resolved_base !== input.base_sha || manifest.input?.resolved_head !== input.head_sha)) gaps.push('ocr_input_sha_mismatch');
  if (outside_diff.length) gaps.push(`ocr_items_outside_frozen_diff:${outside_diff.slice(0, 5).join(',')}`);
  if (!policy.trusted_rule_sha256) gaps.push('trusted_rule_sha256_not_recorded');
  else if (manifest && manifest.execution?.rule_config_sha256 !== policy.trusted_rule_sha256) gaps.push('ocr_rules_not_trusted_copy');
  const protectedHits = items.filter((d) => [...DEFAULT_PROTECTED_PATHS, ...policy.protected_paths].some((g) => globMatch(g, d.path) || (d.old_path !== null && globMatch(g, d.old_path))));
  if (protectedHits.length) reasons.push(`review_config_in_change:${protectedHits.map((d) => d.path).slice(0, 5).join(',')}`);
  if (!doc || gaps.length) return verdict('INSUFFICIENT_EVIDENCE', gaps);

  const state = manifest!.terminal_state;
  if (run.exit_code !== 0 && state !== 'failed') return verdict('INSUFFICIENT_EVIDENCE', [`ocr_exit_${run.exit_code}_contradicts_${state}`]);
  if (state === 'failed') return verdict('FAILED', [`ocr_failed:${manifest!.run_failure?.classification ?? 'items'}`]);
  if (!items.length) return verdict('SKIPPED', ['empty_frozen_diff']);
  const byOcr = counts.reviewed + counts.validly_reused;
  if (byOcr === 0) return verdict('SKIPPED', [`ocr_reviewed_nothing:${state}`]);
  if (counts.unreviewed > 0) return verdict('PARTIAL', [`unreviewed_items:${counts.unreviewed}`]);
  return verdict('COMPLETE');
}

// ─── Provenance ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OcrRunContext {
  repo: string;
  ocr_version: string;
  ocr_source_revision: string;
  binary_sha256: string;
  tools_config: string;           // 'embedded' or the sha256 of a trusted --tools file
  mcp_servers: string[];          // must be [] in the trial
  max_concurrency: number;
  timeout_minutes: number;
  max_tokens_budget: number;
}

export interface OcrProvenanceRecord {
  adapter_version: string;
  ocr: { version: string; source_revision: string; binary_sha256: string; auto_update: 'disabled' };
  llm: { provider: string | null; model: string | null };
  rules: { policy_ref: string; trusted_rule_sha256: string | null; observed_rule_config_sha256: string | null; observed_runtime_config_sha256: string | null };
  toolset: { tools_config: string; mcp_servers: string[] };
  source: { repo: string; base_sha: string; head_sha: string };
  bounds: { max_concurrency: number; timeout_minutes: number; max_tokens_budget: number };
  outcome: OcrShadowOutcome; gate: GateStatus; reasons: string[];
  coverage: Record<ItemStatus, number>; findings: number;
  /** null = not reported (UNKNOWN), never 0. */
  tokens: { input: number | null; output: number | null; total: number | null };
  duration_ms: number; exit_code: number | null; terminated_by: OcrProcessResult['terminated_by'];
  independence: ReviewerIndependenceAssessment | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function buildOcrProvenance(ctx: OcrRunContext, input: FrozenReviewInput, run: OcrProcessResult, policy: TrustedReviewPolicy,
  verdict: OcrShadowVerdict, independence: ReviewerIndependenceAssessment | null = null): OcrProvenanceRecord {
  const { doc } = run.stdout.trim() ? parseOcrJson(run.stdout) : { doc: null };
  const m = doc?.manifest;
  return {
    adapter_version: OCR_ADAPTER_VERSION,
    ocr: { version: ctx.ocr_version, source_revision: ctx.ocr_source_revision, binary_sha256: ctx.binary_sha256, auto_update: 'disabled' },
    llm: { provider: doc?.llm?.provider ?? m?.execution?.provider ?? null, model: doc?.llm?.model ?? m?.execution?.model ?? null },
    rules: { policy_ref: policy.policy_ref, trusted_rule_sha256: policy.trusted_rule_sha256, observed_rule_config_sha256: m?.execution?.rule_config_sha256 ?? null, observed_runtime_config_sha256: m?.execution?.runtime_config_sha256 ?? null },
    toolset: { tools_config: ctx.tools_config, mcp_servers: ctx.mcp_servers },
    source: { repo: ctx.repo, base_sha: input.base_sha, head_sha: input.head_sha },
    bounds: { max_concurrency: ctx.max_concurrency, timeout_minutes: ctx.timeout_minutes, max_tokens_budget: ctx.max_tokens_budget },
    outcome: verdict.outcome, gate: verdict.gate, reasons: verdict.reasons, coverage: verdict.counts, findings: verdict.findings.length,
    tokens: { input: num(doc?.summary?.input_tokens), output: num(doc?.summary?.output_tokens), total: num(doc?.summary?.total_tokens) },
    duration_ms: run.duration_ms, exit_code: run.exit_code, terminated_by: run.terminated_by, independence,
  };
}

/**
 * Independence of OCR against another reviewer (the maker, or the existing checker in the paired trial), through the
 * existing ReviewerIndependenceService: same model family / provider = correlated (FAIL); unknown identity = UNDETERMINED.
 * OCR's internal reflection/filter passes run on OCR's own model and are never counted as an independent review.
 */
export function assessOcrIndependence(other: { id: string; runtime: string; model: string | undefined; prompt: string },
  ocr: { provider: string | null; model: string | null; prompt_identity: string }): ReviewerIndependenceAssessment {
  const svc = new ReviewerIndependenceService(undefined as unknown as Database); // assess() reads no rows
  const otherMeta = leaseIdentity(other.runtime, other.model, other.prompt, {});
  const ocrMeta = ocr.model ? leaseIdentity('ocr', ocr.provider ? `${ocr.provider}/${ocr.model}` : ocr.model, ocr.prompt_identity, {}) : {};
  return svc.assess({ id: other.id, role: 'maker', runtime: other.runtime, metadata: otherMeta }, { id: 'ocr', role: 'checker', runtime: 'ocr', metadata: ocrMeta });
}
