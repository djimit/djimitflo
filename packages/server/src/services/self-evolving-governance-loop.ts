/**
 * SelfEvolvingGovernanceLoop (SEGML) — the orchestrator.
 *
 * Implements the unified self-improvement cycle from arXiv 2607.13104:
 * - §5.1 Intrinsic Generative Demonstrations (case generation)
 * - §5.2 Intrinsic Evaluative Feedback (judge rubric updates)
 * - §6.2 Memory-based Improvement (failure→memory→consolidation)
 * - §6.3 Tool Governance Metacognition (judge as tool refinement)
 * - §6.4 Full Scaffolding (curriculum adaptation)
 *
 * Cycle: Evaluate → Curate → Reflect → Generate → Consolidate → Update → Adapt → Validate → Meta-eval
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { swarmEventBus } from './swarm-event-bus';
import { GovernanceFeedbackService } from './governance-feedback-service';
import { SegmlCaseGenerator } from './segml-case-generator';
import { SegmlMemoryBridge } from './segml-memory-bridge';
import { SegmlJudgeUpdater } from './segml-judge-updater';
import { SegmlCurriculumAdapter } from './segml-curriculum-adapter';
import {
  type SegmlCycleResult,
  type SegmlStage,
  type BlindSpot,
  type GeneratedCase,
  DEFAULT_SEGML_CONFIG,
  type SegmlConfig,
} from './segml-types';

interface EvalRunSummary {
  id: string;
  agentId: string;
  overallScore: number;
  categoryScores: Record<string, number>;
  results: Array<{
    caseId: string;
    category: string;
    difficulty: number;
    response: string;
    judgeScore: number;
    judgeRationale: string;
    status: string;
  }>;
}

export class SelfEvolvingGovernanceLoop {
  private feedback: GovernanceFeedbackService;
  private caseGenerator: SegmlCaseGenerator;
  private memoryBridge: SegmlMemoryBridge;
  private judgeUpdater: SegmlJudgeUpdater;
  private curriculumAdapter: SegmlCurriculumAdapter;
  private config: SegmlConfig;

  constructor(
    private db: Database,
    config: Partial<SegmlConfig> = {}
  ) {
    this.config = { ...DEFAULT_SEGML_CONFIG, ...config };
    this.feedback = new GovernanceFeedbackService(db);
    this.caseGenerator = new SegmlCaseGenerator();
    this.memoryBridge = new SegmlMemoryBridge(db);
    this.judgeUpdater = new SegmlJudgeUpdater(db);
    this.curriculumAdapter = new SegmlCurriculumAdapter(db);
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_cycles (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'partial')),
        stage TEXT NOT NULL DEFAULT 'idle',
        eval_run_id TEXT,
        memories_created INTEGER NOT NULL DEFAULT 0,
        memories_consolidated INTEGER NOT NULL DEFAULT 0,
        cases_generated INTEGER NOT NULL DEFAULT 0,
        rules_updated INTEGER NOT NULL DEFAULT 0,
        judge_rubrics_updated INTEGER NOT NULL DEFAULT 0,
        curriculum_phases_adjusted INTEGER NOT NULL DEFAULT 0,
        score_delta REAL DEFAULT 0,
        blind_spots_json TEXT NOT NULL DEFAULT '[]',
        errors_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_segml_cycles_status ON segml_cycles(status);
      CREATE INDEX IF NOT EXISTS idx_segml_cycles_started ON segml_cycles(started_at DESC);

      CREATE TABLE IF NOT EXISTS segml_generated_cases (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        parent_case_id TEXT,
        category TEXT NOT NULL,
        subcategory TEXT NOT NULL,
        difficulty INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        expected_behavior TEXT NOT NULL,
        failure_mode TEXT NOT NULL,
        rationale TEXT NOT NULL,
        generation_method TEXT NOT NULL,
        validated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (cycle_id) REFERENCES segml_cycles(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_segml_gen_cases_cycle ON segml_generated_cases(cycle_id);
    `);
  }

  async runCycle(agentId: string): Promise<SegmlCycleResult> {
    const cycleId = randomUUID();
    const startedAt = new Date().toISOString();
    let stage: SegmlStage = 'evaluating';

    const result: SegmlCycleResult = {
      id: cycleId,
      started_at: startedAt,
      completed_at: '',
      status: 'partial',
      stage: 'idle',
      eval_run_id: null,
      memories_created: 0,
      memories_consolidated: 0,
      cases_generated: 0,
      rules_updated: 0,
      judge_rubrics_updated: 0,
      curriculum_phases_adjusted: 0,
      score_delta: 0,
      blind_spots_detected: [],
      errors: [],
    };

    this.db.prepare(`
      INSERT INTO segml_cycles (id, started_at, status, stage) VALUES (?, ?, 'running', ?)
    `).run(cycleId, startedAt, stage);

    swarmEventBus.emit('segml:cycle:started', { cycleId, agentId, timestamp: startedAt });

    try {
      // Stage 1: Get latest eval run
      const evalRun = this.getLatestEvalRun(agentId);
      if (!evalRun) {
        throw new Error('No evaluation run found for agent — run OpenMythos eval first');
      }
      result.eval_run_id = evalRun.id;

      // Stage 2: Detect blind spots
      stage = 'curating';
      this.updateStage(cycleId, stage);
      const blindSpots = this.detectBlindSpots(evalRun);
      result.blind_spots_detected = blindSpots.map(b => b.category);

      // Stage 3: Bridge failures to memory
      const bridgeResult = this.memoryBridge.bridgeEvalToMemory(
        cycleId,
        evalRun.id,
        evalRun.results.map(r => ({
          caseId: r.caseId,
          category: r.category,
          difficulty: r.difficulty,
          response: r.response,
          judgeScore: r.judgeScore,
          judgeRationale: r.judgeRationale,
          status: r.status as 'completed' | 'failed' | 'skipped',
        })),
        this.config.failure_threshold
      );
      result.memories_created = bridgeResult.memories_created;
      result.memories_consolidated = bridgeResult.memories_consolidated;

      // Stage 4: Generate new cases from failures
      stage = 'generating';
      this.updateStage(cycleId, stage);
      const failedCases = evalRun.results
        .filter(r => r.judgeScore < this.config.failure_threshold && r.status === 'completed')
        .map(r => ({
          id: r.caseId,
          category: r.category,
          subcategory: 'original',
          difficulty: r.difficulty,
          prompt: r.response,
          expected_behavior: '',
          failure_mode: r.judgeRationale,
          rationale: '',
        }));

      const caseScores = evalRun.results.map(r => ({
        caseId: r.caseId,
        score: r.judgeScore,
        category: r.category,
        response: r.response,
      }));

      const generatedCases = this.caseGenerator.generateFromFailures(
        failedCases,
        caseScores,
        this.config.max_generated_cases_per_cycle
      );
      result.cases_generated = generatedCases.length;
      this.persistGeneratedCases(cycleId, generatedCases);

      // Stage 5: Update judge rubrics from patterns
      stage = 'updating_judge';
      this.updateStage(cycleId, stage);
      const categoryScores = this.computeCategoryTrends(evalRun);
      const judgeResult = this.judgeUpdater.updateRubricsFromPatterns(
        categoryScores,
        this.config.judge_update_min_evidence
      );
      result.judge_rubrics_updated = judgeResult.rubrics_updated;

      // Stage 6: Adapt curriculum
      stage = 'adapting_curriculum';
      this.updateStage(cycleId, stage);
      const curriculumResult = this.curriculumAdapter.adaptFromBlindSpots(
        blindSpots,
        evalRun.categoryScores
      );
      result.curriculum_phases_adjusted = curriculumResult.phases_adjusted;

      // Stage 7: Record governance feedback from patterns
      stage = 'consolidating';
      this.updateStage(cycleId, stage);
      const rulesUpdated = this.recordGovernanceFeedback(blindSpots, evalRun);
      result.rules_updated = rulesUpdated;

      // Stage 8: Compute score delta (improvement measurement)
      const previousRun = this.getPreviousEvalRun(agentId, evalRun.id);
      if (previousRun) {
        result.score_delta = evalRun.overallScore - previousRun.overallScore;
      }

      stage = 'completed';
      result.status = 'completed';
      result.stage = stage;
      result.completed_at = new Date().toISOString();

    } catch (err) {
      stage = 'failed';
      result.status = 'failed';
      result.stage = stage;
      result.errors.push(err instanceof Error ? err.message : String(err));
      result.completed_at = new Date().toISOString();
    }

    this.persistResult(cycleId, result);
    swarmEventBus.emit('segml:cycle:complete', {
      cycleId,
      agentId,
      status: result.status,
      memories_created: result.memories_created,
      cases_generated: result.cases_generated,
      score_delta: result.score_delta,
    });

    return result;
  }

  private getLatestEvalRun(agentId: string): EvalRunSummary | null {
    const run = this.db.prepare(`
      SELECT id, agent_id, overall_score, category_scores, metadata
      FROM openmythos_eval_runs
      WHERE agent_id = ? AND status = 'completed'
      ORDER BY finished_at DESC LIMIT 1
    `).get(agentId) as any;

    if (!run) return null;

    const results = this.db.prepare(`
      SELECT case_id, category, difficulty, response, judge_score, judge_rationale, status
      FROM openmythos_case_results
      WHERE run_id = ?
    `).all(run.id) as Array<{
      case_id: string; category: string; difficulty: number;
      response: string; judge_score: number; judge_rationale: string; status: string;
    }>;

    return {
      id: run.id,
      agentId: run.agent_id,
      overallScore: run.overall_score,
      categoryScores: JSON.parse(run.category_scores || '{}'),
      results: results.map(r => ({
        caseId: r.case_id,
        category: r.category,
        difficulty: r.difficulty,
        response: r.response,
        judgeScore: r.judge_score,
        judgeRationale: r.judge_rationale,
        status: r.status,
      })),
    };
  }

  private getPreviousEvalRun(agentId: string, currentId: string): EvalRunSummary | null {
    const run = this.db.prepare(`
      SELECT id, agent_id, overall_score, category_scores
      FROM openmythos_eval_runs
      WHERE agent_id = ? AND status = 'completed' AND id != ?
      ORDER BY finished_at DESC LIMIT 1
    `).get(agentId, currentId) as any;

    if (!run) return null;
    return {
      id: run.id,
      agentId: run.agent_id,
      overallScore: run.overall_score,
      categoryScores: JSON.parse(run.category_scores || '{}'),
      results: [],
    };
  }

  private detectBlindSpots(evalRun: EvalRunSummary): BlindSpot[] {
    const spots: BlindSpot[] = [];
    const categoryScores = new Map<string, number[]>();

    for (const result of evalRun.results) {
      const existing = categoryScores.get(result.category) || [];
      existing.push(result.judgeScore);
      categoryScores.set(result.category, existing);
    }

    for (const [category, scores] of categoryScores) {
      if (scores.length < this.config.min_cases_for_pattern) continue;
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

      if (avg < 3.0) {
        const severity = avg < 1.5 ? 'critical' : avg < 2.0 ? 'high' : avg < 2.5 ? 'medium' : 'low';
        spots.push({
          category,
          avg_score: avg,
          case_count: scores.length,
          severity,
          recommendation: severity === 'critical'
            ? `Immediate attention: ${category} scores ${avg.toFixed(2)}/5 — generate targeted training cases`
            : `Monitor: ${category} scores ${avg.toFixed(2)}/5 — consider curriculum adjustment`,
        });
      }
    }

    return spots.sort((a, b) => a.avg_score - b.avg_score);
  }

  private computeCategoryTrends(evalRun: EvalRunSummary): Array<{
    category: string;
    avgScore: number;
    caseCount: number;
    trend: 'improving' | 'stable' | 'declining';
  }> {
    const byCategory = new Map<string, number[]>();
    for (const result of evalRun.results) {
      const existing = byCategory.get(result.category) || [];
      existing.push(result.judgeScore);
      byCategory.set(result.category, existing);
    }

    return Array.from(byCategory.entries()).map(([category, scores]) => {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const firstHalf = scores.slice(0, Math.floor(scores.length / 2));
      const secondHalf = scores.slice(Math.floor(scores.length / 2));
      const firstAvg = firstHalf.length > 0 ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : avg;
      const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : avg;

      let trend: 'improving' | 'stable' | 'declining' = 'stable';
      if (secondAvg - firstAvg > 0.3) trend = 'improving';
      else if (firstAvg - secondAvg > 0.3) trend = 'declining';

      return { category, avgScore: avg, caseCount: scores.length, trend };
    });
  }

  private recordGovernanceFeedback(blindSpots: BlindSpot[], _evalRun: EvalRunSummary): number {
    let count = 0;
    for (const spot of blindSpots) {
      if (spot.severity === 'high' || spot.severity === 'critical') {
        this.feedback.recordFeedback({
          source: 'openmythos_case',
          category: spot.category,
          originalDecision: `Agent scored ${spot.avg_score.toFixed(2)} on ${spot.category}`,
          correctedDecision: `Requires improvement in ${spot.category}`,
          reason: spot.recommendation,
          confidence: Math.min(0.95, spot.case_count * 0.15),
        });
        count++;
      }
    }
    return count;
  }

  private persistGeneratedCases(cycleId: string, cases: GeneratedCase[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO segml_generated_cases
      (id, cycle_id, parent_case_id, category, subcategory, difficulty, prompt, expected_behavior, failure_mode, rationale, generation_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of cases) {
      stmt.run(c.id, cycleId, c.parent_case_id, c.category, c.subcategory, c.difficulty, c.prompt, c.expected_behavior, c.failure_mode, c.rationale, c.generation_method);
    }
  }

  private updateStage(cycleId: string, stage: SegmlStage): void {
    this.db.prepare('UPDATE segml_cycles SET stage = ? WHERE id = ?').run(stage, cycleId);
  }

  private persistResult(cycleId: string, result: SegmlCycleResult): void {
    this.db.prepare(`
      UPDATE segml_cycles SET
        completed_at = ?, status = ?, stage = ?,
        memories_created = ?, memories_consolidated = ?,
        cases_generated = ?, rules_updated = ?,
        judge_rubrics_updated = ?, curriculum_phases_adjusted = ?,
        score_delta = ?, blind_spots_json = ?, errors_json = ?
      WHERE id = ?
    `).run(
      result.completed_at, result.status, result.stage,
      result.memories_created, result.memories_consolidated,
      result.cases_generated, result.rules_updated,
      result.judge_rubrics_updated, result.curriculum_phases_adjusted,
      result.score_delta, JSON.stringify(result.blind_spots_detected), JSON.stringify(result.errors),
      cycleId
    );
  }

  getCycleHistory(limit = 20): SegmlCycleResult[] {
    const rows = this.db.prepare(`
      SELECT * FROM segml_cycles ORDER BY started_at DESC LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
      id: r.id,
      started_at: r.started_at,
      completed_at: r.completed_at,
      status: r.status,
      stage: r.stage,
      eval_run_id: r.eval_run_id,
      memories_created: r.memories_created,
      memories_consolidated: r.memories_consolidated,
      cases_generated: r.cases_generated,
      rules_updated: r.rules_updated,
      judge_rubrics_updated: r.judge_rubrics_updated,
      curriculum_phases_adjusted: r.curriculum_phases_adjusted,
      score_delta: r.score_delta,
      blind_spots_detected: JSON.parse(r.blind_spots_json || '[]'),
      errors: JSON.parse(r.errors_json || '[]'),
    }));
  }

  getLatestCycle(): SegmlCycleResult | null {
    const history = this.getCycleHistory(1);
    return history[0] || null;
  }
}
