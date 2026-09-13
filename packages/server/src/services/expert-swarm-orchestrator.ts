import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { KnowledgeAdapterRegistry } from './knowledge-adapters';
import { JudgeService, type ExpertAnswer, type JudgeVerdict } from './judge-service';
import { SkillService } from './skill-service';
import { ExpertCouncilService, type CouncilResult } from './expert-council-service';
import type { ResolveOptions } from './expert-resolver-service';
import { frontierExpertsEnabled } from './frontier-expert-registry-service';

export interface ExpertSwarmInput {
  topic: string;
  /** Legacy path: one adapter lookup per domain string. Kept for compatibility (§15). */
  domains: string[];
  maxParallel?: number;
  sources?: string[];
  /**
   * Frontier path: resolve evidence-backed experts for the topic, run independent perspectives,
   * build the claim graph and falsify. Requires DJIMITFLO_FRONTIER_EXPERTS_ENABLED=true unless
   * `force` is set (tests). Ignored when absent.
   */
  expertSelection?: ResolveOptions & { force?: boolean; adversarial?: boolean; language?: 'en' | 'nl' };
}

export interface ExpertSwarmResult {
  id: string;
  topic: string;
  domains: string[];
  expert_answers: ExpertAnswer[];
  verdict: JudgeVerdict;
  /** True when a governed knowledge candidate was recorded; never means "promoted". */
  knowledge_updated: boolean;
  /** Promotion decision from the judge; VERIFIED_FOR_USE needs an external checker or human. */
  promotion_decision: JudgeVerdict['promotion_decision'];
  /** memory_candidates row awaiting human review, when one was recorded. */
  knowledge_candidate_id: string | null;
  /** Present on the frontier path: perspectives, claim graph, disagreements, adversarial attacks. */
  council?: CouncilResult;
  duration_ms: number;
  created_at: string;
}

export interface ExpertSwarmDeps {
  registry?: KnowledgeAdapterRegistry;
  judge?: JudgeService;
  skills?: SkillService;
  council?: ExpertCouncilService;
}

interface SwarmRow {
  id: string;
  result_json: string;
  created_at: string;
}

export class ExpertSwarmOrchestrator {
  private registry: KnowledgeAdapterRegistry;
  private judge: JudgeService;
  private skills: SkillService;
  private maxParallel = 10;

  private council: ExpertCouncilService | null;

  constructor(private db: Database, deps: ExpertSwarmDeps = {}) {
    this.registry = deps.registry ?? new KnowledgeAdapterRegistry(db);
    this.judge = deps.judge ?? new JudgeService(db);
    this.skills = deps.skills ?? new SkillService(db);
    // Lazily built on first frontier dispatch so the legacy path pays nothing.
    this.council = deps.council ?? null;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS expert_swarm_history (
        id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_swarm_history_created ON expert_swarm_history(created_at DESC)');
  }

  async dispatch(input: ExpertSwarmInput): Promise<ExpertSwarmResult> {
    const start = Date.now();
    const id = randomUUID();
    const requestedParallel = input.maxParallel ?? 3;
    if (!Number.isInteger(requestedParallel) || requestedParallel < 1 || requestedParallel > this.maxParallel) {
      throw new Error('EXPERT_SWARM_MAX_PARALLEL_INVALID');
    }
    const maxParallel = Math.min(requestedParallel, this.maxParallel);
    const sources = input.sources ?? ['wikipedia', 'arxiv', 'okf'];

    const answers: ExpertAnswer[] = [];
    let council: CouncilResult | undefined;

    if (input.expertSelection && (input.expertSelection.force || frontierExpertsEnabled())) {
      // Frontier path (§15, §16): resolver → independent perspectives → claim graph → adversary.
      const { force: _force, adversarial, language, ...selection } = input.expertSelection;
      this.council ??= new ExpertCouncilService(this.db);
      council = await this.council.convene(input.topic, selection, { maxParallel, adversarial, language });
      for (const perspective of council.perspectives) {
        const confidence = perspective.output.claims.length
          ? perspective.output.claims.reduce((sum, claim) => sum + claim.confidence, 0) / perspective.output.claims.length
          : 0.2;
        answers.push({
          domain: perspective.canonical_name,
          content: perspective.output.analysis,
          source: 'frontier-expert',
          confidence,
          evidence_refs: perspective.output.evidence_refs,
          metadata: { expert_id: perspective.expert_id, why_selected: perspective.why_selected, claim_ids: perspective.claim_ids, runtime: perspective.runtime, dropped_refs: perspective.dropped_refs },
        });
      }
    } else {
      const domainChunks = this.chunkArray(input.domains, maxParallel);

      for (const chunk of domainChunks) {
        const chunkPromises = chunk.map(domain => this.executeExpert(domain, input.topic, sources));
        const chunkResults = await Promise.allSettled(chunkPromises);

        for (const result of chunkResults) {
          if (result.status === 'fulfilled' && result.value) {
            answers.push(result.value);
          }
        }
      }
    }

    const verdict = this.judge.evaluate(answers);
    // A council disagreement is a contradiction even when the lexical heuristic misses it (§19, I08).
    if (council?.disagreements.length) {
      verdict.contradictions.push(...council.disagreements.map((item) => `Council disagreement on "${item.proposition}" between ${item.expert_a} and ${item.expert_b}`));
      verdict.promotion_decision = 'CONTRADICTED';
      verdict.verification_status = 'contradicted';
    }
    // The heuristic judge can never say "verified", so the old `verification_status === 'verified'`
    // gate silently stored nothing. Knowledge now enters the governed review queue when the
    // judge asks for human review; contradicted, insufficient or unverifiable output stays out.
    const knowledgeCandidateId = verdict.promotion_decision === 'HUMAN_REVIEW_REQUIRED'
      ? this.storeKnowledge(id, input.topic, answers, verdict)
      : null;

    const result: ExpertSwarmResult = {
      id,
      topic: input.topic,
      domains: input.domains,
      expert_answers: answers,
      verdict,
      knowledge_updated: knowledgeCandidateId !== null,
      promotion_decision: verdict.promotion_decision,
      knowledge_candidate_id: knowledgeCandidateId,
      council,
      duration_ms: Date.now() - start,
      created_at: new Date().toISOString(),
    };

    this.db.prepare('INSERT INTO expert_swarm_history (id, result_json) VALUES (?, ?)').run(id, JSON.stringify(result));

    return result;
  }

  getHistory(limit: number = 20): ExpertSwarmResult[] {
    const rows = this.db.prepare('SELECT result_json FROM expert_swarm_history ORDER BY created_at DESC LIMIT ?').all(limit) as SwarmRow[];
    return rows.map(r => JSON.parse(r.result_json) as ExpertSwarmResult);
  }

  getAvailableSources(): string[] {
    return this.registry.getAvailable();
  }

  private async executeExpert(domain: string, topic: string, sources: string[]): Promise<ExpertAnswer | null> {
    try {
      const skill = this.skills.getSkillForFinding(topic, domain);
      // The skill procedure is LLM context, not a search string: sending it as the query
      // turned every adapter lookup into a prompt-sized keyword soup.
      const query = `${topic} ${domain}`;

      const results = await this.registry.searchAll(query, sources, 3);

      if (results.length === 0) {
        return {
          domain,
          content: `No knowledge found for "${topic}" in domain "${domain}".`,
          source: 'none',
          confidence: 0.1,
          evidence_refs: [],
          metadata: { skill_used: !!skill },
        };
      }

      const bestResult = results.reduce((best, r) => r.confidence > best.confidence ? r : best, results[0]);

      return {
        domain,
        content: bestResult.content,
        source: bestResult.source,
        confidence: bestResult.confidence,
        evidence_refs: [bestResult.id],
        metadata: {
          url: bestResult.url,
          title: bestResult.title,
          all_sources: results.map(r => r.source),
          skill_used: !!skill,
          skill_procedure: skill ? skill.slice(0, 200) : null,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Record swarm output as a governed knowledge candidate. It lands in the human review
   * queue (never `promoted`) with the full provenance: run id, judge verdict, per-answer
   * evidence refs and sources. The previous version used memory_type 'expert_knowledge',
   * which violates the memory_candidates CHECK constraint and was swallowed by a catch.
   */
  private storeKnowledge(runId: string, topic: string, answers: ExpertAnswer[], verdict: JudgeVerdict): string | null {
    const candidateId = randomUUID();
    const content = answers.map(a => `[${a.domain}] ${a.content}`).join('\n\n');
    const evidence = answers.flatMap(a => a.evidence_refs ?? []);
    this.db.prepare(`
      INSERT INTO memory_candidates (id, title, content, memory_type, store, source_ref, status, promotion_status, human_required, sensitivity, metadata, created_at, updated_at)
      VALUES (?, ?, ?, 'operational_memory', 'semantic', ?, 'review_required', 'blocked_pending_human', 1, 'normal', ?, datetime('now'), datetime('now'))
    `).run(
      candidateId,
      `Expert knowledge candidate: ${topic}`,
      content,
      `expert-swarm:${runId}`,
      JSON.stringify({
        origin: 'expert-swarm', run_id: runId, topic, version: 1,
        judge: { verdict_id: verdict.id, score: verdict.score, score_kind: verdict.score_kind, confidence: verdict.confidence, promotion_decision: verdict.promotion_decision, verification_status: verdict.verification_status },
        answers: answers.map(a => ({ domain: a.domain, source: a.source, confidence: a.confidence, evidence_refs: a.evidence_refs ?? [], url: a.metadata?.url ?? null, expert_id: a.metadata?.expert_id ?? null, claim_ids: a.metadata?.claim_ids ?? [] })),
        evidence_refs: evidence,
        empirical_status: 'UNDETERMINED', promotion_allowed: false,
      })
    );
    return candidateId;
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
