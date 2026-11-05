import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { DataClassification } from './data-classification';
import { classifyDestination, type DestinationClass } from './egress-classification';
import { canonicalJson } from './fleet-event-signatures';
import { goalRepoSlug, primaryRepo, extraRepoByPath } from './repo-registry';

/**
 * Data classification → lane policy (LANE_POLICY_MODE = off | shadow, default off). Which runtime/provider destinations a
 * maker or reviewer may use for work of a given data class. Reuses the existing taxonomy (data-classification.ts, plus
 * `judicial`) and the UX-20 destination classifier (egress-classification.ts: local | eu_hosted | us_cloud | unknown).
 * Shadow records one `lane_policy` judgment per runtime dispatch (loop-worker-executor executeViaEngine) and never changes
 * the chosen runtime; off does nothing at all. Unknown or missing class → confidential (fail-closed); the class source is an
 * explicit `data_classification` on the run or goal metadata, else the repo default below.
 */
export type LaneClass = `${DataClassification}` | 'judicial';
export type LanePolicyMode = 'off' | 'shadow';

export const LANE_POLICY = {
  fail_closed_class: 'confidential',
  /** Repo-level default class when the run and goal name none. A repo missing here falls to fail_closed_class. */
  repo_defaults: { 'djimit/djimitflo': 'public' } as Record<string, LaneClass>,
  classes: {
    public: { destinations: ['local', 'eu_hosted', 'us_cloud', 'unknown'], external_network: true },
    internal: { destinations: ['local', 'eu_hosted', 'us_cloud'], external_network: true },
    confidential: { destinations: ['local'], external_network: false },
    restricted: { destinations: ['local'], external_network: false },
    judicial: { destinations: ['local'], external_network: false },
  } as Record<LaneClass, { destinations: DestinationClass[]; external_network: boolean }>,
  /** Where a runtime (or a model id's `provider/` prefix) sends its model calls: a host, an env base URL (with fallback) or local. */
  provider_destinations: {
    remote: 'local', // workstation pull worker (atomic on the local llama-router); the VPS never calls it
    mock: 'local',
    claude: 'host:api.anthropic.com',
    codex: 'host:api.openai.com',
    gemini: 'host:generativelanguage.googleapis.com',
    atomic: 'env:ATOMIC_AGENT_BASE_URL|https://ollama.com/v1',
    anthropic: 'host:api.anthropic.com',
    openai: 'host:api.openai.com',
    google: 'host:generativelanguage.googleapis.com',
  } as Record<string, string>,
} as const;

/** sha256 of the canonical policy: names exactly which policy judged a dispatch. */
export const LANE_POLICY_HASH = createHash('sha256').update(canonicalJson(LANE_POLICY)).digest('hex');

export const lanePolicyMode = (env: NodeJS.ProcessEnv = process.env): LanePolicyMode =>
  (env.LANE_POLICY_MODE || '').trim().toLowerCase() === 'shadow' ? 'shadow' : 'off';

const isLaneClass = (v: unknown): v is LaneClass => typeof v === 'string' && Object.prototype.hasOwnProperty.call(LANE_POLICY.classes, v);

/** Class of the work: explicit field → repo default → fail-closed. An unrecognised explicit value is fail-closed, never ignored. */
export function resolveLaneClass(input: { explicit?: unknown; repo?: string | null }): { cls: LaneClass; source: 'explicit' | 'repo_default' | 'fail_closed' } {
  if (input.explicit !== undefined && input.explicit !== null && input.explicit !== '') {
    const v = typeof input.explicit === 'string' ? input.explicit.trim().toLowerCase() : input.explicit;
    return isLaneClass(v) ? { cls: v, source: 'explicit' } : { cls: LANE_POLICY.fail_closed_class, source: 'fail_closed' };
  }
  const slug = input.repo?.toLowerCase();
  const hit = slug ? Object.entries(LANE_POLICY.repo_defaults).find(([k]) => k.toLowerCase() === slug) : undefined;
  return hit ? { cls: hit[1], source: 'repo_default' } : { cls: LANE_POLICY.fail_closed_class, source: 'fail_closed' };
}

/**
 * Destination class and provider of a runtime + model identity (leaseIdentity's model_id). An Ollama ':cloud' model goes to
 * ollama.com whatever the runtime; a `provider/model` id is classified by its provider; else the provider table for the runtime; else the
 * egress classifier on the runtime name (unknown stays unknown).
 */
export function laneDestination(runtime: string, modelId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): { destination: DestinationClass; provider: string } {
  const model = (modelId ?? '').trim();
  if (/:cloud$/.test(model)) return { destination: classifyDestination({ model }, env), provider: 'ollama.com' };
  const prefix = model.includes('/') ? model.slice(0, model.indexOf('/')) : '';
  const host = (url: string) => { try { return new URL(url).hostname; } catch { return ''; } };
  const byRef = (ref: string): { destination: DestinationClass; provider: string } => {
    if (ref === 'local') return { destination: 'local', provider: runtime };
    if (ref.startsWith('host:')) return { destination: classifyDestination({ provider: `https://${ref.slice(5)}` }, env), provider: ref.slice(5) };
    const [name, fallback] = ref.slice(4).split('|');
    const url = env[name] || fallback;
    return { destination: classifyDestination({ provider: url }, env), provider: host(url) || 'unknown' };
  };
  if (prefix && prefix !== runtime) {
    const ref = LANE_POLICY.provider_destinations[prefix];
    if (ref) return byRef(ref);
    return { destination: classifyDestination({ provider: prefix, model }, env), provider: prefix };
  }
  const ref = LANE_POLICY.provider_destinations[runtime];
  if (ref) return byRef(ref);
  return { destination: classifyDestination({ provider: runtime, model }, env), provider: runtime };
}

export interface LaneDecision {
  input_class: LaneClass;
  class_source: 'explicit' | 'repo_default' | 'fail_closed';
  rule: string;
  runtime: string;
  model_id: string | null;
  provider: string;
  destination: DestinationClass;
  would_deny: boolean;
  policy_hash: string;
}

/** Pure: may this runtime/model serve work of this class? */
export function evaluateLanePolicy(input: { explicit?: unknown; repo?: string | null }, runtime: string, modelId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env): LaneDecision {
  const { cls, source } = resolveLaneClass(input);
  const rule = LANE_POLICY.classes[cls];
  const { destination, provider } = laneDestination(runtime, modelId, env);
  const allowed = rule.destinations.includes(destination) && (rule.external_network || destination === 'local');
  return { input_class: cls, class_source: source, rule: `${cls}:${rule.destinations.join('|')}${rule.external_network ? '' : ':no_external_network'}`,
    runtime, model_id: modelId ?? null, provider, destination, would_deny: !allowed, policy_hash: LANE_POLICY_HASH };
}

const metaOf = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try { const v = JSON.parse(String(raw ?? '{}')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

/**
 * Shadow hook at the single runtime dispatch point. Off → returns null without touching the database. Shadow → one
 * `lane_policy` judgment (subject = the worker lease). Fail-open: never throws, never alters the lease or the runtime.
 */
export function recordLanePolicyShadow(db: Database, run: { id: string; goal_id: string | null; repository_path: string | null; metadata?: Record<string, unknown> },
  lease: { id: string; role: string }, runtime: string, modelId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): LaneDecision | null {
  if (lanePolicyMode(env) === 'off') return null;
  try {
    const goal = run.goal_id ? db.prepare('SELECT metadata FROM goals WHERE id = ?').get(run.goal_id) as { metadata: string | null } | undefined : undefined;
    const explicit = run.metadata?.data_classification ?? metaOf(goal?.metadata).data_classification;
    const repo = goalRepoSlug(db, run.goal_id) ?? extraRepoByPath(run.repository_path, env)?.slug ?? primaryRepo(env);
    const d = evaluateLanePolicy({ explicit, repo }, runtime, modelId, env);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'lane_policy', 'worker_lease', ?, ?, 'shadow', ?, ?, ?, ?)`)
      .run(randomUUID(), lease.id, d.policy_hash, d.would_deny ? 'would_deny' : 'would_allow',
        `${d.input_class} (${d.class_source}) ${lease.role} ${runtime} → ${d.destination}: ${d.would_deny ? 'would deny' : 'would allow'}`.slice(0, 300),
        JSON.stringify({ ...d, role: lease.role, loop_run_id: run.id, repo }), new Date().toISOString());
    return d;
  } catch { return null; }
}

/** Evolution evidence `lane_policy`: shadow decisions per class in the window. Missing table → null (unknown, not 0). */
export function lanePolicyEvidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  type ClassRow = { data_class: string; would_allow: number; would_deny: number };
  let by_class: ClassRow[] | null = null;
  try {
    by_class = db.prepare(`SELECT COALESCE(json_extract(answers_json, '$.input_class'), 'unknown') AS data_class,
        SUM(decision = 'would_allow') AS would_allow, SUM(decision = 'would_deny') AS would_deny
      FROM judgments WHERE judgment = 'lane_policy' AND created_at >= ? GROUP BY 1 ORDER BY 1`).all(since) as ClassRow[];
  } catch { /* judgments absent: unknown */ }
  return { mode: lanePolicyMode(env), policy_hash: LANE_POLICY_HASH, by_class,
    note: 'shadow only: one lane_policy judgment per maker/reviewer runtime dispatch; the chosen runtime is never changed. Class = explicit data_classification on the run or goal, else the repo default, else confidential (fail-closed).' };
}
