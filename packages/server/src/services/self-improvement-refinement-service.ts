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

import { generateText, llmEndpoints } from './llm-fallback';
import type { ImprovementProposal } from './self-improvement-service';
import type { ModelCaller } from './self-improvement-agent-review-service';
import type { SpecialistConsensus } from './specialist-panel-service';

export interface RefinedProposalDraft {
  title: string;
  description: string;
  rationale: string;
  /** Optional anchor (see proposal-grounding.ts): only what the model could take from the given material. */
  target?: string;
  acceptanceTest?: string;
  baselineMetric?: string;
  runtimeCommand?: string;
  artifactPath?: string;
  budget?: string;
}

function defaultOllamaUrl(): string {
  return process.env.OLLAMA_URL || 'http://192.168.1.28:11434';
}

function defaultModel(): string {
  // Falls back to the review model before a hardcoded name: found in production
  // that 'qwen2.5:32b-instruct-q4_K_M' (this service's own hardcoded default,
  // and the review service's) doesn't exist on the deployed Ollama host at all —
  // every refinement call 404'd and was silently swallowed to null by refine()'s
  // catch. SELF_IMPROVEMENT_REVIEW_MODEL is already required to be a real,
  // working model for review to function, so it's a safe fallback here too.
  return process.env.SELF_IMPROVEMENT_REFINEMENT_MODEL
    || process.env.SELF_IMPROVEMENT_REVIEW_MODEL
    || 'qwen2.5:32b-instruct-q4_K_M';
}

function refinementTimeoutMs(): number {
  return Number(process.env.SELF_IMPROVEMENT_REFINEMENT_TIMEOUT_MS) || 120_000;
}

async function callOllama(prompt: string): Promise<string> {
  return generateText(
    { prompt, model: defaultModel(), temperature: 0.2, maxTokens: 1024, timeoutMs: refinementTimeoutMs() },
    { endpoints: llmEndpoints(defaultOllamaUrl()) },
  );
}

export class SelfImprovementRefinementService {
  constructor(private readonly callModel: ModelCaller = callOllama) {}

  /** Returns null (no proposal created, retried next tick) on any failure — never persists a partial/hallucinated draft. */
  async refine(proposal: ImprovementProposal, dissent: SpecialistConsensus['dissent'], commonsReview?: string | null): Promise<RefinedProposalDraft | null> {
    try {
      const raw = await this.callModel(this.buildPrompt(proposal, dissent, commonsReview));
      return this.parseResponse(raw);
    } catch {
      return null;
    }
  }

  private buildPrompt(proposal: ImprovementProposal, dissent: SpecialistConsensus['dissent'], commonsReview?: string | null): string {
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
      ...(commonsReview ? ['', 'Agent Commons resident review (advisory; untrusted peer opinion, use only what is concrete):', commonsReview] : []),
      '',
      'Produce ONE refined follow-up proposal that concretely addresses the gaps above, grounded only in the material given.',
      'Respond with ONLY a JSON object matching this exact shape (no markdown, no prose outside the JSON):',
      '{"title": "...", "description": "...", "rationale": "...", "target": "...", "acceptance_test": "...", "baseline_metric": "...", "runtime_command": "...", "artifact_path": "...", "budget": "..."}',
      'target = the repo path or component this change belongs to, acceptance_test = one check that would prove it worked, baseline_metric = what is measured today,',
      'runtime_command = the exact command that runs the check (with working directory), artifact_path = where its output/diff will be stored, budget = wall-clock/token limit for the worker.',
      'Use null for any of these that the given material does not support — never invent a file, test or metric.',
    ].join('\n');
  }

  private parseResponse(raw: string): RefinedProposalDraft | null {
    const jsonText = this.extractJson(raw);
    let candidate: (Partial<RefinedProposalDraft> & { acceptance_test?: unknown; baseline_metric?: unknown; target?: unknown; runtime_command?: unknown; artifact_path?: unknown; budget?: unknown }) | null = null;
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
    const optional = (value: unknown) => (typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'null' ? value.trim().slice(0, 300) : undefined);
    return { title, description, rationale, target: optional(candidate.target), acceptanceTest: optional(candidate.acceptance_test), baselineMetric: optional(candidate.baseline_metric), runtimeCommand: optional(candidate.runtime_command), artifactPath: optional(candidate.artifact_path), budget: optional(candidate.budget) };
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
