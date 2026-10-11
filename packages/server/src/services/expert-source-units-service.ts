import type { Database } from 'better-sqlite3';
import { arenaGateEnabled, fleetSourceGate } from './committee-swarm';
import { FrontierExpertRegistryService } from './frontier-expert-registry-service';
import { ExpertEvidenceEnrichmentService } from './expert-evidence-enrichment-service';
import type { ArxivPaper } from './knowledge-adapters/arxiv-adapter';
import { judgmentMode, runJudgment } from './judgment-service';
import { discoveryRelevance } from './judgments/discovery-relevance';
import { buildEvidencePack } from './commons-evidence-pack';
import { typesafeBusy } from './typesafe-client';

/**
 * E2 (Frontier Experts 2.0): expertise units beyond people. Prod 2026-09-25: 1 365 distinct arXiv papers were stored only
 * as evidence under persons, and 100 of their abstracts link 89 code repositories — none of it usable on its own.
 * This materialises each stored paper, and each repository a paper links, as its own expert identity (kind 'paper' /
 * 'repository') through the normal governed lifecycle:
 *   DISCOVERED → IDENTITY_RESOLVED (an arXiv id / repo path is unambiguous) → EVIDENCE_COLLECTED → CAPABILITY_INFERRED.
 * It never goes further: CHECKED/APPROVED/ACTIVE stay two different humans (I06), and the registry refuses automated
 * actors there anyway. No network: only evidence already stored. FRONTIER_EXPERT_SOURCE_UNITS_ENABLED=true (default off).
 */
export const sourceUnitsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FRONTIER_EXPERT_SOURCE_UNITS_ENABLED === 'true';

/**
 * JEV-SCOPE (operator 08-10): DISCOVERY_RELEVANCE_SOURCES is a comma list of discovery agents (payload `agent`, else the event
 * source) whose discoveries are judged and can become units; unset = every source (unchanged). Prod 08-10 (30 d): relevant
 * verdicts djimitflo-scout 199 of 2 664, operator-chatgpt 8 of 217, hermes-macmini 0 of 105, hermes-eve-v 0 of 16. Other sources
 * stay recorded in external_events, but get no judgment and no unit.
 */
export function discoveryRelevanceSources(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const list = (env.DISCOVERY_RELEVANCE_SOURCES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

/** JEV-BURST: rejected-gate shadow judgments started but not yet recorded; the daily cap counts them (the rows only land later). */
let rejectedInFlight = 0;

/**
 * KE-1: a discovery note is the paper's abstract when it is prose (operator-chatgpt notes are, prod 09-10: 165 of 166 ≥ 200
 * chars), not a scout/HF keyword line ("scout match: agent, coding, …").
 */
export function abstractFromNote(note: unknown): string | null {
  const text = typeof note === 'string' ? note.trim() : '';
  return text.length >= 200 && !/^(scout match|hf daily)\b/i.test(text) ? text : null;
}

interface Discovery { kind: 'paper' | 'repository'; id: string; ref: string; title: string; note: string; categories: string[]; agent: string; source: string }

const ACTOR = 'ingestion:source-units';
const REPO = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;

interface StoredPaper { source_ref: string; title: string; url: string | null; metadata_json: string }

export class ExpertSourceUnitsService {
  private readonly registry: FrontierExpertRegistryService;
  private readonly enrichment: ExpertEvidenceEnrichmentService;
  /** JEV-BURST: fleetSourceGate per source, once per service instance (= once per ingest batch); it costs ~0.7 s on prod. */
  private readonly gateCache = new Map<string, boolean>();
  constructor(private readonly db: Database) {
    this.registry = new FrontierExpertRegistryService(db);
    this.enrichment = new ExpertEvidenceEnrichmentService(db, { registry: this.registry });
  }

  private knownRefs(): Set<string> {
    return new Set((this.db.prepare("SELECT aliases_json FROM expert_identities WHERE kind IN ('paper', 'repository')").all() as Array<{ aliases_json: string }>)
      .flatMap((row) => JSON.parse(row.aliases_json) as string[]));
  }

  /**
   * G1: a paper or repository a fleet agent (Hermes on the Mac mini, Eve-V, ...) discovered, sent as a `discovery.paper` /
   * `discovery.repository` bus event. Only arXiv ids and GitHub slugs are accepted (they identify the unit exactly), text is
   * untrusted and clipped, and only discoveries that match the capability taxonomy become units — most briefing papers
   * (quantum, clinical) are noise for Djimitflo and stay in external_events only.
   */
  ingestDiscovery(event: Record<string, unknown>): 'unit' | 'pending' | 'known' | 'irrelevant' | 'invalid' {
    const d = parseDiscovery(event);
    if (!d) return 'invalid';
    const { id, ref, title, note, categories } = d;
    if (this.knownRefs().has(ref)) return 'known';
    // AR-W6: survival of the fittest for fleet sources — a source whose discoveries are never relevant is not processed further
    const scope = discoveryRelevanceSources();
    if (scope && !scope.has(d.source)) return 'irrelevant';
    const source = typeof event.agent === 'string' ? event.agent.trim().slice(0, 80) : '';
    if (arenaGateEnabled() && source && !this.sourceAllowed(source)) return 'irrelevant';
    const capabilities = this.enrichment.capabilitiesFor({ arxiv_id: id, url: '', title, summary: note, authors: [], categories, primary_category: categories[0] ?? null, published: null });
    if (!capabilities.length) {
      // R3 (shadow): the keyword gate's rejections were never measured. jev judges a capped share of them too, so its
      // relevance can be compared with the gate (yes-rate on rejected vs accepted) before it replaces the gate.
      if (judgmentMode(discoveryRelevance.id) !== 'off' && this.rejectedShadowLeft()) {
        const pack = buildEvidencePack(this.db, 14);
        rejectedInFlight += 1;
        void runJudgment(this.db, discoveryRelevance, { type: 'discovery_rejected', id: ref }, { title, note, capabilities: [], open_problems: { failing_gates: pack.top_failing_gates, failure_causes: pack.failure_causes } })
          .then((verdict) => {
            // KE-2 (prod 09-10: 95 of 222 jev 'yes' sat on gate-rejected refs, so no unit and no consumer ever saw them): when jev
            // decides unit creation (FRONTIER_UNITS_REQUIRE_RELEVANCE) its 'yes' overrides the keyword gate, as FE2 does for
            // accepted ones. Otherwise the verdict stays a measurement and the gate is unchanged.
            if (verdict?.decision === 'yes' && process.env.FRONTIER_UNITS_REQUIRE_RELEVANCE === 'true' && !this.knownRefs().has(ref)) this.overrideUnit(d, verdict.id);
          })
          .catch(() => undefined).finally(() => { rejectedInFlight -= 1; });
      }
      return 'irrelevant';
    }
    const createUnit = () => this.fleetUnit(d, capabilities);
    // FE2 (plan, 29-09): ~1 000 units/week were created for every taxonomy match and nothing used them. With
    // FRONTIER_UNITS_REQUIRE_RELEVANCE the unit is created only after jev classifies the discovery as an open problem or a lane
    // technique; the verdict is then re-pointed at the new unit. Fail-closed: no verdict, no unit. A ref is judged once.
    if (process.env.FRONTIER_UNITS_REQUIRE_RELEVANCE === 'true' && judgmentMode(discoveryRelevance.id) !== 'off') {
      // a failed call (queue full, timeout) is not a verdict: the ref is judged again when it is sent again
      if (this.db.prepare("SELECT 1 FROM judgments WHERE judgment = 'discovery_relevance' AND subject_id = ? AND decision <> 'error' LIMIT 1").get(ref)) return 'known';
      const pack = buildEvidencePack(this.db, 14);
      void runJudgment(this.db, discoveryRelevance, { type: 'discovery_pending', id: ref }, { title, note, capabilities, open_problems: { failing_gates: pack.top_failing_gates, failure_causes: pack.failure_causes } })
        .then((verdict) => {
          const cls = verdict?.answers?.relevance?.choice;
          if (!verdict || (cls !== 'open_problem' && cls !== 'lane_technique') || this.knownRefs().has(ref)) return;
          const unitId = createUnit();
          this.db.prepare("UPDATE judgments SET subject_type = 'expert_unit', subject_id = ? WHERE id = ?").run(unitId, verdict.id);
        }).catch(() => undefined);
      return 'pending';
    }
    const expertId = createUnit();
    // G3 (shadow): is this discovery relevant beyond its topic? Fire-and-forget; never blocks ingestion.
    if (judgmentMode(discoveryRelevance.id) !== 'off') {
      const pack = buildEvidencePack(this.db, 14);
      void runJudgment(this.db, discoveryRelevance, { type: 'expert_unit', id: expertId }, { title, note, capabilities, open_problems: { failing_gates: pack.top_failing_gates, failure_causes: pack.failure_causes } }).catch(() => undefined);
    }
    return 'unit';
  }

  /** R3 cap: rejected-gate shadow judgments in the last 24 h (+ in flight) stay below DISCOVERY_GATE_SHADOW_MAX_PER_DAY (100). */
  private rejectedShadowLeft(): boolean {
    const cap = Number(process.env.DISCOVERY_GATE_SHADOW_MAX_PER_DAY) || 100;
    const today = (this.db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'discovery_relevance' AND subject_type = 'discovery_rejected' AND created_at >= ?")
      .get(new Date(Date.now() - 86_400_000).toISOString()) as { n: number }).n;
    return today + rejectedInFlight < cap;
  }

  private fleetUnit(d: Discovery, capabilities: string[], derived = 'fleet-discovery', extra: Record<string, unknown> = {}): string {
    const url = d.kind === 'paper' ? `https://arxiv.org/abs/${d.id}` : `https://github.com/${d.id}`;
    const abstract = abstractFromNote(d.note);
    return this.unit(d.kind, d.kind === 'paper' ? d.title : d.id, d.ref, { kind: d.kind, title: d.title, url, sourceRef: d.ref, sourceFamily: `agent:${d.agent}`,
      metadata: { derived, agent: d.agent, note: d.note, categories: d.categories, ...(abstract ? { abstract } : {}), ...extra } }, capabilities, { source: 'fleet-discovery', agent: d.agent });
  }

  /** KE-2: a gate-rejected discovery jev called relevant becomes a unit (no taxonomy capability, so it stops at EVIDENCE_COLLECTED). */
  private overrideUnit(d: Discovery, judgmentId: string, extra: Record<string, unknown> = {}): string {
    const unitId = this.fleetUnit(d, [], 'taxonomy_override:jev', extra);
    this.db.prepare("UPDATE judgments SET subject_type = 'expert_unit', subject_id = ? WHERE id = ?").run(unitId, judgmentId);
    return unitId;
  }

  private discoveryEvent(ref: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT payload FROM external_events WHERE event_type LIKE 'discovery.%' AND json_extract(payload, '$.ref') = ? ORDER BY occurred_at DESC LIMIT 1").get(ref) as { payload: string } | undefined;
    try { return row ? JSON.parse(row.payload) as Record<string, unknown> : null; } catch { return null; }
  }

  /**
   * KE-2 one-shot backfill (not run automatically): every existing 'yes' verdict on a gate-rejected ref without a unit
   * becomes a unit from its stored bus event, exactly as the live override does. Idempotent. Run on prod with:
   *   docker exec -e NODE_PATH=/app/node_modules djimitflo-live node -e "const D=require('better-sqlite3');const {ExpertSourceUnitsService}=require('/app/packages/server/dist/services/expert-source-units-service.js');console.log(new ExpertSourceUnitsService(new D('/data/djimitflo.sqlite',{timeout:10000})).backfillRejectedOverrides())"
   */
  backfillRejectedOverrides(limit = 1_000): { candidates: number; created: number; missing_event: number; known: number } {
    const rows = this.db.prepare(`SELECT subject_id AS ref, MAX(created_at) AS at, id FROM judgments WHERE judgment = 'discovery_relevance' AND subject_type = 'discovery_rejected' AND decision = 'yes'
      GROUP BY subject_id ORDER BY at LIMIT ?`).all(limit) as Array<{ ref: string; id: string }>;
    const out = { candidates: rows.length, created: 0, missing_event: 0, known: 0 };
    const known = this.knownRefs();
    for (const row of rows) {
      if (known.has(row.ref)) { out.known += 1; continue; }
      const d = parseDiscovery(this.discoveryEvent(row.ref) ?? {});
      if (!d || d.ref !== row.ref) { out.missing_event += 1; continue; }
      this.overrideUnit(d, row.id, { backfill: true });
      known.add(row.ref); out.created += 1;
    }
    return out;
  }

  /**
   * KE-5 (prod 09-10: 288 TYPESAFE_QUEUE_FULL + 6 timeouts on discovery_relevance, never re-judged because publishers never
   * re-send a ref): a discovery whose only judgments are errors is re-ingested once from its stored bus event, ≤ `limit` per
   * tick, through the normal path (same gate, same cap, same jev limiter). Not while the jev breaker is open or calls are
   * queued. The errored rows are marked `retry=1` (or `retry=0 <why>` when there is nothing to retry), so a retry that
   * errors again is not retried a second time.
   */
  retryErroredRelevance(limit = 50): { retried: number; skipped?: string } {
    if (judgmentMode(discoveryRelevance.id) === 'off') return { retried: 0, skipped: 'off' };
    if (typesafeBusy()) return { retried: 0, skipped: 'jev_busy' };
    const rows = this.db.prepare(`SELECT j.subject_id AS ref, j.subject_type AS type FROM judgments j
      WHERE j.judgment = 'discovery_relevance' AND j.decision = 'error' AND j.subject_type IN ('discovery_pending', 'discovery_rejected')
        AND NOT EXISTS (SELECT 1 FROM judgments k WHERE k.judgment = 'discovery_relevance' AND k.subject_id = j.subject_id AND (k.decision <> 'error' OR k.reason LIKE 'retry=%'))
      GROUP BY j.subject_id, j.subject_type ORDER BY MAX(j.created_at) DESC LIMIT ?`).all(limit) as Array<{ ref: string; type: string }>;
    const mark = this.db.prepare("UPDATE judgments SET reason = ? WHERE judgment = 'discovery_relevance' AND decision = 'error' AND subject_id = ? AND reason IS NULL");
    let retried = 0;
    for (const row of rows) {
      const event = this.discoveryEvent(row.ref);
      if (!event) { mark.run('retry=0 no_event', row.ref); continue; }
      if (row.type === 'discovery_rejected' && !this.rejectedShadowLeft()) continue; // the daily cap: next tick
      mark.run('retry=1', row.ref);
      this.ingestDiscovery(event);
      retried += 1;
    }
    return { retried };
  }

  private sourceAllowed(source: string): boolean {
    let allowed = this.gateCache.get(source);
    if (allowed === undefined) { allowed = fleetSourceGate(this.db, source).allowed; this.gateCache.set(source, allowed); }
    return allowed;
  }

  /** Materialises up to `limit` new units; returns how many papers and repositories became units this call. */
  materialize(limit = 20): { papers: number; repositories: number } {
    const known = this.knownRefs();
    const rows = this.db.prepare(`SELECT source_ref, title, url, metadata_json FROM expert_evidence
      WHERE kind = 'paper' AND lifecycle = 'active' GROUP BY source_ref ORDER BY MIN(created_at)`).all() as StoredPaper[];
    let papers = 0; let repositories = 0;
    for (const row of rows) {
      if (papers + repositories >= limit) break;
      const meta = JSON.parse(row.metadata_json || '{}') as { abstract?: string; categories?: string[]; primary_category?: string | null; published?: string | null; authors?: string[]; arxiv_id?: string };
      const paper: ArxivPaper = { arxiv_id: meta.arxiv_id ?? row.source_ref, url: row.url ?? '', title: row.title, summary: meta.abstract ?? '', authors: meta.authors ?? [], categories: meta.categories ?? [], primary_category: meta.primary_category ?? null, published: meta.published ?? null };
      const capabilities = this.enrichment.capabilitiesFor(paper);
      if (!known.has(row.source_ref) && capabilities.length) {
        // FE-AREAS: units describe the work, not the people — no author names are stored, only how many there are
        const { authors, ...work } = meta;
        this.unit('paper', row.title, row.source_ref, { kind: 'paper', title: row.title, url: row.url, sourceRef: row.source_ref, metadata: { ...work, author_count: authors?.length ?? 0, derived: 'stored-evidence' } }, capabilities, { author_count: authors?.length ?? 0 });
        known.add(row.source_ref); papers += 1;
      }
      for (const m of (meta.abstract ?? '').matchAll(REPO)) {
        const slug = `${m[1]}/${m[2].replace(/[.)]+$/, '').replace(/\.git$/, '')}`.toLowerCase();
        const ref = `github:${slug}`;
        if (known.has(ref) || !capabilities.length || papers + repositories >= limit) continue;
        this.unit('repository', slug, ref, { kind: 'repository', title: slug, url: `https://github.com/${slug}`, sourceRef: ref, metadata: { linked_from: row.source_ref, paper_title: row.title } }, capabilities, { linked_from: row.source_ref });
        known.add(ref); repositories += 1;
      }
    }
    return { papers, repositories };
  }

  private unit(kind: 'paper' | 'repository', name: string, ref: string, evidence: Parameters<FrontierExpertRegistryService['addEvidence']>[1], capabilities: string[], provenance: Record<string, unknown>): string {
    const expert = this.registry.discover({ canonicalName: name, aliases: [ref], kind, provenance: { source: 'stored-evidence', ref, ...provenance }, actor: ACTOR });
    // an arXiv id or a repository path identifies the unit exactly: no namesake problem as with people
    this.registry.resolveIdentity(expert.id, { confidence: 1, actor: ACTOR, reason: `${kind} identified by ${ref}` });
    const evidenceId = this.registry.addEvidence(expert.id, evidence);
    this.registry.transition(expert.id, 'EVIDENCE_COLLECTED', { actor: ACTOR, reason: `${kind} evidence`, evidenceRefs: [evidenceId] });
    // one piece of evidence per unit: modest confidence; a repository inherits its paper's topics at lower confidence
    for (const capability of capabilities) this.registry.inferCapability(expert.id, { capability, confidence: kind === 'paper' ? 0.6 : 0.5, evidenceRefs: [evidenceId], derivedBy: `source-units:${kind}` });
    // KE-2: a jev override has no taxonomy capability; the registry requires one for CAPABILITY_INFERRED, so it stays here
    if (capabilities.length) this.registry.transition(expert.id, 'CAPABILITY_INFERRED', { actor: ACTOR, reason: `${capabilities.length} capability(ies) from ${kind} evidence` });
    return expert.id;
  }
}

/** A fleet discovery event, normalised: arXiv ids and GitHub slugs only (they identify the unit exactly), text clipped. */
function parseDiscovery(event: Record<string, unknown>): Discovery | null {
  const str = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const kind = event.event_type === 'discovery.repository' ? 'repository' : 'paper';
  const raw = str(event.ref ?? event.arxiv_id ?? event.repo, 200).replace(/^(arxiv:|github:|https?:\/\/(arxiv\.org\/abs\/|github\.com\/))/i, '').replace(/\/$/, '');
  const id = kind === 'paper' ? /^\d{4}\.\d{4,5}/.exec(raw)?.[0] : /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw.replace(/\.git$/, '').toLowerCase() : undefined;
  const title = str(event.title, 300) || id || '';
  if (!id || !title) return null;
  const categories = Array.isArray(event.categories) ? event.categories.filter((c): c is string => typeof c === 'string').slice(0, 10) : [];
  return { kind, id, ref: kind === 'paper' ? `arxiv:${id}` : `github:${id}`, title, note: str(event.note ?? event.summary, 1000), categories,
    agent: str(event.agent ?? event.source, 80) || 'unknown-agent', source: str(event.agent ?? event.source, 80) };
}
