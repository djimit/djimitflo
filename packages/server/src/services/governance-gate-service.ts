/**
 * GovernanceGateService — certification with teeth.
 *
 * Consulted in the task-execution path: when the executing agent/model's
 * latest OpenMythos governance score is below the floor, the gate TIGHTENS
 * the policy decision (allow → require_approval). It never loosens: policy
 * deny/approval outcomes stand regardless of a good score.
 *
 * Default-off. Arm with:
 *   GOVERNANCE_GATE_ENABLED=true
 *   GOVERNANCE_GATE_FLOOR=3                     (0-5 scale, default 3)
 *   GOVERNANCE_GATE_MODEL_MAP=claude=claude-sonnet-4,pi=qwen2.5:14b-instruct-q4_K_M
 *     — maps executor kinds to benchmarked subject models, for tasks whose
 *       agent has no eval history of its own.
 *
 * Evidence lookup order per task: the task's agent_id, then nightly:<model>
 * from the model map, then any run whose metadata subject_model matches.
 * No evidence → allow (the gate only acts on measured behavior).
 *
 * ponytail: flagRetirement only marks the verdict (audit/evidence carry it);
 * auto-invoking AgentRetirementService.planRetirement is the upgrade when
 * operators trust the signal.
 */

import type { Database } from 'better-sqlite3';

export interface GateVerdict {
  action: 'allow' | 'require_approval';
  score: number | null;
  floor: number;
  agentKey: string | null;
  trend: 'improving' | 'stable' | 'declining' | null;
  flagRetirement: boolean;
  reason: string;
}

interface RunRow {
  agent_id: string;
  overall_score: number;
  finished_at: string;
  metadata: string;
}

export class GovernanceGateService {
  constructor(private db: Database) {}

  enabled(): boolean {
    return process.env.GOVERNANCE_GATE_ENABLED === 'true';
  }

  floor(): number {
    const floor = Number(process.env.GOVERNANCE_GATE_FLOOR ?? '3');
    return Number.isFinite(floor) && floor >= 0 && floor <= 5 ? floor : 3;
  }

  private modelForExecutor(executorKind: string): string | null {
    const map = process.env.GOVERNANCE_GATE_MODEL_MAP || '';
    for (const pair of map.split(',')) {
      const [kind, ...rest] = pair.split('=');
      if (kind?.trim() === executorKind && rest.length > 0) return rest.join('=').trim() || null;
    }
    return null;
  }

  /** Recent completed runs for an agent key or subject model, newest first. */
  private recentRuns(agentId: string | null, subjectModel: string | null, limit = 3): RunRow[] {
    const rows = this.db.prepare(`
      SELECT agent_id, overall_score, finished_at, metadata
      FROM openmythos_eval_runs
      WHERE status = 'completed'
      ORDER BY finished_at DESC
    `).all() as RunRow[];

    const matches = rows.filter((row) => {
      if (agentId && row.agent_id === agentId) return true;
      if (subjectModel) {
        if (row.agent_id === `nightly:${subjectModel}`) return true;
        try {
          const metadata = JSON.parse(row.metadata || '{}') as { subject_model?: string };
          if (metadata.subject_model === subjectModel) return true;
        } catch { /* skip malformed */ }
      }
      return false;
    });
    return matches.slice(0, limit);
  }

  assess(task: { agent_id?: string | null }, executorKind: string): GateVerdict {
    const floor = this.floor();
    const base: GateVerdict = {
      action: 'allow', score: null, floor, agentKey: null, trend: null, flagRetirement: false,
      reason: 'Governance gate disabled',
    };
    if (!this.enabled()) return base;

    const subjectModel = this.modelForExecutor(executorKind);
    const runs = task.agent_id
      ? this.recentRuns(task.agent_id, null).length > 0
        ? this.recentRuns(task.agent_id, null)
        : this.recentRuns(null, subjectModel)
      : this.recentRuns(null, subjectModel);

    if (runs.length === 0) {
      return { ...base, reason: `No governance evidence for agent/executor '${task.agent_id ?? executorKind}' — gate allows` };
    }

    const latest = runs[0];
    const score = latest.overall_score;
    let trend: GateVerdict['trend'] = 'stable';
    if (runs.length >= 2) {
      const diff = runs[0].overall_score - runs[1].overall_score;
      trend = diff > 0.1 ? 'improving' : diff < -0.1 ? 'declining' : 'stable';
    }

    if (score >= floor) {
      return {
        ...base, score, agentKey: latest.agent_id, trend,
        reason: `Governance score ${score.toFixed(2)}/5 >= floor ${floor} (${latest.agent_id})`,
      };
    }

    const flagRetirement = runs.length >= 3 && runs.every((run) => run.overall_score < floor) && trend === 'declining';
    return {
      action: 'require_approval',
      score, floor, agentKey: latest.agent_id, trend, flagRetirement,
      reason: `Governance gate: ${latest.agent_id} scored ${score.toFixed(2)}/5 on the OpenMythos benchmark, below floor ${floor} — human approval required` +
        (flagRetirement ? '; persistent decline, retirement candidate' : ''),
    };
  }
}
