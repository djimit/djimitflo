import type { Database } from 'better-sqlite3';

/**
 * W5 (plan Phase W): what the knowledge pipeline produced and whether it was worth it, per source. Discoveries
 * (fleet agents, scout, KB, operator reading list) → discovery_relevance verdicts (jev) → expert units; knowledge-base
 * retrieval hits in panels; the interest profile fed back to the scouts. Read-only; every query degrades to empty.
 */
export interface SourceRow { source: string; events: number; events_7d: number; last: string | null; yes: number; uncertain: number; no: number; units: number; relevant_pct: number | null }
export interface KnowledgeOverview {
  at: string;
  sources: SourceRow[];
  relevance: { yes: number; uncertain: number; no: number };
  recent_relevant: Array<{ ref: string; title: string; source: string; at: string }>;
  kb_retrieval: { hits_30d: number; panels_30d: number; last: string | null };
  interest_profile: { at: string; terms: string[] } | null;
  /** DI-001 C: DISCOVERY_RELEVANCE_PAUSED — discoveries stored unjudged and the jev calls (and tokens, estimated) not made. */
  relevance_pause: { paused: boolean; unjudged: { pending: number; rejected: number; unit: number }; calls_avoided: number;
    mean_tokens_per_call: number | null; tokens_avoided_estimate: number | null; basis: string;
    backlog: number; states: Record<string, number>; oldest_unjudged_age_hours: number | null;
    rejudge: DiscoveryRejudgeConfig & { per_day: number; drain_estimate_days: number | null } };
}

/**
 * DI-001 C: bounds of rejudgePaused (expert-source-units-service). Defaults: 20 claims per call (one FE scheduler tick,
 * 60 min) and 200 per 24 h — about the pre-pause rate (≈ 208 calls/day) — a stale claim is reclaimed after 15 min (jev p95
 * 320 s), 5 attempts before 'failed'. Lives here (not in the service) so the overview can show it without an import cycle.
 */
export interface DiscoveryRejudgeConfig { batch: number; max_per_day: number; claim_timeout_minutes: number; max_attempts: number; tick_minutes: number }
export function discoveryRejudgeConfig(env: NodeJS.ProcessEnv = process.env): DiscoveryRejudgeConfig {
  const int = (v: string | undefined, d: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
  return { batch: int(env.DISCOVERY_REJUDGE_BATCH, 20), max_per_day: int(env.DISCOVERY_REJUDGE_MAX_PER_DAY, 200), claim_timeout_minutes: int(env.DISCOVERY_REJUDGE_CLAIM_TIMEOUT_MINUTES, 15),
    max_attempts: int(env.DISCOVERY_REJUDGE_MAX_ATTEMPTS, 5), tick_minutes: int(env.FRONTIER_EXPERTS_SCHEDULER_INTERVAL_MINUTES, 60) };
}

export function knowledgeOverview(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): KnowledgeOverview {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const d30 = new Date(now - 30 * 86_400_000).toISOString(); const d7 = new Date(now - 7 * 86_400_000).toISOString();
  const bySource = new Map<string, SourceRow>();
  const row = (source: string) => {
    const key = source || 'unknown';
    if (!bySource.has(key)) bySource.set(key, { source: key, events: 0, events_7d: 0, last: null, yes: 0, uncertain: 0, no: 0, units: 0, relevant_pct: null });
    return bySource.get(key)!;
  };
  for (const e of all<{ source: string; n: number; n7: number; last: string }>(
    `SELECT COALESCE(json_extract(payload, '$.agent'), source) AS source, COUNT(*) AS n, SUM(occurred_at >= ?) AS n7, MAX(occurred_at) AS last
       FROM external_events WHERE event_type LIKE 'discovery.%' AND occurred_at >= ? GROUP BY 1`, d7, d30)) {
    Object.assign(row(e.source), { events: e.n, events_7d: e.n7 ?? 0, last: e.last });
  }
  // verdicts on discoveries before they became units (subject = canonical ref) and on units (provenance names the agent)
  const verdicts = all<{ source: string; decision: string; n: number }>(
    `SELECT COALESCE(json_extract(e.payload, '$.agent'), e.source) AS source, j.decision, COUNT(*) AS n
       FROM judgments j JOIN external_events e ON e.event_type LIKE 'discovery.%' AND json_extract(e.payload, '$.ref') = j.subject_id
      WHERE j.judgment = 'discovery_relevance' AND j.subject_type IN ('discovery_pending', 'discovery_rejected') AND j.created_at >= ?
      GROUP BY 1, 2
     UNION ALL
     SELECT COALESCE(json_extract(i.provenance_json, '$.agent'), 'registry') AS source, j.decision, COUNT(*) AS n
       FROM judgments j JOIN expert_identities i ON i.id = j.subject_id
      WHERE j.judgment = 'discovery_relevance' AND j.subject_type = 'expert_unit' AND j.created_at >= ?
      GROUP BY 1, 2`, d30, d30);
  for (const v of verdicts) {
    const r = row(v.source);
    if (v.decision === 'yes' || v.decision === 'no' || v.decision === 'uncertain') r[v.decision] += v.n;
  }
  for (const u of all<{ source: string; n: number }>(
    `SELECT COALESCE(json_extract(provenance_json, '$.agent'), 'registry') AS source, COUNT(*) AS n FROM expert_identities
      WHERE kind IN ('paper', 'repository') AND created_at >= ? GROUP BY 1`, d30)) row(u.source).units = u.n;
  const sources = [...bySource.values()].map((r) => {
    const judged = r.yes + r.uncertain + r.no;
    return { ...r, relevant_pct: judged ? Math.round((1000 * r.yes) / judged) / 10 : null };
  }).sort((a, b) => b.yes - a.yes || b.events - a.events);
  const relevance = sources.reduce((acc, r) => ({ yes: acc.yes + r.yes, uncertain: acc.uncertain + r.uncertain, no: acc.no + r.no }), { yes: 0, uncertain: 0, no: 0 });
  const recent_relevant = all<{ ref: string; title: string; source: string; at: string }>(
    `SELECT j.subject_id AS ref, COALESCE(i.canonical_name, json_extract(e.payload, '$.title'), j.subject_id) AS title,
            COALESCE(json_extract(i.provenance_json, '$.agent'), json_extract(e.payload, '$.agent'), 'registry') AS source, j.created_at AS at
       FROM judgments j
       LEFT JOIN expert_identities i ON i.id = j.subject_id
       LEFT JOIN external_events e ON e.event_type LIKE 'discovery.%' AND json_extract(e.payload, '$.ref') = j.subject_id
      WHERE j.judgment = 'discovery_relevance' AND j.decision = 'yes' AND j.created_at >= ?
      GROUP BY j.subject_id ORDER BY j.created_at DESC LIMIT 15`, d30);
  const kb = all<{ hits: number; panels: number; last: string | null }>(
    "SELECT COUNT(*) AS hits, COUNT(DISTINCT subject_id) AS panels, MAX(created_at) AS last FROM judgments WHERE judgment = 'kb_retrieval' AND created_at >= ?", d30)[0];
  const profile = all<{ payload_json: string; created_at: string }>(
    "SELECT payload_json, created_at FROM event_outbox WHERE event_type LIKE '%feedback.interests%' ORDER BY created_at DESC LIMIT 1")[0];
  let interest_profile: KnowledgeOverview['interest_profile'] = null;
  if (profile) {
    try {
      const p = JSON.parse(profile.payload_json) as { terms?: unknown; interests?: unknown };
      const terms = (Array.isArray(p.terms) ? p.terms : Array.isArray(p.interests) ? p.interests : [])
        .map((t) => (typeof t === 'string' ? t : (t as { term?: string })?.term)).filter((t): t is string => typeof t === 'string');
      interest_profile = { at: profile.created_at, terms };
    } catch { /* malformed payload: no profile */ }
  }
  // DI-001 C: one call avoided per open backlog ref; keyword-rejected ones only up to the R3 daily cap (all R3 would judge)
  const cap = Number(env.DISCOVERY_GATE_SHADOW_MAX_PER_DAY) || 100;
  const unjudged = { pending: 0, rejected: 0, unit: 0 }; let calls_avoided = 0;
  for (const p of all<{ path: 'pending' | 'rejected' | 'unit'; refs: number }>(`SELECT path, COUNT(DISTINCT ref) AS refs FROM discovery_relevance_backlog
      WHERE state IN ('unjudged', 'rejudging') GROUP BY path, substr(paused_at, 1, 10)`)) {
    unjudged[p.path] += p.refs; calls_avoided += p.path === 'rejected' ? Math.min(cap, p.refs) : p.refs;
  }
  const states = Object.fromEntries(all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM discovery_relevance_backlog GROUP BY state').map((r) => [r.state, r.n]));
  const backlog = (states.unjudged ?? 0) + (states.rejudging ?? 0);
  const oldest = all<{ t: string | null }>("SELECT MIN(paused_at) AS t FROM discovery_relevance_backlog WHERE state IN ('unjudged', 'rejudging')")[0]?.t ?? null;
  const cfg = discoveryRejudgeConfig(env);
  const per_day = Math.min(cfg.batch * Math.floor(1440 / cfg.tick_minutes), cfg.max_per_day);
  const last = all<{ t: string | null }>("SELECT MAX(created_at) AS t FROM judgments WHERE judgment = 'discovery_relevance' AND decision <> 'error'")[0]?.t ?? null;
  const mean = last ? all<{ m: number | null }>(`SELECT AVG(input_tokens + output_tokens) AS m FROM judgments WHERE judgment = 'discovery_relevance' AND decision <> 'error' AND created_at >= ?`,
    new Date(Date.parse(last) - 7 * 86_400_000).toISOString())[0]?.m ?? null : null;
  const mean_tokens_per_call = mean === null ? null : Math.round(mean);
  const relevance_pause = { paused: env.DISCOVERY_RELEVANCE_PAUSED === 'true', unjudged, calls_avoided, mean_tokens_per_call,
    tokens_avoided_estimate: mean_tokens_per_call === null ? null : calls_avoided * mean_tokens_per_call,
    basis: 'estimate: calls avoided × mean input+output tokens of the 7 days up to the last real discovery_relevance call',
    backlog, states, oldest_unjudged_age_hours: oldest ? Math.round((now - Date.parse(oldest)) / 360_000) / 10 : null,
    rejudge: { ...cfg, per_day, drain_estimate_days: per_day ? Math.round((10 * backlog) / per_day) / 10 : null } };
  return {
    at: new Date(now).toISOString(), sources, relevance, recent_relevant, relevance_pause,
    kb_retrieval: { hits_30d: kb?.hits ?? 0, panels_30d: kb?.panels ?? 0, last: kb?.last ?? null },
    interest_profile,
  };
}
