import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { OpenMythosAttestationService } from '../services/openmythos-attestation-service';

let db: Database.Database;
const corpusHash = 'a'.repeat(64);

beforeEach(() => {
  db = createTestDb();
  db.prepare(`INSERT INTO openmythos_eval_runs (
    id, agent_id, status, total_cases, completed_cases, overall_score, metadata
  ) VALUES ('run-1', 'agent-1', 'completed', 30, 30, 4.5, ?)`)
    .run(JSON.stringify({ corpus_sha256: corpusHash, score_valid: true }));
});
afterEach(() => db.close());

function artifact(overrides: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {
    schema: 'djimit.openmythos.calibration.v1',
    run_id: 'run-1',
    openmythos_commit: 'a'.repeat(40),
    corpus_sha256: corpusHash,
    corpus_version: '1.0',
    corpus_schema_version: 1,
    corpus_certification_ready: true,
    case_result_rows: 30,
    total_cases: 30,
    completed_cases: 30,
    calibrated: true,
    certification_eligible: true,
    agreement_rate: 0.9,
    lowest_category_agreement_rate: 0.8,
    evidence_sha256: { corpus: corpusHash, run: 'b'.repeat(64), results: 'c'.repeat(64) },
    ...overrides,
  };
  value.attestation_hash = `sha256:${OpenMythosAttestationService.hashArtifact(value)}`;
  return value;
}

describe('OpenMythosAttestationService', () => {
  it('shares canonical hashing with the Python producer for integer-valued floats', () => {
    expect(OpenMythosAttestationService.hashArtifact({ z: 1, a: { rate: 0.75 }, attestation_hash: 'ignored' }))
      .toBe('d1d913a9206b63cd7b02bace2870e629a189f57afd46998c3881bbaa88b045b6');
  });

  it('imports a hash-verified attestation and updates the one operational eligibility path', () => {
    const service = new OpenMythosAttestationService(db);
    const imported = service.import(artifact(), 'operator-1');
    expect(imported).toMatchObject({ run_id: 'run-1', certification_eligible: true, corpus_certification_ready: true });
    expect(service.import(artifact(), 'operator-1').id).toBe(imported.id);
    const metadata = JSON.parse((db.prepare("SELECT metadata FROM openmythos_eval_runs WHERE id = 'run-1'").get() as any).metadata);
    expect(metadata).toMatchObject({ certification_eligible: true, corpus_certification_ready: true, openmythos_attestation: { id: imported.id } });
    expect(service.list()).toHaveLength(1);
  });

  it('fails closed on tampering and corpus mismatch', () => {
    const service = new OpenMythosAttestationService(db);
    expect(() => service.import({ ...artifact(), agreement_rate: 0.1 }, 'operator-1')).toThrow('OPENMYTHOS_ATTESTATION_HASH_MISMATCH');
    expect(() => service.import(artifact({ corpus_sha256: 'd'.repeat(64), evidence_sha256: { corpus: 'd'.repeat(64) } }), 'operator-1'))
      .toThrow('OPENMYTHOS_ATTESTATION_CORPUS_MISMATCH');
  });

  it('cannot mark an uncertified corpus eligible', () => {
    const imported = new OpenMythosAttestationService(db).import(artifact({ corpus_certification_ready: false }), 'operator-1');
    expect(imported.certification_eligible).toBe(false);
    const metadata = JSON.parse((db.prepare("SELECT metadata FROM openmythos_eval_runs WHERE id = 'run-1'").get() as any).metadata);
    expect(metadata.certification_eligible).toBe(false);
  });
});
