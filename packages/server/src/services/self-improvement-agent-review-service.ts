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
 * this is deliberately not built to rubber-stamp.
 *
 * B32 (operator 11-10, 'no silent coercion'): an answer must pass schema + semantic validation (stance in the allowed
 * set, confidence in [0,1], non-empty findings, non-empty concrete evidence_refs). An invalid answer gets ONE re-ask
 * that quotes the validation error; still invalid → quarantined (specialist_review_quarantine: model, prompt hash, raw
 * hash, short excerpt), never stored as a review and never a needs_more_evidence vote. A seat whose attempts are
 * exhausted is closed and the panel decides on its valid reviews only; no valid review at all → panel_failed (#758).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateText, llmEndpoints, type LlmUsage } from './llm-fallback';
import { prepareState } from './typesafe-client';
import { buildDecisionContext } from './decision-context-service';
import { kbContext } from './kb-corpus';
import type { Database } from 'better-sqlite3';
import { SpecialistPanelService, type SpecialistPanelRecord, type SpecialistProfile } from './specialist-panel-service';
import { extraRepoBySlug, repoRefOf } from './repo-registry';
import { chooseModel, modelSelectorMode, recordModelCall, shadowCandidate, shadowRate } from './model-selector';
import { noteOllamaOutput, ollamaLimitClass, PANEL_FALLBACK_PREFIX, panelFallbackModel, panelFallbackRuntime } from './inference-failover';
import { effectiveFallbackRuntime } from './ollama-outage-fallback';
import { AUTH_MISSING, LIMIT_HIT, claudeSubscriptionBackoff, isSubscriptionLimit, recordSubscriptionLimit, subscriptionAuthPresent } from './subscription-gym';
import { subscriptionChildEnv } from '../execution/executors/subscription-env';

/** The model argument is only passed when MODEL_SELECTOR_MODE is on; undefined = the caller's own default (unchanged). */
/** usage: B29 — the provider's token counts for this call (not called = unknown; the ledger keeps null, never 0) */
export type ModelCaller = (prompt: string, model?: string, usage?: (u: LlmUsage) => void) => Promise<string>;
const CONSUMER = 'panel_review';

interface ParsedReview {
  stance: 'support' | 'oppose' | 'uncertain' | 'needs_evidence';
  confidence: number;
  findings: string[];
  recommendations: string[];
  evidence_refs: string[];
  limitations?: string;
}

const VALID_STANCES = new Set(['support', 'oppose', 'uncertain', 'needs_evidence']);
const REVIEW_SHAPE = '{"stance": "support|oppose|uncertain|needs_evidence", "confidence": 0.0-1.0, "findings": ["..."], "recommendations": ["..."], "evidence_refs": ["..."], "limitations": "..."}';
/** B32: a seat is closed after this many quarantined attempts (each attempt = one call + one re-ask). */
export const QUARANTINE_SEAT_LIMIT = 2;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Provenance stored on every automated review and quarantined attempt. */
interface Provenance { model: string; prompt_sha256: string; raw_sha256: string | null; attempt: number }
type AskOutcome = { review: ParsedReview; provenance: Provenance } | { invalid: string; raw: string; provenance: Provenance } | { error: string };

/**
 * E4: why an answer failed validation — 'parse' (no JSON object could be read) vs 'schema' (JSON, but a field breaks the
 * review schema). The writer records it (ledger status invalid_parse / invalid_schema); the quarantine row keeps the exact
 * error text, which reviewFailureKind() maps back without guessing (the parse messages are this fixed list).
 */
export type ReviewFailureKind = 'parse' | 'schema';
export const PARSE_ERRORS = ['no JSON object in the answer', 'answer is not valid JSON', 'answer is not a JSON object'] as const;
const SCHEMA_ERROR = /^(stance|confidence|findings|evidence_refs|recommendations|limitations) must /;
export function reviewFailureKind(error: string): ReviewFailureKind | null {
  return (PARSE_ERRORS as readonly string[]).includes(error) ? 'parse' : SCHEMA_ERROR.test(error) ? 'schema' : null;
}

const PLACEHOLDER_REF = /^(\.{2,}|n\/a|none|todo|tbd)$/i;

/**
 * B32: strict schema + semantic check of one specialist answer. No coercion: a missing or out-of-set stance, a confidence
 * outside [0,1], empty findings or no concrete evidence ref makes the answer invalid (re-asked once, then quarantined).
 * ponytail: 'cited evidence exists' is checked as 'non-empty, not a placeholder'; matching refs against the prompt
 * context is the upgrade if invented refs show up in quarantine / audit samples.
 */
export function validateReview(raw: string): { ok: true; review: ParsedReview } | { ok: false; error: string; kind: ReviewFailureKind } {
  const parse = (error: string) => ({ ok: false as const, error, kind: 'parse' as const });
  const schema = (error: string) => ({ ok: false as const, error, kind: 'schema' as const });
  // thinking models (and the LLM fallback) may prefix the answer with a reasoning block that itself contains braces
  const trimmed = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  const jsonText = fenced ? fenced[1].trim() : first !== -1 && last > first ? trimmed.slice(first, last + 1) : null;
  if (!jsonText) return parse(PARSE_ERRORS[0]);
  let c: Record<string, unknown>;
  try { c = JSON.parse(jsonText); } catch { return parse(PARSE_ERRORS[1]); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return parse(PARSE_ERRORS[2]);
  if (typeof c.stance !== 'string' || !VALID_STANCES.has(c.stance)) {
    return schema(`stance must be one of support|oppose|uncertain|needs_evidence (got ${JSON.stringify(c.stance ?? null)})`);
  }
  const confidence = typeof c.confidence === 'number' ? c.confidence : Number.NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return schema('confidence must be a number between 0 and 1');
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : null);
  const findings = strings(c.findings);
  if (!findings || findings.length === 0) return schema('findings must be a non-empty array of strings');
  const evidence = strings(c.evidence_refs)?.filter((r) => r.length >= 3 && !PLACEHOLDER_REF.test(r));
  if (!evidence || evidence.length === 0) return schema('evidence_refs must cite at least one concrete item from the context');
  if (c.recommendations !== undefined && !Array.isArray(c.recommendations)) return schema('recommendations must be an array of strings');
  if (c.limitations !== undefined && c.limitations !== null && typeof c.limitations !== 'string') return schema('limitations must be a string');
  return {
    ok: true,
    review: {
      stance: c.stance as ParsedReview['stance'], confidence, findings, recommendations: strings(c.recommendations) ?? [],
      evidence_refs: evidence, limitations: typeof c.limitations === 'string' ? c.limitations : undefined,
    },
  };
}

function defaultOllamaUrl(): string {
  return process.env.OLLAMA_URL || ''; // unset = no primary endpoint (llmEndpoints drops it), M2d
}

function defaultModel(): string {
  return process.env.SELF_IMPROVEMENT_REVIEW_MODEL || 'qwen2.5:32b-instruct-q4_K_M';
}

function reviewTimeoutMs(): number {
  return Number(process.env.SELF_IMPROVEMENT_REVIEW_TIMEOUT_MS) || 120_000;
}

async function callOllama(prompt: string, model = defaultModel(), usage?: (u: LlmUsage) => void): Promise<string> {
  return generateText(
    { prompt, model, temperature: 0.2, maxTokens: 1024, timeoutMs: reviewTimeoutMs(), purpose: 'panel_review:review', onUsage: usage },
    { endpoints: llmEndpoints(defaultOllamaUrl()) },
  );
}

const MAX_GENERATION_ATTEMPTS = 3;

/**
 * PANEL_FALLBACK_RUNTIME=claude: the CLI args of one panel answer — print mode, JSON result, no tools at all (`--tools ""`)
 * in plan mode (read-only; the most restrictive mode of the 2.1.282 CLI), prompts nobody answers denied, no session kept,
 * no MCP servers. Prompt on stdin.
 */
export const panelClaudeArgs = (model: string): string[] =>
  ['-p', '--output-format', 'json', '--model', model, '--permission-mode', 'plan', '--permission-prompts', 'none', '--tools', '', '--no-session-persistence', '--strict-mcp-config'];
/** A fallback failure that says nothing about the proposal (no OAuth token / subscription window used): no attempt spent. */
const FALLBACK_INFRA = /^panel_fallback: infra: subscription_(auth_missing|limit)\b/; // AUTH_MISSING / LIMIT_HIT (literal: import cycle at load)
export type SpawnFn = typeof spawn;

/**
 * One panel answer from the Claude Code CLI on the Max subscription: child env without any API key / base URL, the OAuth
 * token injected (subscriptionChildEnv), cwd a temp dir (no repo CLAUDE.md). No token → refused before any spawn.
 * model is 'claude:<model>' (the provenance name). Usage reported as provider subscription-cli:claude.
 */
export function callClaudePanel(prompt: string, model = `${PANEL_FALLBACK_PREFIX}${panelFallbackModel()}`, usage?: (u: LlmUsage) => void,
  deps: { spawnFn?: SpawnFn; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const env = deps.env ?? process.env;
  if (!subscriptionAuthPresent('claude', env)) return Promise.reject(new Error(`panel_fallback: ${AUTH_MISSING}`));
  const cliModel = model.startsWith(PANEL_FALLBACK_PREFIX) ? model.slice(PANEL_FALLBACK_PREFIX.length) : model;
  return new Promise((resolve, reject) => {
    const child = (deps.spawnFn ?? spawn)(env.CLAUDE_BIN_PATH || 'claude', panelClaudeArgs(cliModel), { cwd: os.tmpdir(), env: subscriptionChildEnv(env, 'claude', env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), reviewTimeoutMs());
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`panel_fallback: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let out: { result?: unknown; is_error?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null = null;
      try { out = JSON.parse(stdout.trim()); } catch { out = null; }
      if (code !== 0 || !out || out.is_error === true || typeof out.result !== 'string') {
        const detail = (typeof out?.result === 'string' ? out.result : stderr || stdout).trim().split('\n').pop()?.slice(0, 200) ?? '';
        reject(new Error(`panel_fallback: ${isSubscriptionLimit(code ?? 1, stdout, stderr) ? LIMIT_HIT : `exit=${code ?? 'signal'}`} ${detail}`.trim()));
        return;
      }
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      try { usage?.({ tokensIn: n(out.usage?.input_tokens), tokensOut: n(out.usage?.output_tokens), provider: 'subscription-cli:claude', model }); } catch { /* usage never breaks the call */ }
      resolve(out.result);
    });
    child.stdin?.end(prompt);
  });
}

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

/** The fixed instruction lines of every specialist panel review prompt (exported for the STE prompt lint). */
export const PANEL_REVIEW_INSTRUCTIONS = [
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
];

export class SelfImprovementAgentReviewService {
  private readonly panels: SpecialistPanelService;
  private readonly callModel: ModelCaller;
  private readonly generationFailures = new Map<string, number>();
  private readonly random: () => number;

  private readonly callFallback: ModelCaller;

  constructor(private readonly db: Database, callModel: ModelCaller = callOllama, opts: { random?: () => number; callFallback?: ModelCaller } = {}) {
    this.panels = new SpecialistPanelService(db);
    this.callModel = callModel;
    this.random = opts.random ?? Math.random;
    this.callFallback = opts.callFallback ?? ((prompt, model, usage) => callClaudePanel(prompt, model, usage));
  }

  /** Generate and submit reviews for every specialist role that hasn't reviewed this panel yet. */
  async reviewMissingSpecialists(panelId: string, runId: string): Promise<SpecialistPanelRecord> {
    let panel = this.panels.getPanel(panelId);
    const reviewed = new Set((panel.reviews || []).map((review) => review.specialist_id));
    const closed = this.panels.closedSeats(panel.id);
    const missing = panel.panel.filter((profile) => !reviewed.has(profile.id) && !closed.has(profile.id));
    // one advisory lookup per panel (not per specialist); null unless TYPESAFE_DECISION_CONTEXT_MODE=enforce
    const lessons = missing.length
      ? (await buildDecisionContext(this.db, { type: 'specialist_panel', id: panel.id }, { topic: panel.topic, context: panel.context }).catch(() => null))?.text
      : undefined;
    // L2: the operator's KB as quoted reference, once per panel
    const kb = missing.length ? await kbContext(this.db, { type: 'specialist_panel', id: panel.id }, `${panel.topic}\n${JSON.stringify(panel.context).slice(0, 2_000)}`) : null;
    const advisory = [lessons, kb].filter(Boolean).join('\n\n') || undefined;

    for (const profile of missing) {
      const outcome = await this.reviewOne(panel, profile, advisory);
      if ('invalid' in outcome) {
        // B32: never a review — quarantine the attempt; close the seat once its attempts are exhausted
        this.panels.quarantineAttempt({ panel_id: panel.id, specialist_id: profile.id, ...outcome.provenance, raw_excerpt: outcome.raw, error: outcome.invalid });
        if (this.panels.seatQuarantineCount(panel.id, profile.id) >= QUARANTINE_SEAT_LIMIT) panel = this.panels.closeSeat(panel.id, profile.id);
        continue;
      }
      if ('error' in outcome) {
        // A failed model call is not a judgement. It used to be stored as a confidence-0 needs_evidence review
        // (208 of 2309 production reviews: 404 on a missing model, 'fetch failed'), which parked the proposal
        // for good. Leave the seat empty so the next tick retries; only after MAX_GENERATION_ATTEMPTS in a row
        // fall back to the recorded failure so a permanently broken proposal cannot spin forever.
        // A connectivity failure (host down, timeout) says nothing about the proposal: wait it out without
        // spending attempts, or a 45-minute outage would park every proposal in review (seen 2026-09-21).
        if (CONNECTIVITY_ERROR.test(outcome.error) || FALLBACK_INFRA.test(outcome.error)) {
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
        // bounded: a seat that keeps failing to generate is closed (quarantined), not filled with a synthetic review
        this.panels.quarantineAttempt({ panel_id: panel.id, specialist_id: profile.id, model: defaultModel(), error: `generation failed: ${outcome.error}`, attempt: attempts });
        panel = this.panels.closeSeat(panel.id, profile.id);
        continue;
      }
      panel = this.panels.submitReview(
        panel.id,
        { specialist_id: profile.id, ...outcome.review, ...outcome.provenance },
        `agent:${profile.id}:${runId}${outcome.provenance.model.startsWith(PANEL_FALLBACK_PREFIX) ? ':panel_fallback' : ''}`,
      );
    }
    return panel;
  }

  private async reviewOne(panel: SpecialistPanelRecord, profile: SpecialistProfile, lessons?: string): Promise<AskOutcome> {
    const prompt = this.buildPrompt(panel, profile, lessons);
    // PANEL_FALLBACK_RUNTIME=claude: while Ollama is limited (auto state or the manual outage flag) the seat is answered on the
    // subscription; a panel call failing with the usage-limit shape is answered there too. Same validation / quarantine.
    const fallback = panelFallbackRuntime() ? `${PANEL_FALLBACK_PREFIX}${panelFallbackModel()}` : null;
    if (fallback && effectiveFallbackRuntime(this.db)) return this.askFallback(prompt, profile.id, fallback);
    const outcome = await this.reviewOnOllama(prompt, profile);
    if (fallback && 'error' in outcome && ollamaLimitClass(outcome.error)) {
      noteOllamaOutput(this.db, outcome.error, 'panel_review');
      return this.askFallback(prompt, profile.id, fallback);
    }
    return outcome;
  }

  /**
   * The fallback seat under the shared Claude subscription backoff (subscription-gym claudeSubscriptionBackoff): while it holds,
   * no spawn and an infra error (FALLBACK_INFRA: no attempt spent, no quarantine, no verdict); a limit hit records it.
   */
  private async askFallback(prompt: string, who: string, model: string): Promise<AskOutcome> {
    const backoff = claudeSubscriptionBackoff(this.db);
    if (backoff) return { error: `panel_fallback: ${LIMIT_HIT} backoff (hit ${backoff.hit_at} via ${backoff.source}, until ${backoff.until})` };
    const outcome = await this.ask(prompt, who, model, undefined, this.callFallback);
    if ('error' in outcome && outcome.error.startsWith(`panel_fallback: ${LIMIT_HIT}`)) recordSubscriptionLimit(this.db, 'panel_review');
    return outcome;
  }

  private async reviewOnOllama(prompt: string, profile: SpecialistProfile): Promise<AskOutcome> {
    const mode = modelSelectorMode();
    if (mode === 'off') return this.ask(prompt, profile.id);
    // MS-1: enforce uses the cheapest model that earned it (incumbent as fallback); shadow samples one candidate and discards it
    const incumbent = defaultModel();
    const pick = mode === 'enforce' ? chooseModel(this.db, CONSUMER, incumbent) : incumbent;
    let outcome = await this.ask(prompt, profile.id, pick);
    // the configured fallback: a selector-picked challenger that fails or answers invalidly falls back to the incumbent
    if (pick !== incumbent && !('review' in outcome)) outcome = await this.ask(prompt, profile.id, incumbent);
    if (mode === 'shadow' && this.random() < shadowRate()) {
      const candidate = shadowCandidate(this.db, CONSUMER, incumbent);
      if (candidate) await this.ask(prompt, profile.id, candidate, 'review' in outcome ? outcome.review.stance : null);
    }
    return outcome;
  }

  /**
   * One answer with at most one re-ask: the re-ask quotes the validation error. With a model given the call is recorded in
   * the MS-1 ledger (status ok / repaired / invalid_parse / invalid_schema (E4; 'invalid' before) / empty / error; a shadow call when incumbentStance is passed).
   */
  private async ask(prompt: string, who: string, model?: string, incumbentStance?: ParsedReview['stance'] | null, callModel: ModelCaller = this.callModel): Promise<AskOutcome> {
    const started = Date.now();
    const shadow = incumbentStance !== undefined;
    const promptSha = sha256(prompt);
    // B29: tokens of this call (summed over the re-ask) as the provider reported them; recorded on the selector row
    // (the transport row then carries none, so they count once). No row (selector off) = the transport row keeps them.
    let usage: { tokensIn: number | null; tokensOut: number | null; provider: string | null } = { tokensIn: null, tokensOut: null, provider: null };
    const sink = (u: LlmUsage) => {
      const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
      usage = { tokensIn: add(usage.tokensIn, u.tokensIn), tokensOut: add(usage.tokensOut, u.tokensOut), provider: u.provider };
    };
    const record = (ok: boolean, chars: number, status: string, stance?: string) => {
      if (model) recordModelCall(this.db, { consumer: CONSUMER, model, ok, latencyMs: Date.now() - started, outChars: chars, shadow: shadow ? 1 : 0,
        agree: shadow && incumbentStance && stance ? stance === incumbentStance : null, status,
        provider: usage.provider ?? (model.startsWith(PANEL_FALLBACK_PREFIX) ? 'subscription-cli:claude' : null), tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
        taskKind: 'review', purpose: `panel_review:${shadow ? 'shadow' : model.startsWith(PANEL_FALLBACK_PREFIX) ? 'fallback' : 'review'}` });
    };
    try {
      let raw = await callModel(prompt, model, model ? sink : undefined);
      // prod 2026-09-25 (sample logged since #416): the "unreadable" answers were empty responses — a transient model
      // failure, treated like an unreachable host (no attempt spent, never recorded as a vote)
      if (!raw.trim()) { record(false, 0, 'empty'); return { error: 'empty model response (timed out)' }; }
      let checked = validateReview(raw);
      let attempt = 1;
      if (!checked.ok) {
        attempt = 2;
        const retry = await callModel(`${prompt}\n\nYour previous answer was rejected: ${checked.error}. Respond again with ONLY the JSON object in exactly this shape:\n${REVIEW_SHAPE}`, model, model ? sink : undefined);
        if (retry.trim()) { raw = retry; checked = validateReview(raw); }
      }
      const provenance: Provenance = { model: model ?? defaultModel(), prompt_sha256: promptSha, raw_sha256: sha256(raw), attempt };
      if (!checked.ok) {
        record(false, raw.length, `invalid_${checked.kind}`);
        console.warn(`self-improvement review for ${who}${shadow ? ' (shadow)' : ''}: invalid answer after re-ask (${checked.error}; ${raw.length} chars): ${JSON.stringify(raw.slice(0, 160))}`);
        return { invalid: checked.error, raw, provenance };
      }
      record(true, raw.length, attempt === 1 ? 'ok' : 'repaired', checked.review.stance);
      return { review: checked.review, provenance };
    } catch (err) {
      record(false, 0, 'error');
      return { error: err instanceof Error ? err.message : String(err) };
    }
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
      ...PANEL_REVIEW_INSTRUCTIONS,
    ].join('\n');
  }

  private targetEvidence(panel: SpecialistPanelRecord): string | null {
    const context = panel.context as { grounding?: { target?: unknown }; evidence_refs?: unknown } | undefined;
    // multi-repo: a proposal for a registered extra repo (`repo:<slug>`, EXTRA_REPOS_ENABLED=on) is read from that checkout
    const repo = extraRepoBySlug(repoRefOf(context?.evidence_refs));
    return repo ? readTargetExcerpt(context?.grounding?.target, repo.path) : readTargetExcerpt(context?.grounding?.target);
  }
}
