import { createHash } from 'crypto';
import { prepareState, type TsAnswer, type TsQuestion } from './typesafe-client';

/**
 * DI-001 B: versioned decision provenance on every NEW judgment row (`judgments.provenance_json`). Additive: rows written
 * before the column existed stay NULL and read as `{ status: 'unrecorded' }` — never backfilled. Writers that cannot supply
 * a field write null and name the reason in `missing`, so an absent field is distinguishable from a recorded one. Direct
 * INSERT writers that are not instrumented get a `partial` floor from the `trg_judgments_provenance_floor` trigger (migrate.ts).
 *
 * Rollback (SQLite >= 3.35): `DROP TRIGGER IF EXISTS trg_judgments_provenance_floor; ALTER TABLE judgments DROP COLUMN provenance_json;`
 * Old readers/writers keep working with the column present: every reader and writer names its columns explicitly.
 */
export const DIGEST_ALG = 'canon/v1';
/** Version of the code that turns answers into a decision (decideObserved + band). Bump when that logic changes. */
export const EVALUATOR_VERSION = 'decideObserved/v1';
const MANDATORY = ['policy_id', 'policy_version', 'prompt_id', 'prompt_version', 'input_digest', 'evaluator_version', 'execution_mode', 'decision_timestamp', 'evidence_reference'] as const;

export interface JudgmentProvenance {
  v: 1;
  /** recorded: every mandatory field present | partial: some missing (see `missing`) | error: computing it failed */
  status: 'recorded' | 'partial' | 'error';
  writer: string;
  policy_id: string | null; policy_version: string | null;
  prompt_id: string | null; prompt_version: string | null;
  input_digest: string | null;
  model_id: string | null; model_version: string | null;
  evaluator_version: string | null; execution_mode: string | null;
  decision_timestamp: string | null; evidence_reference: string | null;
  uncertainty: { abstained: boolean; reason: string | null; min_confidence: number | null } | null;
  missing?: Record<string, string>;
  error?: string;
}
export type ProvenanceRead = JudgmentProvenance | { status: 'unrecorded' };

/** Canonical JSON (canon/v1): object keys sorted by code unit, no whitespace, JSON value rules (undefined dropped in objects, null in arrays, non-finite → null). */
export function canonicalize(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown): string | undefined => {
    if (v && typeof (v as { toJSON?: unknown }).toJSON === 'function') v = (v as { toJSON: () => unknown }).toJSON();
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v === 'bigint') throw new Error('CANON_BIGINT');
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (seen.has(v as object)) throw new Error('CANON_CYCLE');
    seen.add(v as object);
    const out = Array.isArray(v)
      ? `[${v.map((x) => walk(x) ?? 'null').join(',')}]`
      : `{${Object.keys(v as Record<string, unknown>).sort().flatMap((k) => { const s = walk((v as Record<string, unknown>)[k]); return s === undefined ? [] : [`${JSON.stringify(k)}:${s}`]; }).join(',')}}`;
    seen.delete(v as object);
    return out;
  };
  return walk(value) ?? 'null';
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256 over the canonical form of the REDACTED state (the same scrub as typesafe-client applies before it leaves the host). */
export const inputDigest = (state: unknown): string => `${DIGEST_ALG}:sha256:${sha256(canonicalize(prepareState(state)))}`;

/** prompt_version: hash of the definition's questions + its decide() source (where the thresholds live). Stable per build. */
export const promptVersion = (def: { questions: Record<string, TsQuestion>; decide: (...a: never[]) => unknown }): string =>
  sha256(canonicalize({ questions: def.questions, decide: String(def.decide) })).slice(0, 16);

const versionOf = (model: string | null | undefined): string | null => (model?.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null);

export interface ProvenanceInput {
  writer: string;
  def: { id: string; questions: Record<string, TsQuestion>; decide: (...a: never[]) => unknown; policyVersion?: string };
  mode: string; state: unknown; subject: { type: string; id: string }; stateHash: string; at: string;
  model?: string | null; decision?: string; reason?: string; answers?: Record<string, TsAnswer>;
  /** default EVALUATOR_VERSION; a writer that decides another way names its own */
  evaluator?: string;
}

/** Never throws: a failure to compute yields an `error` marker so the judgment row is still written (fail-open persistence). */
export function buildProvenance(p: ProvenanceInput): JudgmentProvenance {
  const base = { v: 1 as const, writer: p.writer, execution_mode: p.mode, decision_timestamp: p.at };
  try {
    const missing: Record<string, string> = {};
    const policyVersion = typeof p.def.policyVersion === 'string' && p.def.policyVersion ? p.def.policyVersion : null;
    if (!policyVersion) missing.policy_version = 'policy_version_undeclared_on_def';
    const model = p.model ?? null;
    if (!model) missing.model_id = p.decision === 'error' ? 'no_model_response' : 'model_not_reported';
    const modelVersion = versionOf(model);
    if (model && !modelVersion) missing.model_version = 'model_name_has_no_version';
    const confidences = Object.values(p.answers ?? {}).map((a) => a?.confidence).filter((c): c is number => typeof c === 'number');
    const prov: JudgmentProvenance = {
      ...base, status: 'recorded',
      policy_id: p.def.id, policy_version: policyVersion,
      prompt_id: `${p.def.id}/questions`, prompt_version: promptVersion(p.def),
      input_digest: inputDigest(p.state),
      model_id: model, model_version: modelVersion,
      evaluator_version: p.evaluator ?? EVALUATOR_VERSION,
      evidence_reference: `${p.subject.type}:${p.subject.id}#state=${p.stateHash}`,
      uncertainty: p.decision === undefined ? null : {
        abstained: p.decision === 'uncertain' || p.decision === 'error',
        reason: p.decision === 'error' ? 'error' : p.decision === 'uncertain' ? (p.reason?.startsWith('insufficient_evidence') ? 'insufficient_evidence' : 'banded_uncertain') : null,
        min_confidence: confidences.length ? Math.min(...confidences) : null,
      },
    };
    if (Object.keys(missing).length) prov.missing = missing;
    if (MANDATORY.some((k) => !prov[k])) prov.status = 'partial';
    return prov;
  } catch (err) {
    return {
      ...base, status: 'error', policy_id: null, policy_version: null, prompt_id: null, prompt_version: null, input_digest: null,
      model_id: null, model_version: null, evaluator_version: null, evidence_reference: null, uncertainty: null,
      missing: { all: 'provenance_compute_failed' }, error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

/** Serialised for the column; null only if even serialising fails (the row is still written). */
export const provenanceJson = (p: JudgmentProvenance): string | null => { try { return JSON.stringify(p); } catch { return null; } };

/** A row's provenance; NULL (pre-activation history) reads as `unrecorded`, unparseable as an `error` marker. */
export function readProvenance(row: { provenance_json?: string | null } | null | undefined): ProvenanceRead {
  const raw = row?.provenance_json;
  if (raw === null || raw === undefined) return { status: 'unrecorded' };
  try {
    const p = JSON.parse(raw) as JudgmentProvenance;
    return p && typeof p === 'object' && typeof p.status === 'string' ? p : { status: 'unrecorded' };
  } catch {
    return { v: 1, status: 'error', writer: 'unknown', policy_id: null, policy_version: null, prompt_id: null, prompt_version: null, input_digest: null,
      model_id: null, model_version: null, evaluator_version: null, execution_mode: null, decision_timestamp: null, evidence_reference: null, uncertainty: null, error: 'unparseable' };
  }
}

/**
 * Gate for consumers that use a judgment as evidence for a promotion / evidence-backed verdict: true only for a `recorded`
 * provenance with every mandatory field. Accepts a DB row (`provenance_json`) or an in-memory record (`provenance`).
 */
export function hasMandatoryProvenance(x: { provenance_json?: string | null } | { provenance?: JudgmentProvenance | null } | null | undefined): boolean {
  if (!x) return false;
  const p: ProvenanceRead = 'provenance' in x ? (x.provenance ?? { status: 'unrecorded' }) : readProvenance(x as { provenance_json?: string | null });
  if (p.status !== 'recorded') return false;
  const r = p as JudgmentProvenance;
  return MANDATORY.every((k) => typeof r[k] === 'string' && (r[k] as string).length > 0) && String(r.input_digest).startsWith(`${DIGEST_ALG}:sha256:`);
}
