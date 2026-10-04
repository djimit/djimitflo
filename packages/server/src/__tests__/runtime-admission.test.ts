import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import {
  AUTHORITIES, GATES, RUNTIME_ADMISSIONS, assessmentRef, checkAdmission, decide, expiringAdmissions,
  type RuntimeAdmissionAssessment,
} from '../execution/runtime-admission';
import { detectStalls } from '../services/stall-watch';

const NOW = Date.parse('2026-10-01T12:00:00Z');

/** A fully evidenced, version-bound candidate: the only shape that may reach ADMIT. */
function admitted(over: Partial<RuntimeAdmissionAssessment> = {}): RuntimeAdmissionAssessment {
  return {
    runtime_id: 'candidate', runtime_version: '1.2.3', source_revision: 'abc', assessment_timestamp: '2026-10-01T00:00:00Z', assessed_by: 'operator',
    gates: Object.fromEntries(GATES.map((g) => [g, { status: 'PASS', evidence_refs: [`evidence:${g}`] }])) as RuntimeAdmissionAssessment['gates'],
    authority: Object.fromEntries(AUTHORITIES.map((a) => [a, 'DJIMITFLO'])) as RuntimeAdmissionAssessment['authority'],
    child_agents: 'NONE',
    capability_gap: { status: 'PROVEN', description: 'beats the incumbent on the holdout', evidence_refs: ['gym:holdout'] },
    reassessment_triggers: ['runtime version changed'], expires_at: '2027-01-01T00:00:00Z',
    ...over,
  };
}
const gate = (a: RuntimeAdmissionAssessment, g: typeof GATES[number], status: 'PASS' | 'FAIL' | 'NOT_PROVEN', refs = ['x']) =>
  ({ ...a, gates: { ...a.gates, [g]: { status, evidence_refs: refs } } });
const check = (a: RuntimeAdmissionAssessment, observed: string | null = '1.2.3', now = NOW) => checkAdmission(a.runtime_id, observed, now, [a]);

describe('decision algebra', () => {
  it('positive control (synthetic): a fully evidenced, version-bound runtime with a proven gap is ADMITted', () => {
    expect(decide(admitted())).toEqual({ decision: 'ADMIT', blocked_reasons: [] });
    expect(check(admitted()).allowed).toBe(true);
    expect(decide(admitted({ conditions: ['gym only (EVOLUTION_GYM_EXTRA_SPECIES)'] })).decision).toBe('CONDITIONAL');
  });

  it.each(['licensing', 'reproducibility', 'supply_chain'] as const)('RA-04/RA-07: %s FAIL rejects even when every other gate passes', (g) => {
    expect(decide(gate(admitted(), g, 'FAIL')).decision).toBe('REJECT');
  });

  it('RA-07: unknown licence / reproducibility cannot silently pass', () => {
    expect(decide(gate(admitted(), 'licensing', 'NOT_PROVEN', [])).decision).toBe('HOLD');
    expect(decide(gate(admitted(), 'reproducibility', 'NOT_PROVEN', [])).decision).toBe('HOLD');
  });

  it('a private dependency (reproducibility FAIL) is rejected and a legacy status cannot mask it', () => {
    const a = gate(admitted({ legacy: { reason: 'incumbent', migration: [] } }), 'reproducibility', 'FAIL');
    expect(decide(a).decision).toBe('REJECT');
  });

  it('RA-08: missing cancellation (lifecycle) holds, never admits', () => {
    expect(decide(gate(admitted(), 'lifecycle', 'FAIL')).decision).toBe('HOLD');
    expect(decide(gate(admitted(), 'lifecycle', 'NOT_PROVEN', [])).decision).toBe('HOLD');
  });

  it('RA-09 / self-report: a PASS without evidence refs counts as NOT_PROVEN', () => {
    const a = gate(admitted(), 'evidence', 'PASS', []);
    expect(decide(a)).toMatchObject({ decision: 'HOLD', blocked_reasons: ['evidence: NOT_PROVEN'] });
  });

  it('RA-05: a runtime cannot assess itself', () => {
    expect(decide(admitted({ assessed_by: 'Candidate' })).decision).toBe('REJECT');
  });

  it.each(['approval', 'canonical_memory', 'promotion', 'task'] as const)('RA-06: runtime claiming %s authority is rejected; UNKNOWN holds', (k) => {
    expect(decide(admitted({ authority: { ...admitted().authority, [k]: 'RUNTIME' } })).decision).toBe('REJECT');
    expect(decide(admitted({ authority: { ...admitted().authority, [k]: 'SHARED' } })).decision).toBe('REJECT');
    expect(decide(admitted({ authority: { ...admitted().authority, [k]: 'UNKNOWN' } })).decision).toBe('HOLD');
  });

  it('RA-10: hidden child agents (inside the runtime, invisible to Djimitflo budget/lineage) block admission', () => {
    expect(decide(admitted({ child_agents: 'RUNTIME_INTERNAL' })).decision).toBe('HOLD');
    expect(decide(admitted({ child_agents: 'UNKNOWN' })).decision).toBe('HOLD');
    expect(decide(admitted({ child_agents: 'DJIMITFLO_GATED' })).decision).toBe('ADMIT');
  });

  it('broader filesystem scope or an extra MCP server is a containment change: the new assessment cannot be PASS without evidence', () => {
    expect(decide(gate(admitted(), 'containment', 'NOT_PROVEN', [])).decision).toBe('HOLD');
  });

  it('RA-13: the capability gap must be explicit; NONE rejects, a missing proof holds', () => {
    expect(decide(admitted({ capability_gap: { status: 'NONE', description: '', evidence_refs: ['x'] } })).decision).toBe('REJECT');
    expect(decide(admitted({ capability_gap: { status: 'PROVEN', description: 'claimed', evidence_refs: [] } })).decision).toBe('HOLD');
  });

  it('RA-14: a new production runtime needs gym evidence; a gym regression drops it to HOLD', () => {
    expect(decide(gate(admitted(), 'gym_evidence', 'NOT_PROVEN', [])).decision).toBe('HOLD');
    expect(decide(gate(admitted(), 'gym_evidence', 'FAIL')).decision).toBe('HOLD');
  });
});

describe('version binding and expiry', () => {
  it('RA-03: admission(runtime@X) is not admission(runtime@Y)', () => {
    expect(check(admitted(), '1.2.3').allowed).toBe(true);
    expect(check(admitted(), 'candidate 1.2.4')).toMatchObject({ allowed: false, reasons: [expect.stringContaining('runtime drift')] });
    expect(check(admitted(), '1.2.30').allowed).toBe(false); // no prefix match
    expect(assessmentRef(admitted())).not.toBe(assessmentRef(admitted({ runtime_version: '1.2.4' })));
  });

  it('RA-11: a non-legacy admission whose executing version is not observed does not run', () => {
    expect(check(admitted(), null)).toMatchObject({ allowed: false, reasons: [expect.stringContaining('version not observed')] });
  });

  it('binary hash change = new assessment ref (the evidence names exactly which record allowed a run)', () => {
    expect(assessmentRef(admitted({ artifact_sha256: 'aa' }))).not.toBe(assessmentRef(admitted({ artifact_sha256: 'bb' })));
  });

  it('RA-12: an expired admission cannot execute', () => {
    expect(check(admitted({ expires_at: '2026-09-30T00:00:00Z' }))).toMatchObject({ allowed: false, reasons: [expect.stringContaining('expired')] });
    expect(check(admitted({ expires_at: 'not-a-date' })).allowed).toBe(false);
  });

  it('RA-01: an unknown runtime cannot execute', () => {
    expect(checkAdmission('custom', '1.0.0', NOW)).toMatchObject({ allowed: false, decision: 'UNKNOWN_RUNTIME' });
  });

  it('several versions of one runtime: the record matching the executing version decides', () => {
    const old = admitted({ runtime_version: '1.0.0', expires_at: '2026-01-01T00:00:00Z' });
    const ledger = [old, admitted()];
    expect(checkAdmission('candidate', '1.2.3', NOW, ledger).allowed).toBe(true);
    expect(checkAdmission('candidate', '1.0.0', NOW, ledger).allowed).toBe(false);
  });

  it('legacy admission is explicit and expiring, never permanent', () => {
    for (const a of RUNTIME_ADMISSIONS.filter((r) => r.legacy)) {
      expect(decide(a).decision).toBe('LEGACY_ADMITTED');
      expect(Date.parse(a.expires_at)).toBeLessThanOrEqual(Date.parse('2027-01-01T00:00:00Z'));
      expect(a.legacy!.migration.length).toBeGreaterThan(0);
    }
    expect(expiringAdmissions(Date.parse('2026-12-15T00:00:00Z')).map((a) => a.runtime_id)).toContain('opencode');
    expect(expiringAdmissions(NOW)).toEqual([]);
  });
});

describe('ledger controls', () => {
  it('negative control: OpenHuman with the 2026-10-01 evidence is REJECTed', () => {
    const oh = RUNTIME_ADMISSIONS.find((a) => a.runtime_id === 'openhuman')!;
    const v = decide(oh);
    expect(v.decision).toBe('REJECT');
    expect(v.blocked_reasons).toEqual(expect.arrayContaining(['licensing: FAIL', 'reproducibility: FAIL', 'supply_chain: FAIL', 'capability_gap: NONE', 'authority.approval: RUNTIME']));
    expect(checkAdmission('openhuman', null, NOW).allowed).toBe(false);
  });

  it('positive control: the incumbent opencode runs, bound to its pinned version, with its gaps named', () => {
    const c = checkAdmission('opencode', '1.18.10', NOW);
    expect(c).toMatchObject({ allowed: true, decision: 'LEGACY_ADMITTED', version_bound: true });
    expect(c.reasons).toEqual(expect.arrayContaining(['supply_chain: NOT_PROVEN', 'containment: NOT_PROVEN', 'child_agents: RUNTIME_INTERNAL']));
    expect(checkAdmission('opencode', '1.19.0', NOW).allowed).toBe(false);
  });

  it('every executor the engine registers has an admission record (enforcement changes no current behaviour)', () => {
    const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
    const engine = new ExecutionEngine(db, { broadcastTaskEvent: vi.fn(), broadcastTaskEventById: vi.fn() } as any);
    for (const kind of [...(engine as any).executors.keys()]) expect(checkAdmission(kind, null, NOW).allowed, kind).toBe(true);
    db.close();
  });
});

describe('ExecutionEngine enforcement', () => {
  let db: Database.Database;
  let engine: ExecutionEngine;
  const id = 'admission-fixture';
  const start = vi.fn(async () => { throw new Error('executor must not start'); });
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    engine = new ExecutionEngine(db, { broadcastTaskEvent: vi.fn(), broadcastTaskEventById: vi.fn() } as any);
    db.prepare(`INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata)
      VALUES (?, 'Fixture', 'Read local fixture', 'pending', 'low', 'low', 'local', ?)`).run(id, JSON.stringify({ runtime_admission: { decision: 'ADMIT' } }));
  });
  afterEach(() => { vi.unstubAllEnvs(); start.mockClear(); db.close(); });
  const events = () => db.prepare("SELECT message, metadata FROM execution_events WHERE task_id=? AND json_extract(metadata,'$.source')='runtime-admission'").all(id) as Array<{ message: string; metadata: string }>;

  it('RA-02/RA-05: a registered but unadmitted executor is denied, whatever the task metadata claims, and the denial is recorded (RA-16)', async () => {
    engine.registerExecutor({ kind: 'custom', canExecute: () => true, start } as any);
    const r = await engine.executeTask(id, 'custom' as any, 'maker');
    expect(r).toMatchObject({ status: 'denied', reason: expect.stringContaining('RUNTIME_NOT_ADMITTED') });
    expect(start).not.toHaveBeenCalled();
    expect(events()[0].message).toContain('denied');
    expect(JSON.parse(events()[0].metadata)).toMatchObject({ decision: 'UNKNOWN_RUNTIME', allowed: false });
  });

  it('RA-11: drift observed by the contract probe after boot denies the pinned runtime', async () => {
    engine.registerExecutor({ kind: 'opencode', canExecute: () => true, start } as any);
    db.prepare("INSERT INTO runtime_contract_probes(runtime,command,status,available,contract_json,probed_at) VALUES ('opencode','opencode','ok',1,?,?)")
      .run(JSON.stringify({ version: '1.19.0' }), new Date(Date.now() + 1000).toISOString());
    const r = await engine.executeTask(id, 'opencode', 'maker');
    expect(r).toMatchObject({ status: 'denied', reason: expect.stringContaining('runtime drift') });
    expect(start).not.toHaveBeenCalled();
  });

  it('a probe row from before this process started (previous image) is not taken as the executing version', () => {
    db.prepare("INSERT INTO runtime_contract_probes(runtime,command,status,available,contract_json,probed_at) VALUES ('opencode','opencode','ok',1,?,'2000-01-01T00:00:00Z')")
      .run(JSON.stringify({ version: '1.19.0' }));
    expect((engine as any).admitRuntime(id, 'opencode')).toMatchObject({ allowed: true, decision: 'LEGACY_ADMITTED' });
  });

  it('RA-15: a fallback attempt passes admission too', async () => {
    engine.registerExecutor({ kind: 'custom', canExecute: () => true, start } as any);
    const task = (engine as any).getTask(id);
    vi.spyOn((engine as any), 'fallbackAdmitted').mockReturnValue(true);
    await expect((engine as any).startExecutionAttempt(task, 'custom', 'fast', 1, 3)).rejects.toThrow('RUNTIME_NOT_ADMITTED');
    expect(start).not.toHaveBeenCalled();
  });

  it('shadow mode (operator rollback) records the failure and does not block', () => {
    vi.stubEnv('RUNTIME_ADMISSION_MODE', 'shadow');
    expect((engine as any).admitRuntime(id, 'custom').allowed).toBe(true);
    expect(events()[0].message).toContain('shadow');
  });
});

describe('stall watch', () => {
  it('warns 30 days before an admission expires', () => {
    const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
    expect(detectStalls(db, Date.parse('2026-12-10T00:00:00Z'), {}).map((s) => s.subsystem)).toContain('runtime_admission:opencode');
    expect(detectStalls(db, NOW, {}).some((s) => s.subsystem.startsWith('runtime_admission'))).toBe(false);
    db.close();
  });
});
