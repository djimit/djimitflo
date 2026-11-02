import { ContractRegistry, sha256, type MacroContract, type ObjectSchema } from './contract';
import { AsgError, type CapabilityGate, type FsWorkspace } from './effects';

/**
 * The three ASG-001 v1 macros. Chosen for the oracle lanes (test-gap: add one test file; mutation: strengthen one test file)
 * because those changes are test-only, single-file and locally verifiable by one targeted test command, and because the
 * remaining maker tool-loop cost after environment bootstrap is "repeated verification" (docs/research/di-001/MAKER_FAILURES.md
 * §3: edit test → run targeted test → re-edit). No publish, deploy, merge, install or network procedure is a macro.
 * Frequency from prod tool-call traces is NOT confirmed (the read-only trace query, docs/research/asg-001/trace-mine.js, was
 * not run: prod reads were not authorised in this session). All three start as lifecycle 'candidate'.
 */

const SRC = '^[A-Za-z0-9_][A-Za-z0-9_./@-]*\\.(m?[jt]s|tsx?)$';
export const TEST_PATH_PATTERN = '^(?=[A-Za-z0-9_])(?:[A-Za-z0-9_./@-]*__tests__/[A-Za-z0-9_.@-]+\\.(?:m?[jt]s|tsx?)|[A-Za-z0-9_./@-]*\\.(?:test|spec)\\.(?:m?[jt]s|tsx?))$';
const HEX = '^[0-9a-f]{64}$';
const obj = (required: string[], properties: ObjectSchema['properties']): ObjectSchema => ({ type: 'object', required, properties, additionalProperties: false });
const LINEAGE = {
  derived_from: 'hand-written from trace analysis (docs/research/di-001/MAKER_FAILURES.md §1, §3) and the oracle-lane proposal shape (test-gap-source-service.ts grounding: target, artifactPath, acceptanceTest)',
  evidence_refs: ['docs/research/di-001/MAKER_FAILURES.md#3-dominant-cause-environment-bootstrap-inside-the-makers-tool-loop', 'arXiv:2610.31461v1#4.5'],
  skill_card_refs: [] as string[], parent: null,
};
const RECOVERABLE_EDIT = {
  precondition_mismatch: { recoverable: true }, partial_effect: { recoverable: true }, validation_failure: { recoverable: true },
  tool_schema: { recoverable: true }, executor_exception: { recoverable: true }, timeout_uncertain: { recoverable: true },
} as const;
const VERIFY_OUT = obj(['written_digest', 'passed', 'verifier_exit'], { written_digest: { type: 'string', pattern: HEX }, passed: { type: 'boolean' }, verifier_exit: { type: 'number' } });

export const INSPECT_TARGET_MODULE: MacroContract = {
  skill_id: 'asg:inspect_target_module', version: 1, lanes: ['test-gap', 'mutation'],
  summary: 'Read one source module and report its exported names, size and digest. Read-only.',
  input_schema: obj(['source_path'], { source_path: { type: 'string', pattern: SRC, maxLength: 300 } }),
  output_schema: obj(['exists', 'loc', 'sha256', 'exports'], { exists: { type: 'boolean' }, loc: { type: 'number' }, sha256: { type: 'string', pattern: HEX }, exports: { type: 'string', maxLength: 2000 } }),
  preconditions: [{ id: 'source_exists', check: 'path_exists', path: 'source_path' }],
  effects: { read: ['${source_path}'], write: [], exec: [] },
  required_capabilities: ['read'], runtime_compat: ['asg-harness'],
  postconditions: [{ id: 'schema', check: 'output_schema' }, { id: 'no_change', check: 'workspace_unchanged' }],
  verifier_ref: 'none:read_only', timeout_ms: 5_000, budget_units: 1,
  failure_taxonomy: { precondition_mismatch: { recoverable: true }, tool_schema: { recoverable: true }, executor_exception: { recoverable: true }, timeout_uncertain: { recoverable: true } },
  idempotency: { idempotent: true, key_fields: ['source_path'], compensation: 'none' },
  micro_fallback: { allowed: true, required_context: ['failure_class', 'source_path'], hint: 'read the module with read_file' },
  lineage: LINEAGE,
};

export const WRITE_TEST_FILE_AND_VERIFY: MacroContract = {
  skill_id: 'asg:write_test_file_and_verify', version: 1, lanes: ['test-gap'],
  summary: 'Create one new test file with the given content, then run the targeted test for that file.',
  input_schema: obj(['test_path', 'source_path', 'content'], { test_path: { type: 'string', pattern: TEST_PATH_PATTERN, maxLength: 300 }, source_path: { type: 'string', pattern: SRC, maxLength: 300 }, content: { type: 'string', maxLength: 20_000 } }),
  output_schema: VERIFY_OUT,
  preconditions: [
    { id: 'test_is_test_path', check: 'path_matches', path: 'test_path', pattern: TEST_PATH_PATTERN },
    { id: 'test_absent', check: 'path_absent', path: 'test_path' }, // never overwrites an existing (or user) file
    { id: 'source_exists', check: 'path_exists', path: 'source_path' },
  ],
  effects: { read: ['${source_path}'], write: ['${test_path}'], exec: ['verifier:target_test'] },
  required_capabilities: ['read', 'write:test', 'exec:verifier'], runtime_compat: ['asg-harness'],
  postconditions: [{ id: 'schema', check: 'output_schema' }, { id: 'digest', check: 'file_digest_equals_output', path: 'test_path', output: 'written_digest' }, { id: 'test_passes', check: 'verifier_passes' }],
  verifier_ref: 'verifier:target_test', timeout_ms: 60_000, budget_units: 1,
  failure_taxonomy: RECOVERABLE_EDIT,
  idempotency: { idempotent: true, key_fields: ['test_path', 'content'], compensation: 'restore_preimage' },
  micro_fallback: { allowed: true, required_context: ['failure_class', 'observed_effects', 'test_path', 'verifier_output', 'remaining_budget'], hint: 'repair the test file in place from its current content; never delete or rewrite other files' },
  lineage: LINEAGE,
};

export const REPLACE_IN_TEST_AND_VERIFY: MacroContract = {
  skill_id: 'asg:replace_in_test_and_verify', version: 1, lanes: ['mutation'],
  summary: 'Replace exactly one occurrence of a text in one unchanged test file, then run the targeted test for that file.',
  input_schema: obj(['test_path', 'find', 'replace', 'base_digest'], { test_path: { type: 'string', pattern: TEST_PATH_PATTERN, maxLength: 300 }, find: { type: 'string', maxLength: 2_000 }, replace: { type: 'string', maxLength: 4_000 }, base_digest: { type: 'string', pattern: HEX } }),
  output_schema: VERIFY_OUT,
  preconditions: [
    { id: 'test_is_test_path', check: 'path_matches', path: 'test_path', pattern: TEST_PATH_PATTERN },
    { id: 'test_exists', check: 'path_exists', path: 'test_path' },
    { id: 'unchanged_since_base', check: 'digest_equals', path: 'test_path', digest: 'base_digest' }, // protects user changes
    { id: 'find_once', check: 'text_occurs_once', path: 'test_path', text: 'find' },
  ],
  effects: { read: ['${test_path}'], write: ['${test_path}'], exec: ['verifier:target_test'] },
  required_capabilities: ['read', 'write:test', 'exec:verifier'], runtime_compat: ['asg-harness'],
  postconditions: [{ id: 'schema', check: 'output_schema' }, { id: 'digest', check: 'file_digest_equals_output', path: 'test_path', output: 'written_digest' }, { id: 'test_passes', check: 'verifier_passes' }],
  verifier_ref: 'verifier:target_test', timeout_ms: 60_000, budget_units: 1,
  failure_taxonomy: RECOVERABLE_EDIT,
  idempotency: { idempotent: false, key_fields: ['test_path', 'find', 'replace', 'base_digest'], compensation: 'restore_preimage' },
  micro_fallback: { allowed: true, required_context: ['failure_class', 'observed_effects', 'test_path', 'verifier_output', 'remaining_budget'], hint: 'continue from the current file content; the replacement may already be applied' },
  lineage: LINEAGE,
};

export const ASG_MACROS: readonly MacroContract[] = [INSPECT_TARGET_MODULE, WRITE_TEST_FILE_AND_VERIFY, REPLACE_IN_TEST_AND_VERIFY];

export function defaultRegistry(): ContractRegistry {
  const r = new ContractRegistry();
  for (const c of ASG_MACROS) r.register(c, 'candidate');
  return r;
}

export interface VerifyResult { passed: boolean; exit: number; output: string }
export interface MacroCtx { ws: FsWorkspace; gate: CapabilityGate; verify: (testPath: string) => VerifyResult; write: (p: string, content: string) => void }
export type Procedure = (input: Record<string, unknown>, ctx: MacroCtx) => Record<string, unknown>;

const exportsOf = (src: string): string[] => [...src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);

export const PROCEDURES: Record<string, Procedure> = {
  'asg:inspect_target_module@1': (input, { ws }) => {
    const src = ws.read(String(input.source_path));
    if (src === null) throw new AsgError('precondition_mismatch', 'source module is absent');
    return { exists: true, loc: src.split('\n').length, sha256: sha256(src), exports: exportsOf(src).join(',').slice(0, 2000) };
  },
  'asg:write_test_file_and_verify@1': (input, ctx) => {
    const p = String(input.test_path); const content = String(input.content);
    ctx.write(p, content);
    const v = ctx.verify(p);
    return { written_digest: sha256(content), passed: v.passed, verifier_exit: v.exit };
  },
  'asg:replace_in_test_and_verify@1': (input, ctx) => {
    const p = String(input.test_path); const cur = ctx.ws.read(p);
    if (cur === null) throw new AsgError('precondition_mismatch', 'test file is absent');
    const parts = cur.split(String(input.find));
    if (parts.length !== 2) throw new AsgError('precondition_mismatch', `find text occurs ${parts.length - 1} times`);
    const next = parts.join(String(input.replace));
    ctx.write(p, next);
    const v = ctx.verify(p);
    return { written_digest: sha256(next), passed: v.passed, verifier_exit: v.exit };
  },
};
