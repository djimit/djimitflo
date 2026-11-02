import type { Database } from 'better-sqlite3';
import { arenaGateEnabled, fleetSourceGate } from './committee-swarm';
import { FrontierExpertRegistryService } from './frontier-expert-registry-service';
import { ExpertEvidenceEnrichmentService } from './expert-evidence-enrichment-service';
import type { ArxivPaper } from './knowledge-adapters/arxiv-adapter';
import { judgmentMode, runJudgment } from './judgment-service';
import { hasMandatoryProvenance, provenanceJson, readProvenance, type JudgmentProvenance } from './judgment-provenance';
import { discoveryRelevance } from './judgments/discovery-relevance';
import { CONFIDENCE_FLOOR } from './judgments/checker-second-opinion';
import { buildEvidencePack } from './commons-evidence-pack';
import { typesafeBusy, typesafeConfigured } from './typesafe-client';
import { createHash } from 'crypto';
import { discoveryRejudgeConfig } from './knowledge-overview';
import { recordNegativeEvidenceMatches } from './negative-evidence-check';

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

/**
 * DI-001 C (operator 14-10): DISCOVERY_RELEVANCE_PAUSED=true stops NEW discovery_relevance jev calls (default off =
 * unchanged). Historical judgments and the judgment definition stay. No silent fallback — each path says what it does:
 *  - FE2 admission (FRONTIER_UNITS_REQUIRE_RELEVANCE): no unit is admitted (fail-closed, as for "no verdict").
 *  - R3 / KE-2 (keyword-rejected): no shadow call, no override unit; the keyword gate's rejection stands.
 *  - G3 direct path (REQUIRE_RELEVANCE off): the unit is created as before (it never waited for jev); only the shadow call goes.
 * Every such discovery is parked durably in discovery_relevance_backlog (see rejudgePaused for the recovery contract).
 * Readers of verdicts (fleet source gate, N4 term yields, knowledge overview) see no verdict = missing, never 'no'.
 */
export const discoveryRelevancePaused = (env: NodeJS.ProcessEnv = process.env): boolean => env.DISCOVERY_RELEVANCE_PAUSED === 'true';
export type IngestResult = 'unit' | 'pending' | 'known' | 'irrelevant' | 'invalid' | 'paused-pending' | 'paused-rejected' | 'paused-unit';

/**
 * Decision identity = (event_id, judge policy version). The version hashes the judgment's questions, the confidence floor
 * and DECIDE_RULE (bump it when discoveryRelevance.decide changes), so a changed policy is a new identity, never an overwrite.
 */
const DECIDE_RULE = 'decide:v1';
export const DISCOVERY_RELEVANCE_POLICY = `discovery_relevance:${createHash('sha256').update(JSON.stringify(discoveryRelevance.questions)).update(`${CONFIDENCE_FLOOR}|${DECIDE_RULE}`).digest('hex').slice(0, 12)}`;
const eventIdOf = (event: Record<string, unknown>, ref: string): string => [event.event_id, event._id].map((v) => (typeof v === 'string' ? v.trim() : '')).find(Boolean) || `ref:${ref}`;
interface BacklogRow { event_id: string; policy: string; ref: string; path: 'pending' | 'rejected' | 'unit'; event_json: string }

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
  ingestDiscovery(event: Record<string, unknown>): IngestResult {
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
      if (judgmentMode(discoveryRelevance.id) !== 'off' && discoveryRelevancePaused()) return this.park(event, ref, 'rejected');
      if (judgmentMode(discoveryRelevance.id) !== 'off' && this.backlogOwns(ref)) return 'irrelevant'; // the backlog decides it
      if (judgmentMode(discoveryRelevance.id) !== 'off' && this.rejectedShadowLeft()) {
        const pack = buildEvidencePack(this.db, 14);
        rejectedInFlight += 1;
        void runJudgment(this.db, discoveryRelevance, { type: 'discovery_rejected', id: ref }, { title, note, capabilities: [], open_problems: { failing_gates: pack.top_failing_gates, failure_causes: pack.failure_causes } })
          .then((verdict) => {
            // KE-2 (prod 09-10: 95 of 222 jev 'yes' sat on gate-rejected refs, so no unit and no consumer ever saw them): when jev
            // decides unit creation (FRONTIER_UNITS_REQUIRE_RELEVANCE) its 'yes' overrides the keyword gate, as FE2 does for
            // accepted ones. Otherwise the verdict stays a measurement and the gate is unchanged.
            // DI-001 B: a promotion — only on a verdict with recorded provenance (fail-closed)
            if (verdict?.decision === 'yes' && hasMandatoryProvenance(verdict) && process.env.FRONTIER_UNITS_REQUIRE_RELEVANCE === 'true' && !this.knownRefs().has(ref)) this.overrideUnit(d, verdict.id);
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
      if (discoveryRelevancePaused()) return this.park(event, ref, 'pending');
      if (this.backlogOwns(ref)) return 'known'; // parked during a pause: rejudgePaused decides it
      const pack = buildEvidencePack(this.db, 14);
      void runJudgment(this.db, discoveryRelevance, { type: 'discovery_pending', id: ref }, { title, note, capabilities, open_problems: { failing_gates: pack.top_failing_gates, failure_causes: pack.failure_causes } })
        .then((verdict) => {
          const cls = verdict?.answers?.relevance?.choice;
          // DI-001 B: unit creation is a promotion — no recorded provenance, no unit (fail-closed, like no verdict)
          if (!verdict || !hasMandatoryProvenance(verdict) || (cls !== 'open_problem' && cls !== 'lane_technique') || this.knownRefs().has(ref)) return;
          this.repointVerdict(verdict.id, createUnit());
        }).catch(() => undefined);
      return 'pending';
    }
    const expertId = createUnit();
    // G3 (shadow): is this discovery relevant beyond its topic? Fire-and-forget; never blocks ingestion.
    if (judgmentMode(discoveryRelevance.id) !== 'off') {
      if (discoveryRelevancePaused()) return this.park(event, ref, 'unit');
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
    this.repointVerdict(judgmentId, unitId);
    return unitId;
  }

  /**
   * AUTHZ-F2: re-point a discovery verdict at the expert unit it created. The row's subject moves to the unit (its readers
   * join on expert_unit), and its provenance records the move: `evidence_reference` still names the judged discovery and
   * `subject_rewrite` names from → to. NULL provenance (pre-DI-001 history) stays NULL — never backfilled.
   */
  private repointVerdict(judgmentId: string, unitId: string): void {
    const row = this.db.prepare('SELECT subject_type, subject_id, provenance_json FROM judgments WHERE id = ?').get(judgmentId) as
      { subject_type: string; subject_id: string; provenance_json: string | null } | undefined;
    if (!row) return;
    let provenance = row.provenance_json;
    if (provenance !== null) {
      const p = readProvenance(row);
      if (p.status !== 'unrecorded') {
        const rewrite = { from: { type: row.subject_type, id: row.subject_id }, to: { type: 'expert_unit', id: unitId }, at: new Date().toISOString(), reason: 'expert_unit_created' };
        provenance = provenanceJson({ ...(p as JudgmentProvenance), subject_rewrite: rewrite }) ?? provenance;
      }
    }
    this.db.prepare("UPDATE judgments SET subject_type = 'expert_unit', subject_id = ?, provenance_json = ? WHERE id = ?").run(unitId, provenance, judgmentId);
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
  backfillRejectedOverrides(limit = 1_000): { candidates: number; created: number; missing_event: number; known: number; no_provenance: number } {
    const rows = this.db.prepare(`SELECT subject_id AS ref, MAX(created_at) AS at, id, provenance_json FROM judgments WHERE judgment = 'discovery_relevance' AND subject_type = 'discovery_rejected' AND decision = 'yes'
      GROUP BY subject_id ORDER BY at LIMIT ?`).all(limit) as Array<{ ref: string; id: string; provenance_json: string | null }>;
    const out = { candidates: rows.length, created: 0, missing_event: 0, known: 0, no_provenance: 0 };
    const known = this.knownRefs();
    for (const row of rows) {
      if (known.has(row.ref)) { out.known += 1; continue; }
      // DI-001 B: a backfill is a NEW promotion, so a verdict without recorded provenance (pre-activation history) is not used
      if (!hasMandatoryProvenance(row)) { out.no_provenance += 1; continue; }
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
    if (discoveryRelevancePaused()) return { retried: 0, skipped: 'paused' };
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

  /** DI-001 C: park a discovery the pause left unjudged. Idempotent on (event_id, policy): a re-delivered event is one row. */
  private park(event: Record<string, unknown>, ref: string, path: BacklogRow['path']): IngestResult {
    this.db.prepare('INSERT OR IGNORE INTO discovery_relevance_backlog (event_id, policy, ref, path, event_json, paused_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(eventIdOf(event, ref), DISCOVERY_RELEVANCE_POLICY, ref, path, JSON.stringify(event), new Date().toISOString());
    return `paused-${path}`;
  }

  /** An open backlog row (unjudged or claimed) owns the ref's decision; normal ingestion does not judge it a second time. */
  private backlogOwns(ref: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM discovery_relevance_backlog WHERE ref = ? AND state IN ('unjudged', 'rejudging') LIMIT 1").get(ref));
  }

  /**
   * DI-001 C recovery contract. Each parked discovery is one row keyed by (event_id, policy) — the decision identity.
   *  - Claim: one atomic UPDATE moves 'unjudged' (or a 'rejudging' claim older than the claim timeout) to 'rejudging' and
   *    increments the row's fence (monotonic); the worker holds that fence value.
   *  - Commit: the judgment row, the backlog decision and the downstream admission (unit creation / re-pointing) are ONE
   *    transaction, and it commits only while the row is 'rejudging' with the worker's fence. A stale worker (its claim was
   *    reclaimed) is vetoed and writes nothing: at most one persisted decision per identity.
   *  - The jev call itself is at-least-once: a crash or a reclaimed claim can call jev again; one result is persisted.
   *  - A failed call or a failed commit releases the claim with attempts + 1; at DISCOVERY_REJUDGE_MAX_ATTEMPTS → 'failed'.
   *  - Bounded: ≤ DISCOVERY_REJUDGE_BATCH claims per call and ≤ DISCOVERY_REJUDGE_MAX_PER_DAY claims per 24 h, both counted
   *    from the table (a restart does not reset them). Unpausing never replays the backlog at once.
   */
  rejudgePaused(opts: { limit?: number; now?: number } = {}): { claimed: number; skipped?: string } {
    if (judgmentMode(discoveryRelevance.id) === 'off' || !typesafeConfigured()) return { claimed: 0, skipped: 'off' };
    if (discoveryRelevancePaused()) return { claimed: 0, skipped: 'paused' };
    if (typesafeBusy()) return { claimed: 0, skipped: 'jev_busy' };
    const cfg = discoveryRejudgeConfig(); const now = opts.now ?? Date.now(); const nowIso = new Date(now).toISOString();
    const used = (this.db.prepare('SELECT COUNT(*) n FROM discovery_relevance_backlog WHERE claimed_at >= ?').get(new Date(now - 86_400_000).toISOString()) as { n: number }).n;
    const take = Math.min(opts.limit ?? cfg.batch, cfg.batch, cfg.max_per_day - used);
    if (take <= 0) return { claimed: 0, skipped: 'daily_cap' };
    const stale = new Date(now - cfg.claim_timeout_minutes * 60_000).toISOString();
    const open = "(state = 'unjudged' OR (state = 'rejudging' AND claimed_at < ?))";
    const rows = this.db.prepare(`SELECT event_id, policy, ref, path, event_json FROM discovery_relevance_backlog WHERE policy = ? AND ${open} ORDER BY paused_at, event_id LIMIT ?`)
      .all(DISCOVERY_RELEVANCE_POLICY, stale, take) as BacklogRow[];
    const claim = this.db.prepare(`UPDATE discovery_relevance_backlog SET state = 'rejudging', fence = fence + 1, claimed_at = ? WHERE event_id = ? AND policy = ? AND ${open} RETURNING fence`);
    let claimed = 0;
    for (const row of rows) {
      if (row.path === 'rejected' && !this.rejectedShadowLeft()) continue; // R3's own daily cap: a later call
      const won = claim.get(nowIso, row.event_id, row.policy, stale) as { fence: number } | undefined;
      if (!won) continue; // another worker claimed it first
      claimed += 1;
      this.rejudgeOne(row, won.fence);
    }
    return { claimed };
  }

  private rejudgeOne(row: BacklogRow, fence: number): void {
    const key = [row.event_id, row.policy, fence] as const;
    const finish = (state: 'judged' | 'skipped', decision: string, judgmentId: string | null) => this.db.prepare(`UPDATE discovery_relevance_backlog SET state = ?, decision = ?, judgment_id = ?, judged_at = ?
      WHERE event_id = ? AND policy = ? AND fence = ? AND state = 'rejudging'`).run(state, decision, judgmentId, new Date().toISOString(), ...key).changes === 1;
    const release = () => this.db.prepare(`UPDATE discovery_relevance_backlog SET attempts = attempts + 1, state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'unjudged' END
      WHERE event_id = ? AND policy = ? AND fence = ? AND state = 'rejudging'`).run(discoveryRejudgeConfig().max_attempts, ...key);
    const d = parseDiscovery(JSON.parse(row.event_json) as Record<string, unknown>);
    if (!d) { finish('skipped', 'invalid', null); return; }
    const unitOf = () => (this.db.prepare("SELECT id FROM expert_identities WHERE kind IN ('paper', 'repository') AND aliases_json LIKE ? LIMIT 1").get(`%"${d.ref}"%`) as { id: string } | undefined)?.id;
    const judged = () => this.db.prepare("SELECT 1 FROM judgments WHERE judgment = 'discovery_relevance' AND subject_id = ? AND decision <> 'error' LIMIT 1").get(d.ref);
    // a ref already decided (another event of the same ref, or a unit) is not judged again: the same rule as ingestion
    if (row.path !== 'unit' && (unitOf() || judged())) { finish('skipped', 'known', null); return; }
    const unitId = row.path === 'unit' ? unitOf() : undefined;
    if (row.path === 'unit' && !unitId) { finish('skipped', 'no_unit', null); return; }
    const capabilities = row.path === 'pending' ? this.enrichment.capabilitiesFor({ arxiv_id: d.id, url: '', title: d.title, summary: d.note, authors: [], categories: d.categories, primary_category: d.categories[0] ?? null, published: null }) : [];
    const subject = unitId ? { type: 'expert_unit', id: unitId } : { type: row.path === 'pending' ? 'discovery_pending' : 'discovery_rejected', id: d.ref };
    const pack = buildEvidencePack(this.db, 14);
    if (row.path === 'rejected') rejectedInFlight += 1;
    void runJudgment(this.db, discoveryRelevance, subject, { title: d.title, note: d.note, capabilities, open_problems: { failing_gates: pack.top_failing_gates, failure_causes: pack.failure_causes } }, undefined, undefined,
      (verdict) => {
        if (!finish('judged', verdict.decision, verdict.id)) return false; // stale fence: vetoed, nothing is written
        const requireRelevance = process.env.FRONTIER_UNITS_REQUIRE_RELEVANCE === 'true';
        if (row.path === 'pending') {
          const cls = verdict.answers?.relevance?.choice;
          // DI-001 B: under FRONTIER_UNITS_REQUIRE_RELEVANCE the verdict decides unit creation (a promotion) — recorded provenance
          // is mandatory, as on the live ingest path (AUTHZ-F2: the backlog path lacked this check)
          if ((!requireRelevance || ((cls === 'open_problem' || cls === 'lane_technique') && hasMandatoryProvenance(verdict))) && !unitOf()) {
            this.repointVerdict(verdict.id, this.fleetUnit(d, capabilities));
          }
        } else if (row.path === 'rejected' && verdict.decision === 'yes' && requireRelevance && hasMandatoryProvenance(verdict) && !unitOf()) this.overrideUnit(d, verdict.id);
        return true;
      })
      .then((verdict) => { if (!verdict) release(); }) // a no-op when the fence moved on
      .catch(() => undefined).finally(() => { if (row.path === 'rejected') rejectedInFlight -= 1; });
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
    // K3 (NE_GENERATOR_CHECK_MODE=shadow): every unit admission path ends here; the untrusted text is only matched, never followed
    const meta = (evidence.metadata ?? {}) as Record<string, unknown>;
    recordNegativeEvidenceMatches(this.db, { type: 'expert_unit', id: expert.id }, [name, ref, evidence.title, meta.note, meta.abstract].filter((x) => typeof x === 'string').join('\n'), 'discovery_unit');
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
