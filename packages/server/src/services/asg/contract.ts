import { createHash } from 'crypto';

/**
 * ASG-001 macro contract: the existing skill model (skill_cards: candidate → survived/regressed; maker_genomes: trial → active
 * → retired) extended with what an *executable* composite procedure needs. A contract is data. It can never widen the task's
 * permissions: the effective write set is always the intersection of the contract's declared effects and the task capability
 * (effectiveWrites), and every write is checked again at dispatch (effects.ts CapabilityGate).
 *
 * Three kinds of knowledge are kept apart:
 *  - procedure knowledge: the contract + its procedure code (macros.ts), identified by (skill_id, version, digest);
 *  - applicability knowledge: router rules (router.ts, policy hash) and learned ApplicabilityRule rows with provenance;
 *  - recovery knowledge: failure taxonomy + micro fallback context (RecoveryKnowledge), versioned with the contract.
 */

export const LIFECYCLE_STATES = ['candidate', 'replay_validated', 'heldout_validated', 'shadow', 'eligible', 'active', 'deprecated'] as const;
export type LifecycleState = typeof LIFECYCLE_STATES[number];
/** Equivalent existing states: skill_cards 'candidate'; maker_genomes 'trial' ≈ shadow, 'active' = active, 'retired' ≈ deprecated. */
export const EXISTING_STATE_EQUIVALENTS: Record<string, LifecycleState> = { 'skill_cards.candidate': 'candidate', 'maker_genomes.trial': 'shadow', 'maker_genomes.active': 'active', 'maker_genomes.retired': 'deprecated' };

export const FAILURE_CLASSES = [
  'precondition_mismatch', 'partial_effect', 'validation_failure', 'tool_schema', 'executor_exception', 'timeout_uncertain',
  'policy_refusal', 'permission_invalid', 'unknown_external_effect', 'concurrent_execution', 'lease_lost',
] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];
/** Never recoverable, whatever a contract says (operator rule: unknown external effects, policy refusal, invalid permissions). */
export const NEVER_RECOVERABLE: ReadonlySet<FailureClass> = new Set(['policy_refusal', 'permission_invalid', 'unknown_external_effect', 'concurrent_execution', 'lease_lost']);

export interface FieldSchema { type: 'string' | 'number' | 'boolean'; pattern?: string; maxLength?: number }
export interface ObjectSchema { type: 'object'; required: string[]; properties: Record<string, FieldSchema>; additionalProperties: false }

/** Machine-checkable, evaluated against the workspace. `path` is an input field name whose value is a workspace path. */
export type Precondition =
  | { id: string; check: 'path_exists' | 'path_absent'; path: string }
  | { id: string; check: 'path_matches'; path: string; pattern: string }
  | { id: string; check: 'text_occurs_once'; path: string; text: string } // text = input field holding the needle
  | { id: string; check: 'digest_equals'; path: string; digest: string }; // digest = input field holding the expected base digest

export type Postcondition =
  | { id: string; check: 'file_digest_equals_output'; path: string; output: string }
  | { id: string; check: 'verifier_passes' }
  | { id: string; check: 'workspace_unchanged' }
  | { id: string; check: 'output_schema' };

export interface MacroContract {
  skill_id: string;
  /** immutable: a registered (skill_id, version) never changes digest */
  version: number;
  summary: string;
  /** oracle lanes this procedure applies to */
  lanes: Array<'test-gap' | 'mutation'>;
  input_schema: ObjectSchema;
  output_schema: ObjectSchema;
  preconditions: Precondition[];
  /** declared effects; `${field}` is replaced by the input field's value. Globs: `*` (one segment), `**` (any) */
  effects: { read: string[]; write: string[]; exec: string[] };
  required_capabilities: string[];
  /** runtimes with a macro adapter that can execute this contract */
  runtime_compat: string[];
  postconditions: Postcondition[];
  verifier_ref: string;
  timeout_ms: number;
  /** total cost units this macro may consume (one shared task budget still applies) */
  budget_units: number;
  failure_taxonomy: Partial<Record<FailureClass, { recoverable: boolean }>>;
  idempotency: { idempotent: boolean; key_fields: string[]; compensation: 'restore_preimage' | 'none' };
  micro_fallback: { allowed: boolean; required_context: string[]; hint: string };
  lineage: { derived_from: string; evidence_refs: string[]; skill_card_refs: string[]; parent: string | null };
}

export interface AdmissionEvidence { gate: LifecycleState; kind: 'replay' | 'heldout' | 'shadow' | 'operator'; ref: string; runs: number; verified: number; invariant_violations: number; split?: 'train' | 'dev' | 'test'; at: string }
export interface AdmittedMacro { contract: MacroContract; digest: string; state: LifecycleState; admission: AdmissionEvidence[] }

/** Learned applicability rule (none exist in v1). A rule without provenance is refused. */
export interface ApplicabilityRule { id: string; skill_id: string; version: number; condition: Record<string, unknown>; provenance: { derived_from_runs: string[]; split: 'train'; created_by: string; created_at: string } }
export interface RecoveryKnowledge { skill_id: string; version: number; recoverable: FailureClass[]; required_context: string[]; hint: string }

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Content digest of the procedure contract (canonical JSON). Lifecycle state and admission evidence are not part of it. */
export const contractDigest = (c: MacroContract): string => sha256(canonical(c));
export const canonicalJson = canonical;

export function recoveryKnowledge(c: MacroContract): RecoveryKnowledge {
  const recoverable = (Object.entries(c.failure_taxonomy) as Array<[FailureClass, { recoverable: boolean }]>)
    .filter(([k, v]) => v.recoverable && !NEVER_RECOVERABLE.has(k)).map(([k]) => k).sort();
  return { skill_id: c.skill_id, version: c.version, recoverable, required_context: [...c.micro_fallback.required_context], hint: c.micro_fallback.hint };
}

export function isRecoverable(c: MacroContract | null, cls: FailureClass): boolean {
  if (NEVER_RECOVERABLE.has(cls)) return false;
  if (!c) return false;
  return c.micro_fallback.allowed && c.failure_taxonomy[cls]?.recoverable === true;
}

/** Validate an input/output object against a contract schema. Returns null when valid, else the first problem. */
export function validateSchema(schema: ObjectSchema, value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const obj = value as Record<string, unknown>;
  for (const k of schema.required) if (!(k in obj)) return `missing ${k}`;
  for (const [k, v] of Object.entries(obj)) {
    const f = schema.properties[k];
    if (!f) return `unexpected field ${k}`;
    if (f.type === 'number' ? typeof v !== 'number' || !Number.isFinite(v) : typeof v !== f.type) return `${k} is not ${f.type}`;
    if (f.type === 'string') {
      if (f.maxLength !== undefined && (v as string).length > f.maxLength) return `${k} too long`;
      if (f.pattern && !new RegExp(f.pattern).test(v as string)) return `${k} does not match`;
    }
  }
  return null;
}

/** Glob → RegExp: `**` any number of segments, `*` within one segment. Paths are workspace-relative posix. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; continue; }
    if (ch === '*') { re += '[^/]*'; continue; }
    re += /[.+^${}()|[\]\\?]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (p: string, globs: string[]): boolean => globs.some((g) => globToRegExp(g).test(p));

/** `${field}` → input value. A value that is not a plain path string makes the effect unresolvable (null). */
export function resolveEffect(template: string, input: Record<string, unknown>): string | null {
  let bad = false;
  const out = template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, k: string) => {
    const v = input[k];
    if (typeof v !== 'string' || !SAFE_PATH.test(v) || v.split('/').includes('..')) { bad = true; return ''; }
    return v;
  });
  return bad ? null : out;
}
export const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./@-]*$/;

/**
 * The contract's resolved write set, kept only where the task capability also allows it. A contract that declares more than
 * the task allows does not get more: the excess is returned as `refused` (and the router will not pick it).
 */
export function effectiveWrites(c: MacroContract, input: Record<string, unknown>, capabilityWrite: string[]): { allowed: string[]; refused: string[] } {
  const allowed: string[] = []; const refused: string[] = [];
  for (const t of c.effects.write) {
    const p = resolveEffect(t, input);
    if (p !== null && !/[*]/.test(p) && matchesAny(p, capabilityWrite)) allowed.push(p); else refused.push(p ?? t);
  }
  return { allowed, refused };
}

export class ContractRegistry {
  private byKey = new Map<string, AdmittedMacro>();
  register(contract: MacroContract, state: LifecycleState = 'candidate', admission: AdmissionEvidence[] = []): AdmittedMacro {
    const key = `${contract.skill_id}@${contract.version}`;
    const digest = contractDigest(contract);
    const prev = this.byKey.get(key);
    if (prev && prev.digest !== digest) throw new Error(`ASG_CONTRACT_VERSION_IMMUTABLE: ${key} is registered with digest ${prev.digest.slice(0, 12)}`);
    const entry = prev ?? { contract, digest, state, admission };
    this.byKey.set(key, entry);
    return entry;
  }
  get(skillId: string, version?: number): AdmittedMacro | undefined {
    if (version !== undefined) return this.byKey.get(`${skillId}@${version}`);
    return [...this.byKey.values()].filter((m) => m.contract.skill_id === skillId).sort((a, b) => b.contract.version - a.contract.version)[0];
  }
  list(): AdmittedMacro[] { return [...this.byKey.values()].sort((a, b) => a.contract.skill_id.localeCompare(b.contract.skill_id) || a.contract.version - b.contract.version); }
}

/** Promotion needs the evidence of the gate being entered; nothing reaches eligible/active without evaluation evidence. */
const NEXT: Record<LifecycleState, LifecycleState | null> = {
  candidate: 'replay_validated', replay_validated: 'heldout_validated', heldout_validated: 'shadow', shadow: 'eligible', eligible: 'active', active: null, deprecated: null,
};
const REQUIRED_KIND: Partial<Record<LifecycleState, { kind: AdmissionEvidence['kind']; split?: AdmissionEvidence['split']; minRuns: number }>> = {
  replay_validated: { kind: 'replay', split: 'train', minRuns: 5 },
  heldout_validated: { kind: 'heldout', split: 'test', minRuns: 5 },
  shadow: { kind: 'operator', minRuns: 0 },
  eligible: { kind: 'shadow', minRuns: 20 },
  active: { kind: 'operator', minRuns: 0 },
};

export function promote(m: AdmittedMacro, to: LifecycleState, evidence: AdmissionEvidence | null): { ok: true; macro: AdmittedMacro } | { ok: false; reason: string } {
  if (to === 'deprecated') return { ok: true, macro: { ...m, state: 'deprecated', admission: evidence ? [...m.admission, evidence] : m.admission } };
  if (NEXT[m.state] !== to) return { ok: false, reason: `ASG_PROMOTION_NOT_NEXT: ${m.state} → ${to}` };
  const req = REQUIRED_KIND[to]!;
  if (!evidence) return { ok: false, reason: 'ASG_PROMOTION_NO_EVIDENCE' };
  if (evidence.gate !== to || evidence.kind !== req.kind) return { ok: false, reason: `ASG_PROMOTION_WRONG_EVIDENCE: need ${req.kind} for ${to}` };
  if (req.split && evidence.split !== req.split) return { ok: false, reason: `ASG_PROMOTION_WRONG_SPLIT: need ${req.split}` };
  if (evidence.runs < req.minRuns) return { ok: false, reason: `ASG_PROMOTION_TOO_FEW_RUNS: ${evidence.runs} < ${req.minRuns}` };
  if (evidence.invariant_violations > 0) return { ok: false, reason: 'ASG_PROMOTION_INVARIANT_VIOLATIONS' };
  if (req.kind !== 'operator' && evidence.verified < evidence.runs) return { ok: false, reason: `ASG_PROMOTION_NOT_ALL_VERIFIED: ${evidence.verified}/${evidence.runs}` };
  return { ok: true, macro: { ...m, state: to, admission: [...m.admission, evidence] } };
}

/** Learned applicability rules must carry train-split provenance; anything else is refused. */
export function admitApplicabilityRule(r: ApplicabilityRule): { ok: boolean; reason?: string } {
  if (!r.provenance || r.provenance.split !== 'train' || !r.provenance.derived_from_runs?.length || !r.provenance.created_by) return { ok: false, reason: 'ASG_RULE_PROVENANCE_REQUIRED' };
  return { ok: true };
}
