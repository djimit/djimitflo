import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { SkillLoaderService } from './skill-loader-service';
import type { OpenMythosEvalService, EvalRunResult } from './openmythos-eval-service';
import { OpenMythosEvalService as OpenMythosEvalServiceImpl } from './openmythos-eval-service';
import { COMPLETED_UNVERIFIED_REF, DELIVERED_ATTRIBUTION_SQL } from './skill-evolution-engine';

/**
 * A source outcome is a verified, delivered one in main's attribution model (INT-004 receipt ref `skill_delivery:delivered`
 * + passed task verification), never a bare process exit.
 */
export const verifiedDeliveredOutcomeSql = (): string => `success = 1 AND ${DELIVERED_ATTRIBUTION_SQL}
  AND evidence_refs_json NOT LIKE '%"${COMPLETED_UNVERIFIED_REF}"%'`; // a function: the import cycle via swarm-intelligence-service


type Candidate = {
  id: string; skill_id: string; version: string; content_hash: string; source_package_hash: string;
  parent_hash: string; instructions: string; capability_id: string | null; created_by: string;
  lifecycle: string; created_at: string; origin_task_id: string; source_outcome_id: string;
};

export class SkillArtifactEvolutionService {
  constructor(private db: Database) {
    // SkillEvolutionEngine owns creation and compatibility migration of these tables.
    this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_artifact_versions'").get();
  }

  createCandidate(input: {
    loader: SkillLoaderService; skillId: string; baselineHash: string;
    find: string; replace: string; actor: string; sourceTaskId: string;
  }): Candidate {
    const skill = input.loader.getSkill(input.skillId);
    if (!skill || !input.actor.trim()) throw new Error('SKILL_EVOLUTION_SKILL_OR_ACTOR_REQUIRED');
    if (skill.contentHash !== input.baselineHash) throw new Error('SKILL_EVOLUTION_BASELINE_HASH_MISMATCH');
    const sourceOutcome = this.db.prepare(`SELECT id, skill_version FROM skill_outcomes
      WHERE task_id = ? AND skill_id = ? AND skill_content_hash = ? AND skill_version IS NOT NULL AND ${verifiedDeliveredOutcomeSql()}
      ORDER BY created_at DESC LIMIT 1`).get(input.sourceTaskId, input.skillId, input.baselineHash) as { id: string; skill_version: string } | undefined;
    if (!sourceOutcome) throw new Error('SKILL_EVOLUTION_DELIVERED_SOURCE_OUTCOME_REQUIRED');
    const verifiedBaseline = (this.db.prepare(`SELECT metadata FROM openmythos_eval_runs
      WHERE agent_id = ? AND status = 'completed' AND completed_cases = total_cases ORDER BY finished_at DESC`).all(input.skillId) as Array<{ metadata: string }>)
      .some((row) => {
        try {
          const metadata = JSON.parse(row.metadata || '{}');
          return metadata.evaluation_mode === 'skill_conditioned_prompt' && metadata.skill_id === skill.id
            && metadata.skill_version === sourceOutcome.skill_version && metadata.skill_content_hash === input.baselineHash
            && metadata.score_valid === true && metadata.certification_eligible === true;
        } catch { return false; }
      });
    if (!verifiedBaseline) throw new Error('SKILL_EVOLUTION_CERTIFIED_BASELINE_EVALUATION_REQUIRED');
    if (!input.find || !input.replace || input.find === input.replace || input.find.length > 2_000 || input.replace.length > 2_000) {
      throw new Error('SKILL_EVOLUTION_PATCH_INVALID');
    }
    const first = skill.instructions.indexOf(input.find);
    if (first < 0 || skill.instructions.indexOf(input.find, first + input.find.length) >= 0) {
      throw new Error('SKILL_EVOLUTION_PATCH_ANCHOR_MUST_MATCH_ONCE');
    }
    const instructions = skill.instructions.slice(0, first) + input.replace + skill.instructions.slice(first + input.find.length);
    if (instructions.length > 20_000) throw new Error('SKILL_EVOLUTION_SKILL_SIZE_LIMIT');
    const parentHash = skill.contentHash;
    const contentHash = createHash('sha256').update(JSON.stringify({ parentHash, instructions })).digest('hex');
    if (this.db.prepare('SELECT 1 FROM skill_artifact_versions WHERE skill_id = ? AND content_hash = ?').get(skill.id, contentHash)) {
      throw new Error('SKILL_EVOLUTION_DUPLICATE_CANDIDATE');
    }
    const variants = Number((this.db.prepare('SELECT COUNT(*) AS count FROM skill_artifact_versions WHERE skill_id = ? AND parent_hash = ? AND candidate_id IS NOT NULL').get(skill.id, parentHash) as { count: number }).count);
    if (variants >= 2) throw new Error('SKILL_EVOLUTION_CANDIDATE_VARIANT_LIMIT');
    const generation = Number((this.db.prepare('SELECT COUNT(*) AS count FROM skill_artifact_versions WHERE skill_id = ?').get(skill.id) as { count: number }).count);
    const version = `${skill.version}+evo.${generation}`;
    const id = randomUUID();
    const sourcePackageHash = skill.sourcePackageHash || skill.contentHash;
    const createdAt = new Date().toISOString();
    const insert = this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO skill_artifact_versions
        (skill_id, version, content_hash, source_package_hash, parent_hash, instructions, lifecycle, created_by, created_at)
        VALUES (?, ?, ?, ?, NULL, ?, 'active', 'baseline', ?)`)
        .run(skill.id, skill.version, sourcePackageHash, sourcePackageHash, skill.instructions, createdAt);
      this.db.prepare(`INSERT INTO skill_artifact_versions
        (skill_id, version, content_hash, source_package_hash, parent_hash, instructions, lifecycle, candidate_id, created_by, created_at, origin_task_id, source_outcome_id)
        VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?)`)
        .run(skill.id, version, contentHash, sourcePackageHash, parentHash, instructions, id, input.actor, createdAt, input.sourceTaskId, sourceOutcome.id);
    });
    insert();
    return { id, skill_id: skill.id, version, content_hash: contentHash, source_package_hash: sourcePackageHash,
      parent_hash: parentHash, instructions, capability_id: null, created_by: input.actor, lifecycle: 'candidate', created_at: createdAt,
      origin_task_id: input.sourceTaskId, source_outcome_id: sourceOutcome.id };
  }

  bindCapability(candidateId: string, capabilityId: string): void {
    const result = this.db.prepare(`UPDATE skill_artifact_versions SET capability_id = ? WHERE candidate_id = ? AND lifecycle = 'candidate'`)
      .run(capabilityId, candidateId);
    if (result.changes !== 1) throw new Error('SKILL_EVOLUTION_CANDIDATE_NOT_FOUND');
  }

  async compare(candidateId: string, loader: SkillLoaderService, evals: OpenMythosEvalService,
    input: { model: string; caseIds: string[]; actor: string }): Promise<Record<string, unknown>> {
    const candidate = this.getCandidate(candidateId);
    const baseline = loader.getSkill(candidate.skill_id);
    if (!baseline || baseline.contentHash !== candidate.parent_hash) throw new Error('SKILL_EVOLUTION_BASELINE_CHANGED');
    if (!input.actor.trim() || !input.model.trim() || !input.caseIds.length || input.caseIds.length > 100 || new Set(input.caseIds).size !== input.caseIds.length) {
      throw new Error('SKILL_EVOLUTION_EVALUATION_CONTRACT_INVALID');
    }
    const baseRun = await evals.runEval(candidate.skill_id, undefined, input.model, input.caseIds, {
        kind: 'skill', id: candidate.skill_id, version: baseline.version, contentHash: baseline.contentHash, instructions: baseline.instructions,
      });
    const candidateRun = await evals.runEval(candidate.skill_id, undefined, input.model, input.caseIds, {
        kind: 'skill', id: candidate.skill_id, version: candidate.version, contentHash: candidate.content_hash, instructions: candidate.instructions,
      });
    // The evaluator build is pinned on the comparison, not on the OpenMythos run receipt (a build hash never enters run
    // metadata, E01): both runs execute in this process, so they share this build by construction.
    const evaluatorBuildSha = process.env.DJIMITFLO_BUILD_SHA?.trim() || null;
    const result = this.classifyComparison(baseRun, candidateRun, candidate, evaluatorBuildSha);
    (result.manifest as Record<string, unknown>).evaluated_by = input.actor;
    const comparisonId = randomUUID();
    this.db.prepare(`INSERT INTO skill_evolution_comparisons
      (id, candidate_id, baseline_eval_id, candidate_eval_id, verdict, reason, baseline_score, candidate_score, case_results_json, manifest_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(comparisonId, candidate.id, baseRun.id, candidateRun.id, result.verdict, result.reason,
        baseRun.overallScore, candidateRun.overallScore, JSON.stringify(result.cases), JSON.stringify(result.manifest), new Date().toISOString());
    return { id: comparisonId, candidate_id: candidate.id, baseline_eval_id: baseRun.id, candidate_eval_id: candidateRun.id,
      verdict: result.verdict, reason: result.reason, baseline_score: baseRun.overallScore,
      candidate_score: candidateRun.overallScore, cases: result.cases, manifest: result.manifest,
      known_cost: null, cost_status: 'unknown' };
  }

  latestComparison(candidateId: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM skill_evolution_comparisons WHERE candidate_id = ? ORDER BY rowid DESC LIMIT 1').get(candidateId) as any;
    return row ? { id: row.id, candidate_id: row.candidate_id, baseline_eval_id: row.baseline_eval_id,
      candidate_eval_id: row.candidate_eval_id, verdict: row.verdict, reason: row.reason,
      baseline_score: row.baseline_score, candidate_score: row.candidate_score,
      cases: JSON.parse(row.case_results_json), manifest: JSON.parse(row.manifest_json) } : null;
  }

  requirePassingComparison(candidate: Candidate): void {
    const comparison = this.latestComparison(candidate.id);
    if (!comparison || comparison.verdict !== 'PASS') throw new Error('SKILL_EVOLUTION_PAIRED_EVALUATION_REQUIRED');
  }

  requireCandidateComparison(candidateId: string): void {
    this.requirePassingComparison(this.getCandidate(candidateId));
    const comparison = this.latestComparison(candidateId)! as any;
    let identity;
    try { identity = new OpenMythosEvalServiceImpl(this.db).getCurrentEvaluationIdentity(); }
    catch { throw new Error('SKILL_EVOLUTION_EVALUATION_IDENTITY_UNAVAILABLE'); }
    const baseline = comparison.manifest.baseline;
    const candidate = comparison.manifest.candidate;
    const currentSubjectDigest = process.env.OPENMYTHOS_SUBJECT_MODEL_DIGEST?.trim();
    const currentJudgeDigest = process.env.OPENMYTHOS_JUDGE_MODEL_DIGEST?.trim();
    // OpenMythos always judges on Ollama (there is no JudgeService path; OPENMYTHOS_USE_JUDGE_SERVICE changes nothing).
    const currentJudgeBackend = 'ollama';
    const currentJudgeModel = process.env.OPENMYTHOS_JUDGE_MODEL || 'qwen2.5:14b-instruct-q4_K_M';
    const judgeDigestMatches = currentJudgeDigest && baseline.judge_model_digest === currentJudgeDigest;
    if (identity.corpus_sha256 !== baseline.corpus_sha256 || identity.corpus_version !== baseline.corpus_version
      || identity.oracle_anchors_sha256 !== baseline.oracle_anchors_sha256
      || !identity.evaluator_build_sha || identity.evaluator_build_sha !== comparison.manifest.evaluator_build_sha
      || !currentSubjectDigest || currentSubjectDigest !== baseline.subject_model_digest
      || baseline.judge_backend !== currentJudgeBackend || baseline.judge_model !== currentJudgeModel
      || baseline.subject_model_digest !== candidate.subject_model_digest || !judgeDigestMatches) {
      throw new Error('SKILL_EVOLUTION_EVALUATION_IDENTITY_STALE');
    }
  }

  activate(candidateId: string): void {
    const candidate = this.getCandidate(candidateId);
    if (candidate.lifecycle !== 'candidate') throw new Error('SKILL_EVOLUTION_CANDIDATE_NOT_ACTIVEABLE');
    this.requireCandidateComparison(candidateId);
    const activate = this.db.transaction(() => {
      this.db.prepare("UPDATE skill_artifact_versions SET lifecycle = 'approved' WHERE skill_id = ? AND lifecycle = 'active'").run(candidate.skill_id);
      const result = this.db.prepare("UPDATE skill_artifact_versions SET lifecycle = 'active', activated_at = ? WHERE candidate_id = ? AND lifecycle = 'candidate'")
        .run(new Date().toISOString(), candidateId);
      if (result.changes !== 1) throw new Error('SKILL_EVOLUTION_CANDIDATE_NOT_FOUND');
    });
    activate();
  }

  rollback(candidateId: string): Record<string, unknown> {
    const candidate = this.getCandidate(candidateId);
    if (candidate.lifecycle !== 'active') throw new Error('SKILL_EVOLUTION_VERSION_NOT_ACTIVE');
    const restore = this.db.prepare("SELECT * FROM skill_artifact_versions WHERE skill_id = ? AND content_hash = ? AND lifecycle = 'approved'")
      .get(candidate.skill_id, candidate.parent_hash) as any;
    if (!restore) throw new Error('SKILL_EVOLUTION_PREVIOUS_VERSION_UNAVAILABLE');
    this.db.transaction(() => {
      this.db.prepare("UPDATE skill_artifact_versions SET lifecycle = 'revoked' WHERE candidate_id = ?").run(candidateId);
      this.db.prepare("UPDATE skill_artifact_versions SET lifecycle = 'active', activated_at = ? WHERE skill_id = ? AND content_hash = ?")
        .run(new Date().toISOString(), candidate.skill_id, candidate.parent_hash);
    })();
    return { skill_id: candidate.skill_id, active_version: restore.version, active_hash: restore.content_hash,
      revoked_version: candidate.version, external_effects_reversed: false };
  }

  private getCandidate(id: string): Candidate {
    const row = this.db.prepare('SELECT candidate_id AS id, * FROM skill_artifact_versions WHERE candidate_id = ?').get(id) as Candidate | undefined;
    if (!row) throw new Error('SKILL_EVOLUTION_CANDIDATE_NOT_FOUND');
    return row;
  }

  getCandidateById(id: string): Record<string, unknown> {
    const candidate = this.getCandidate(id);
    return { id: candidate.id, skill_id: candidate.skill_id, version: candidate.version,
      content_hash: candidate.content_hash, parent_hash: candidate.parent_hash,
      capability_id: candidate.capability_id, lifecycle: candidate.lifecycle,
      created_by: candidate.created_by, created_at: candidate.created_at,
      origin_task_id: candidate.origin_task_id,
      source_outcome_id: candidate.source_outcome_id,
      comparison: this.latestComparison(candidate.id) };
  }

  private classifyComparison(baseline: EvalRunResult, candidate: EvalRunResult, artifact: Candidate, evaluatorBuildSha: string | null) {
    const baseMeta = this.runMetadata(baseline.id);
    const candidateMeta = this.runMetadata(candidate.id);
    const exactCases = (run: EvalRunResult) => run.results.map((result) => result.caseId);
    const cases = baseline.results.map((base) => {
      const changed = candidate.results.find((row) => row.caseId === base.caseId);
      return { case_id: base.caseId, baseline_status: base.status, candidate_status: changed?.status || 'missing',
        baseline_score: base.judgeScore, candidate_score: changed?.judgeScore ?? null,
        baseline_scoring_source: base.scoringSource, candidate_scoring_source: changed?.scoringSource || 'missing',
        baseline_oracle_pass: base.oraclePass ?? null, candidate_oracle_pass: changed?.oraclePass ?? null,
        oracle_regression: base.oraclePass === true && changed?.oraclePass === false };
    });
    let verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'INCONCLUSIVE';
    let reason = exactCases(baseline).length < 30 ? `paired case minimum not met: ${exactCases(baseline).length}/30` : 'evaluation evidence incomplete';
    if (baseline.status === 'completed' && candidate.status === 'completed'
      && baseline.completedCases === baseline.totalCases && candidate.completedCases === candidate.totalCases
      && JSON.stringify([...exactCases(baseline)].sort()) === JSON.stringify([...exactCases(candidate)].sort())
      && exactCases(baseline).length >= 30
      && JSON.stringify([...(baseMeta.case_ids || [])].sort()) === JSON.stringify([...exactCases(baseline)].sort())
      && JSON.stringify([...(candidateMeta.case_ids || [])].sort()) === JSON.stringify([...exactCases(candidate)].sort())
      && baseMeta.corpus_sha256 && baseMeta.corpus_sha256 === candidateMeta.corpus_sha256
      && baseMeta.corpus_version && baseMeta.corpus_version === candidateMeta.corpus_version
      && baseMeta.corpus_certification_ready === true && candidateMeta.corpus_certification_ready === true
      && baseMeta.score_valid === true && candidateMeta.score_valid === true
      && baseMeta.certification_eligible === true && candidateMeta.certification_eligible === true
      && baseMeta.subject_model === candidateMeta.subject_model
      && evaluatorBuildSha
      && baseMeta.subject_model_digest && baseMeta.subject_model_digest === candidateMeta.subject_model_digest
      && baseMeta.judge_backend === candidateMeta.judge_backend
      && baseMeta.judge_model === candidateMeta.judge_model
      && baseMeta.judge_model_digest
      && baseMeta.judge_model_digest === candidateMeta.judge_model_digest
      && baseMeta.oracle_anchors_sha256 && baseMeta.oracle_anchors_sha256 === candidateMeta.oracle_anchors_sha256
      && Number(baseMeta.oracle_anchor_cases) > 0 && Number(candidateMeta.oracle_anchor_cases) > 0
      && JSON.stringify(baseMeta.generation_options) === JSON.stringify(candidateMeta.generation_options)
      && candidateMeta.skill_content_hash === artifact.content_hash) {
      const evaluatorFailure = baseline.results.some((row) => row.scoringSource === 'error')
        || candidate.results.some((row) => row.scoringSource === 'error');
      const oracleRegression = cases.some((row) => row.oracle_regression);
      verdict = evaluatorFailure ? 'INCONCLUSIVE' : oracleRegression ? 'FAIL' : candidate.overallScore > baseline.overallScore ? 'PASS' : 'FAIL';
      reason = oracleRegression ? 'candidate regressed an oracle case'
        : evaluatorFailure ? 'a required case lacks valid evaluator evidence'
          : verdict === 'PASS' ? 'candidate scored higher on the identical pinned case set' : 'candidate did not improve the aggregate score';
    }
    return { verdict, reason, cases, manifest: { baseline: baseMeta, candidate: candidateMeta,
      baseline_run_ms: Date.parse(baseline.finishedAt) - Date.parse(baseline.startedAt),
      candidate_run_ms: Date.parse(candidate.finishedAt) - Date.parse(candidate.startedAt),
      case_ids: exactCases(baseline), candidate_case_ids: exactCases(candidate), comparison: 'same-run-settings-and-pinned-case-identities',
      evaluator_build_sha: evaluatorBuildSha } };
  }

  private runMetadata(runId: string): Record<string, any> {
    const row = this.db.prepare('SELECT metadata FROM openmythos_eval_runs WHERE id = ?').get(runId) as { metadata?: string } | undefined;
    try { return JSON.parse(row?.metadata || '{}'); } catch { return {}; }
  }
}
