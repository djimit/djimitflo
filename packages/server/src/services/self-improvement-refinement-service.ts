/**
 * SelfImprovementRefinementService — turns a parked (needs_more_evidence)
 * proposal's specialist dissent into one refined follow-up draft.
 *
 * Found on 2026-09-19/20: since the self-improvement pipeline went live,
 * 0 of 357 proposals ever reached 'goal' — all come from generateFromReflection()
 * (vague qualitative narrative), and reviewers correctly park them with specific,
 * actionable feedback (e.g. "lacks technical specifications for the telemetry
 * API interface") that was previously just discarded. This service is the
 * grounded-refinement step: it asks the model to rewrite the proposal
 * addressing that named feedback, using only material already present —
 * never inventing evidence to plug a gap, same "do not invent" discipline
 * SelfImprovementAgentReviewService already applies on the review side.
 *
 * Pure and DB-free by design: it only turns (proposal, dissent) into a draft.
 * Persistence — creating the actual follow-up proposal, and bounding this to
 * at most one refinement per original — is SelfImprovementService.refineFromDissent()'s
 * job, not this service's.
 */

import type { ImprovementProposal } from './self-improvement-service';
import type { ModelCaller } from './self-improvement-agent-review-service';
import type { SpecialistConsensus } from './specialist-panel-service';

export interface RefinedProposalDraft {
  title: string;
  description: string;
  rationale: string;
}

function defaultOllamaUrl(): string {
  return process.env.OLLAMA_URL || 'http://192.168.1.28:11434';
}

function defaultModel(): string {
  return process.env.SELF_IMPROVEMENT_REFINEMENT_MODEL || 'qwen2.5:32b-instruct-q4_K_M';
}

function refinementTimeoutMs(): number {
  return Number(process.env.SELF_IMPROVEMENT_REFINEMENT_TIMEOUT_MS) || 120_000;
}

async function callOllama(prompt: string): Promise<string> {
  const response = await fetch(`${defaultOllamaUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: defaultModel(),
      prompt,
      stream: false,
      format: 'json',
      think: false,
      options: { temperature: 0.2, num_predict: 1024 },
    }),
    signal: AbortSignal.timeout(refinementTimeoutMs()),
  });
  if (!response.ok) throw new Error(`Ollama request failed: ${response.status}`);
  const data = (await response.json()) as { response?: string };
  return data.response || '';
}

export class SelfImprovementRefinementService {
  constructor(private readonly callModel: ModelCaller = callOllama) {}

  /** Returns null (no proposal created, retried next tick) on any failure — never persists a partial/hallucinated draft. */
  async refine(proposal: ImprovementProposal, dissent: SpecialistConsensus['dissent']): Promise<RefinedProposalDraft | null> {
    try {
      const raw = await this.callModel(this.buildPrompt(proposal, dissent));
      return this.parseResponse(raw);
    } catch {
      return null;
    }
  }

  private buildPrompt(proposal: ImprovementProposal, dissent: SpecialistConsensus['dissent']): string {
    return [
      'You are refining a self-improvement proposal that specialist reviewers found too vague or unsupported to approve as a goal.',
      'Do NOT invent facts, evidence, or technical details that are not present in the original proposal or the reviewer feedback below.',
      'If a reviewer asked for something concrete (an API spec, a registry query, a metric, a specific file) that this material does not contain,',
      'say so explicitly as an open gap in the refined description — do not fabricate an answer for it.',
      '',
      `Original title: ${proposal.title}`,
      `Original description: ${proposal.description}`,
      `Original rationale: ${proposal.rationale}`,
      '',
      'Reviewer dissent (why this was NOT approved):',
      ...dissent.map((d) => `- [${d.specialist_title}] stance=${d.stance}: ${d.limitations || '(no limitations text given)'}`),
      '',
      'Produce ONE refined follow-up proposal that concretely addresses the gaps above, grounded only in the material given.',
      'Respond with ONLY a JSON object matching this exact shape (no markdown, no prose outside the JSON):',
      '{"title": "...", "description": "...", "rationale": "..."}',
    ].join('\n');
  }

  private parseResponse(raw: string): RefinedProposalDraft | null {
    const jsonText = this.extractJson(raw);
    let candidate: Partial<RefinedProposalDraft> | null = null;
    try {
      candidate = jsonText ? JSON.parse(jsonText) : null;
    } catch {
      candidate = null;
    }
    if (!candidate || typeof candidate !== 'object') return null;

    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
    const rationale = typeof candidate.rationale === 'string' ? candidate.rationale.trim() : '';
    if (!title || !description || !rationale) return null;
    return { title, description, rationale };
  }

  private extractJson(raw: string): string | null {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null;
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
}
