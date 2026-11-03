import type { Database } from 'better-sqlite3';
import { DataClassification } from './data-classification';

/**
 * UX-20 (shadow, report only): where does each server-side model call send its data? Classifies the provider recorded in
 * llm_model_calls (UX-18) into a destination class and reports, per consumer, what a stricter routing rule WOULD block.
 * Nothing calls this on a request path — it never blocks, reroutes or changes a call. The provider → class table is
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

/** Destination class of one recorded call. A ':cloud' model with no provider is an Ollama Cloud model (panel review). */
export function classifyDestination(call: { provider?: string | null; model?: string | null }, env: NodeJS.ProcessEnv = process.env): DestinationClass {
  const provider = (call.provider ?? '').trim();
  const url = provider.replace(/^(ollama|openai):/, '');
  const host = hostOf(url);
  if (host) return classifyHost(host);
  const named = NAMED[provider];
  if (named?.cls) return named.cls;
  if (named?.host) return classifyHost(named.host);
  if (named?.envUrl) { const h = hostOf(env[named.envUrl]); return h ? classifyHost(h) : 'unknown'; }
  if (!provider && /:cloud$/.test(call.model ?? '')) return classifyHost('ollama.com');
  return 'unknown';
}

/**
 * V2 routing rule (NOT wired anywhere): private_only allows only self-hosted and EU-hosted destinations — not US clouds
 * and not unknown ones. The original checkProviderRouting (which lists openai and anthropic as private_only) is unchanged.
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

/** Evidence: calls per consumer × destination class over the window, and what V2 would have blocked per data class. */
export function egressEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now(), days = 7) {
  let rows: Array<{ consumer: string; provider: string | null; model: string; n: number }> = [];
  try {
    rows = db.prepare('SELECT consumer, provider, model, COUNT(*) AS n FROM llm_model_calls WHERE created_at >= ? GROUP BY 1, 2, 3')
      .all(new Date(now - days * 86_400_000).toISOString()) as typeof rows;
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
  };
}
