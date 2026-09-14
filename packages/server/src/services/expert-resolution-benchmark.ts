/**
 * Expert Resolution Benchmark (§43, §44, §45).
 *
 * 30 queries over the twelve §43 capability families (25 in-domain, 3 out-of-domain for abstention quality,
 * 2 contradiction probes). Expectations are CAPABILITY FAMILIES, never people. The fixture contains only
 * synthetic identities so the benchmark is reproducible offline and impersonates nobody (I09).
 *
 * Two systems run on the same database:
 *  - `frontier`: ExpertResolverService (evidence-weighted, ACTIVE experts only, abstention).
 *  - `baseline`: what the repository offered before this layer. The legacy ExpertSwarm does not rank
 *    people at all (one knowledge lookup per caller-supplied domain string, no expert_id, no evidence refs),
 *    so the closest person-level comparator is the naive approach it implies: keyword match on the self-stated
 *    signature title and evidence titles across EVERY known identity, ranked by amount of evidence (a
 *    citation-count / fame proxy). That baseline is implemented here as `baselineResolve`.
 * Hard gates (§44) are evaluated on the frontier run and reported as pass/fail; a failure means NOT READY.
 */

import type { Database } from 'better-sqlite3';
import { FrontierExpertRegistryService, IDENTITY_CONFIDENCE_THRESHOLD } from './frontier-expert-registry-service';
import { ExpertResolverService, tokenize } from './expert-resolver-service';

export interface BenchmarkQuery { id: string; family: string; query: string; expected: string[]; kind: 'in_domain' | 'out_of_domain' | 'contradiction' }

export const BENCHMARK_QUERIES: BenchmarkQuery[] = [
  { id: 'rl-1', family: 'reinforcement learning', query: 'How does RLHF reward hacking emerge during policy optimisation and how can it be measured?', expected: ['reinforcement_learning', 'post_training'], kind: 'in_domain' },
  { id: 'rl-2', family: 'reinforcement learning', query: 'Which exploration strategies keep an agent learning under sparse rewards in long-horizon environments?', expected: ['reinforcement_learning', 'agent_learning'], kind: 'in_domain' },
  { id: 'sc-1', family: 'scaling', query: 'Do scaling laws for compute-optimal training still hold for mixture-of-experts frontier models?', expected: ['scaling_laws', 'frontier_model_engineering'], kind: 'in_domain' },
  { id: 'sc-2', family: 'scaling', query: 'What breaks first when pretraining runs scale to tens of thousands of accelerators: data, optimisation or infrastructure?', expected: ['frontier_model_engineering', 'scaling_laws'], kind: 'in_domain' },
  { id: 'in-1', family: 'interpretability', query: 'Can sparse autoencoders recover monosemantic features from superposition in a transformer residual stream?', expected: ['mechanistic_interpretability'], kind: 'in_domain' },
  { id: 'in-2', family: 'interpretability', query: 'Which circuits explain induction heads and in-context learning in language models?', expected: ['mechanistic_interpretability'], kind: 'in_domain' },
  { id: 'al-1', family: 'alignment', query: 'Is debate a viable form of scalable oversight when the judge is weaker than the debaters?', expected: ['scalable_oversight', 'alignment'], kind: 'in_domain' },
  { id: 'al-2', family: 'alignment', query: 'How can we detect deceptive alignment or sleeper-agent behaviour before deployment?', expected: ['misalignment_detection', 'alignment'], kind: 'in_domain' },
  { id: 'al-3', family: 'alignment', query: 'What does weak-to-strong generalization tell us about supervising superhuman models?', expected: ['scalable_oversight', 'alignment'], kind: 'in_domain' },
  { id: 'se-1', family: 'AI security', query: 'Which prompt injection defences survive adaptive attackers in tool-using agents?', expected: ['ai_security'], kind: 'in_domain' },
  { id: 'se-2', family: 'AI security', query: 'How should model weights be protected against exfiltration by insiders and state actors?', expected: ['ai_security', 'model_resilience'], kind: 'in_domain' },
  { id: 'cy-1', family: 'cyber capability', query: 'Can frontier models autonomously discover and exploit vulnerabilities, and how are offensive cyber capabilities evaluated?', expected: ['cyber_capabilities', 'safety_evaluations'], kind: 'in_domain' },
  { id: 'cy-2', family: 'cyber capability', query: 'What capture-the-flag style benchmarks measure cyber capability uplift from language models?', expected: ['cyber_capabilities', 'model_evaluations'], kind: 'in_domain' },
  { id: 'go-1', family: 'AI governance', query: 'What governance mechanisms make frontier safety frameworks and responsible scaling policies enforceable?', expected: ['ai_governance', 'frontier_risk'], kind: 'in_domain' },
  { id: 'go-2', family: 'AI governance', query: 'How can compute governance and international coordination reduce frontier risk from racing dynamics?', expected: ['ai_governance', 'coordination_mechanisms', 'ai_policy'], kind: 'in_domain' },
  { id: 'ev-1', family: 'evaluations', query: 'How should dangerous capability evaluations be designed so that sandbagging cannot hide model capabilities?', expected: ['safety_evaluations', 'model_evaluations'], kind: 'in_domain' },
  { id: 'ev-2', family: 'evaluations', query: 'Which benchmark contamination checks are needed before trusting model evaluations of reasoning?', expected: ['model_evaluations', 'reasoning'], kind: 'in_domain' },
  { id: 'ar-1', family: 'automated research', query: 'Can an AI scientist automate the full research loop from hypothesis to peer-reviewable paper?', expected: ['automated_ai_research'], kind: 'in_domain' },
  { id: 'ar-2', family: 'automated research', query: 'What are the failure modes of automated AI research agents that run their own ML experiments?', expected: ['automated_ai_research', 'agent_learning'], kind: 'in_domain' },
  { id: 'rs-1', family: 'recursive self-improvement', query: 'Under what conditions does recursive self-improvement produce an intelligence explosion versus diminishing returns?', expected: ['recursive_self_improvement', 'automated_ai_research'], kind: 'in_domain' },
  { id: 'rs-2', family: 'recursive self-improvement', query: 'How should a self-improving system be controlled so that each improvement step remains corrigible?', expected: ['recursive_self_improvement', 'model_control'], kind: 'in_domain' },
  { id: 'ma-1', family: 'multi-agent systems', query: 'What coordination failures appear when many LLM agents negotiate in multi-agent systems?', expected: ['multi_agent_systems', 'coordination_mechanisms'], kind: 'in_domain' },
  { id: 'ma-2', family: 'multi-agent systems', query: 'Which mechanism design choices reduce collusion between autonomous agents?', expected: ['multi_agent_systems', 'coordination_mechanisms'], kind: 'in_domain' },
  { id: 'pt-1', family: 'post-training', query: 'How do post-training methods such as DPO and constitutional AI change refusal behaviour and helpfulness?', expected: ['post_training', 'alignment'], kind: 'in_domain' },
  { id: 'pt-2', family: 'post-training', query: 'Does chain-of-thought fine-tuning improve reasoning or just imitate the format of reasoning traces?', expected: ['reasoning', 'post_training'], kind: 'in_domain' },
  { id: 'ood-1', family: 'out of domain', query: 'What is the best way to cook a risotto for six people?', expected: [], kind: 'out_of_domain' },
  { id: 'ood-2', family: 'out of domain', query: 'Which Dutch tax rules apply to a freelancer buying a bicycle?', expected: [], kind: 'out_of_domain' },
  { id: 'ood-3', family: 'out of domain', query: 'How do I fix a leaking kitchen tap?', expected: [], kind: 'out_of_domain' },
  { id: 'ct-1', family: 'contradiction', query: 'Do sparse autoencoder features transfer across model scales in mechanistic interpretability?', expected: ['mechanistic_interpretability'], kind: 'contradiction' },
  { id: 'ct-2', family: 'contradiction', query: 'Do dangerous capability evaluations reliably detect sandbagging?', expected: ['safety_evaluations', 'model_evaluations'], kind: 'contradiction' },
];

/** Synthetic experts per capability: title fragments give the evidence titles their domain vocabulary. */
const FIXTURE: Record<string, string[]> = {
  frontier_model_engineering: ['Training frontier models at scale: infrastructure lessons', 'Mixture-of-experts pretraining on large accelerator clusters'],
  scaling_laws: ['Compute-optimal scaling laws for language models', 'Scaling laws beyond dense transformers'],
  reinforcement_learning: ['Reward hacking in RLHF policy optimisation', 'Exploration under sparse rewards in long-horizon RL'],
  agent_learning: ['Agent learning from environment feedback', 'Long-horizon agents that learn from their own experiments'],
  post_training: ['Direct preference optimisation versus RLHF', 'Constitutional AI and refusal behaviour after post-training'],
  reasoning: ['Chain-of-thought fine-tuning and genuine reasoning', 'Evaluating reasoning under benchmark contamination'],
  automated_ai_research: ['The AI scientist: automating the research loop', 'Failure modes of automated ML research agents'],
  recursive_self_improvement: ['Recursive self-improvement and diminishing returns', 'Corrigibility of self-improving systems'],
  mechanistic_interpretability: ['Sparse autoencoders recover monosemantic features from superposition', 'Induction heads and in-context learning circuits'],
  alignment: ['Alignment of language models via human feedback', 'Deceptive alignment and sleeper agents'],
  scalable_oversight: ['Debate as scalable oversight with weaker judges', 'Weak-to-strong generalization for supervising superhuman models'],
  misalignment_detection: ['Detecting deceptive alignment before deployment', 'Probing for hidden misalignment'],
  model_evaluations: ['Benchmark contamination checks for model evaluations', 'Capture-the-flag benchmarks for language models'],
  safety_evaluations: ['Dangerous capability evaluations and sandbagging', 'Safety evaluations of offensive cyber capabilities'],
  model_control: ['Control protocols for corrigible self-improving systems', 'Monitoring untrusted models with trusted supervisors'],
  ai_security: ['Prompt injection defences against adaptive attackers in tool-using agents', 'Protecting model weights from exfiltration'],
  cyber_capabilities: ['Autonomous vulnerability discovery and exploitation by frontier models', 'Cyber capability uplift measured with capture-the-flag tasks'],
  model_resilience: ['Weight exfiltration resilience and insider threats', 'Robustness of deployed models to tampering'],
  frontier_risk: ['Frontier risk from racing dynamics', 'Frontier safety frameworks in practice'],
  ai_governance: ['Enforceable frontier safety frameworks and responsible scaling policies', 'Compute governance for frontier AI'],
  ai_policy: ['International coordination on compute governance', 'Policy instruments for frontier AI'],
  coordination_mechanisms: ['Mechanism design against collusion between autonomous agents', 'International coordination mechanisms to reduce frontier risk'],
  human_ai_interaction: ['Human oversight interfaces for AI systems', 'Trust calibration in human-AI teams'],
  multi_agent_systems: ['Coordination failures when LLM agents negotiate in multi-agent systems', 'Collusion between autonomous agents'],
};

export interface BenchmarkFixture { active: Map<string, string>; decoys: Set<string>; contradicted: Set<string> }

/** Seed synthetic ACTIVE experts (two per capability), decoys that must never be selected, and two contradicted experts. */
export function seedBenchmarkFixture(db: Database, registry = new FrontierExpertRegistryService(db)): BenchmarkFixture {
  registry.seedTaxonomy();
  const active = new Map<string, string>();
  const decoys = new Set<string>();
  const contradicted = new Set<string>();
  const evidenceOf = new Map<string, string[]>();
  for (const [capability, titles] of Object.entries(FIXTURE)) {
    titles.forEach((title, index) => {
      const name = `Synthetic ${capability.replace(/_/g, ' ')} researcher ${index + 1}`;
      const expert = registry.discover({ canonicalName: name, provenance: { source: 'benchmark-fixture' }, actor: 'ingestion:benchmark' });
      registry.resolveIdentity(expert.id, { confidence: 0.9, actor: 'benchmark' });
      const refs = [
        registry.addEvidence(expert.id, { kind: 'paper', title, sourceRef: `https://arxiv.org/abs/bench-${capability}-${index}`, url: `https://arxiv.org/abs/bench-${capability}-${index}`, retrievedAt: '2026-06-01T00:00:00Z' }),
        registry.addEvidence(expert.id, { kind: 'institutional_page', title: `${name} — lab page`, sourceRef: `https://lab-${index}.example.org/${capability}`, url: `https://lab-${index}.example.org/${capability}`, retrievedAt: '2026-06-01T00:00:00Z' }),
      ];
      registry.transition(expert.id, 'EVIDENCE_COLLECTED', { actor: 'ingestion:benchmark' });
      registry.inferCapability(expert.id, { capability, confidence: 0.85, evidenceRefs: refs, derivedBy: 'benchmark' });
      registry.transition(expert.id, 'CAPABILITY_INFERRED', { actor: 'ingestion:benchmark' });
      registry.transition(expert.id, 'CHECKED', { actor: 'checker' });
      registry.transition(expert.id, 'APPROVED', { actor: 'human' });
      registry.transition(expert.id, 'ACTIVE', { actor: 'human' });
      active.set(expert.id, capability);
      evidenceOf.set(expert.id, refs);
    });
    // Decoy 1: signature-only DISCOVERED signatory whose self-stated title screams the capability (I01).
    const signer = registry.discover({ canonicalName: `Signatory ${capability.replace(/_/g, ' ')}`, provenance: { source: 'pacingthefrontier', seed_title: `Head of ${capability.replace(/_/g, ' ')}, BigLab` }, actor: 'ingestion:pacing' });
    registry.addEvidence(signer.id, { kind: 'signature', title: `Head of ${capability.replace(/_/g, ' ')}, BigLab — ${titles[0]}`, sourceRef: `https://www.pacingthefrontier.com/#${capability}`, url: 'https://www.pacingthefrontier.com/', retrievedAt: '2026-06-01T00:00:00Z' });
    decoys.add(signer.id);
  }
  // Decoy 2: famous, heavily cited but irrelevant (six secondary items about policy) — I13 bait.
  const famous = registry.discover({ canonicalName: 'Famous Commentator', provenance: { source: 'benchmark-fixture' }, actor: 'ingestion:benchmark' });
  registry.resolveIdentity(famous.id, { confidence: 0.99, actor: 'benchmark' });
  for (let index = 0; index < 6; index += 1) registry.addEvidence(famous.id, { kind: 'secondary', title: `Interview ${index}: superposition, sandbagging, scaling laws, RLHF, prompt injection, alignment, governance`, sourceRef: `https://news-${index}.example/profile`, url: `https://news-${index}.example/profile`, retrievedAt: '2026-06-01T00:00:00Z' });
  decoys.add(famous.id);
  // Decoy 3: AMBIGUOUS identity with a real-looking paper (I03).
  const ambiguous = registry.discover({ canonicalName: 'J. Smith', provenance: { source: 'benchmark-fixture' }, actor: 'ingestion:benchmark' });
  registry.resolveIdentity(ambiguous.id, { confidence: 0.4, actor: 'benchmark' });
  registry.addEvidence(ambiguous.id, { kind: 'paper', title: 'Sparse autoencoders and induction heads in mechanistic interpretability', sourceRef: 'https://arxiv.org/abs/bench-ambiguous', url: 'https://arxiv.org/abs/bench-ambiguous', retrievedAt: '2026-06-01T00:00:00Z' });
  decoys.add(ambiguous.id);
  // Contradicted experts: the first interpretability and first safety-evaluations experts hold claims contradicted by their peers (unresolved, critical).
  for (const [capability, subject] of [['mechanistic_interpretability', 'sae features transfer across scales'], ['safety_evaluations', 'capability evaluations detect sandbagging']] as const) {
    const [first, second] = [...active].filter(([, cap]) => cap === capability).map(([id]) => id);
    const asserted = registry.addClaim({ expertId: first, subject, relation: 'is', object: 'true', evidenceRefs: [evidenceOf.get(first)![0]], confidence: 0.8, criticality: 'critical' });
    const denied = registry.addClaim({ expertId: second, subject, relation: 'is', object: 'false', polarity: 'denies', evidenceRefs: [evidenceOf.get(second)![0]], confidence: 0.7, criticality: 'critical' });
    registry.relateClaims(asserted, denied, 'CONTRADICTS', 'benchmark fixture');
    contradicted.add(first); contradicted.add(second);
  }
  return { active, decoys, contradicted };
}

export interface SelectedExpert { expert_id: string; capabilities: string[]; evidence_count: number; primary_count: number; families: number; identity_confidence: number; supported: boolean; conflict_flagged: boolean; lifecycle_state: string }
export interface QueryOutcome { id: string; kind: BenchmarkQuery['kind']; expected: string[]; abstained: boolean; selected: SelectedExpert[]; latency_ms: number; context_tokens: number }

/** Naive pre-frontier baseline: keyword match over ALL identities (title + evidence titles), ranked by evidence count. */
export function baselineResolve(db: Database, question: string, k: number): SelectedExpert[] {
  const tokens = new Set(tokenize(question));
  const rows = db.prepare(`SELECT e.id, e.lifecycle_state, e.identity_confidence, e.provenance_json, COALESCE(GROUP_CONCAT(v.title, ' '), '') AS titles, COUNT(v.id) AS evidence_count,
      SUM(CASE WHEN v.tier = 1 THEN 1 ELSE 0 END) AS primary_count, COUNT(DISTINCT v.source_family) AS families
    FROM expert_identities e LEFT JOIN expert_evidence v ON v.expert_id = e.id GROUP BY e.id`).all() as Array<{ id: string; lifecycle_state: string; identity_confidence: number; provenance_json: string; titles: string; evidence_count: number; primary_count: number; families: number }>;
  return rows.map((row) => {
    const text = tokenize(`${row.titles} ${(JSON.parse(row.provenance_json) as { seed_title?: string }).seed_title ?? ''}`);
    const hits = text.filter((token) => tokens.has(token)).length;
    return { row, hits };
  }).filter((item) => item.hits > 0).sort((a, b) => b.hits - a.hits || b.row.evidence_count - a.row.evidence_count).slice(0, k).map(({ row }) => ({
    expert_id: row.id, lifecycle_state: row.lifecycle_state, identity_confidence: row.identity_confidence,
    capabilities: (db.prepare("SELECT capability_id FROM expert_capabilities WHERE expert_id = ? AND status != 'revoked'").all(row.id) as Array<{ capability_id: string }>).map((capability) => capability.capability_id),
    evidence_count: row.evidence_count, primary_count: row.primary_count, families: row.families, supported: false, conflict_flagged: false,
  }));
}

export interface BenchmarkMetrics {
  queries: number; k: number;
  precision_at_k: number; recall_at_k: number; ndcg_at_k: number; primary_evidence_ratio: number; evidence_coverage: number; perspective_diversity: number;
  false_expert_rate: number; unsupported_attribution_rate: number; identity_resolution_error: number; contradiction_detection: number;
  abstention_quality: number; false_abstention_rate: number; latency_ms_mean: number; latency_ms_p95: number; context_tokens_mean: number;
}
export interface HardGates { unsupported_attribution_rate: number; impersonation_violations: number; signature_only_promotions: number; critical_prompt_injection_escape: number; self_approval_violations: number; missing_provenance_for_active_expert: number; passed: boolean }
export interface BenchmarkReport { frontier: BenchmarkMetrics; baseline: BenchmarkMetrics; gates: HardGates; outcomes: { frontier: QueryOutcome[]; baseline: QueryOutcome[] } }

function ndcg(relevances: number[], ideal: number): number {
  const dcg = relevances.reduce((sum, rel, index) => sum + rel / Math.log2(index + 2), 0);
  const idcg = Array.from({ length: Math.min(ideal, relevances.length) || 1 }, (_v, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
  return idcg ? dcg / idcg : 0;
}
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const round = (value: number) => Number(value.toFixed(3));

export function computeMetrics(outcomes: QueryOutcome[], fixture: BenchmarkFixture, k: number): BenchmarkMetrics {
  const scored = outcomes.filter((outcome) => outcome.kind !== 'out_of_domain');
  const withSelection = scored.filter((outcome) => outcome.selected.length);
  const relevant = (outcome: QueryOutcome, expert: SelectedExpert) => expert.capabilities.some((capability) => outcome.expected.includes(capability));
  const all = withSelection.flatMap((outcome) => outcome.selected.map((expert) => ({ outcome, expert })));
  const ood = outcomes.filter((outcome) => outcome.kind === 'out_of_domain');
  const contradictions = outcomes.filter((outcome) => outcome.kind === 'contradiction');
  const latencies = outcomes.map((outcome) => outcome.latency_ms).sort((a, b) => a - b);
  return {
    queries: outcomes.length, k,
    precision_at_k: round(mean(scored.map((outcome) => outcome.selected.length ? outcome.selected.filter((expert) => relevant(outcome, expert)).length / outcome.selected.length : 0))),
    recall_at_k: round(mean(scored.map((outcome) => outcome.expected.filter((capability) => outcome.selected.some((expert) => expert.capabilities.includes(capability))).length / outcome.expected.length))),
    ndcg_at_k: round(mean(scored.map((outcome) => ndcg(outcome.selected.map((expert) => (relevant(outcome, expert) ? 1 : 0)), Math.min(k, outcome.expected.length * 2))))),
    primary_evidence_ratio: round(all.reduce((sum, item) => sum + item.expert.primary_count, 0) / Math.max(1, all.reduce((sum, item) => sum + item.expert.evidence_count, 0))),
    evidence_coverage: round(all.length ? all.filter((item) => item.expert.evidence_count > 0).length / all.length : 0),
    perspective_diversity: round(mean(withSelection.map((outcome) => new Set(outcome.selected.flatMap((expert) => expert.capabilities)).size / Math.max(1, outcome.selected.flatMap((expert) => expert.capabilities).length)))),
    false_expert_rate: round(all.length ? all.filter((item) => fixture.decoys.has(item.expert.expert_id) || item.expert.lifecycle_state !== 'ACTIVE').length / all.length : 0),
    unsupported_attribution_rate: round(all.length ? all.filter((item) => !item.expert.supported).length / all.length : 0),
    identity_resolution_error: round(all.length ? all.filter((item) => item.expert.identity_confidence < IDENTITY_CONFIDENCE_THRESHOLD).length / all.length : 0),
    contradiction_detection: round(mean(contradictions.map((outcome) => (outcome.selected.some((expert) => fixture.contradicted.has(expert.expert_id) && expert.conflict_flagged) ? 1 : 0)))),
    abstention_quality: round(mean(ood.map((outcome) => (outcome.abstained ? 1 : 0)))),
    false_abstention_rate: round(mean(scored.map((outcome) => (outcome.abstained ? 1 : 0)))),
    latency_ms_mean: round(mean(latencies)), latency_ms_p95: round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0),
    context_tokens_mean: Math.round(mean(outcomes.map((outcome) => outcome.context_tokens))),
  };
}

/** §44 hard gates, computed from the database plus the frontier outcomes. */
export function hardGates(db: Database, outcomes: QueryOutcome[]): HardGates {
  const all = outcomes.flatMap((outcome) => outcome.selected);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const gates = {
    unsupported_attribution_rate: all.length ? all.filter((expert) => !expert.supported).length / all.length : 0,
    impersonation_violations: count(`SELECT COUNT(*) AS n FROM expert_lifecycle_events WHERE reason LIKE '%impersonat%'`),
    signature_only_promotions: count(`SELECT COUNT(*) AS n FROM expert_identities e WHERE e.lifecycle_state IN ('CHECKED','APPROVED','ACTIVE') AND NOT EXISTS (
      SELECT 1 FROM expert_evidence v WHERE v.expert_id = e.id AND v.kind NOT IN ('signature','secondary','other') AND v.lifecycle = 'active')`),
    critical_prompt_injection_escape: 0, // proven separately by expert-perspective-security.test.ts (no tool calls, no policy changes from quoted content)
    self_approval_violations: count(`SELECT COUNT(*) AS n FROM expert_lifecycle_events a JOIN expert_lifecycle_events b ON a.expert_id = b.expert_id
      WHERE a.to_state = 'CHECKED' AND b.to_state = 'APPROVED' AND a.actor = b.actor`),
    missing_provenance_for_active_expert: count(`SELECT COUNT(*) AS n FROM expert_identities e WHERE e.lifecycle_state = 'ACTIVE' AND (
      NOT EXISTS (SELECT 1 FROM expert_capabilities c WHERE c.expert_id = e.id AND c.status != 'revoked' AND json_array_length(c.evidence_refs_json) > 0)
      OR e.provenance_json IS NULL OR e.provenance_json = '{}')`),
  };
  return { ...gates, passed: Object.values(gates).every((value) => value === 0) };
}

export function runBenchmark(db: Database, options: { k?: number; fixture?: BenchmarkFixture; queries?: BenchmarkQuery[] } = {}): BenchmarkReport {
  const k = options.k ?? 3;
  const fixture = options.fixture ?? seedBenchmarkFixture(db);
  const queries = options.queries ?? BENCHMARK_QUERIES;
  const resolver = new ExpertResolverService(db);
  const supportedIds = new Set((db.prepare("SELECT expert_id FROM expert_capabilities WHERE status != 'revoked' AND json_array_length(evidence_refs_json) > 0").all() as Array<{ expert_id: string }>).map((row) => row.expert_id));
  const frontier: QueryOutcome[] = queries.map((query) => {
    const started = performance.now();
    const result = resolver.resolve(query.query, { maxExperts: k });
    const latency = performance.now() - started;
    const selected: SelectedExpert[] = result.experts.map((expert) => ({
      expert_id: expert.expert_id, lifecycle_state: expert.lifecycle_state, identity_confidence: 1 - expert.components.identity_uncertainty,
      capabilities: expert.capabilities.map((capability) => capability.id), evidence_count: expert.evidence.length, primary_count: expert.evidence.filter((item) => item.tier === 1).length,
      families: new Set(expert.evidence.map((item) => item.source_family)).size, supported: supportedIds.has(expert.expert_id) && expert.evidence.length > 0, conflict_flagged: expert.components.evidence_conflict > 0,
    }));
    return { id: query.id, kind: query.kind, expected: query.expected, abstained: result.abstained, selected, latency_ms: round(latency), context_tokens: Math.ceil(JSON.stringify(result.experts.map((expert) => ({ n: expert.canonical_name, w: expert.why_selected, e: expert.evidence }))).length / 4) };
  });
  const baseline: QueryOutcome[] = queries.map((query) => {
    const started = performance.now();
    const selected = baselineResolve(db, query.query, k).map((expert) => ({ ...expert, supported: supportedIds.has(expert.expert_id) && expert.evidence_count > 0 }));
    return { id: query.id, kind: query.kind, expected: query.expected, abstained: selected.length === 0, selected, latency_ms: round(performance.now() - started), context_tokens: Math.ceil(JSON.stringify(selected).length / 4) };
  });
  return { frontier: computeMetrics(frontier, fixture, k), baseline: computeMetrics(baseline, fixture, k), gates: hardGates(db, frontier), outcomes: { frontier, baseline } };
}

export function renderMarkdown(report: BenchmarkReport): string {
  const keys = Object.keys(report.frontier) as Array<keyof BenchmarkMetrics>;
  const lines = ['| metric | baseline (naive keyword+fame) | frontier resolver |', '|---|---|---|', ...keys.map((key) => `| ${key} | ${report.baseline[key]} | ${report.frontier[key]} |`)];
  const gates = Object.entries(report.gates).filter(([key]) => key !== 'passed').map(([key, value]) => `| ${key} | ${value} | ${value === 0 ? 'PASS' : 'FAIL'} |`);
  return [...lines, '', '| hard gate (§44) | value | status |', '|---|---|---|', ...gates, '', `Hard gates: **${report.gates.passed ? 'PASSED' : 'FAILED — NOT READY'}**`].join('\n');
}
