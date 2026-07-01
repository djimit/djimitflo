import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';

export interface DistillationResult {
  skillId: string;
  okfPath: string;
  status: 'candidate';
}

interface MakerLeaseRow {
  id: string;
  loop_run_id: string;
  metadata: string;
}

interface LoopRunRow {
  id: string;
  goal_id: string | null;
}

interface GoalRow {
  objective: string;
}

export class SkillDistillationService {
  private okfSkillsDir: string;

  constructor(
    private db: Database,
    okfSkillsDir?: string,
  ) {
    this.okfSkillsDir = okfSkillsDir || path.resolve(process.cwd(), 'knowledge', 'skills');
  }

  async distillFromRun(loopRunId: string): Promise<DistillationResult | null> {
    const run = this.db.prepare('SELECT id, goal_id FROM loop_runs WHERE id = ?').get(loopRunId) as LoopRunRow | undefined;
    if (!run) return null;

    const leases = this.db.prepare(
      "SELECT id, loop_run_id, metadata FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' AND status = 'completed'"
    ).all(loopRunId) as MakerLeaseRow[];

    if (leases.length === 0) return null;

    const maker = leases[0];
    const findingType = 'unknown';
    const findingMessage = '';
    let assignmentPath = '';
    let stdoutPath = '';

    try {
      const meta = JSON.parse(maker.metadata || '{}');
      assignmentPath = meta.assignment_path || meta.assignment_packet_file || '';
      stdoutPath = meta.stdout_path || '';
    } catch { /* skip */ }

    const goalObjective = run.goal_id
      ? (this.db.prepare('SELECT objective FROM goals WHERE id = ?').get(run.goal_id) as GoalRow | undefined)?.objective || ''
      : '';

    const slug = 'distilled-' + loopRunId.slice(0, 8) + '-' + randomUUID().slice(0, 4);
    const skillContent = this.formatSkillProcedure({
      findingType,
      findingMessage,
      goalObjective,
      loopRunId,
      assignmentPath,
      stdoutPath,
    });

    try {
      fs.mkdirSync(this.okfSkillsDir, { recursive: true });
      const okfPath = path.join(this.okfSkillsDir, slug + '.md');
      fs.writeFileSync(okfPath, skillContent);

      const skillId = 'skill-' + slug;
      this.db.prepare(`
        INSERT INTO swarm_capabilities (
          id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
          allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
          eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at
        ) VALUES (?, 'skill', 'distillation', '0.1.0', 'candidate', 'low', 'none', 'none',
          '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail',
          ?, datetime('now'), datetime('now'))
      `).run(skillId, JSON.stringify({ distilled_from: loopRunId, okf_path: okfPath }));

      return { skillId, okfPath, status: 'candidate' };
    } catch { return null; }
  }

  private formatSkillProcedure(input: {
    findingType: string;
    findingMessage: string;
    goalObjective: string;
    loopRunId: string;
    assignmentPath: string;
    stdoutPath: string;
  }): string {
    return `---
capability_id: skill-distilled
procedure:
  - step: Read the finding description and evidence
  - step: Analyze the code context around the finding
  - step: Apply the suggested fix following codebase conventions
  - step: Verify the change does not break existing tests
precondition: Finding type matches this skill's expertise
expected_effect: Finding resolved, diff minimal
source_run: ${input.loopRunId}
created: ${new Date().toISOString()}
---

# Distilled Skill: ${input.findingType}

## Goal
${input.goalObjective || 'Resolve finding'}

## Context
- Source run: ${input.loopRunId}
- Assignment: ${input.assignmentPath || 'N/A'}
- Original output: ${input.stdoutPath || 'N/A'}

## Procedure
1. Read the finding description and evidence
2. Analyze the code context around the finding
3. Apply the suggested fix following codebase conventions
4. Verify the change does not break existing tests
5. Keep the diff small and local

## Rules
- Do not merge, push, deploy, or modify secrets
- Do not run tests — the checker verifies externally
- Stay within the worktree boundary
`;
  }
}
