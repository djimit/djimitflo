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

import fs from 'node:fs';
import path from 'node:path';
import { generateText, llmEndpoints } from './llm-fallback';
import { prepareState } from './typesafe-client';
import { buildDecisionContext } from './decision-context-service';
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
  return generateText(
    { prompt, model: defaultModel(), temperature: 0.2, maxTokens: 1024, timeoutMs: reviewTimeoutMs() },
    { endpoints: llmEndpoints(defaultOllamaUrl()) },
  );
}

const MAX_GENERATION_ATTEMPTS = 3;

const EXCERPT_CHARS = 6000;
const SENSITIVE_PATH = /(^|\/)(\.env|node_modules|\.git)(\/|$)|secret|credential|password|\.pem$|id_rsa|\.key$/i;

/**
 * Panels kept answering needs_evidence on fully grounded proposals because they never saw the target file
 * ("provide the source code of ..."; 2026-09-22, both test-gap proposals). Grounded proposals now carry an excerpt of
 * their target. The target comes from a proposal (semi-trusted text), so: relative repo paths only, resolved inside the
 * repository root, no sensitive names, size-capped and secret-scrubbed before it reaches any model.
 */
export function readTargetExcerpt(target: unknown, repoRoot = process.env.REVIEW_EVIDENCE_REPO_PATH || process.env.LOOP_DAEMON_REPOSITORY_PATH): string | null {
  if (typeof target !== 'string' || !repoRoot || !/^[A-Za-z0-9_.\/-]+$/.test(target) || target.includes('..') || target.startsWith('/') || SENSITIVE_PATH.test(target)) return null;
  const root = path.resolve(repoRoot);
  const file = path.resolve(root, target);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2_000_000) return null;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').length;
    return `Target file ${target} (${lines} lines${text.length > EXCERPT_CHARS ? `, first ${EXCERPT_CHARS} characters` : ''}):\n${prepareState(text.slice(0, EXCERPT_CHARS))}`;
  } catch { return null; }
}
const CONNECTIVITY_ERROR = /fetch failed|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|aborted|timed? ?out|socket hang up/i;

export class SelfImprovementAgentReviewService {
  private readonly panels: SpecialistPanelService;
  private readonly callModel: ModelCaller;
  private readonly generationFailures = new Map<string, number>();

  constructor(private readonly db: Database, callModel: ModelCaller = callOllama) {
    this.panels = new SpecialistPanelService(db);
    this.callModel = callModel;
  }

  /** Generate and submit reviews for every specialist role that hasn't reviewed this panel yet. */
  async reviewMissingSpecialists(panelId: string, runId: string): Promise<SpecialistPanelRecord> {
    let panel = this.panels.getPanel(panelId);
    const reviewed = new Set((panel.reviews || []).map((review) => review.specialist_id));
    const missing = panel.panel.filter((profile) => !reviewed.has(profile.id));
    // one advisory lookup per panel (not per specialist); null unless TYPESAFE_DECISION_CONTEXT_MODE=enforce
    const lessons = missing.length
      ? (await buildDecisionContext(this.db, { type: 'specialist_panel', id: panel.id }, { topic: panel.topic, context: panel.context }).catch(() => null))?.text
      : undefined;

    for (const profile of missing) {
      const outcome = await this.reviewOne(panel, profile, lessons);
      if ('error' in outcome) {
        // A failed model call is not a judgement. It used to be stored as a confidence-0 needs_evidence review
        // (208 of 2309 production reviews: 404 on a missing model, 'fetch failed'), which parked the proposal
        // for good. Leave the seat empty so the next tick retries; only after MAX_GENERATION_ATTEMPTS in a row
        // fall back to the recorded failure so a permanently broken proposal cannot spin forever.
        // A connectivity failure (host down, timeout) says nothing about the proposal: wait it out without
        // spending attempts, or a 45-minute outage would park every proposal in review (seen 2026-09-21).
        if (CONNECTIVITY_ERROR.test(outcome.error)) {
          console.warn(`self-improvement review for ${profile.id} skipped, model host unreachable (${outcome.error}); will retry next tick`);
          continue;
        }
        const key = `${panel.id}:${profile.id}`;
        const attempts = (this.generationFailures.get(key) ?? 0) + 1;
        this.generationFailures.set(key, attempts);
        if (attempts < MAX_GENERATION_ATTEMPTS) {
          console.warn(`self-improvement review for ${profile.id} failed (attempt ${attempts}/${MAX_GENERATION_ATTEMPTS}), will retry: ${outcome.error}`);
          continue;
        }
      }
      const parsed = 'error' in outcome ? this.failureReview(outcome.error) : outcome;
      panel = this.panels.submitReview(
        panel.id,
        { specialist_id: profile.id, ...parsed },
        `agent:${profile.id}:${runId}`,
      );
    }
    return panel;
  }

  private async reviewOne(panel: SpecialistPanelRecord, profile: SpecialistProfile, lessons?: string): Promise<ParsedReview | { error: string }> {
    try {
      const raw = await this.callModel(this.buildPrompt(panel, profile, lessons));
      return this.parseResponse(raw);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private failureReview(error: string): ParsedReview {
    return {
      stance: 'needs_evidence',
      confidence: 0,
      findings: [`Review generation failed: ${error}`],
      recommendations: ['Retry the automated review, or have a human complete this specialist role.'],
      evidence_refs: [FALLBACK_EVIDENCE],
    };
  }

  private buildPrompt(panel: SpecialistPanelRecord, profile: SpecialistProfile, lessons?: string): string {
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
      ...(this.targetEvidence(panel) ? ['', this.targetEvidence(panel) as string, 'The target source is provided above: judge the proposal against it and do not ask for the source code again.'] : []),
      ...(lessons ? ['', lessons] : []),
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

  private targetEvidence(panel: SpecialistPanelRecord): string | null {
    const grounding = (panel.context as { grounding?: { target?: unknown } } | undefined)?.grounding;
    return readTargetExcerpt(grounding?.target);
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
