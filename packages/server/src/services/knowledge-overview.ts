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
}

export function knowledgeOverview(db: Database, now = Date.now()): KnowledgeOverview {
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
  return {
    at: new Date(now).toISOString(), sources, relevance, recent_relevant,
    kb_retrieval: { hits_30d: kb?.hits ?? 0, panels_30d: kb?.panels ?? 0, last: kb?.last ?? null },
    interest_profile,
  };
}
