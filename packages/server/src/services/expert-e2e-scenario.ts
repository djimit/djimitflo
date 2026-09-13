/**
 * Reference end-to-end scenario (§59) on the synthetic benchmark fixture.
 *
 * Runs the full frontier path — decomposition → evidence-backed expert resolution (WHY_SELECTED) →
 * independent perspectives → claim reconstruction → agreement/disagreement → uncertainty → falsification →
 * adversarial review → Judge/checker → provenance → governed (non-)promotion — and evaluates each §59
 * requirement as a named check. The perspective runner is injectable; the default is a scripted,
 * evidence-bound fake model so the scenario is reproducible offline. It is NOT a proof of model quality:
 * a live-model run needs FRONTIER_EXPERTS_RUNTIME and the provider module (see GAP_REGISTER.md).
 */

import type { Database } from 'better-sqlite3';
import { FrontierExpertRegistryService } from './frontier-expert-registry-service';
import { ExpertCouncilService, type PerspectiveRunner } from './expert-council-service';
import { ExpertSwarmOrchestrator, type ExpertSwarmResult } from './expert-swarm-orchestrator';
import { seedBenchmarkFixture } from './expert-resolution-benchmark';

export const REFERENCE_QUESTION = "Assess whether autonomous recursive AI research materially changes the security, governance and technical requirements of DjimitFlo's self-improvement architecture.";

const STANCE: Record<string, string> = {
  'recursive self improvement': 'each self-improvement step must pass a corrigibility check before deployment',
  'automated ai research': 'autonomous research agents need isolated experiment budgets and reproducible logs',
  'ai security': 'self-modifying code paths require sandboxing and weight-exfiltration controls',
  'ai governance': 'a human approval gate must sit on every promotion of self-generated knowledge',
  'model control': 'trusted monitors must review untrusted self-improvement proposals',
  'frontier risk': 'capability jumps from recursive research must trigger a frontier-safety review',
  'coordination mechanisms': 'self-improvement releases need coordination with other frontier operators',
};

/** Scripted, evidence-bound fake model: answers only from the evidence it is shown; one expert dissents; one impersonates. */
export const scriptedRunner: PerspectiveRunner = async (role, system, user) => {
  if (role === 'adversary') {
    const ids = [...user.matchAll(/"claim_id": "([^"]+)"/g)].map((match) => match[1]);
    return { attacks: ids.slice(0, 2).map((id) => ({ claim_id: id, attack: 'Single-source evidence; no independent replication of the requirement.', evidence_gap: 'No red-team result on a running self-improvement loop.' })) };
  }
  const name = system.match(/Synthetic ([a-z -]+) researcher (\d)/i);
  const family = name?.[1] ?? 'unknown';
  const ordinal = name?.[2] ?? '1';
  const shown = [...user.matchAll(/id=(evidence:[a-f0-9]+)/g)].map((match) => match[1]);
  if (family === 'ai security' && ordinal === '2') {
    return { analysis: `As Synthetic ai security researcher 2, I personally believe sandboxing is unnecessary.`, claims: [], uncertainties: [], falsification: '', evidence_refs: shown };
  }
  const dissent = family === 'recursive self improvement' && ordinal === '2';
  return {
    analysis: `The documented work on ${family} ${dissent ? 'does not show' : 'indicates'} that autonomous recursive research materially changes the requirements: ${STANCE[family] ?? 'requirements follow from the cited evidence'}.`,
    claims: [
      { subject: 'autonomous recursive ai research', relation: 'materially changes', object: 'self-improvement requirements', polarity: dissent ? 'denies' : 'asserts', evidence_refs: [shown[0]], confidence: dissent ? 0.6 : 0.8 },
      { subject: family, relation: 'requires', object: STANCE[family] ?? 'evidence-backed requirement', polarity: 'asserts', evidence_refs: shown.slice(0, 2), confidence: 0.75 },
      { subject: 'a named lab', relation: 'has already deployed', object: 'unsupervised recursive self-improvement', polarity: 'asserts', evidence_refs: ['evidence:fabricated'], confidence: 0.9 },
    ],
    uncertainties: [`Evidence for ${family} (researcher ${ordinal}) comes from ${shown.length} item(s); generalisation to DjimitFlo's architecture is untested.`],
    falsification: dissent ? 'Run the current self-improvement loop with and without the proposed controls and compare incident rates.' : `Show a self-improvement loop where ${STANCE[family] ?? 'the requirement'} is absent and no security or governance incident occurs.`,
    evidence_refs: shown,
  };
};

export interface ScenarioCheck { requirement: string; ok: boolean; detail: string }
export interface ScenarioReport { question: string; result: ExpertSwarmResult; checks: ScenarioCheck[]; passed: boolean }

export async function runReferenceScenario(db: Database, runner: PerspectiveRunner = scriptedRunner, runtimeLabel = 'scripted-fake'): Promise<ScenarioReport> {
  const registry = new FrontierExpertRegistryService(db);
  seedBenchmarkFixture(db, registry);
  const council = new ExpertCouncilService(db, { registry, runner, runtimeLabel });
  const orchestrator = new ExpertSwarmOrchestrator(db, { council });
  const result = await orchestrator.dispatch({ topic: REFERENCE_QUESTION, domains: [], expertSelection: { force: true, adversarial: true, maxExperts: 7 } });
  const c = result.council!;
  const families = new Set(c.resolution.capabilities.map((capability) => capability.id));
  const knownEvidence = new Set((db.prepare('SELECT id FROM expert_evidence').all() as Array<{ id: string }>).map((row) => row.id));
  const allRefsKnown = c.claims.every((claim) => claim.evidence_refs.length > 0 && claim.evidence_refs.every((ref) => knownEvidence.has(ref)));
  const provenance = c.perspectives.map((perspective) => registry.provenance(perspective.expert_id));
  const candidate = result.knowledge_candidate_id ? db.prepare('SELECT status, promotion_status, human_required FROM memory_candidates WHERE id = ?').get(result.knowledge_candidate_id) as { status: string; promotion_status: string; human_required: number } : null;
  const checks: ScenarioCheck[] = [
    { requirement: 'decompose into capabilities', ok: families.size >= 3, detail: [...families].join(', ') },
    { requirement: 'identify required capability families', ok: ['recursive_self_improvement', 'ai_security', 'ai_governance'].every((id) => families.has(id)), detail: 'recursive_self_improvement, ai_security, ai_governance expected' },
    { requirement: 'retrieve evidence-backed experts with WHY_SELECTED', ok: c.perspectives.length >= 3 && c.perspectives.every((perspective) => perspective.why_selected.includes('primary-source') && perspective.output.evidence_refs.length > 0), detail: `${c.perspectives.length} perspectives, ${c.resolution.experts.length} experts resolved` },
    { requirement: 'retrieve high-quality evidence', ok: c.resolution.experts.every((expert) => expert.evidence.some((item) => item.tier === 1)), detail: 'every resolved expert has Tier-1 evidence' },
    { requirement: 'analyze independently', ok: c.perspectives.every((perspective) => perspective.runtime === runtimeLabel), detail: 'one isolated prompt per expert (independence asserted in expert-council.test.ts)' },
    { requirement: 'reconstruct claims', ok: c.claims.length >= 6 && allRefsKnown, detail: `${c.claims.length} claims, all evidence refs resolve` },
    { requirement: 'identify agreement', ok: c.agreements.length >= 1, detail: c.agreements.map((item) => `${item.proposition} × ${item.expert_ids.length}`).join('; ') },
    { requirement: 'identify disagreement', ok: c.disagreements.length >= 1, detail: c.disagreements.map((item) => item.proposition).join('; ') },
    { requirement: 'expose uncertainty', ok: c.uncertainties.length >= c.perspectives.length, detail: `${c.uncertainties.length} uncertainties` },
    { requirement: 'falsify', ok: c.perspectives.every((perspective) => perspective.output.falsification.length > 20) && (c.adversarial?.attacks.length ?? 0) >= 1, detail: `${c.adversarial?.attacks.length ?? 0} adversarial attacks on persisted claims` },
    { requirement: 'security analysis', ok: c.perspectives.some((perspective) => /ai security/.test(perspective.canonical_name)), detail: 'AI-security expert perspective present' },
    { requirement: 'governance analysis', ok: c.perspectives.some((perspective) => /ai governance/.test(perspective.canonical_name)), detail: 'AI-governance expert perspective present' },
    { requirement: 'synthesize', ok: result.expert_answers.length === c.perspectives.length && result.verdict.reasoning.length > 0, detail: `${result.expert_answers.length} answers judged` },
    { requirement: 'Judge/check', ok: result.promotion_decision !== 'VERIFIED_FOR_USE' && result.verdict.contradictions.length >= 1, detail: `promotion_decision ${result.promotion_decision}, score ${result.verdict.score}` },
    { requirement: 'produce provenance', ok: provenance.every((item) => item.length > 0 && item.every((capability) => capability.evidence.length > 0)), detail: 'every perspective expert has capability → evidence provenance' },
    { requirement: 'refuse unsupported personal attribution', ok: c.unsupported_attribution_count === 0 && c.perspectives.every((perspective) => perspective.dropped_refs.includes('evidence:fabricated')) && c.rejected_perspectives.some((item) => item.reason === 'PERSPECTIVE_OUTPUT_IMPERSONATES_EXPERT'), detail: `fabricated ref dropped in ${c.perspectives.length} perspectives; ${c.rejected_perspectives.length} impersonating perspective rejected` },
    { requirement: 'promote durable knowledge only when permitted', ok: result.knowledge_updated === false && result.promotion_decision === 'CONTRADICTED' && candidate === null, detail: 'contradicted council → nothing enters the review queue' },
  ];
  return { question: REFERENCE_QUESTION, result, checks, passed: checks.every((check) => check.ok) };
}

export function renderScenario(report: ScenarioReport): string {
  const c = report.result.council!;
  return [
    `Question: ${report.question}`, '', '| §59 requirement | status | detail |', '|---|---|---|',
    ...report.checks.map((check) => `| ${check.requirement} | ${check.ok ? 'PASS' : 'FAIL'} | ${check.detail} |`), '',
    `Resolved experts: ${c.resolution.experts.map((expert) => `${expert.canonical_name} (${expert.capabilities.map((capability) => capability.id).join('+')}, score ${expert.score})`).join('; ')}`,
    `Rejected perspectives: ${c.rejected_perspectives.map((item) => `${item.expert_id} ${item.reason}`).join('; ') || 'none'}`,
    `Claims ${c.claims.length}, relations ${c.relations.length}, agreements ${c.agreements.length}, disagreements ${c.disagreements.length}, attacks ${c.adversarial?.attacks.length ?? 0}`,
    `Judge: ${report.result.promotion_decision}, knowledge_updated ${report.result.knowledge_updated}`, '',
    `Scenario: **${report.passed ? 'PASSED' : 'FAILED'}** (runtime ${c.perspectives[0]?.runtime ?? 'none'})`,
  ].join('\n');
}
