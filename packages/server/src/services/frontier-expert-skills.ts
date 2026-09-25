/**
 * Frontier analysis skills (§34): fourteen procedural skills, one per capability family, written as OKF
 * skill files (`<okf>/skills/<slug>.md`) through the same frontmatter contract SkillService validates.
 * The council injects the matching procedure into an expert perspective prompt (§16), so the analysis
 * follows a declared method: required evidence, claim extraction, falsification, prohibited shortcuts.
 * Skills are installed only when absent (or with force) and never mark themselves validated.
 */

import fs from 'fs';
import path from 'path';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

export interface FrontierSkill { slug: string; title: string; capabilities: string[]; purpose: string; evidence: string; falsification: string; shortcuts: string }

export const FRONTIER_SKILLS: FrontierSkill[] = [
  { slug: 'frontier-model-analysis', title: 'Frontier model analysis', capabilities: ['frontier_model_engineering'], purpose: 'Assess claims about how frontier models are trained, served and constrained by infrastructure.', evidence: 'technical reports, system cards, training-run descriptions with dates and scale figures', falsification: 'Name the scale, data or infrastructure observation that would invalidate the claim and check whether any cited source already reports it.', shortcuts: 'inferring capability from parameter counts alone; treating marketing pages as technical reports' },
  { slug: 'scaling-analysis', title: 'Scaling analysis', capabilities: ['scaling_laws'], purpose: 'Evaluate scaling-law claims: fit ranges, extrapolation limits, compute-optimal trade-offs.', evidence: 'papers with fitted curves and their data ranges; replication attempts', falsification: 'State the extrapolation point where the law is untested and look for reported deviations.', shortcuts: 'extrapolating beyond the fitted range; ignoring data or architecture changes between runs' },
  { slug: 'reinforcement-learning-analysis', title: 'Reinforcement learning analysis', capabilities: ['reinforcement_learning', 'post_training'], purpose: 'Analyse reward design, optimisation pressure, reward hacking and exploration claims.', evidence: 'papers with reward specifications, environment descriptions and ablations', falsification: 'Identify the reward or environment change under which the reported behaviour should disappear.', shortcuts: 'reading benchmark gains as generalisation; ignoring reward-model exploitation' },
  { slug: 'agentic-systems-analysis', title: 'Agentic systems analysis', capabilities: ['agent_learning', 'multi_agent_systems', 'coordination_mechanisms'], purpose: 'Assess autonomous and multi-agent behaviour: coordination, collusion, long-horizon learning.', evidence: 'agent benchmarks with trajectories, multi-agent experiments, incident reports', falsification: 'Specify the interaction protocol change that would remove the observed coordination effect.', shortcuts: 'single-run anecdotes as evidence; ignoring communication-channel assumptions' },
  { slug: 'recursive-self-improvement-analysis', title: 'Recursive self-improvement analysis', capabilities: ['recursive_self_improvement', 'automated_ai_research'], purpose: 'Evaluate claims that systems improve their own capabilities or research, and the controls required.', evidence: 'papers on automated research loops with measured improvement per iteration and their stopping rules', falsification: 'Find the iteration count or task where measured improvement flattens or reverses.', shortcuts: 'equating automation of one step with recursive improvement; timelines without measurements' },
  { slug: 'mechanistic-interpretability-analysis', title: 'Mechanistic interpretability analysis', capabilities: ['mechanistic_interpretability'], purpose: 'Assess circuit, feature and superposition claims and what they license about model behaviour.', evidence: 'papers with causal interventions (ablation, patching) rather than correlational probes only', falsification: 'Name the intervention that should change behaviour if the circuit claim holds, and whether it was run.', shortcuts: 'treating attention visualisations as mechanism; generalising from toy models without checking scale' },
  { slug: 'alignment-analysis', title: 'Alignment analysis', capabilities: ['alignment', 'misalignment_detection'], purpose: 'Analyse alignment methods and misalignment detection claims, including deceptive behaviour.', evidence: 'papers with held-out behavioural evaluations and red-team results', falsification: 'Describe the distribution shift or adversarial setting where the alignment method is untested.', shortcuts: 'refusal rates as alignment; consensus statements as evidence' },
  { slug: 'scalable-oversight-analysis', title: 'Scalable oversight analysis', capabilities: ['scalable_oversight', 'model_control'], purpose: 'Evaluate oversight protocols (debate, weak-to-strong, control) when the overseer is weaker than the model.', evidence: 'protocol papers with judge-strength ablations and adversarial evaluations', falsification: 'Identify the judge-capability gap or adversary strength at which the protocol was not tested.', shortcuts: 'assuming honest debaters; reporting accuracy without the adversarial condition' },
  { slug: 'frontier-evaluation-analysis', title: 'Frontier evaluation analysis', capabilities: ['model_evaluations', 'safety_evaluations'], purpose: 'Assess evaluation validity: contamination, sandbagging, elicitation, measurement error.', evidence: 'evaluation reports with elicitation methods, contamination checks and confidence intervals', falsification: 'State the elicitation or contamination check whose absence would overturn the score.', shortcuts: 'leaderboard positions as capability; single-prompt evaluations' },
  { slug: 'ai-security-analysis', title: 'AI security analysis', capabilities: ['ai_security', 'model_resilience'], purpose: 'Analyse threat models for models and agents: prompt injection, weight theft, tampering.', evidence: 'security papers with adaptive-attacker evaluations, incident write-ups, defence ablations', falsification: 'Name the adaptive attack the defence was not evaluated against.', shortcuts: 'static attack suites as proof of robustness; vendor claims without attack details' },
  { slug: 'cyber-capability-analysis', title: 'Cyber capability analysis', capabilities: ['cyber_capabilities'], purpose: 'Evaluate offensive and defensive cyber capability claims and uplift measurements.', evidence: 'CTF-style evaluations with solve rates, human baselines and tool access described', falsification: 'Identify the task class or tool restriction under which the reported uplift was not measured.', shortcuts: 'anecdotal exploit demos; ignoring human-in-the-loop assistance' },
  { slug: 'frontier-risk-analysis', title: 'Frontier risk analysis', capabilities: ['frontier_risk'], purpose: 'Assess catastrophic-risk arguments and frontier safety frameworks against evidence.', evidence: 'safety frameworks, threshold definitions, evaluation results tied to thresholds', falsification: 'State the threshold observation that would trigger or dismiss the risk claim.', shortcuts: 'probability estimates without a stated method; treating pledges as controls' },
  { slug: 'ai-governance-analysis', title: 'AI governance analysis', capabilities: ['ai_governance'], purpose: 'Analyse governance mechanisms: enforceability, verification, incentive compatibility.', evidence: 'policy documents, compliance reports, audits with verifiable commitments', falsification: 'Name the compliance signal that would show the mechanism failed.', shortcuts: 'announcements as implementation; conflating voluntary and binding commitments' },
  { slug: 'ai-policy-analysis', title: 'AI policy analysis', capabilities: ['ai_policy'], purpose: 'Evaluate policy instruments and their expected effects with evidence from comparable regimes.', evidence: 'legislation texts, regulatory impact assessments, empirical studies of comparable regimes', falsification: 'Identify the measurable outcome the policy predicts and whether any regime reports it.', shortcuts: 'op-eds as evidence; attributing positions to named people without their published text' },
];

export function renderFrontierSkill(skill: FrontierSkill): string {
  return [
    '---', 'type: Skill', `title: ${skill.title}`, `description: ${skill.purpose}`, `tags: [skill, frontier-experts, ${skill.slug}]`,
    `capabilities: [${skill.capabilities.join(', ')}]`, 'status: draft', 'trust_level: system_generated', 'generated_by: frontier-expert-intelligence', '---', '',
    `# ${skill.title}`, '', `Purpose: ${skill.purpose}`, `Applicable capabilities: ${skill.capabilities.join(', ')}.`, '',
    '## Procedure', '1. Restate the question and the capability families it touches; abstain if none apply.',
    `2. Required evidence: ${skill.evidence}. Use only evidence items listed in the prompt; absence of evidence is not evidence of absence.`,
    '3. Extract claims as subject / relation / object with polarity and the evidence ids that support each; never attribute views to a person beyond their cited work.',
    `4. Falsification: ${skill.falsification}`,
    '5. Report uncertainties and the conditions under which each claim holds; preserve disagreement with other perspectives instead of averaging.',
    `## Prohibited shortcuts`, `- ${skill.shortcuts}.`, '- No impersonation, no unsupported attribution, no citation counts as truth.',
    '## Recommended expert retrieval', `- Resolve experts by capability ${skill.capabilities.map((capability) => `\`${capability}\``).join(', ')} with primary (Tier-1) evidence; famous but irrelevant experts do not qualify.`, '',
  ].join('\n');
}

/** Write the skills that are missing (all with force) into `<skillsDir>`; returns what was written or kept. */
export function installFrontierSkills(skillsDir: string, options: { force?: boolean } = {}): Array<{ slug: string; path: string; action: 'written' | 'kept' }> {
  fs.mkdirSync(skillsDir, { recursive: true });
  return FRONTIER_SKILLS.map((skill) => {
    const target = path.join(skillsDir, `${skill.slug}.md`);
    if (!options.force && fs.existsSync(target)) return { slug: skill.slug, path: target, action: 'kept' as const };
    fs.writeFileSync(target, renderFrontierSkill(skill), 'utf8');
    return { slug: skill.slug, path: target, action: 'written' as const };
  });
}

/** Procedure section of the skill covering a capability, read from the OKF skills dir (installed file wins over the built-in text). */
export function procedureForCapability(capabilityId: string, skillsDir: string | null = defaultSkillsDir()): string | null {
  const skill = FRONTIER_SKILLS.find((item) => item.capabilities.includes(capabilityId));
  if (!skill) return null;
  let content = renderFrontierSkill(skill);
  if (skillsDir) { try { content = fs.readFileSync(path.join(skillsDir, `${skill.slug}.md`), 'utf8'); } catch { /* not installed: built-in text */ } }
  const start = content.indexOf('## Procedure');
  const end = content.indexOf('## Recommended expert retrieval');
  return start >= 0 ? `${skill.slug}: ${content.slice(start, end > start ? end : undefined).trim()}` : null;
}

function defaultSkillsDir(): string | null {
  try { return path.join(KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true }), 'skills'); } catch { return null; }
}
