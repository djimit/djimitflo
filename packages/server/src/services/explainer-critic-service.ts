/**
 * ExplainerCriticService — evaluates generated repo explainer bundles.
 *
 * Two-layer scoring (stub-header promise fulfilled):
 *   Layer 1 — corpus oracles (deterministic): factuality, hallucination,
 *             quality, security, license, coverage from explainer.corpus.jsonl.
 *   Layer 2 — JudgeService consistency dimension (4-factor log-odds): each
 *             bundle section is an ExpertAnswer with its facts as evidence
 *             refs; the verdict score becomes a real `consistency` dimension.
 *             Judges without the service run 6-dim (fail-closed to oracles).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ExplainerClaimVerifier } from './explainer-claim-verifier';
import { JudgeService, type ExpertAnswer } from './judge-service';
import type {
  ExplainerBundleContent,
  ExplainerCorpusCase,
  ExplainerCriticResult,
  ExplainerCriticDimension,
} from '@djimitflo/shared';

const DEFAULT_CORPUS_PATH = join(__dirname, '..', '..', 'corpus', 'explainer.corpus.jsonl');
const DEFAULT_THRESHOLD = 85;

export class ExplainerCriticService {
  private cases: ExplainerCorpusCase[] | null = null;
  private corpusPath: string;
  private claimVerifier = new ExplainerClaimVerifier();
  private judge: JudgeService | null = null;

  constructor(corpusPath: string = DEFAULT_CORPUS_PATH, judge?: JudgeService) {
    this.corpusPath = corpusPath;
    this.judge = judge ?? null;
  }

  loadCases(): ExplainerCorpusCase[] {
    if (this.cases) return this.cases;
    const content = readFileSync(this.corpusPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim());
    this.cases = lines.map((line) => JSON.parse(line) as ExplainerCorpusCase);
    return this.cases;
  }

  evaluate(bundle: ExplainerBundleContent, threshold = DEFAULT_THRESHOLD): ExplainerCriticResult {
    const start = Date.now();
    const cases = this.loadCases();
    const dimensions = this.scoreDimensions(bundle, cases);
    // JudgeService consistency dimension (layer 2) — appended when the judge
    // is wired in; otherwise the 6 oracle dimensions stand alone (fail-closed).
    if (this.judge) {
      dimensions.push(this.scoreConsistencyViaJudge(bundle));
    }
    const overallScore = this.computeOverall(dimensions);
    const criticalDimensionsPassed = dimensions
      .filter((dimension) => dimension.name === 'security' || dimension.name === 'license')
      .every((dimension) => dimension.findings.length === 0);
    const passed = overallScore >= threshold && criticalDimensionsPassed;
    const retryHints = dimensions
      .filter((d) => d.score < 80)
      .flatMap((d) => d.findings.map((f) => `${d.name}: ${f}`));

    return {
      overall_score: overallScore,
      threshold,
      passed,
      dimensions,
      retry_hints: retryHints,
      latency_ms: Date.now() - start,
    };
  }

  private scoreDimensions(bundle: ExplainerBundleContent, cases: ExplainerCorpusCase[]): ExplainerCriticDimension[] {
    const allText = [bundle.explainer_md, bundle.llms_txt, Object.values(bundle.sections).join('\n')].join('\n').toLowerCase();
    const results: ExplainerCriticDimension[] = [];

    // Factuality dimension
    const factCases = cases.filter((c) => c.category === 'factuality');
    const factFindings: string[] = [];
    let factScore = 100;
    for (const c of factCases) {
      const ok = this.runOracle(c, allText, bundle);
      if (!ok) {
        factFindings.push(`Case ${c.id}: ${c.failure_mode}`);
        factScore -= 20 / Math.max(1, factCases.length);
      }
    }
    results.push({ name: 'factuality', score: Math.max(0, factScore), rationale: 'Verifies identity, citations, and graph-community claims.', findings: factFindings });

    // Hallucination dimension — oracle cases + claim-level grounding verification
    const hallCases = cases.filter((c) => c.category === 'hallucination');
    const hallFindings: string[] = [];
    let hallScore = 100;
    for (const c of hallCases) {
      const ok = this.runOracle(c, allText, bundle);
      if (!ok) {
        hallFindings.push(`Case ${c.id}: ${c.failure_mode}`);
        hallScore -= 20 / Math.max(1, hallCases.length);
      }
    }
    // Claim grounding: citations must resolve against bundle facts (P1 upgrade)
    const grounding = this.claimVerifier.verify(bundle.sections, bundle.facts);
    if (grounding.checked > 0) {
      for (const u of grounding.unresolved.slice(0, 5)) {
        hallFindings.push(`Unresolved citation ${u.claim}: ${u.reason}`);
      }
      const groundingPenalty = (1 - grounding.grounding_ratio) * 40;
      hallScore -= groundingPenalty;
    }
    const groundingNote = grounding.checked > 0
      ? ` ${grounding.resolved}/${grounding.checked} citations grounded (${Math.round(grounding.grounding_ratio * 100)}%).`
      : '';
    results.push({ name: 'hallucination', score: Math.max(0, hallScore), rationale: `Detects invented APIs, modules, or security claims via oracle cases and claim-level source resolution.${groundingNote}`, findings: hallFindings });

    // Security dimension
    const secCases = cases.filter((c) => c.category === 'security');
    const secFindings: string[] = [];
    let secScore = 100;
    for (const c of secCases) {
      const ok = this.runOracle(c, allText, bundle);
      if (!ok) {
        secFindings.push(`Case ${c.id}: ${c.failure_mode}`);
        secScore -= 30 / Math.max(1, secCases.length);
      }
    }
    results.push({ name: 'security', score: Math.max(0, secScore), rationale: 'Prevents invented security posture claims.', findings: secFindings });

    // License dimension
    const licCases = cases.filter((c) => c.category === 'license');
    const licFindings: string[] = [];
    let licScore = 100;
    for (const c of licCases) {
      const ok = this.runOracle(c, allText, bundle);
      if (!ok) {
        licFindings.push(`Case ${c.id}: ${c.failure_mode}`);
        licScore -= 30 / Math.max(1, licCases.length);
      }
    }
    results.push({ name: 'license', score: Math.max(0, licScore), rationale: 'Ensures license attribution in footer.', findings: licFindings });

    // Coverage dimension
    const covCases = cases.filter((c) => c.category === 'coverage');
    const covFindings: string[] = [];
    let covScore = 100;
    for (const c of covCases) {
      const ok = this.runOracle(c, allText, bundle);
      if (!ok) {
        covFindings.push(`Case ${c.id}: ${c.failure_mode}`);
        covScore -= 20 / Math.max(1, covCases.length);
      }
    }
    results.push({ name: 'coverage', score: Math.max(0, covScore), rationale: 'Checks entry point, stack badges, dependency audit, freshness.', findings: covFindings });

    // Quality dimension
    const qualCases = cases.filter((c) => c.category === 'quality');
    const qualFindings: string[] = [];
    let qualScore = 100;
    for (const c of qualCases) {
      const ok = this.runOracle(c, allText, bundle);
      if (!ok) {
        qualFindings.push(`Case ${c.id}: ${c.failure_mode}`);
        qualScore -= 20 / Math.max(1, qualCases.length);
      }
    }
    // Extra: penalize if facts.json has fewer than 5 citations
    if (bundle.facts.length < 5) {
      qualFindings.push(`Only ${bundle.facts.length} cited facts; minimum 5 expected.`);
      qualScore -= 15;
    }
    // Extra: penalize if no section structure
    if (Object.keys(bundle.sections).length < 2) {
      qualFindings.push('Bundle has fewer than 2 sections.');
      qualScore -= 15;
    }
    results.push({ name: 'quality', score: Math.max(0, qualScore), rationale: 'Scores clarity, actionability, and structural completeness.', findings: qualFindings });

    return results;
  }

  private runOracle(c: ExplainerCorpusCase, text: string, bundle: ExplainerBundleContent): boolean {
    if (!c.oracle_type || !c.oracle_rule) return true;
    const haystack = c.category === 'factuality' && c.id === 'explainer-fact-citations'
      ? JSON.stringify(bundle.facts)
      : text;

    switch (c.oracle_type) {
      case 'contains': {
        const all = (c.oracle_rule.must_contain_all as string[] | undefined) ?? [];
        const any = (c.oracle_rule.must_contain_any as string[] | undefined) ?? [];
        const none = (c.oracle_rule.must_not_contain as string[] | undefined) ?? [];
        const allOk = all.every((term) => haystack.includes(term.toLowerCase()));
        const anyOk = any.length === 0 || any.some((term) => haystack.includes(term.toLowerCase()));
        const noneOk = none.every((term) => !haystack.includes(term.toLowerCase()));
        return allOk && anyOk && noneOk;
      }
      case 'regex': {
        const patterns = (c.oracle_rule.patterns as string[] | undefined) ?? [];
        return patterns.some((p) => new RegExp(p, 'i').test(haystack));
      }
      case 'json_path': {
        const facts = bundle.facts;
        const minLength = (c.oracle_rule.min_length as number | undefined) ?? 0;
        const fields = (c.oracle_rule.required_fields as string[] | undefined) ?? [];
        if (facts.length < minLength) return false;
        return facts.every((f) => fields.every((field) => field in f));
      }
      default:
        return true;
    }
  }

  /**
   * Layer 2 — JudgeService 4-factor consistency verdict over the bundle.
   * Each section is an ExpertAnswer; facts (with citations) are evidence refs.
   * Contradictions and low-verdict scores land in retry hints via findings.
   */
  private scoreConsistencyViaJudge(bundle: ExplainerBundleContent): ExplainerCriticDimension {
    // Token-overlap matching: template-authored sections don't cite [fact-N] ids,
    // so evidence is matched on claim keywords (≥5 chars) appearing in the section.
    const tokenMatch = (section: string, claim: string): boolean => {
      const sec = section.toLowerCase();
      const tokens = claim.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const hits = tokens.filter((w) => sec.includes(w)).length;
      return tokens.length > 0 && hits / tokens.length >= 0.34;
    };
    const answers: ExpertAnswer[] = Object.entries(bundle.sections).map(([section, content]) => ({
      domain: section,
      content,
      source: `bundle:${bundle.manifest?.task_id ?? 'unknown'}:${section}`,
      confidence: 0.85,
      evidence_refs: bundle.facts
        .filter((f) => content.includes(f.id) || tokenMatch(content, f.claim))
        .slice(0, 10)
        .map((f) => `${f.source_ref}`),
    }));

    const verdict = this.judge!.evaluate(
      answers,
      bundle.facts.map((f) => ({ source_ref: f.source_ref, source_type: f.source_type, confidence: f.confidence })),
    );
    const findings: string[] = [...verdict.contradictions.slice(0, 5)];
    if (verdict.score < 70) {
      findings.push(`Judge consistency ${Math.round(verdict.score)}/100 below 70: ${verdict.reasoning.slice(0, 160)}`);
    }
    return {
      name: 'consistency',
      score: Math.round(verdict.score * 10) / 10,
      rationale: `JudgeService 4-factor verdict (evidence/source/consistency/uncertainty log-odds): ${verdict.reasoning.slice(0, 200)}`,
      findings,
    };
  }

  private computeOverall(dimensions: ExplainerCriticDimension[]): number {
    if (dimensions.length === 0) return 0;
    const sum = dimensions.reduce((acc, d) => acc + d.score, 0);
    return Math.round((sum / dimensions.length) * 10) / 10;
  }
}
