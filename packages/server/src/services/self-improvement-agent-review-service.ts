/**
 * SelfImprovementAgentReviewService — LLM-generated specialist reviews.
 *
 * Specialist panels (SpecialistPanelService) exist and the human-facing UI to
 * fill them in exists (SpecialistPanelCard on /swarm-resources), but nothing
 * ever generated a review automatically — the panel this was built for sat at
 * 0/2 submitted reviews indefinitely. The only prior example of an automated
 * submitReview() caller (ProofRunService) uses hardcoded demo content for a
 * sales demo, not a real judgment — not reusable here.
 *
 * This calls a model directly per specialist role, using each role's own
 * profile (from the panel's catalog snapshot) as the reviewer persona, and
 * requires it to answer in the panel's own output_schema as JSON. The prompt
 * is explicit that 'oppose'/'needs_evidence' are expected, valid outcomes —
 * this is deliberately not built to rubber-stamp. A response that fails to
 * parse, or omits evidence, is submitted as 'needs_evidence' with a synthetic
 * evidence marker rather than inventing supporting evidence to pass
 * validation.
 */

import type { Database } from 'better-sqlite3';
import { SpecialistPanelService, type SpecialistPanelRecord, type SpecialistProfile } from './specialist-panel-service';

export type ModelCaller = (prompt: string) => Promise<string>;

interface ParsedReview {
  stance: 'support' | 'oppose' | 'uncertain' | 'needs_evidence';
  confidence: number;
  findings: string[];
  recommendations: string[];
  evidence_refs: string[];
  limitations?: string;
}

const VALID_STANCES = new Set(['support', 'oppose', 'uncertain', 'needs_evidence']);
const FALLBACK_EVIDENCE = 'agent-review:model-response-unparseable-or-missing-evidence';

function defaultOllamaUrl(): string {
  return process.env.OLLAMA_URL || 'http://192.168.1.28:11434';
}

function defaultModel(): string {
  return process.env.SELF_IMPROVEMENT_REVIEW_MODEL || 'qwen2.5:32b-instruct-q4_K_M';
}

function reviewTimeoutMs(): number {
  return Number(process.env.SELF_IMPROVEMENT_REVIEW_TIMEOUT_MS) || 120_000;
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
      // Reasoning models (e.g. qwen3.5:cloud) burn most of num_predict on an
      // internal "thinking" trace before ever emitting the requested JSON —
      // observed truncating the real response entirely on a review-length
      // prompt. We want the structured answer, not the transcript.
      think: false,
      options: { temperature: 0.2, num_predict: 1024 },
    }),
    signal: AbortSignal.timeout(reviewTimeoutMs()),
  });
  if (!response.ok) throw new Error(`Ollama request failed: ${response.status}`);
  const data = (await response.json()) as { response?: string };
  return data.response || '';
}

export class SelfImprovementAgentReviewService {
  private readonly panels: SpecialistPanelService;
  private readonly callModel: ModelCaller;

  constructor(db: Database, callModel: ModelCaller = callOllama) {
    this.panels = new SpecialistPanelService(db);
    this.callModel = callModel;
  }

  /** Generate and submit reviews for every specialist role that hasn't reviewed this panel yet. */
  async reviewMissingSpecialists(panelId: string, runId: string): Promise<SpecialistPanelRecord> {
    let panel = this.panels.getPanel(panelId);
    const reviewed = new Set((panel.reviews || []).map((review) => review.specialist_id));
    const missing = panel.panel.filter((profile) => !reviewed.has(profile.id));

    for (const profile of missing) {
      const parsed = await this.reviewOne(panel, profile);
      panel = this.panels.submitReview(
        panel.id,
        { specialist_id: profile.id, ...parsed },
        `agent:${profile.id}:${runId}`,
      );
    }
    return panel;
  }

  private async reviewOne(panel: SpecialistPanelRecord, profile: SpecialistProfile): Promise<ParsedReview> {
    try {
      const raw = await this.callModel(this.buildPrompt(panel, profile));
      return this.parseResponse(raw);
    } catch (err) {
      return {
        stance: 'needs_evidence',
        confidence: 0,
        findings: [`Review generation failed: ${err instanceof Error ? err.message : String(err)}`],
        recommendations: ['Retry the automated review, or have a human complete this specialist role.'],
        evidence_refs: [FALLBACK_EVIDENCE],
      };
    }
  }

  private buildPrompt(panel: SpecialistPanelRecord, profile: SpecialistProfile): string {
    return [
      `You are acting as an independent "${profile.title}" reviewer on a governance panel.`,
      `Your domains: ${profile.domains.join(', ')}.`,
      `Questions you must consider: ${profile.default_questions.join(' | ')}`,
      `Evidence you are expected to look for: ${profile.required_evidence.join(', ')}`,
      `Do NOT make these forbidden claims: ${profile.forbidden_claims.join(' | ')}`,
      '',
      `Panel topic: ${panel.topic}`,
      `Question to answer: ${panel.question}`,
      `Context: ${JSON.stringify(panel.context)}`,
      '',
      'You are one of several independent reviewers. Your job is to genuinely evaluate this proposal',
      "from your domain's perspective, not to approve it by default. If the evidence is insufficient,",
      "respond with stance 'needs_evidence'. If you see a real problem, respond with stance 'oppose'.",
      "Only respond 'support' if you are actually convinced.",
      '',
      'Respond with ONLY a JSON object matching this exact shape (no markdown, no prose outside the JSON):',
      '{"stance": "support|oppose|uncertain|needs_evidence", "confidence": 0.0-1.0,',
      ' "findings": ["..."], "recommendations": ["..."], "evidence_refs": ["..."], "limitations": "..."}',
      'evidence_refs must cite something concrete from the context above (e.g. a specific fact from the',
      'description/rationale) — do not leave it empty and do not invent evidence that is not in the context.',
    ].join('\n');
  }

  private parseResponse(raw: string): ParsedReview {
    const jsonText = this.extractJson(raw);
    let candidate: Partial<ParsedReview> | null = null;
    try {
      candidate = jsonText ? JSON.parse(jsonText) : null;
    } catch {
      candidate = null;
    }

    if (!candidate || typeof candidate !== 'object') return this.needsEvidenceFallback();

    const stance = typeof candidate.stance === 'string' && VALID_STANCES.has(candidate.stance)
      ? (candidate.stance as ParsedReview['stance'])
      : 'needs_evidence';
    const confidence = Number(candidate.confidence);
    const evidenceRefs = Array.isArray(candidate.evidence_refs)
      ? candidate.evidence_refs.filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
      : [];

    return {
      stance: evidenceRefs.length === 0 ? 'needs_evidence' : stance,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
      findings: this.stringArray(candidate.findings),
      recommendations: this.stringArray(candidate.recommendations),
      evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : [FALLBACK_EVIDENCE],
      limitations: typeof candidate.limitations === 'string' ? candidate.limitations : undefined,
    };
  }

  private needsEvidenceFallback(): ParsedReview {
    return {
      stance: 'needs_evidence',
      confidence: 0,
      findings: ['Model response could not be parsed as a structured review.'],
      recommendations: ['Retry the automated review, or have a human complete this specialist role.'],
      evidence_refs: [FALLBACK_EVIDENCE],
    };
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

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }
}
