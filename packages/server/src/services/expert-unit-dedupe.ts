import type { Database } from 'better-sqlite3';
import { knowledgeFitness } from './knowledge-fitness';
import { gapDemandByCapability } from './evolution-feedback';

/**
 * FE-DEDUPE (audit 11-10): Frontier Experts units are inflated (prod ≈ 4 708 non-person units for ≈ 1 769 distinct titles).
 * READ-ONLY report: duplicate clusters over expert_identities units (kind paper / repository / area). Nothing is written,
 * merged or deleted here — collapsing duplicates is a later, separately approved migration. Every count below is
 * computed, never applied.
 *
 * Cluster key (within one kind): the unit's canonical id when present — arXiv id without version (also from an arXiv
 * DOI 10.48550/arXiv.<id>), DOI lowercased, GitHub owner/repo lowercased — else its normalised title (NFKC, lowercase,
 * punctuation/symbols → space, whitespace collapsed). A unit with neither is its own cluster ('none').
 * Canonical member: most evidence rows, then oldest created_at, then id.
 */
export type DedupeKeyType = 'arxiv' | 'doi' | 'github' | 'title' | 'none';
export const DEDUPE_KINDS = ['paper', 'repository', 'area'] as const;
type UnitKind = (typeof DEDUPE_KINDS)[number];

/** Pure: NFKC, lowercase, punctuation and symbols to spaces, whitespace collapsed. */
export function normaliseTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const ARXIV_DOI = /10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i;
const ARXIV_REF = /(?:arxiv:\s*|arxiv\.org\/(?:abs|pdf)\/)([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i;
const ARXIV_BARE = /^(\d{4}\.\d{4,5})(?:v\d+)?$/;
const DOI = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const GITHUB = /(?:github:|github\.com\/)([a-z0-9_.-]+)\/([a-z0-9_.-]+)/i;
const SLUG = /^([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i;
const repo = (owner: string, name: string) => `${owner}/${name.replace(/\.git$/i, '').replace(/[.)]+$/, '')}`.toLowerCase();

/** Pure: the canonical id one string carries, or null. */
export function canonicalId(value: string): { type: 'arxiv' | 'doi' | 'github'; value: string } | null {
  const s = value.trim();
  let m = ARXIV_DOI.exec(s) ?? ARXIV_REF.exec(s) ?? ARXIV_BARE.exec(s);
  if (m) return { type: 'arxiv', value: m[1].toLowerCase() };
  if ((m = DOI.exec(s))) return { type: 'doi', value: m[1].replace(/[.,;)\]]+$/, '').toLowerCase() };
  if ((m = GITHUB.exec(s))) return { type: 'github', value: repo(m[1], m[2]) };
  return null;
}

export interface UnitRow { id: string; kind: string; canonical_name: string; aliases_json: string | null; provenance_json: string | null; lifecycle_state: string; created_at: string }

const parse = (s: string | null): unknown => { try { return JSON.parse(s || 'null'); } catch { return null; } };

/** Pure: a unit's cluster key — arXiv > DOI > GitHub over aliases + provenance refs (+ a repository's slug name), else its title. */
export function unitKey(unit: Pick<UnitRow, 'kind' | 'canonical_name' | 'aliases_json' | 'provenance_json'>): { type: DedupeKeyType; value: string } {
  const aliases = parse(unit.aliases_json); const prov = parse(unit.provenance_json) as Record<string, unknown> | null;
  const candidates = [...(Array.isArray(aliases) ? aliases : []), prov?.ref, prov?.arxiv_id, prov?.doi].filter((v): v is string => typeof v === 'string');
  const ids = candidates.map(canonicalId).filter((v): v is NonNullable<typeof v> => v !== null);
  if (unit.kind === 'repository') { const m = SLUG.exec(unit.canonical_name.trim()); if (m) ids.push({ type: 'github', value: repo(m[1], m[2]) }); }
  for (const type of ['arxiv', 'doi', 'github'] as const) { const hit = ids.find((i) => i.type === type); if (hit) return hit; }
  const title = normaliseTitle(unit.canonical_name ?? '');
  return title ? { type: 'title', value: title } : { type: 'none', value: '' };
}

export interface DedupeMember { id: string; lifecycle_state: string; created_at: string; evidence: number; claims: number; capabilities: number; area_links: number }
export interface DedupeCluster {
  kind: UnitKind; key_type: DedupeKeyType; key: string; title: string; size: number;
  canonical: string; members: DedupeMember[]; members_truncated: boolean;
  states: Record<string, number>;
  /** rows attached to the non-canonical members: what a merge would re-point (computed, never applied) */
  would_move: { evidence: number; claims: number; capabilities: number; area_links: number };
}
interface Stat { units: number; clusters: number; duplicate_units: number; inflation_factor: number | null }

const stat = (units: number, clusters: number): Stat => ({ units, clusters, duplicate_units: units - clusters, inflation_factor: clusters ? +(units / clusters).toFixed(3) : null });

export function expertUnitDedupe(db: Database, opts: { limit?: number; now?: number; env?: NodeJS.ProcessEnv } = {}) {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)));
  const all = <T>(sql: string): T[] => { try { return db.prepare(sql).all() as T[]; } catch { return []; } };
  const units = all<UnitRow>(`SELECT id, kind, canonical_name, aliases_json, provenance_json, lifecycle_state, created_at FROM expert_identities
    WHERE kind IN ('paper', 'repository', 'area') ORDER BY created_at, id`);
  const countBy = (sql: string) => new Map(all<{ id: string; n: number }>(sql).map((r) => [r.id, r.n]));
  const evidence = countBy('SELECT expert_id AS id, COUNT(*) AS n FROM expert_evidence WHERE expert_id IS NOT NULL GROUP BY expert_id');
  const claims = countBy('SELECT expert_id AS id, COUNT(*) AS n FROM expert_claims WHERE expert_id IS NOT NULL GROUP BY expert_id');
  const capabilities = countBy('SELECT expert_id AS id, COUNT(*) AS n FROM expert_capabilities GROUP BY expert_id');
  // FE-AREAS: an area's evidence rows point at the paper/repository unit by id (source_ref)
  const areaLinks = countBy("SELECT source_ref AS id, COUNT(*) AS n FROM expert_evidence WHERE expert_id LIKE 'area:%' GROUP BY source_ref");

  const groups = new Map<string, { kind: UnitKind; type: DedupeKeyType; key: string; rows: UnitRow[] }>();
  for (const u of units) {
    const k = unitKey(u);
    const id = k.type === 'none' ? `${u.kind}\u0000none:${u.id}` : `${u.kind}\u0000${k.type}:${k.value}`;
    const g = groups.get(id) ?? { kind: u.kind as UnitKind, type: k.type, key: k.value, rows: [] };
    g.rows.push(u); groups.set(id, g);
  }

  const canonicalOf = new Map<string, string>(); // unit id → its cluster's canonical id
  const clusters: DedupeCluster[] = [];
  for (const g of groups.values()) {
    const members: DedupeMember[] = g.rows.map((u) => ({ id: u.id, lifecycle_state: u.lifecycle_state, created_at: u.created_at,
      evidence: evidence.get(u.id) ?? 0, claims: claims.get(u.id) ?? 0, capabilities: capabilities.get(u.id) ?? 0, area_links: areaLinks.get(u.id) ?? 0 }));
    members.sort((a, b) => b.evidence - a.evidence || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const canonical = members[0].id;
    for (const m of members) canonicalOf.set(m.id, canonical);
    if (members.length < 2) continue;
    const rest = members.slice(1);
    const sum = (f: keyof Pick<DedupeMember, 'evidence' | 'claims' | 'capabilities' | 'area_links'>) => rest.reduce((a, m) => a + m[f], 0);
    const states: Record<string, number> = {};
    for (const m of members) states[m.lifecycle_state] = (states[m.lifecycle_state] ?? 0) + 1;
    clusters.push({ kind: g.kind, key_type: g.type, key: g.key, title: (g.rows.find((r) => r.id === canonical)!.canonical_name ?? '').replace(/\s+/g, ' ').slice(0, 160),
      size: members.length, canonical, members: members.slice(0, 25), members_truncated: members.length > 25, states,
      would_move: { evidence: sum('evidence'), claims: sum('claims'), capabilities: sum('capabilities'), area_links: sum('area_links') } });
  }
  clusters.sort((a, b) => b.size - a.size || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));

  const groupList = [...groups.values()];
  const by_kind = DEDUPE_KINDS.map((kind) => ({ kind, ...stat(units.filter((u) => u.kind === kind).length, groupList.filter((g) => g.kind === kind).length) }));
  const by_key_type = (['arxiv', 'doi', 'github', 'title', 'none'] as const).map((type) => {
    const gs = groupList.filter((g) => g.type === type);
    return { key_type: type, ...stat(gs.reduce((a, g) => a + g.rows.length, 0), gs.length) };
  });
  const isCanonical = (id: string) => canonicalOf.get(id) === id;

  // ---- FE metrics that would change if duplicates were collapsed (computed, never applied) ----
  const cells = new Map<string, { kind: string; state: string; before: number; after: number }>();
  for (const u of units) {
    const k = `${u.kind}\u0000${u.lifecycle_state}`;
    const c = cells.get(k) ?? { kind: u.kind, state: u.lifecycle_state, before: 0, after: 0 };
    c.before++; if (isCanonical(u.id)) c.after++; cells.set(k, c);
  }
  const changedCells = [...cells.values()].filter((c) => c.before !== c.after).sort((a, b) => (b.before - b.after) - (a.before - a.after) || a.kind.localeCompare(b.kind) || a.state.localeCompare(b.state));

  let gap_demand: { areas_annotated_before: number; areas_annotated_after: number; total_before: number; total_after: number } | null = null;
  const demand = (() => { try { return gapDemandByCapability(db, opts.env); } catch { return null; } })();
  if (demand) {
    const caps = new Map<string, string[]>();
    for (const r of all<{ id: string; cap: string }>("SELECT expert_id AS id, capability_id AS cap FROM expert_capabilities WHERE status != 'revoked' AND expert_id LIKE 'area:%'")) caps.set(r.id, [...(caps.get(r.id) ?? []), r.cap]);
    gap_demand = { areas_annotated_before: 0, areas_annotated_after: 0, total_before: 0, total_after: 0 };
    for (const u of units) {
      if (u.kind !== 'area') continue;
      const n = (caps.get(u.id) ?? []).reduce((a, c) => a + (demand.get(c) ?? 0), 0);
      if (!n) continue;
      gap_demand.areas_annotated_before++; gap_demand.total_before += n;
      if (isCanonical(u.id)) { gap_demand.areas_annotated_after++; gap_demand.total_after += n; }
    }
  }

  let knowledge_fitness: { inventory_before: number; inventory_after: number; used_items_before: number; used_items_after: number; used_items_in_duplicate_clusters: number; unused_before: number; unused_after: number } | null = null;
  try {
    const fitness = knowledgeFitness(db, opts.now ?? Date.now(), Number.MAX_SAFE_INTEGER);
    const used = new Set(fitness.top.filter((i) => i.kind === 'expert_unit' && canonicalOf.has(i.id)).map((i) => i.id));
    const inv = units.filter((u) => u.kind === 'paper' || u.kind === 'repository');
    const invClusters = new Set(inv.map((u) => canonicalOf.get(u.id)!));
    const usedClusters = new Set([...used].map((id) => canonicalOf.get(id)!));
    const dupCanon = new Set(clusters.map((c) => c.canonical));
    knowledge_fitness = { inventory_before: inv.length, inventory_after: invClusters.size, used_items_before: used.size, used_items_after: usedClusters.size,
      used_items_in_duplicate_clusters: [...used].filter((id) => dupCanon.has(canonicalOf.get(id)!)).length,
      unused_before: inv.filter((u) => !used.has(u.id)).length, unused_after: [...invClusters].filter((c) => !usedClusters.has(c)).length };
  } catch { knowledge_fitness = null; }

  const duplicateClusters = clusters.length;
  return {
    at: new Date(opts.now ?? Date.now()).toISOString(),
    totals: { ...stat(units.length, groups.size), duplicate_clusters: duplicateClusters,
      /** distinct normalised titles per kind, ignoring ids — the audit's comparison figure */
      distinct_titles: new Set(units.map((u) => `${u.kind}\u0000${normaliseTitle(u.canonical_name ?? '')}`)).size },
    by_kind, by_key_type,
    top_clusters: clusters.slice(0, limit),
    metrics_if_collapsed: {
      funnel: { units_before: units.length, units_after: groups.size, cells_changed: changedCells.length, cells: changedCells },
      /** null: EVOLUTION_FEEDBACK_MODE is not on or no digest has a gap_demand yet (unknown, not 0) */
      gap_demand,
      /** null: knowledge fitness could not be computed (unknown, not 0) */
      knowledge_fitness,
    },
    rule: 'cluster key per kind: arXiv id without version > DOI lowercased > GitHub owner/repo lowercased, else NFKC-lowercase title with punctuation collapsed; canonical = most evidence, then oldest, then id',
    writes: 0 as const,
    merge: 'not implemented: collapsing duplicates is a separate, approved migration',
  };
}
export type ExpertUnitDedupeReport = ReturnType<typeof expertUnitDedupe>;
