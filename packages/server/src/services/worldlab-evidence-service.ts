import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { SwarmEvidenceService } from './swarm-evidence-service';

const gateState = z.enum(['PASS', 'FAIL', 'UNDETERMINED']);
const retestSchema = z.object({
  schema: z.literal('djimit.openmythos.worldlab.retest.v1'),
  finding_id: z.string().trim().min(1),
  goal_id: z.string().trim().min(1),
  change_id: z.string().trim().min(1),
  commit: z.string().regex(/^[a-f0-9]{7,64}$/),
  trajectory_id: z.string().trim().min(1),
  evidence_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  gates: z.object({
    static_openmythos: gateState,
    worldlab_targeted: gateState,
    djimitflo_tests: gateState,
    security_invariants: gateState,
  }).strict(),
  evidence_refs: z.array(z.string().trim().min(1)).min(4),
}).strict().superRefine((input, context) => {
  for (const prefix of ['openmythos:', 'worldlab:', 'djimitflo:', 'security:']) {
    if (!input.evidence_refs.some((ref) => ref.startsWith(prefix))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence_refs'], message: `missing ${prefix} evidence` });
    }
  }
});

export type WorldLabRetestDecision = 'PROMOTION_CANDIDATE' | 'REJECTED' | 'UNDETERMINED';

export class WorldLabEvidenceService {
  constructor(private readonly db: Database) {}

  recordRetest(payload: unknown): { id: string; decision: WorldLabRetestDecision; duplicate: boolean; promoted: false } {
    const parsed = retestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('WORLDLAB_RETEST_INVALID');
    const input = parsed.data;
    const goal = this.db.prepare('SELECT metadata FROM goals WHERE id = ?').get(input.goal_id) as { metadata: string } | undefined;
    if (!goal) throw new Error('WORLDLAB_RETEST_GOAL_NOT_FOUND');
    const metadata = this.object(goal.metadata);
    const source = this.object(metadata.openmythos_source);
    if (source.finding_id !== input.finding_id) throw new Error('WORLDLAB_RETEST_FINDING_MISMATCH');
    const states = Object.values(input.gates);
    const decision: WorldLabRetestDecision = states.includes('FAIL') ? 'REJECTED'
      : states.includes('UNDETERMINED') ? 'UNDETERMINED' : 'PROMOTION_CANDIDATE';
    const canonical = JSON.stringify(this.canonical(input));
    const id = `worldlab-retest:sha256:${createHash('sha256').update(canonical).digest('hex')}`;
    const history = Array.isArray(metadata.worldlab_retests) ? metadata.worldlab_retests as Array<Record<string, unknown>> : [];
    if (history.some((entry) => entry.id === id)) return { id, decision, duplicate: true, promoted: false };
    const now = new Date().toISOString();
    const record = { id, ...input, decision, recorded_at: now, promoted: false };
    const evidence = new SwarmEvidenceService(this.db);
    const transaction = this.db.transaction(() => {
      this.db.prepare('UPDATE goals SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...metadata, worldlab_retests: [...history, record], promotion_state: decision }), now, input.goal_id);
      evidence.createEvidenceEdge(`finding:${input.finding_id}`, `change:${input.change_id}`, 'addressed_by', { effect_scope: 'isolated', retest_id: id });
      evidence.createEvidenceEdge(`change:${input.change_id}`, `commit:${input.commit}`, 'implemented_by', { effect_scope: 'isolated', retest_id: id });
      evidence.createEvidenceEdge(`change:${input.change_id}`, `trajectory:${input.trajectory_id}`, 'retested_by', { effect_scope: 'simulated', retest_id: id });
      evidence.createEvidenceEdge(`change:${input.change_id}`, `goal:${input.goal_id}`, 'implements', { effect_scope: 'isolated', retest_id: id });
      for (const ref of [...new Set(input.evidence_refs)]) {
        evidence.createEvidenceEdge(ref, `change:${input.change_id}`, 'supports', { effect_scope: 'isolated', retest_id: id });
      }
    });
    transaction();
    return { id, decision, duplicate: false, promoted: false };
  }

  private object(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== 'string') return {};
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }

  private canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.canonical(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, this.canonical(item)]));
    return value;
  }
}
