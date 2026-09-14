/**
 * Bounded, resumable arXiv enrichment of DISCOVERED experts (§33, §51, E4).
 *   npx tsx src/scripts/enrich-experts.ts --db <path> [--source datacite|openalex|arxiv] [--batch 5] [--spacing-ms 60000] [--backoff-ms 900000] [--once] [--stop-file <path>] [--log <path>]
 * One arXiv request per expert, spaced by --spacing-ms; on HTTP 429 the runner backs off for --backoff-ms and
 * retries the same identities (they are only marked attempted after a completed request). Progress goes to --log as JSON lines.
 * `--recompute` re-derives capabilities from stored evidence offline (namesake papers challenged, unsupported inferred capabilities revoked).
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrate';
import { ArxivAdapter } from '../services/knowledge-adapters/arxiv-adapter';
import { OpenAlexAdapter } from '../services/knowledge-adapters/openalex-adapter';
import { DataCiteAdapter } from '../services/knowledge-adapters/datacite-adapter';
import { ExpertEvidenceEnrichmentService } from '../services/expert-evidence-enrichment-service';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';

const arg = (name: string, fallback: string) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback; };
const dbPath = arg('db', '');
if (!dbPath) { console.error('usage: enrich-experts --db <path>'); process.exit(2); }
const sourceName = arg('source', 'datacite');
const batch = Number(arg('batch', '5'));
const spacingMs = Number(arg('spacing-ms', '60000'));
const backoffMs = Number(arg('backoff-ms', '900000'));
const stopFile = arg('stop-file', '');
const logPath = arg('log', '');
const once = process.argv.includes('--once');
const recompute = process.argv.includes('--recompute');

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
runMigrations(db);
const registry = new FrontierExpertRegistryService(db);
registry.seedTaxonomy();
const adapter = sourceName === 'arxiv' ? new ArxivAdapter() : sourceName === 'openalex' ? new OpenAlexAdapter() : new DataCiteAdapter();
let last = 0;
const source = { name: sourceName, async searchAuthorPapers(name: string, limit?: number) {
  const wait = last + spacingMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  try { return await adapter.searchAuthorPapers(name, limit); } finally { last = Date.now(); }
} };
const service = new ExpertEvidenceEnrichmentService(db, { registry, source });
const log = (entry: Record<string, unknown>) => { const line = JSON.stringify({ at: new Date().toISOString(), ...entry }); console.log(line); if (logPath) fs.appendFileSync(logPath, `${line}\n`); };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  if (recompute) {
    // Offline pass: re-derive capabilities from stored evidence after a rule or taxonomy change (§54); no network.
    const ids = (db.prepare("SELECT DISTINCT expert_id FROM expert_evidence WHERE kind = 'paper'").all() as Array<{ expert_id: string }>).map((row) => row.expert_id);
    const totals = { experts: ids.length, revoked: 0, added: 0, challenged_evidence: 0, kept_governed_unsupported: 0 };
    for (const id of ids) { const result = service.recompute(id, { actor: 'ingestion:recompute' }); totals.revoked += result.revoked.length; totals.added += result.added.length; totals.challenged_evidence += result.challenged_evidence; totals.kept_governed_unsupported += result.kept_governed_unsupported.length; }
    log({ event: 'recompute', ...totals });
    db.close();
    return;
  }
  log({ event: 'start', source: sourceName, pending: service.pending(), batch, spacingMs, backoffMs });
  while (true) {
    if (stopFile && fs.existsSync(stopFile)) { log({ event: 'stop', reason: 'stop-file' }); break; }
    const results = await service.enrichBatch({ actor: 'ingestion:arxiv', limit: batch });
    if (!results.length) { log({ event: 'done', pending: 0 }); break; }
    const throttled = results.filter((result) => /_HTTP_(429|5\d\d)|TimeoutError|aborted/i.test(result.reason ?? ''));
    const counts = results.reduce<Record<string, number>>((acc, result) => { const key = result.reason ?? result.lifecycle_state; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
    log({ event: 'batch', results: results.length, counts, pending: service.pending(), throttled: throttled.length,
      inferred: results.filter((result) => result.lifecycle_state === 'CAPABILITY_INFERRED').map((result) => ({ name: result.canonical_name, capabilities: result.capabilities.map((capability) => capability.id) })) });
    if (once) break;
    if (throttled.length) { log({ event: 'backoff', ms: backoffMs }); await sleep(backoffMs); }
  }
  db.close();
})().catch((error) => { log({ event: 'fatal', error: error instanceof Error ? error.message : String(error) }); process.exit(1); });
