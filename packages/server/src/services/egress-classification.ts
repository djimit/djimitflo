import type { Database } from 'better-sqlite3';
import { DataClassification } from './data-classification';
import { goalRepoSlug, primaryRepo } from './repo-registry';

/**
 * UX-20 (shadow, report only): where does each server-side model call send its data? Classifies the provider recorded in
 * llm_model_calls (UX-18) into a destination class and reports, per consumer, what a stricter routing rule WOULD block.
 * Nothing calls this on a request path — it never blocks, reroutes or changes a call (EGRESS_CLASS_MODE below only records). The provider → class table is
 * information for the operator's legal/security review (docs/design/egress-classification.md), not legal advice.
 */
export type DestinationClass = 'local' | 'eu_hosted' | 'us_cloud' | 'unknown';

/** Known destinations by hostname (suffix match) with the evidence for each class. Unknown stays unknown — never guessed. */
export const DESTINATIONS: Array<{ host: string; cls: DestinationClass; evidence: string }> = [
  { host: 'ollama.com', cls: 'us_cloud', evidence: 'Ollama Cloud, operated by Ollama Inc. (US company); hosting region not verified' },
  { host: 'integrate.api.nvidia.com', cls: 'us_cloud', evidence: 'NVIDIA API catalog (NVIDIA Corp., US); hosting region not verified' },
  { host: 'api.openai.com', cls: 'us_cloud', evidence: 'OpenAI (US company)' },
  { host: 'api.anthropic.com', cls: 'us_cloud', evidence: 'Anthropic (US company)' },
  { host: 'openrouter.ai', cls: 'us_cloud', evidence: 'OpenRouter (US company); routes to further providers' },
  { host: 'generativelanguage.googleapis.com', cls: 'us_cloud', evidence: 'Google Gemini API (US company)' },
  { host: 'api.typesafe.ai', cls: 'unknown', evidence: 'TypeSafe jev API; operator jurisdiction and hosting region not verified' },
];

/** Provider names recorded without a URL. */
const NAMED: Record<string, { host?: string; cls?: DestinationClass; envUrl?: string }> = {
  nvidia: { host: 'integrate.api.nvidia.com' },
  typesafe: { host: 'api.typesafe.ai' },
  local: { cls: 'local' },
  'llama-router': { cls: 'local' },
  // runtime names: the destination is whatever base URL the server is configured with
  'openai-compatible': { envUrl: 'SOCIAL_COMPAT_BASE_URL' },
  ollama: { envUrl: 'OLLAMA_URL' },
  'embedding-provider': { envUrl: 'EMBEDDING_BASE_URL' },
};

/** Loopback, RFC 1918 private ranges and the CGNAT range Tailscale uses = self-hosted machines (no host list in the repo). */
export function isSelfHostedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.ts.net')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function classifyHost(host: string): DestinationClass {
  const h = host.toLowerCase();
  if (isSelfHostedHost(h)) return 'local';
  const hit = DESTINATIONS.find((d) => h === d.host || h.endsWith(`.${d.host}`));
  return hit ? hit.cls : 'unknown';
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

/** Host and destination class of one recorded call. A ':cloud' model with no provider is an Ollama Cloud model (panel review). */
export function resolveDestination(call: { provider?: string | null; model?: string | null }, env: NodeJS.ProcessEnv = process.env): { host: string | null; cls: DestinationClass } {
  const provider = (call.provider ?? '').trim();
  const at = (host: string | null) => ({ host, cls: host ? classifyHost(host) : 'unknown' as DestinationClass });
  const host = hostOf(provider.replace(/^(ollama|openai):/, ''));
  if (host) return at(host);
  const named = NAMED[provider];
  if (named?.cls) return { host: null, cls: named.cls };
  if (named?.host) return at(named.host);
  if (named?.envUrl) return at(hostOf(env[named.envUrl]));
  if (!provider && /:cloud$/.test(call.model ?? '')) return at('ollama.com');
  return { host: null, cls: 'unknown' };
}
export const classifyDestination = (call: { provider?: string | null; model?: string | null }, env: NodeJS.ProcessEnv = process.env): DestinationClass =>
  resolveDestination(call, env).cls;

/**
 * V2 routing rule (NOT wired anywhere): private_only allows only self-hosted and EU-hosted destinations — not US clouds
 * and not unknown ones.
 */
const ROUTING: Record<string, DestinationClass[]> = {
  any: ['local', 'eu_hosted', 'us_cloud', 'unknown'],
  private_only: ['local', 'eu_hosted'],
  on_premise_only: ['local'],
};
const ROUTING_OF: Record<DataClassification, keyof typeof ROUTING> = {
  [DataClassification.PUBLIC]: 'any', [DataClassification.INTERNAL]: 'any',
  [DataClassification.CONFIDENTIAL]: 'private_only', [DataClassification.RESTRICTED]: 'on_premise_only',
};
export function checkProviderRoutingV2(classification: DataClassification, destination: DestinationClass): { allowed: boolean; reason: string } {
  const allowed = ROUTING[ROUTING_OF[classification]].includes(destination);
  return { allowed, reason: `${classification} data → ${destination}: ${allowed ? 'allowed' : 'would be blocked'} under V2 (${ROUTING_OF[classification]})` };
}

/** Assumed data class per consumer (documented in docs/design/egress-classification.md; the operator validates them). */
export const CONSUMER_DATA_CLASS: Record<string, DataClassification> = {
  frontier_experts: DataClassification.PUBLIC, // public papers and repositories
  content_safety: DataClassification.INTERNAL, // untrusted inbound text (agent messages, discoveries, KB pages)
  embeddings: DataClassification.INTERNAL, // proposal and KB text
  panel_review: DataClassification.INTERNAL, // proposal text with file paths, no diffs
  fallback: DataClassification.INTERNAL,
  council: DataClassification.INTERNAL,
  jev: DataClassification.CONFIDENTIAL, // judgments include checker_second_opinion states with source diffs
};
export const dataClassOf = (consumer: string): DataClassification =>
  CONSUMER_DATA_CLASS[consumer] ?? (consumer.startsWith('resident:') ? DataClassification.INTERNAL : DataClassification.CONFIDENTIAL);

/**
 * re-20261105 E7 / C4 (shadow): EGRESS_CLASS_MODE (off | shadow, default off). In shadow every llm_model_calls row (the one
 * ledger of every server-side model call, model-selector.recordModelCall) carries an `egress_class` judgment: destination
 * host + class, the data class of the payload source where the caller knows it, and would_deny under the rule
 * "confidential/restricted data → any non-local destination = deny". Nothing reads it on a request path: it never blocks,
 * reroutes or changes a call. Any other value (also 'enforce') is off — enforcement is a separate, operator-approved change.
 */
export type EgressClassMode = 'off' | 'shadow';
export const egressClassMode = (env: NodeJS.ProcessEnv = process.env): EgressClassMode => (env.EGRESS_CLASS_MODE === 'shadow' ? 'shadow' : 'off');

/** Repos whose source is public on GitHub: a maker diff of these is public data. */
const PUBLIC_REPOS = ['djimit/djimitflo'];
/** `maker_diff:<owner/repo>` of a goal's run: the goal's `repo:<slug>` ref, else the primary repo. */
export const makerDiffSource = (db: Database, goalId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string =>
  `maker_diff:${goalRepoSlug(db, goalId) ?? primaryRepo(env)}`;

/**
 * Data class of a payload source; no source = the consumer's documented assumption (dataClassOf).
 * - kb_page: the operator's private workstation wiki → confidential. kb_pages carries no public-source marker, so every page
 *   is private until one exists.
 * - maker_diff:<slug>: public for a public repo, confidential for any other.
 */
export function dataClassOfSource(consumer: string, source: string | null | undefined): DataClassification {
  if (source === 'kb_page') return DataClassification.CONFIDENTIAL;
  if (source?.startsWith('maker_diff:')) {
    const slug = source.slice('maker_diff:'.length).toLowerCase();
    return PUBLIC_REPOS.includes(slug) ? DataClassification.PUBLIC : DataClassification.CONFIDENTIAL;
  }
  return dataClassOf(consumer);
}

export interface EgressJudgment { host: string | null; dest: DestinationClass; data: DataClassification; source: string | null; would_deny: boolean }
export function egressJudgment(call: { consumer: string; provider?: string | null; model?: string | null; dataSource?: string | null }, env: NodeJS.ProcessEnv = process.env): EgressJudgment {
  const { host, cls } = resolveDestination(call, env);
  const data = dataClassOfSource(call.consumer, call.dataSource);
  const privateData = data === DataClassification.CONFIDENTIAL || data === DataClassification.RESTRICTED;
  return { host, dest: cls, data, source: call.dataSource ?? null, would_deny: privateData && cls !== 'local' };
}

/** egress_class column value for a ledger row; null when the flag is off (no judgment recorded). */
export const egressClassColumn = (call: Parameters<typeof egressJudgment>[0], env: NodeJS.ProcessEnv = process.env): string | null =>
  (egressClassMode(env) === 'shadow' ? JSON.stringify(egressJudgment(call, env)) : null);

/** Readout of the shadow judgments over the window: judged vs unjudged calls and would_deny per consumer × destination × data class. */
function egressShadow(db: Database, env: NodeJS.ProcessEnv, since: string) {
  let rows: Array<{ consumer: string; dest: string | null; data: string | null; judged: number; n: number; deny: number }> = [];
  try {
    rows = db.prepare(`SELECT consumer, json_extract(egress_class, '$.dest') AS dest, json_extract(egress_class, '$.data') AS data,
        egress_class IS NOT NULL AS judged, COUNT(*) AS n, SUM(COALESCE(json_extract(egress_class, '$.would_deny'), 0)) AS deny
      FROM llm_model_calls WHERE created_at >= ? GROUP BY 1, 2, 3, 4`).all(since) as typeof rows;
  } catch { rows = []; }
  const judged = rows.filter((r) => r.judged);
  return {
    mode: egressClassMode(env),
    rule: 'confidential/restricted data → non-local destination = would_deny (shadow: nothing is blocked)',
    calls: rows.reduce((a, r) => a + r.n, 0),
    judged: judged.reduce((a, r) => a + r.n, 0),
    unjudged: rows.filter((r) => !r.judged).reduce((a, r) => a + r.n, 0),
    would_deny: judged.reduce((a, r) => a + r.deny, 0),
    by: judged.map((r) => ({ consumer: r.consumer, dest: r.dest, data: r.data, calls: r.n, would_deny: r.deny })),
  };
}

/** Evidence: calls per consumer × destination class over the window, and what V2 would have blocked per data class. */
export function egressEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now(), days = 7) {
  const since = new Date(now - days * 86_400_000).toISOString();
  let rows: Array<{ consumer: string; provider: string | null; model: string; n: number }> = [];
  try {
    rows = db.prepare('SELECT consumer, provider, model, COUNT(*) AS n FROM llm_model_calls WHERE created_at >= ? GROUP BY 1, 2, 3')
      .all(since) as typeof rows;
  } catch { rows = []; }
  const byConsumer = new Map<string, Record<DestinationClass, number>>();
  const wouldBlock = new Map<string, { calls: number; blocked: number }>();
  for (const r of rows) {
    const cls = classifyDestination(r, env);
    const c = byConsumer.get(r.consumer) ?? { local: 0, eu_hosted: 0, us_cloud: 0, unknown: 0 };
    c[cls] += r.n; byConsumer.set(r.consumer, c);
    const dc = dataClassOf(r.consumer);
    const w = wouldBlock.get(dc) ?? { calls: 0, blocked: 0 };
    w.calls += r.n; if (!checkProviderRoutingV2(dc, cls).allowed) w.blocked += r.n;
    wouldBlock.set(dc, w);
  }
  return {
    window_days: days,
    note: 'shadow report — nothing is blocked; destination classes and data classes are assumptions for the operator to validate',
    by_consumer: [...byConsumer].map(([consumer, classes]) => ({ consumer, data_class: dataClassOf(consumer), ...classes })),
    would_block_v2: [...wouldBlock].map(([data_class, v]) => ({ data_class, ...v })),
    shadow: egressShadow(db, env, since),
  };
}
