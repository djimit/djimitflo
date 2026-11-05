/**
 * ExplainerMermaidService — P1: generates Mermaid C4-style diagrams from the
 * graph summary and validates syntax before publication. Follows the
 * Litho/deepwiki-rs verification pattern: every diagram must pass a syntax
 * check (balanced nodes, no invalid characters, known diagram type) or it
 * gets repaired/skipped instead of leaking broken markup into bundles.
 */

import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { GraphSummary } from '@djimitflo/shared';

export interface MermaidDiagram {
  type: 'flowchart' | 'component';
  title: string;
  source: string;
  valid: boolean;
}

/** Optional shadow context: with it (and MERMAID_VALIDATE_MODE=shadow) each generated diagram is also checked by the Mermaid API. */
export interface MermaidShadowContext {
  db: Database;
  repo: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

export class ExplainerMermaidService {
  /** The last shadow check started by generateArchitectureDiagram (tests await it; nothing else does). */
  lastShadow: Promise<MermaidShadowDecision | null> | null = null;

  constructor(private readonly shadow?: MermaidShadowContext) {}

  /** Flowchart of top communities and their hub nodes. */
  generateArchitectureDiagram(graph: GraphSummary): MermaidDiagram | null {
    const communities = (graph.communities ?? []).slice(0, 6);
    if (communities.length === 0) return null;

    const lines: string[] = ['flowchart LR'];
    const ids = new Map<string, string>();
    communities.forEach((c, i) => {
      const id = `C${i}`;
      ids.set(c.name, id);
      lines.push(`  ${id}["${escapeLabel(c.name)} (${c.language}, ${c.size})"]`);
    });
    // Hub nodes rendered inside their dominant community (best-effort: first community that "contains" name)
    const hubs = (graph.hub_nodes ?? []).slice(0, 5);
    for (const hub of hubs) {
      const host = communities.find((c) => hub.file?.includes(c.name.split(' ')[0]?.toLowerCase() ?? '\u0000'));
      if (host && ids.has(host.name)) {
        lines.push(`  ${ids.get(host.name)} --- H${sanitize(hub.name)}["${escapeLabel(hub.name)}"]`);
      }
    }
    // Implicit edge flow: connect communities in sequence (visual grouping, no real edges available)
    for (let i = 0; i + 1 < communities.length; i++) {
      lines.push(`  C${i} -.-> C${i + 1}`);
    }

    const source = lines.join('\n');
    const valid = this.validate(source);
    // shadow only: runs after the heuristic decision, never awaited, never changes it
    if (this.shadow) this.lastShadow = shadowValidateMermaid(this.shadow.db, { repo: this.shadow.repo, source, heuristicValid: valid }, this.shadow.env, this.shadow.fetchFn);
    return { type: 'flowchart', title: 'Architecture Overview', source, valid };
  }

  /** Syntax gate: blocks broken mermaid from entering published bundles. */
  validate(source: string): boolean {
    if (!source.trim()) return false;
    const lines = source.trim().split('\n');
    // First line must declare a known diagram type
    const first = lines[0].trim();
    if (!/^(flowchart|graph|sequenceDiagram|classDiagram|erDiagram|gantt|pie|stateDiagram|mindmap)\b/.test(first)) {
      return false;
    }
    let square = 0;
    let round = 0;
    let curly = 0;
    for (const line of lines) {
      for (const ch of line) {
        if (ch === '[') square++;
        if (ch === ']') square--;
        if (ch === '(') round++;
        if (ch === ')') round--;
        if (ch === '{') curly++;
        if (ch === '}') curly--;
        if (square < 0 || round < 0 || curly < 0) return false;
      }
    }
    return square === 0 && round === 0 && curly === 0;
  }

  /** Auto-repair: strip invalid lines, re-validate. Returns null if unrepairable. */
  repair(source: string): string | null {
    const lines = source.split('\n');
    const header = lines[0];
    const body = lines.slice(1).filter((line) => {
      if (!line.trim()) return false;
      // node/edge lines must contain an identifier and not end mid-label
      if (!/[A-Za-z0-9_]/.test(line)) return false;
      const opens = (line.match(/\[/g) ?? []).length;
      const closes = (line.match(/\]/g) ?? []).length;
      return opens === closes;
    });
    if (body.length === 0) return null;
    const repaired = `${header}\n${body.join('\n')}`;
    return this.validate(repaired) ? repaired : null;
  }
}

function escapeLabel(text: string): string {
  return text.replace(/["\n]/g, ' ').slice(0, 60);
}

function sanitize(text: string): string {
  return text.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30).replace(/^_+/, 'N_');
}
/*
 * MERMAID_VALIDATE_MODE=shadow (default off): the hosted Mermaid API (POST https://api.mermaid.ai/v1/validate, 1 credit,
 * beta) runs Mermaid's own parser over a generated diagram and its verdict is recorded next to the heuristic one as ONE
 * `mermaid_validate` judgment per (repo, diagram sha256). Only for repos in MERMAID_VALIDATE_REPOS (default djimit/djimitflo):
 * the diagram code leaves our systems, so public repos only; the row stores the sha256, never the code. Fail-open: no key,
 * a timeout (5 s), 401/402/429/5xx or a network error is `unavailable`, never `invalid`, and nothing is ever blocked.
 */
export const MERMAID_VALIDATE_URL = 'https://api.mermaid.ai/v1/validate';
const MERMAID_VALIDATE_TIMEOUT_MS = 5_000;
/** ponytail: fixed cap (15/day ≈ 450/month < the 500-credit allowance); make it a flag when a second consumer shares the key. */
export const MERMAID_VALIDATE_DAILY_CAP = 15;

export type MermaidApiVerdict = { status: 'valid' | 'invalid' | 'unavailable'; code: string | null; line?: number; column?: number; diagram_type?: string };
export type MermaidShadowDecision = 'agree' | 'heuristic_pass_api_invalid' | 'heuristic_fail_api_valid' | 'unavailable';

export const mermaidValidateMode = (env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' =>
  (env.MERMAID_VALIDATE_MODE || '').trim().toLowerCase() === 'shadow' ? 'shadow' : 'off';

export const mermaidValidateRepos = (env: NodeJS.ProcessEnv = process.env): string[] =>
  (env.MERMAID_VALIDATE_REPOS ?? 'djimit/djimitflo').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);

/** One POST /v1/validate. Every failure of the call itself is `unavailable`; only a 200 with valid:false is `invalid`. */
export async function validateWithMermaidApi(code: string, apiKey: string, fetchFn: typeof fetch = fetch, timeoutMs = MERMAID_VALIDATE_TIMEOUT_MS): Promise<MermaidApiVerdict> {
  try {
    const res = await fetchFn(MERMAID_VALIDATE_URL, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => null) as { valid?: unknown; diagramType?: unknown; error?: { code?: unknown; details?: { line?: unknown; column?: unknown } } } | null;
    if (!res.ok) return { status: 'unavailable', code: `http_${res.status}${typeof body?.error?.code === 'string' ? `:${body.error.code}` : ''}` };
    const diagram_type = typeof body?.diagramType === 'string' ? body.diagramType : undefined;
    if (body?.valid === true) return { status: 'valid', code: null, diagram_type };
    if (body?.valid !== false) return { status: 'unavailable', code: 'unparsed' };
    const d = body.error?.details;
    return { status: 'invalid', code: typeof body.error?.code === 'string' ? body.error.code : 'ERR_DIAGRAM_INVALID', diagram_type,
      ...(typeof d?.line === 'number' ? { line: d.line } : {}), ...(typeof d?.column === 'number' ? { column: d.column } : {}) };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return { status: 'unavailable', code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
  }
}

const inFlight = new Set<string>();

/**
 * Shadow check of one diagram. Returns null when it did not run (off, no key, repo not allowlisted, already judged, daily
 * cap); otherwise the recorded decision. Never throws.
 */
export async function shadowValidateMermaid(db: Database, input: { repo: string; source: string; heuristicValid: boolean }, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<MermaidShadowDecision | null> {
  try {
    if (mermaidValidateMode(env) !== 'shadow') return null;
    const key = env.MERMAID_API_KEY?.trim();
    if (!key || !input.source.trim() || !mermaidValidateRepos(env).includes(input.repo.trim().toLowerCase())) return null;
    const sha = createHash('sha256').update(input.source).digest('hex');
    const slot = `${input.repo}|${sha}`;
    if (inFlight.has(slot)) return null;
    // one definite verdict per (repo, diagram): the critic loop regenerates the same diagram up to 3 times per bundle
    if (db.prepare(`SELECT 1 FROM judgments WHERE judgment = 'mermaid_validate' AND subject_id = ? AND state_hash = ? AND decision != 'unavailable' LIMIT 1`).get(input.repo, sha)) return null;
    const today = (db.prepare(`SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'mermaid_validate' AND created_at >= ?`).get(new Date(Date.now() - 86_400_000).toISOString()) as { n: number }).n;
    if (today >= MERMAID_VALIDATE_DAILY_CAP) return null;
    inFlight.add(slot);
    try {
      const started = Date.now();
      const api = await validateWithMermaidApi(input.source, key, fetchFn);
      const decision: MermaidShadowDecision = api.status === 'unavailable' ? 'unavailable'
        : (api.status === 'valid') === input.heuristicValid ? 'agree'
          : input.heuristicValid ? 'heuristic_pass_api_invalid' : 'heuristic_fail_api_valid';
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, latency_ms, model, created_at)
        VALUES (?, 'mermaid_validate', 'explainer_diagram', ?, ?, 'shadow', ?, ?, ?, ?, 'mermaid-api', ?)`).run(randomUUID(), input.repo, sha, decision, api.code ?? 'ok',
        JSON.stringify({ heuristic_valid: input.heuristicValid, api_valid: api.status === 'unavailable' ? null : api.status === 'valid', error_code: api.code,
          line: api.line ?? null, column: api.column ?? null, diagram_type: api.diagram_type ?? null, diagram_sha256: sha }),
        Date.now() - started, new Date().toISOString());
      return decision;
    } finally { inFlight.delete(slot); }
  } catch { return null; }
}

/** Read-only readout for GET /api/health/mermaid-validate: decision counts in the window; never the key or diagram code. */
export function mermaidValidateEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, days = 30) {
  const counts: Record<MermaidShadowDecision, number> = { agree: 0, heuristic_pass_api_invalid: 0, heuristic_fail_api_valid: 0, unavailable: 0 };
  const base = { mode: mermaidValidateMode(env), key_set: Boolean(env.MERMAID_API_KEY?.trim()), repos: mermaidValidateRepos(env), window_days: days, daily_cap: MERMAID_VALIDATE_DAILY_CAP };
  try {
    const rows = db.prepare(`SELECT decision, COUNT(*) AS n FROM judgments WHERE judgment = 'mermaid_validate' AND created_at >= ? GROUP BY decision`)
      .all(new Date(Date.now() - days * 86_400_000).toISOString()) as Array<{ decision: string; n: number }>;
    for (const r of rows) if (r.decision in counts) counts[r.decision as MermaidShadowDecision] = r.n;
  } catch { return { ...base, counts: null }; }
  return { ...base, counts };
}
