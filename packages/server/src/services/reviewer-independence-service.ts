import type { Database } from 'better-sqlite3';

export type IndependenceState = 'PASS' | 'FAIL' | 'UNDETERMINED';
export type IndependenceDimension = boolean | null;

export interface ReviewerIndependenceAssessment {
  loop_run_id: string;
  maker_lease_id: string | null;
  checker_lease_id: string | null;
  state: IndependenceState;
  risk: 'low' | 'medium' | 'high';
  dimensions: {
    model_family_independence: IndependenceDimension;
    provider_independence: IndependenceDimension;
    prompt_independence: IndependenceDimension;
    context_independence: IndependenceDimension;
    memory_independence: IndependenceDimension;
    retrieval_independence: IndependenceDimension;
    oracle_independence: IndependenceDimension;
  };
  correlated_fields: string[];
  unknown_fields: string[];
}

interface LeaseIdentity {
  id: string;
  loop_run_id?: string;
  role?: string;
  runtime?: string;
  metadata?: Record<string, unknown> | string;
}

export class ReviewerIndependenceService {
  constructor(private readonly db: Database) {}

  assessLoop(loopRunId: string): ReviewerIndependenceAssessment {
    const rows = this.db.prepare(`
      SELECT id, loop_run_id, role, runtime, metadata FROM worker_leases
      WHERE loop_run_id = ? AND role IN ('maker', 'checker') ORDER BY created_at DESC
    `).all(loopRunId) as LeaseIdentity[];
    return this.assess(
      rows.find((row) => row.role === 'maker') || null,
      rows.find((row) => row.role === 'checker') || null,
      loopRunId,
    );
  }

  assess(maker: LeaseIdentity | null, checker: LeaseIdentity | null, loopRunId = maker?.loop_run_id || checker?.loop_run_id || ''): ReviewerIndependenceAssessment {
    const makerMeta = this.object(maker?.metadata);
    const checkerMeta = this.object(checker?.metadata);
    const dimensions: ReviewerIndependenceAssessment['dimensions'] = {
      model_family_independence: this.different(this.identity(makerMeta, ['model_family', 'model_id', 'model']), this.identity(checkerMeta, ['model_family', 'model_id', 'model'])),
      provider_independence: this.different(this.identity(makerMeta, ['provider', 'model_provider']), this.identity(checkerMeta, ['provider', 'model_provider'])),
      prompt_independence: this.different(this.identity(makerMeta, ['system_prompt_hash', 'prompt_hash']), this.identity(checkerMeta, ['system_prompt_hash', 'prompt_hash'])),
      context_independence: this.different(this.identity(makerMeta, ['context_hash']), this.identity(checkerMeta, ['context_hash'])),
      memory_independence: this.different(this.identity(makerMeta, ['memory_hash', 'memory_scope_hash']), this.identity(checkerMeta, ['memory_hash', 'memory_scope_hash'])),
      retrieval_independence: this.different(this.identity(makerMeta, ['retrieval_hash']), this.identity(checkerMeta, ['retrieval_hash'])),
      oracle_independence: this.different(this.identity(makerMeta, ['oracle_hash']), this.identity(checkerMeta, ['oracle_hash'])),
    };
    const correlatedFields = Object.entries(dimensions).filter(([, independent]) => independent === false).map(([field]) => field);
    const unknownFields = Object.entries(dimensions).filter(([, independent]) => independent === null).map(([field]) => field);
    const state: IndependenceState = !maker || !checker || unknownFields.length === Object.keys(dimensions).length
      ? 'UNDETERMINED'
      : correlatedFields.length > 0 ? 'FAIL' : unknownFields.length > 0 ? 'UNDETERMINED' : 'PASS';
    return {
      loop_run_id: loopRunId,
      maker_lease_id: maker?.id || null,
      checker_lease_id: checker?.id || null,
      state,
      risk: correlatedFields.length > 0 ? 'high' : unknownFields.length > 0 ? 'medium' : 'low',
      dimensions,
      correlated_fields: correlatedFields,
      unknown_fields: unknownFields,
    };
  }

  latest(limit = 20): ReviewerIndependenceAssessment[] {
    const runs = this.db.prepare(`
      SELECT DISTINCT loop_run_id FROM worker_leases
      WHERE role = 'checker' ORDER BY updated_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(limit, 100))) as Array<{ loop_run_id: string }>;
    return runs.map((row) => this.assessLoop(row.loop_run_id));
  }

  private different(left: string | null, right: string | null): IndependenceDimension {
    return left && right ? left !== right : null;
  }

  private identity(metadata: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      if (typeof metadata[key] === 'string' && String(metadata[key]).trim()) return String(metadata[key]).trim();
    }
    return null;
  }

  private object(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== 'string') return {};
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
}
