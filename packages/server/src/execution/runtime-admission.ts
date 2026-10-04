import { createHash } from 'crypto';

/**
 * Runtime admission (reports/runtime-admission-20261001). A registered executor is not an admitted one: before the engine
 * hands a task to a runtime, the runtime@version must hold an evidence-backed assessment in this ledger. The ledger lives in
 * the repo, so an assessment changes only through review — a runtime never attests itself (task metadata, runtime output
 * and runtime logs are not read here). RuntimeCommandService's contract probe stays the *availability/interface* check; this
 * is the *may we use it at all* check (licence, reproducibility, authority, containment, lifecycle, evidence, supply chain,
 * capability gap, gym). Decisions are deterministic: a critical FAIL can never be outweighed by passes elsewhere.
 */
export type GateStatus = 'PASS' | 'FAIL' | 'NOT_PROVEN';
export type AdmissionDecision = 'ADMIT' | 'CONDITIONAL' | 'HOLD' | 'REJECT' | 'LEGACY_ADMITTED';
export type AuthorityOwner = 'DJIMITFLO' | 'RUNTIME' | 'SHARED' | 'UNKNOWN';

export const GATES = ['licensing', 'reproducibility', 'interface', 'containment', 'lifecycle', 'evidence', 'supply_chain', 'gym_evidence'] as const;
export const AUTHORITIES = ['task', 'policy', 'approval', 'evidence', 'canonical_memory', 'worker_lifecycle', 'capability_registry', 'promotion'] as const;
const CRITICAL_GATES: Gate[] = ['licensing', 'reproducibility', 'supply_chain'];
const EXECUTABLE: AdmissionDecision[] = ['ADMIT', 'CONDITIONAL', 'LEGACY_ADMITTED'];

export type Gate = typeof GATES[number];
export type Authority = typeof AUTHORITIES[number];
export interface GateResult { status: GateStatus; evidence_refs: string[]; note?: string }

export interface RuntimeAdmissionAssessment {
  runtime_id: string;
  /** Exact artifact version admitted; null = not version-bound, allowed only for LEGACY_ADMITTED. */
  runtime_version: string | null;
  artifact_sha256?: string;
  source_revision: string | null;
  assessment_timestamp: string;
  /** Who assessed. Never the runtime itself. */
  assessed_by: string;
  gates: Record<Gate, GateResult>;
  authority: Record<Authority, AuthorityOwner>;
  /** NONE, children only via Djimitflo's NestedSpawnService, children inside the runtime invisible to Djimitflo, or unknown. */
  child_agents: 'NONE' | 'DJIMITFLO_GATED' | 'RUNTIME_INTERNAL' | 'UNKNOWN';
  capability_gap: { status: 'PROVEN' | 'INCUMBENT' | 'NONE' | 'NOT_PROVEN'; description: string; evidence_refs: string[] };
  /** Restrictions an admission holds under; each must name the mechanism that enforces it. */
  conditions?: string[];
  /** Explicit, expiring migration status for incumbents whose full evidence does not exist yet. Never masks a critical FAIL. */
  legacy?: { reason: string; migration: string[] };
  reassessment_triggers: string[];
  expires_at: string;
}

export interface AdmissionVerdict { decision: AdmissionDecision; blocked_reasons: string[] }

export function decide(a: RuntimeAdmissionAssessment): AdmissionVerdict {
  const critical: string[] = [];
  const unproven: string[] = [];
  if (a.assessed_by.trim().toLowerCase() === a.runtime_id.trim().toLowerCase()) critical.push('self-attested assessment');
  for (const g of GATES) {
    const r = a.gates[g];
    // a PASS without evidence is a claim, not a proof
    const status: GateStatus = r?.status === 'PASS' && !r.evidence_refs.length ? 'NOT_PROVEN' : r?.status ?? 'NOT_PROVEN';
    if (status === 'FAIL' && CRITICAL_GATES.includes(g)) critical.push(`${g}: FAIL`);
    else if (status !== 'PASS') unproven.push(`${g}: ${status}`);
  }
  for (const k of AUTHORITIES) {
    const owner = a.authority[k] ?? 'UNKNOWN';
    if (owner === 'RUNTIME' || owner === 'SHARED') critical.push(`authority.${k}: ${owner}`);
    else if (owner === 'UNKNOWN') unproven.push(`authority.${k}: UNKNOWN`);
  }
  if (a.child_agents === 'RUNTIME_INTERNAL' || a.child_agents === 'UNKNOWN') unproven.push(`child_agents: ${a.child_agents}`);
  if (a.capability_gap.status === 'NONE') critical.push('capability_gap: NONE');
  else if (a.capability_gap.status === 'NOT_PROVEN' || !a.capability_gap.evidence_refs.length) unproven.push('capability_gap: NOT_PROVEN');
  if (a.runtime_version === null) unproven.push('runtime_version: not bound');
  if (critical.length) return { decision: 'REJECT', blocked_reasons: [...critical, ...unproven] };
  if (unproven.length) return { decision: a.legacy ? 'LEGACY_ADMITTED' : 'HOLD', blocked_reasons: unproven };
  return { decision: a.conditions?.length ? 'CONDITIONAL' : 'ADMIT', blocked_reasons: [] };
}

/** Content hash of an assessment: the admission evidence names exactly which record allowed or denied a run. */
export function assessmentRef(a: RuntimeAdmissionAssessment): string {
  return `${a.runtime_id}@${a.runtime_version ?? 'unpinned'}#${createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0, 12)}`;
}

/** Same version when the pinned semver appears as a whole token in the observed version string ('codex-cli 0.146.0'). */
export function versionMatches(pinned: string, observed: string): boolean {
  return (observed.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/g) ?? ([] as string[])).includes(pinned);
}

export interface AdmissionCheck {
  allowed: boolean;
  decision: AdmissionDecision | 'UNKNOWN_RUNTIME';
  ref: string | null;
  reasons: string[];
  version_bound: boolean;
}

export function checkAdmission(runtimeId: string, observedVersion: string | null, now = Date.now(),
  ledger: readonly RuntimeAdmissionAssessment[] = RUNTIME_ADMISSIONS): AdmissionCheck {
  const records = ledger.filter((a) => a.runtime_id === runtimeId);
  if (!records.length) return { allowed: false, decision: 'UNKNOWN_RUNTIME', ref: null, reasons: [`no admission record for runtime '${runtimeId}'`], version_bound: false };
  // several records = one per admitted version; prefer the one matching what actually runs
  const record = (observedVersion && records.find((a) => a.runtime_version && versionMatches(a.runtime_version, observedVersion))) || records[0];
  const { decision, blocked_reasons } = decide(record);
  const ref = assessmentRef(record);
  const deny = (reason: string): AdmissionCheck => ({ allowed: false, decision, ref, reasons: [reason, ...blocked_reasons], version_bound: Boolean(record.runtime_version) });
  if (!EXECUTABLE.includes(decision)) return deny(`admission ${decision}`);
  if (!(Date.parse(record.expires_at) > now)) return deny(`admission expired at ${record.expires_at}`);
  if (record.runtime_version) {
    if (observedVersion && !versionMatches(record.runtime_version, observedVersion)) return deny(`runtime drift: admitted ${record.runtime_version}, observed '${observedVersion.slice(0, 80)}'`);
    if (!observedVersion && decision !== 'LEGACY_ADMITTED') return deny(`runtime version not observed; admission is bound to ${record.runtime_version}`);
  }
  const notes = record.runtime_version && !observedVersion ? ['version not observed (no runtime contract probe yet)'] : [];
  return { allowed: true, decision, ref, reasons: [...notes, ...blocked_reasons], version_bound: Boolean(record.runtime_version) };
}

/** Admissions that expire within `days` (stall watch warns before an expiry silently stops work). */
export function expiringAdmissions(now = Date.now(), days = 30, ledger: readonly RuntimeAdmissionAssessment[] = RUNTIME_ADMISSIONS): RuntimeAdmissionAssessment[] {
  return ledger.filter((a) => EXECUTABLE.includes(decide(a).decision) && Date.parse(a.expires_at) - now < days * 86_400_000);
}

// ─── Ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const NP = (note: string): GateResult => ({ status: 'NOT_PROVEN', evidence_refs: [], note });
const P = (note: string, ...evidence_refs: string[]): GateResult => ({ status: 'PASS', evidence_refs, note });
const F = (note: string, ...evidence_refs: string[]): GateResult => ({ status: 'FAIL', evidence_refs, note });
const DJIMITFLO_OWNS_ALL: Record<Authority, AuthorityOwner> = { task: 'DJIMITFLO', policy: 'DJIMITFLO', approval: 'DJIMITFLO', evidence: 'DJIMITFLO', canonical_memory: 'DJIMITFLO', worker_lifecycle: 'DJIMITFLO', capability_registry: 'DJIMITFLO', promotion: 'DJIMITFLO' };
const ENGINE_GATES = 'packages/server/src/execution/execution-engine.ts (risk → policy → governance gate → approval before dispatch)';
const LEGACY_EXPIRY = '2026-12-31T00:00:00Z';
const LEGACY_MIGRATION = [
  'G1 licence of the runtime and its dependencies recorded with evidence',
  'G2/G8 artifact pinned in the Dockerfile by version and checksum held in this repo',
  'G5 network egress of runtime child processes scoped (today only in-process fetch is guarded by OUTBOUND_DENY_HOSTS)',
  'G7 structured events or diff-only evidence recorded per run',
  'G10 gym outcomes compared with the incumbent maker',
];
const TRIGGERS = ['runtime version changed', 'dependency graph changed', 'licence changed', 'binary checksum changed', 'security advisory for the runtime',
  'Djimitflo policy or capability contract changed', 'gym regression versus the incumbent', 'executor landscape changed', 'admission expired'];

function legacy(runtime_id: string, runtime_version: string | null, reason: string, gates: Partial<Record<Gate, GateResult>> = {},
  child_agents: RuntimeAdmissionAssessment['child_agents'] = 'UNKNOWN'): RuntimeAdmissionAssessment {
  return {
    runtime_id, runtime_version, source_revision: null, assessment_timestamp: '2026-10-01T00:00:00Z', assessed_by: 'djimitflo-operator-loop',
    gates: {
      licensing: NP('not yet assessed'), reproducibility: NP('not yet assessed'), interface: NP('not yet assessed'),
      containment: NP('worktree cwd + env allowlist (executors/executor-env.ts) + wall timeout enforced by Djimitflo; network egress not scoped'),
      lifecycle: NP('not yet assessed'), evidence: NP('not yet assessed'), supply_chain: NP('not yet assessed'), gym_evidence: NP('no gym outcomes'),
      ...gates,
    },
    authority: DJIMITFLO_OWNS_ALL, child_agents,
    capability_gap: { status: 'INCUMBENT', description: 'registered executor in production before runtime admission existed', evidence_refs: [ENGINE_GATES] },
    legacy: { reason, migration: LEGACY_MIGRATION }, reassessment_triggers: TRIGGERS, expires_at: LEGACY_EXPIRY,
  };
}

const OPENHUMAN_REPORTS = 'reports/openhuman-20261001/OPENHUMAN_VERIFICATION_REPORT.md';

export const RUNTIME_ADMISSIONS: readonly RuntimeAdmissionAssessment[] = [
  // Positive control: the incumbent maker. Licence, pin, authority, interface, lifecycle and gym are evidenced; containment
  // (network egress, opencode's own subagents) is not — so it runs as LEGACY_ADMITTED, bound to the pinned version.
  legacy('opencode', '1.18.10', 'incumbent maker/checker; containment of network egress and internal subagents not proven', {
    licensing: P('MIT; npm package and its only dependencies (per-platform opencode-* binaries of the same release) MIT', 'gh api repos/sst/opencode: MIT', 'npm view opencode-ai@1.18.10 license: MIT'),
    reproducibility: P('public source; exact version pinned; registry integrity sha512', 'Dockerfile: npm install --global opencode-ai@1.18.10', 'npm view opencode-ai@1.18.10 dist.integrity'),
    interface: P('headless run with --format json events, --dir cwd, usage parsing', 'packages/server/src/services/runtime-command-service.ts getRuntimeContract (conformance checks)'),
    lifecycle: P('wall-clock timeout and kill, token brake per run, stop/cancel via engine', 'packages/server/src/execution/executors/opencode-executor.ts (OPENCODE_MAX_RUN_TOKENS)', 'packages/server/src/__tests__/loop-runtime-stop.test.ts'),
    evidence: P('diff, checks, JSON events and token usage recorded by Djimitflo, not taken from runtime logs', 'worker manifests (runtime_contract gate ref)', 'skill_outcomes'),
    supply_chain: NP('npm registry integrity only; no provenance attestation published for opencode-ai@1.18.10; global install has no lockfile'),
    gym_evidence: P('gym 15 outcomes / 40–50 % success; 12 verified real makers in 14 d (plan Phase Y, 30-09)', 'skill_outcomes domain gym + loop'),
  }, 'RUNTIME_INTERNAL'),
  legacy('atomic', '0.6.5', 'gym maker on the local model; plain-text interface, diff is the only evidence', {
    licensing: P('MIT', 'gh api repos/AtomicBot-ai/atomic-agent: MIT'),
    reproducibility: P('release tarball pinned by version + sha256 held in this repo', 'Dockerfile ATOMIC_AGENT_VERSION / ATOMIC_AGENT_SHA256_*'),
    supply_chain: P('checksum stored in this repo at review time (independent of a later swap at the release origin)', 'Dockerfile sha256sum -c'),
    interface: NP('no structured output; goal on stdin, plain text on stdout (RuntimeContract json_flag empty)'),
    gym_evidence: P('gym 126 outcomes / 87–90 % on the workstation R9700 (plan Phase Y)', 'skill_outcomes species atomic@llama-router'),
  }),
  legacy('codex', '0.146.0', 'registered executor; not used by the loops in prod', {
    licensing: P('Apache-2.0', 'gh api repos/openai/codex: Apache-2.0'),
    reproducibility: P('npm version pinned', 'Dockerfile: npm install --global @openai/codex@0.146.0'),
  }),
  legacy('claude', '2.1.282', 'registered executor; CLI needs an operator login in the container', {
    reproducibility: P('npm version pinned', 'Dockerfile: npm install --global @anthropic-ai/claude-code@2.1.282'),
  }),
  legacy('remote', null, 'workstation pull maker (plan I3); the patch passes the VPS gates; the runtime on the host is atomic', {
    containment: NP('runs on the workstation outside the VPS; only its patch enters Djimitflo, through the normal gates'),
    gym_evidence: P('remote gym on the workstation (plan I1)', 'skill_outcomes remote:workstation'),
  }, 'NONE'),
  legacy('mock', null, 'deterministic demo/test runtime; makes no real changes (W1 label)', {}, 'NONE'),
  legacy('hermes', null, 'registered executor'),
  legacy('gemini', null, 'registered executor'),
  legacy('editor', null, 'registered executor'),
  legacy('pi', null, 'registered executor'),
  legacy('deep-agent', null, 'sovereign runtime with its own assurance hold (EVE-V)'),
  // Negative control: the 2026-10-01 falsification. Findings copied from the report, not re-judged.
  {
    runtime_id: 'openhuman', runtime_version: null, source_revision: 'tinyhumansai/openhuman@0e703ed4d583cc78e10e7c441ea632c5f3000816',
    assessment_timestamp: '2026-10-01T12:00:00Z', assessed_by: 'djimitflo-operator-loop',
    gates: {
      licensing: F('GPL-3.0 core and submodules; Djimitflo is MIT; tinyhumans-sdk not public', OPENHUMAN_REPORTS),
      reproducibility: F('18 submodules required, one private (tinyhumans-sdk 404); embed crate unpublished', OPENHUMAN_REPORTS),
      interface: F('embed API is Rust-only; no Node binding; no turn-level cancel or timeout', OPENHUMAN_REPORTS),
      containment: NP('SecurityPolicy off by default; sandbox lives in an unfetched submodule'),
      lifecycle: F('no turn-level cancel/timeout in the embed API', OPENHUMAN_REPORTS),
      evidence: NP('own AuditLogger and run ledger; Djimitflo capture not designed'),
      supply_chain: F('npm postinstall downloads a binary whose checksum comes from the same origin', OPENHUMAN_REPORTS),
      gym_evidence: NP('not buildable; no gym run'),
    },
    authority: { task: 'RUNTIME', policy: 'RUNTIME', approval: 'RUNTIME', evidence: 'RUNTIME', canonical_memory: 'RUNTIME', worker_lifecycle: 'RUNTIME', capability_registry: 'UNKNOWN', promotion: 'RUNTIME' },
    child_agents: 'RUNTIME_INTERNAL',
    capability_gap: { status: 'NONE', description: 'no capability the 11 existing executors lack that an oracle lane needs', evidence_refs: ['reports/openhuman-20261001/OPENHUMAN_FIT_GAP.md'] },
    reassessment_triggers: ['licence-compatible public interface', 'reproducible public build', 'machine API with cancellation',
      'authority duplication can be disabled and proven absent', 'demonstrated Djimitflo capability gap'],
    expires_at: '2027-04-01T00:00:00Z',
  },
];
