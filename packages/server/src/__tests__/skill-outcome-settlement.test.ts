import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrate';
import { schema } from '../database/schema';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { EvidenceService } from '../services/evidence-service';
import { EvidenceType, EvidenceSeverity } from '@djimitflo/shared';
let db: Database.Database;
let skills: SkillEvolutionEngine;
const digest = 'a'.repeat(64);
const packageHash = 'b'.repeat(64);
beforeEach(() => {
  vi.stubEnv('SKILL_FIRST_MODE', 'on');
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); skills = new SkillEvolutionEngine(db);
  db.prepare("INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode) VALUES('task','fixture','fixture','completed','low','low','review_only')").run();
  new EvidenceService(db).captureEvidence({ task_id: 'task', source: 'system', evidence_type: EvidenceType.EXECUTION_SUMMARY, severity: EvidenceSeverity.INFO, title: 'Delivery fixture', summary: 'Fixture', metadata: { reason: 'skill_delivery_receipt' }, details: { skill_id: 'counter-v1-0-0', skill_content_hash: digest, skill_package_hash: packageHash, delivery_state: 'delivered' } });
  skills.recordOutcome('counter-v1-0-0', { taskId: 'task', skillContentHash: digest, success: false,
    tokensUsed: null, durationMs: 321, domain: 'test', evidenceRefs: ['skill_delivery:delivered', 'outcome_class:completed_unverified', `skill_package_sha256:${packageHash}`] });
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); });
function verify(source = 'system', hash = digest, severity = EvidenceSeverity.INFO, verifiedPackage: string | undefined = packageHash) {
  return new EvidenceService(db).captureEvidence({ task_id: 'task', evidence_type: EvidenceType.TEST_RESULT,
    source, severity, title: 'Independent fixture check', summary: 'Test fixture, not operational evidence',
    details: { status: 'passed', skill_package_id: 'counter-v1-0-0', skill_content_hash: hash, skill_package_hash: verifiedPackage } });
}
it('settles late verification once without inventing usage and retains later failed evidence', () => {
  const before = db.prepare('SELECT id,tokens_used,duration_ms FROM skill_outcomes').get();
  const evidence = verify(); verify();
  const rows = db.prepare('SELECT * FROM skill_outcomes').all() as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ ...before as object, success: 1 });
  expect(JSON.parse(String(rows[0].evidence_refs_json))).toContain(evidence);
  expect(skills.measuredTraits('counter-v1-0-0').reliability).toBe(1);
  verify('system', digest, EvidenceSeverity.ERROR);
  expect(db.prepare('SELECT success FROM skill_outcomes').get()).toEqual({ success: 0 });
});
it('does not settle on maker evidence or a different version hash', () => {
  verify('executor'); verify('system', 'b'.repeat(64));
  expect(db.prepare('SELECT success FROM skill_outcomes').get()).toEqual({ success: 0 });
  expect(skills.measuredTraits('counter-v1-0-0').reliability).toBeNull();
});
it('leaves ambiguous retry outcomes unverified instead of crediting both', () => {
  skills.recordOutcome('counter-v1-0-0', { taskId: 'task', skillContentHash: digest, success: false,
    tokensUsed: 99, durationMs: 123, domain: 'test', evidenceRefs: ['skill_delivery:delivered', 'outcome_class:completed_unverified', `skill_package_sha256:${packageHash}`] });
  verify();
  expect(db.prepare('SELECT SUM(success) n FROM skill_outcomes').get()).toEqual({ n: 0 });
});

it('refuses a different executable package even when its instructions hash is unchanged', () => {
  verify('system', digest, EvidenceSeverity.INFO, 'c'.repeat(64));
  expect(skills.measuredTraits('counter-v1-0-0').reliability).toBeNull();
  expect(db.prepare('SELECT success FROM skill_outcomes').get()).toEqual({ success: 0 });
});
it('leaves settlement disabled when the skill-first feature is off', () => {
  vi.stubEnv('SKILL_FIRST_MODE', 'off'); verify();
  expect(db.prepare('SELECT success FROM skill_outcomes').get()).toEqual({ success: 0 });
});

it('does not promote contradictory info-severity failure evidence to success', () => {
  new EvidenceService(db).captureEvidence({ task_id: 'task', evidence_type: EvidenceType.TEST_RESULT,
    source: 'system', severity: EvidenceSeverity.INFO, title: 'Rejected verifier result', summary: 'Explicit failure',
    details: { status: 'failed', skill_package_id: 'counter-v1-0-0', skill_content_hash: digest, skill_package_hash: packageHash } });
  expect(db.prepare('SELECT success FROM skill_outcomes').get()).toEqual({ success: 0 });
});
it('keeps an executable result without an explicit verifier verdict unknown', () => {
  new EvidenceService(db).captureEvidence({ task_id: 'task', evidence_type: EvidenceType.TEST_RESULT,
    source: 'system', severity: EvidenceSeverity.INFO, title: 'No verifier result', summary: 'Missing verdict',
    details: { skill_package_id: 'counter-v1-0-0', skill_content_hash: digest, skill_package_hash: packageHash } });
  expect(db.prepare('SELECT success FROM skill_outcomes').get()).toEqual({ success: 0 });
  expect(skills.measuredTraits('counter-v1-0-0').reliability).toBeNull();
});
