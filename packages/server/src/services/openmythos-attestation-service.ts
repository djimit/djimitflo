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

/** The producer's default minimum (OpenMythos scripts/r21_calibrate_djimitflo.py --minimum-agreement). */
const DEFAULT_MINIMUM_AGREEMENT = 0.8;
/** A rate is evidence only as a finite number in [0, 1]; absent, null, a string or out of range is not. */
const rate = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

/**
 * M1 (B §5) / review #1094: the producer's `calibrated` only means "complete and enough cases"; it stays true at any
 * agreement. A calibration artifact may claim calibrated only with its agreement evidence present and valid:
 * agreement_rate and lowest_category_agreement_rate finite in [0, 1]; minimum_agreement_rate (default 0.8) and
 * minimum_category_agreement_rate (default 0) finite in [0, 1] when given; agreement ≥ its minimum, the lowest category ≥ its
 * minimum, and the lowest category ≤ the overall rate (an overall rate is a weighted mean of the category rates).
 * Returns why it is refused, or null when the claim holds. Callers need not have schema-validated the report.
 */
export function calibrationRefusal(report: Record<string, unknown>): string | null {
  if (report.calibrated !== true) return 'not calibrated';
  const agreement = rate(report.agreement_rate);
  const lowest = rate(report.lowest_category_agreement_rate);
  if (agreement === null) return 'agreement_rate missing or not a rate in [0, 1]';
  if (lowest === null) return 'lowest_category_agreement_rate missing or not a rate in [0, 1]';
  const minimum = report.minimum_agreement_rate === undefined ? DEFAULT_MINIMUM_AGREEMENT : rate(report.minimum_agreement_rate);
  const categoryMinimum = report.minimum_category_agreement_rate === undefined ? 0 : rate(report.minimum_category_agreement_rate);
  if (minimum === null) return 'minimum_agreement_rate not a rate in [0, 1]';
  if (categoryMinimum === null) return 'minimum_category_agreement_rate not a rate in [0, 1]';
  if (agreement < minimum) return `agreement ${agreement} < minimum ${minimum}`;
  if (lowest < categoryMinimum) return `lowest category agreement ${lowest} < minimum ${categoryMinimum}`;
  if (lowest > agreement + 1e-9) return `lowest category agreement ${lowest} > overall ${agreement} (inconsistent)`;
  return null;
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
    const refusal = artifact.calibrated ? calibrationRefusal(artifact) : null;
    const calibrated = artifact.calibrated && refusal === null;
    const certificationEligible = artifact.certification_eligible && calibrated && artifact.corpus_certification_ready;
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
        calibrated,
        calibration_refusal: refusal,
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

  /** Certifying evidence: stored eligible + corpus ready, and its payload still passes calibrationRefusal (rows imported before M1). */
  certifies(id: string): boolean {
    const row = this.db.prepare('SELECT payload FROM openmythos_attestations WHERE id = ? AND certification_eligible = 1 AND corpus_certification_ready = 1')
      .get(id) as { payload: string } | undefined;
    return Boolean(row) && calibrationRefusal(this.object(row!.payload)) === null;
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
