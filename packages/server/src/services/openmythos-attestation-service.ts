import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';

const nonBlank = z.string().trim().min(1);
const attestationSchema = z.object({
  schema: z.literal('djimit.openmythos.calibration.v1'),
  attestation_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  run_id: nonBlank,
  openmythos_commit: z.string().regex(/^[a-f0-9]{7,64}$/),
  corpus_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  corpus_version: z.union([z.string(), z.number()]).nullable().optional(),
  corpus_schema_version: z.union([z.string(), z.number()]).nullable().optional(),
  corpus_certification_ready: z.boolean(),
  case_result_rows: z.number().int().nonnegative(),
  total_cases: z.number().int().nonnegative(),
  completed_cases: z.number().int().nonnegative(),
  calibrated: z.boolean(),
  certification_eligible: z.boolean(),
  agreement_rate: z.number().min(0).max(1),
  lowest_category_agreement_rate: z.number().min(0).max(1),
  evidence_sha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
}).passthrough();

export interface OpenMythosAttestationRecord {
  id: string;
  run_id: string;
  schema_version: string;
  corpus_sha256: string;
  openmythos_commit: string;
  certification_eligible: boolean;
  corpus_certification_ready: boolean;
  payload: Record<string, unknown>;
  imported_by: string;
  created_at: string;
}

export class OpenMythosAttestationService {
  constructor(private readonly db: Database) {}

  import(payload: unknown, importedBy: string): OpenMythosAttestationRecord {
    if (!importedBy.trim()) throw new Error('OPENMYTHOS_ATTESTATION_IMPORT_ACTOR_REQUIRED');
    const parsed = attestationSchema.safeParse(payload);
    if (!parsed.success) throw new Error('OPENMYTHOS_ATTESTATION_INVALID');
    const artifact = parsed.data;
    const expectedHash = `sha256:${OpenMythosAttestationService.hashArtifact(artifact)}`;
    if (artifact.attestation_hash !== expectedHash) throw new Error('OPENMYTHOS_ATTESTATION_HASH_MISMATCH');
    if (artifact.evidence_sha256.corpus !== artifact.corpus_sha256) throw new Error('OPENMYTHOS_ATTESTATION_CORPUS_EVIDENCE_MISMATCH');
    const run = this.db.prepare(`
      SELECT id, status, total_cases, completed_cases, metadata FROM openmythos_eval_runs WHERE id = ?
    `).get(artifact.run_id) as { id: string; status: string; total_cases: number; completed_cases: number; metadata: string } | undefined;
    if (!run) throw new Error('OPENMYTHOS_ATTESTATION_RUN_NOT_FOUND');
    if (run.status !== 'completed' || run.total_cases !== run.completed_cases
      || run.total_cases !== artifact.total_cases || run.completed_cases !== artifact.completed_cases
      || artifact.case_result_rows !== artifact.completed_cases) {
      throw new Error('OPENMYTHOS_ATTESTATION_RUN_INCOMPLETE');
    }
    const metadata = this.object(run.metadata);
    if (metadata.corpus_sha256 !== artifact.corpus_sha256) throw new Error('OPENMYTHOS_ATTESTATION_CORPUS_MISMATCH');
    const certificationEligible = artifact.certification_eligible && artifact.calibrated && artifact.corpus_certification_ready;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO openmythos_attestations (
          id, run_id, schema_version, corpus_sha256, openmythos_commit,
          certification_eligible, corpus_certification_ready, payload, imported_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.attestation_hash, artifact.run_id, artifact.schema, artifact.corpus_sha256,
        artifact.openmythos_commit, certificationEligible ? 1 : 0,
        artifact.corpus_certification_ready ? 1 : 0, JSON.stringify(artifact), importedBy.trim(),
      );
      this.db.prepare('UPDATE openmythos_eval_runs SET metadata = ? WHERE id = ?').run(JSON.stringify({
        ...metadata,
        corpus_certification_ready: artifact.corpus_certification_ready,
        certification_eligible: certificationEligible,
        openmythos_attestation: {
          id: artifact.attestation_hash,
          schema: artifact.schema,
          openmythos_commit: artifact.openmythos_commit,
          agreement_rate: artifact.agreement_rate,
          lowest_category_agreement_rate: artifact.lowest_category_agreement_rate,
          imported_by: importedBy.trim(),
        },
      }), artifact.run_id);
    });
    transaction();
    return this.get(artifact.attestation_hash);
  }

  get(id: string): OpenMythosAttestationRecord {
    const row = this.db.prepare('SELECT * FROM openmythos_attestations WHERE id = ?').get(id);
    if (!row) throw new Error('OPENMYTHOS_ATTESTATION_NOT_FOUND');
    return this.parse(row as any);
  }

  list(limit = 50): OpenMythosAttestationRecord[] {
    return (this.db.prepare('SELECT * FROM openmythos_attestations ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 200))) as any[]).map((row) => this.parse(row));
  }

  static hashArtifact(payload: Record<string, unknown>): string {
    const withoutHash = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'attestation_hash'));
    return createHash('sha256').update(JSON.stringify(this.canonical(withoutHash))).digest('hex');
  }

  private static canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.canonical(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, this.canonical(item)]));
    }
    return value;
  }

  private parse(row: any): OpenMythosAttestationRecord {
    return {
      id: row.id,
      run_id: row.run_id,
      schema_version: row.schema_version,
      corpus_sha256: row.corpus_sha256,
      openmythos_commit: row.openmythos_commit,
      certification_eligible: Boolean(row.certification_eligible),
      corpus_certification_ready: Boolean(row.corpus_certification_ready),
      payload: this.object(row.payload),
      imported_by: row.imported_by,
      created_at: row.created_at,
    };
  }

  private object(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== 'string') return {};
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
}
