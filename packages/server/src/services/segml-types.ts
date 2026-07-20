/**
 * SEGML — Self-Evolving Governance Memory Loop
 *
 * Shared types for the self-improving governance subsystem.
 * Bridges OpenMythos evaluation, Memory evolution, and Governance feedback
 * into a unified learning cycle (arXiv 2607.13104 §5.1+§5.2+§6.2+§6.3).
 */

export interface SegmlCycleResult {
  id: string;
  started_at: string;
  completed_at: string;
  status: 'completed' | 'failed' | 'partial';
  stage: SegmlStage;
  eval_run_id: string | null;
  memories_created: number;
  memories_consolidated: number;
  cases_generated: number;
  rules_updated: number;
  judge_rubrics_updated: number;
  curriculum_phases_adjusted: number;
  score_delta: number;
  blind_spots_detected: string[];
  errors: string[];
}

export type SegmlStage =
  | 'idle'
  | 'evaluating'
  | 'curating'
  | 'reflecting'
  | 'generating'
  | 'consolidating'
  | 'updating_judge'
  | 'adapting_curriculum'
  | 'validating'
  | 'meta_evaluating'
  | 'completed'
  | 'failed';

export interface BlindSpot {
  category: string;
  avg_score: number;
  case_count: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  recommendation: string;
}

export interface GeneratedCase {
  id: string;
  parent_case_id: string;
  category: string;
  subcategory: string;
  difficulty: number;
  prompt: string;
  expected_behavior: string;
  failure_mode: string;
  rationale: string;
  generation_method: 'mutation' | 'complexity_elevation' | 'cross_category' | 'adversarial';
}

export interface GovernanceRule {
  id: string;
  category: string;
  pattern: string;
  source: 'consolidated_failures' | 'reflection_pattern' | 'meta_evolution';
  confidence: number;
  applied: boolean;
  created_at: string;
}

export interface JudgeRubricUpdate {
  category: string;
  previous_weight: number;
  new_weight: number;
  rationale: string;
  evidence_count: number;
}

export interface CurriculumPhaseAdjustment {
  phase: number;
  previous_categories: string[];
  new_categories: string[];
  reason: string;
}

export interface SegmlConfig {
  failure_threshold: number;
  min_cases_for_pattern: number;
  max_generated_cases_per_cycle: number;
  consolidation_confidence_threshold: number;
  judge_update_min_evidence: number;
  validation_enabled: boolean;
  rollback_on_no_improvement: boolean;
}

export const DEFAULT_SEGML_CONFIG: SegmlConfig = {
  failure_threshold: 2.5,
  min_cases_for_pattern: 5,
  max_generated_cases_per_cycle: 20,
  consolidation_confidence_threshold: 0.6,
  judge_update_min_evidence: 3,
  validation_enabled: true,
  rollback_on_no_improvement: true,
};
