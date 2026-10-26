import { canonicalJson, contractDigest, matchesAny, sha256, type AdmittedMacro, type ContractRegistry, type LifecycleState } from './contract';
import { safeWorkspacePath, type FsWorkspace } from './effects';

/**
 * ASG-001 deterministic router. It sees only decision-time information: the task spec (prompt, lane, declared targets and
 * writes, capability, runtime) and the initial workspace state of the declared targets. The spec type has no field for the
 * verifier, hidden tests, other arms or results, so they cannot leak in; asg-router.test.ts checks that the decision is a
 * pure function of these inputs. A policy refusal is STOP (never a MICRO detour); an insufficient contract match is MICRO
 * within the same permissions.
 */
export type Route = 'MICRO' | 'MACRO' | 'HYBRID' | 'STOP';
export type Lane = 'test-gap' | 'mutation' | 'other';

export interface AsgTaskSpec {
  task_id: string;
  lane: Lane;
  prompt: string;
  targets: { source_path: string | null; test_path: string | null };
  /** every path the task says it changes */
  declared_writes: string[];
  capability: { write: string[] };
  runtime: string;
  runtime_has_macro_adapter: boolean;
}

export const FEATURE_SCHEMA = {
  lane: 'test-gap|mutation|other', n_declared_writes: 'int', declared_writes_safe: 'bool', declared_writes_in_capability: 'bool',
  source_exists: 'bool', source_loc: 'int|null', source_export_count: 'int|null', test_exists: 'bool', test_loc: 'int|null',
  prompt_chars: 'int', prompt_says_strengthen: 'bool', runtime: 'string', runtime_has_macro_adapter: 'bool',
} as const;
export type Features = { [K in keyof typeof FEATURE_SCHEMA]: string | number | boolean | null };
export const FEATURE_SCHEMA_HASH = sha256(canonicalJson(FEATURE_SCHEMA)).slice(0, 16);

export const POLICY_VERSION = 1;
/** The rules in order; their text is hashed into every decision (policy_hash). Changing a rule = new version + new hash. */
export const POLICY_RULES = [
  'R1 STOP POLICY_REFUSAL if a declared write is not a safe workspace path or not inside the task capability',
  'R2 MICRO RUNTIME_NO_MACRO_ADAPTER if the runtime cannot execute macro contracts',
  'R3 MICRO MULTI_TARGET if the task declares other than exactly one write',
  'R4 candidates: test-gap → write_test_file_and_verify when the test is absent and the source exists; mutation → replace_in_test_and_verify when the test exists',
  'R5 drop a candidate whose resolved write set is not inside the capability, whose runtime_compat lacks the runtime, whose lifecycle is not executable here, or whose budget exceeds the remaining budget',
  'R6 MICRO NO_CONTRACT_MATCH if no candidate is left',
  'R7 HYBRID MACRO_WITH_RECOVERY if the contract allows micro fallback, else MACRO MACRO_CONTRACT_MATCH',
] as const;
export const POLICY_HASH = sha256(canonicalJson({ v: POLICY_VERSION, rules: POLICY_RULES })).slice(0, 16);

export interface SkillRef { skill_id: string; version: number; digest: string; state: LifecycleState }
export interface RouteDecision {
  policy: { id: 'asg-policy'; version: number; hash: string };
  feature_schema_hash: string;
  features: Features;
  route: Route;
  reason_codes: string[];
  skill: SkillRef | null;
  /** the prefix macro (read-only inspect) available in the MACRO/HYBRID envelope */
  prefix: SkillRef | null;
  alternatives: Array<{ route: Route; skill: string | null; reason: string }>;
}

const lines = (s: string | null): number | null => (s === null ? null : s.split('\n').length);

export function extractFeatures(spec: AsgTaskSpec, ws: FsWorkspace): Features {
  const safe = spec.declared_writes.every((p) => safeWorkspacePath(p));
  const src = spec.targets.source_path && safeWorkspacePath(spec.targets.source_path) ? ws.read(spec.targets.source_path) : null;
  const test = spec.targets.test_path && safeWorkspacePath(spec.targets.test_path) ? ws.read(spec.targets.test_path) : null;
  return {
    lane: spec.lane, n_declared_writes: spec.declared_writes.length, declared_writes_safe: safe,
    declared_writes_in_capability: safe && spec.declared_writes.every((p) => matchesAny(p, spec.capability.write)),
    source_exists: src !== null, source_loc: lines(src),
    source_export_count: src === null ? null : [...src.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|class)\b/g)].length,
    test_exists: test !== null, test_loc: lines(test),
    prompt_chars: spec.prompt.length, prompt_says_strengthen: /\b(strengthen|kill|mutant|stronger)\b/i.test(spec.prompt),
    runtime: spec.runtime, runtime_has_macro_adapter: spec.runtime_has_macro_adapter,
  };
}

export interface RouteOptions {
  /** lifecycle states whose contracts may execute here; prod = eligible/active only, the evaluation harness = any */
  executableStates: ReadonlyArray<LifecycleState>;
  remainingBudget: number;
}

const ref = (m: AdmittedMacro): SkillRef => ({ skill_id: m.contract.skill_id, version: m.contract.version, digest: m.digest, state: m.state });

export function decideRoute(spec: AsgTaskSpec, features: Features, registry: ContractRegistry, opts: RouteOptions): RouteDecision {
  const base = { policy: { id: 'asg-policy' as const, version: POLICY_VERSION, hash: POLICY_HASH }, feature_schema_hash: FEATURE_SCHEMA_HASH, features };
  const done = (route: Route, reason: string, skill: AdmittedMacro | null, alternatives: RouteDecision['alternatives'] = []): RouteDecision => {
    const inspect = registry.get('asg:inspect_target_module');
    const prefix = skill && inspect && opts.executableStates.includes(inspect.state) ? ref(inspect) : null;
    return { ...base, route, reason_codes: [reason], skill: skill ? ref(skill) : null, prefix, alternatives };
  };
  if (!features.declared_writes_safe || !features.declared_writes_in_capability) return done('STOP', 'POLICY_REFUSAL', null);
  if (!features.runtime_has_macro_adapter) return done('MICRO', 'RUNTIME_NO_MACRO_ADAPTER', null, [{ route: 'HYBRID', skill: null, reason: 'needs a runtime with a macro adapter' }]);
  if (features.n_declared_writes !== 1) return done('MICRO', 'MULTI_TARGET', null);
  const wanted = spec.lane === 'test-gap' && !features.test_exists && features.source_exists ? 'asg:write_test_file_and_verify'
    : spec.lane === 'mutation' && features.test_exists ? 'asg:replace_in_test_and_verify' : null;
  const alternatives: RouteDecision['alternatives'] = [];
  const m = wanted ? registry.get(wanted) : undefined;
  if (!m) return done('MICRO', 'NO_CONTRACT_MATCH', null, [{ route: 'HYBRID', skill: wanted, reason: wanted ? 'not registered' : 'no contract for this lane/state' }]);
  const input = { test_path: spec.targets.test_path, source_path: spec.targets.source_path };
  const writes = m.contract.effects.write.map((t) => t.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_x, k: string) => String((input as Record<string, unknown>)[k] ?? '')));
  const reject = !writes.every((p) => safeWorkspacePath(p) && matchesAny(p, spec.capability.write) && spec.declared_writes.includes(p)) ? 'CONTRACT_EFFECTS_EXCEED_CAPABILITY'
    : !m.contract.runtime_compat.includes(spec.runtime) ? 'RUNTIME_NOT_COMPATIBLE'
    : !opts.executableStates.includes(m.state) ? `LIFECYCLE_NOT_EXECUTABLE:${m.state}`
    : m.contract.budget_units > opts.remainingBudget ? 'CONTRACT_BUDGET_EXCEEDS_REMAINING'
    : contractDigest(m.contract) !== m.digest ? 'CONTRACT_DIGEST_MISMATCH' : null;
  if (reject) { alternatives.push({ route: 'HYBRID', skill: m.contract.skill_id, reason: reject }); return done('MICRO', 'NO_CONTRACT_MATCH', null, alternatives); }
  alternatives.push({ route: 'MICRO', skill: null, reason: 'always admissible within the same permissions' });
  return m.contract.micro_fallback.allowed ? done('HYBRID', 'MACRO_WITH_RECOVERY', m, alternatives) : done('MACRO', 'MACRO_CONTRACT_MATCH', m, alternatives);
}
