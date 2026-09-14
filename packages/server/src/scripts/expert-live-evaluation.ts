/**
 * Live-data resolution evaluation (§43 on real identities, G-03) and identity-resolution sample (G-04).
 *   npx tsx src/scripts/expert-live-evaluation.ts --db <path> [--k 3] [--sample 30] [--seed 7]
 * Runs the 30 benchmark queries against the enriched seed database. No human has approved anyone yet, so the
 * resolver is asked for CAPABILITY_INFERRED+ states explicitly; everything reported here is tentative by construction.
 */
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrate';
import { BENCHMARK_QUERIES } from '../services/expert-resolution-benchmark';
import { ExpertResolverService } from '../services/expert-resolver-service';

const arg = (name: string, fallback: string) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback; };
const db = new Database(arg('db', ''), { readonly: false });
runMigrations(db);
const k = Number(arg('k', '3'));
const resolver = new ExpertResolverService(db);
const states = ['CAPABILITY_INFERRED', 'CHECKED', 'APPROVED', 'ACTIVE'];

const counts = db.prepare('SELECT lifecycle_state AS state, COUNT(*) AS n FROM expert_identities GROUP BY 1 ORDER BY 2 DESC').all() as Array<{ state: string; n: number }>;
console.log(`# Live-data evaluation — ${new Date().toISOString()}\n\nIdentities by state: ${counts.map((row) => `${row.state} ${row.n}`).join(', ')}.`);
console.log(`Evidence rows (paper): ${(db.prepare("SELECT COUNT(*) AS n FROM expert_evidence WHERE kind = 'paper'").get() as { n: number }).n}; capabilities inferred: ${(db.prepare('SELECT COUNT(*) AS n FROM expert_capabilities').get() as { n: number }).n}.\n`);

const scored = BENCHMARK_QUERIES.filter((query) => query.kind !== 'out_of_domain');
let precision = 0; let recall = 0; let abstained = 0; let primary = 0; let evidenceTotal = 0; let considered = 0; let identity = 0; let selected = 0;
const rows: string[] = [];
for (const query of BENCHMARK_QUERIES) {
  const result = resolver.resolve(query.query, { maxExperts: k, states });
  considered += result.considered;
  if (query.kind === 'out_of_domain') { rows.push(`| ${query.id} | out of domain | ${result.abstained ? 'abstained' : 'SELECTED (bad)'} | — |`); continue; }
  if (result.abstained) { abstained += 1; rows.push(`| ${query.id} | ${query.expected.join(', ')} | abstained: ${result.reason} | — |`); continue; }
  const relevant = result.experts.filter((expert) => expert.capabilities.some((capability) => query.expected.includes(capability.id)));
  precision += relevant.length / result.experts.length;
  recall += query.expected.filter((capability) => result.experts.some((expert) => expert.capabilities.some((item) => item.id === capability))).length / query.expected.length;
  for (const expert of result.experts) { selected += 1; evidenceTotal += expert.evidence.length; primary += expert.evidence.filter((item) => item.tier === 1).length; identity += 1 - expert.components.identity_uncertainty; }
  rows.push(`| ${query.id} | ${query.expected.join(', ')} | ${result.experts.map((expert) => `${expert.canonical_name} (${expert.capabilities.filter((capability) => query.expected.includes(capability.id)).map((capability) => capability.id).join('+') || 'off-target'}, ${expert.score})`).join('; ')} | ${result.considered} |`);
}
const n = scored.length - abstained;
console.log('| metric | value |\n|---|---|');
console.log(`| queries (in-domain) | ${scored.length} |\n| abstained (in-domain) | ${abstained} |\n| precision@${k} (capability family match) | ${n ? (precision / n).toFixed(3) : '—'} |\n| recall@${k} (families covered) | ${n ? (recall / n).toFixed(3) : '—'} |\n| candidates considered per query (mean) | ${(considered / BENCHMARK_QUERIES.length).toFixed(1)} |\n| primary evidence ratio | ${evidenceTotal ? (primary / evidenceTotal).toFixed(3) : '—'} |\n| mean identity confidence of selected | ${selected ? (identity / selected).toFixed(3) : '—'} |\n| out-of-domain abstention | ${BENCHMARK_QUERIES.filter((query) => query.kind === 'out_of_domain').every((query) => resolver.resolve(query.query, { maxExperts: k, states }).abstained) ? '3/3' : 'FAIL'} |`);
console.log('\n| query | expected families | selected (matching capabilities, score) | considered |\n|---|---|---|---|');
for (const row of rows) console.log(row);

// G-04 sample: deterministic pseudo-random sample of enriched identities for human labelling.
const sampleSize = Number(arg('sample', '30'));
let seed = Number(arg('seed', '7'));
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const enriched = db.prepare("SELECT id, canonical_name, identity_confidence, provenance_json FROM expert_identities WHERE lifecycle_state IN ('CAPABILITY_INFERRED', 'EVIDENCE_COLLECTED') ORDER BY id").all() as Array<{ id: string; canonical_name: string; identity_confidence: number; provenance_json: string }>;
const sample = [...enriched].sort(() => random() - 0.5).slice(0, sampleSize);
console.log(`\n## Identity-resolution sample (${sample.length} of ${enriched.length} enriched; label manually: same person as the signatory?)\n\n| name | self-stated title (seed) | confidence | active/matched papers | newest active paper | active capabilities |\n|---|---|---|---|---|---|`);
for (const expert of sample) {
  const provenance = JSON.parse(expert.provenance_json) as { seed_title?: string; enrichment?: { papers_matched?: number } };
  const newest = db.prepare("SELECT title FROM expert_evidence WHERE expert_id = ? AND kind = 'paper' AND lifecycle = 'active' ORDER BY json_extract(metadata_json, '$.published') DESC LIMIT 1").get(expert.id) as { title: string } | undefined;
  const active = (db.prepare("SELECT COUNT(*) AS n FROM expert_evidence WHERE expert_id = ? AND kind = 'paper' AND lifecycle = 'active'").get(expert.id) as { n: number }).n;
  const capabilities = (db.prepare("SELECT capability_id FROM expert_capabilities WHERE expert_id = ? AND status != 'revoked'").all(expert.id) as Array<{ capability_id: string }>).map((row) => row.capability_id);
  console.log(`| ${expert.canonical_name} | ${(provenance.seed_title ?? '').replace(/\|/g, '/')} | ${expert.identity_confidence} | ${active}/${provenance.enrichment?.papers_matched ?? '?'} | ${(newest?.title ?? '').slice(0, 70).replace(/\|/g, '/')} | ${capabilities.join(', ')} |`);
}
db.close();
