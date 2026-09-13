/**
 * PacingFrontierIngestionService — seed discovery from https://www.pacingthefrontier.com/ (§8, §33).
 *
 * What the public site actually does: the server-rendered page carries the complete signatory list
 * and the public comments inside the React flight payload (`self.__next_f.push(...)`); the client only
 * reveals 20 at a time behind "Show more". One GET therefore yields the whole dataset, so ingestion is a
 * single, cached, rate-limited request. No robots.txt exists (404); the site is public and unauthenticated.
 *
 * Source semantics (§8): a signature establishes only PERSON P signed STATEMENT S with self-stated
 * affiliation A at retrieval time T. Ingestion creates DISCOVERED identities, `signature` evidence
 * (tier 4, can never carry a capability: I01) and a self-declared affiliation with modest confidence.
 * It never advances the lifecycle. Data minimisation (§27): name, self-stated title/affiliation and the
 * public comment only.
 */

import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { FrontierExpertRegistryService } from './frontier-expert-registry-service';

export const PACING_URL = 'https://www.pacingthefrontier.com/';
const USER_AGENT = 'djimitflo-frontier-experts/0.1 (+https://djimitflo.agentical.nl; research indexing; contact info@djimit.nl)';
const MIN_INTERVAL_MS = 60 * 60_000;

export interface PacingSignatory { name: string; title: string; quote_id: string | null }
export interface PacingQuote { id: string; name: string; title: string; quote: string }
export interface PacingParse { signatory_count: number | null; signatories: PacingSignatory[]; quotes: PacingQuote[] }
export interface PacingIngestResult {
  fetched: boolean; skipped_reason: string | null; content_hash: string; parsed: number; quotes: number;
  discovered_new: number; already_known: number; evidence_added: number; affiliations_added: number;
  /** "Anonymous" signatures are counted, never turned into an identity: there is no person to resolve. */
  anonymous_skipped: number; snapshot_id: string | null;
}

/** Pure parser over the raw HTML: decodes the flight payload and pulls signatories and quotes out of it. */
export function parsePacingFrontier(html: string): PacingParse {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((match) => match[1]);
  const flight = decodeFlight(chunks.join(''));
  const signatories: PacingSignatory[] = [];
  const seen = new Set<string>();
  for (const match of flight.matchAll(/\{"name":"((?:[^"\\]|\\.)*)","title":"((?:[^"\\]|\\.)*)","quoteId":(?:"([^"]*)"|"\$undefined"|null)\}/g)) {
    const name = unescapeJson(match[1]).trim();
    const title = unescapeJson(match[2]).trim();
    const key = `${name.toLowerCase()}|${title.toLowerCase()}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    signatories.push({ name, title, quote_id: match[3] && match[3] !== '$undefined' ? match[3] : null });
  }
  const quotes: PacingQuote[] = [];
  for (const match of flight.matchAll(/\{"id":"([0-9a-f-]{36})","name":"((?:[^"\\]|\\.)*)","title":"((?:[^"\\]|\\.)*)","quote":"((?:[^"\\]|\\.)*)"/g)) {
    quotes.push({ id: match[1], name: unescapeJson(match[2]).trim(), title: unescapeJson(match[3]).trim(), quote: unescapeJson(match[4]).trim() });
  }
  const count = flight.match(/"signatoryCount":(\d+)/);
  return { signatory_count: count ? Number(count[1]) : null, signatories, quotes };
}

/** "Role, Organization" → { role, organization }; a bare organization keeps role null. */
export function splitTitle(title: string): { role: string | null; organization: string } {
  const parts = title.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return { role: null, organization: parts[0] || title.trim() };
  return { role: parts.slice(0, -1).join(', '), organization: parts[parts.length - 1] };
}

export class PacingFrontierIngestionService {
  private readonly registry: FrontierExpertRegistryService;

  constructor(private readonly db: Database, deps: { registry?: FrontierExpertRegistryService; fetchImpl?: typeof fetch } = {}) {
    this.registry = deps.registry ?? new FrontierExpertRegistryService(db);
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }
  private readonly fetchImpl: typeof fetch;

  async fetchPage(): Promise<string> {
    const response = await this.fetchImpl(PACING_URL, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`PACING_FETCH_HTTP_${response.status}`);
    return response.text();
  }

  /** One request per hour at most; identical content is recognised by hash and re-ingestion is a no-op by construction. */
  async ingest(input: { actor: string; html?: string; force?: boolean } = { actor: 'ingestion:pacing' }): Promise<PacingIngestResult> {
    const last = this.db.prepare("SELECT retrieved_at, content_hash FROM expert_source_snapshots WHERE source = 'pacingthefrontier' ORDER BY retrieved_at DESC LIMIT 1").get() as { retrieved_at: string; content_hash: string } | undefined;
    if (!input.html && !input.force && last && Date.now() - Date.parse(last.retrieved_at) < MIN_INTERVAL_MS) {
      return { fetched: false, skipped_reason: 'rate_limited', content_hash: last.content_hash, parsed: 0, quotes: 0, discovered_new: 0, already_known: 0, evidence_added: 0, affiliations_added: 0, anonymous_skipped: 0, snapshot_id: null };
    }
    const html = input.html ?? await this.fetchPage();
    const contentHash = createHash('sha256').update(html).digest('hex');
    const parsed = parsePacingFrontier(html);
    if (!parsed.signatories.length) throw new Error('PACING_PARSE_EMPTY');
    const retrievedAt = new Date().toISOString();
    const snapshotId = `snapshot:${randomUUID()}`;
    this.db.prepare('INSERT INTO expert_source_snapshots (id, source, url, content_hash, entry_count, retrieved_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(snapshotId, 'pacingthefrontier', PACING_URL, contentHash, parsed.signatories.length, retrievedAt, JSON.stringify({ signatory_count: parsed.signatory_count, quotes: parsed.quotes.length, unchanged: last?.content_hash === contentHash }));

    const quoteById = new Map(parsed.quotes.map((quote) => [quote.id, quote]));
    const result: PacingIngestResult = { fetched: !input.html, skipped_reason: null, content_hash: contentHash, parsed: parsed.signatories.length, quotes: parsed.quotes.length, discovered_new: 0, already_known: 0, evidence_added: 0, affiliations_added: 0, anonymous_skipped: 0, snapshot_id: snapshotId };
    const findExisting = this.db.prepare("SELECT id FROM expert_identities WHERE lower(canonical_name) = lower(?) AND json_extract(provenance_json, '$.seed_title') = ?");
    const evidenceExists = this.db.prepare('SELECT 1 FROM expert_evidence WHERE id = ?');
    const affiliationExists = this.db.prepare('SELECT 1 FROM expert_affiliations WHERE expert_id = ? AND source_ref = ?');

    this.db.transaction(() => {
      for (const signatory of parsed.signatories) {
        if (/^anonymous$/i.test(signatory.name)) { result.anonymous_skipped += 1; continue; }
        const signatureRef = `pacingthefrontier:signature:${createHash('sha256').update(`${signatory.name.toLowerCase()}|${signatory.title.toLowerCase()}`).digest('hex').slice(0, 24)}`;
        let expertId = (findExisting.get(signatory.name, signatory.title) as { id: string } | undefined)?.id;
        if (expertId) result.already_known += 1;
        else {
          expertId = this.registry.discover({ canonicalName: signatory.name, aliases: [], provenance: { source: 'pacingthefrontier', seed_title: signatory.title, statement: 'Pacing the Frontier', retrieved_at: retrievedAt, snapshot_id: snapshotId, signature_ref: signatureRef }, actor: input.actor }).id;
          result.discovered_new += 1;
        }
        const quote = signatory.quote_id ? quoteById.get(signatory.quote_id) : undefined;
        const evidenceId = this.registry.addEvidence(expertId, {
          kind: 'signature', title: `Pacing the Frontier signature: ${signatory.name} (${signatory.title})`, url: PACING_URL, sourceRef: signatureRef,
          canonicalOrigin: signatureRef, sourceFamily: 'pacingthefrontier.com', retrievedAt,
          metadata: { self_stated_title: signatory.title, statement: 'Pacing the Frontier', quote_id: signatory.quote_id, public_comment: quote?.quote ?? null, snapshot_id: snapshotId },
        });
        if (!evidenceExists.get(evidenceId)) continue; // cannot happen: INSERT OR IGNORE keeps the deterministic id
        result.evidence_added += 1;
        if (!affiliationExists.get(expertId, evidenceId)) {
          const { role, organization } = splitTitle(signatory.title);
          this.registry.addAffiliation(expertId, { organization, role: role ?? undefined, sourceRef: evidenceId, confidence: 0.5 });
          result.affiliations_added += 1;
        }
      }
    })();
    return result;
  }
}

/** One escape layer at a time, in a single left-to-right pass, so "\\n" never turns into a stray backslash. */
function decodeEscapes(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_match, escaped: string) => {
    if (escaped[0] === 'u') return String.fromCharCode(parseInt(escaped.slice(1), 16));
    return escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
  });
}

/** The flight payload is a JS string literal (layer 1) wrapping JSON text (layer 2). Nothing is executed. */
function decodeFlight(raw: string): string { return decodeEscapes(raw); }

const HTML_ENTITIES: Record<string, string> = { '&#x27;': "'", '&amp;': '&', '&quot;': '"' };
/** Single pass over the three entities the page emits, so "&amp;quot;" can never be unescaped twice. */
function unescapeJson(text: string): string {
  return decodeEscapes(text).replace(/&(?:#x27|amp|quot);/g, (entity) => HTML_ENTITIES[entity]);
}
