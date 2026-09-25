/** Bounded cross-review of evidence-derived candidates. Records audit receipts; never activates experts.
 * node dist/scripts/review-experts.js --db /data/djimitflo.sqlite --limit 20 --log /data/expert-reviews.jsonl
 * Set FRONTIER_EXPERTS_RUNTIME to select the model. Re-running skips unchanged successful receipts.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { ExpertCouncilService } from '../services/expert-council-service';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? '' : process.argv[i + 1] ?? ''; };
const dbPath = arg('db');
const log = arg('log');
const limit = Number(arg('limit') || 20);
if (!dbPath || !log || !Number.isInteger(limit) || limit < 2 || limit > 50) throw new Error('usage: review-experts --db PATH --log PATH --limit 2..50');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const registry = new FrontierExpertRegistryService(db);
const experts = registry.list({ state: 'CAPABILITY_INFERRED', limit });
const prior = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];

(async () => {
  if (experts.length < 2) throw new Error('EXPERT_REVIEW_NEEDS_TWO_CANDIDATES');
  for (const target of experts) {
    const peers = experts.filter((peer) => peer.id !== target.id).sort((a, b) => b.capabilities.filter((id) => target.capabilities.includes(id)).length - a.capabilities.filter((id) => target.capabilities.includes(id)).length);
    const peer = peers[0];
    if (prior.some((item) => item.report?.expert_id === target.id && item.report.expert_version === target.version && item.report.reviewer_id === peer.id && item.report.reviewer_version === peer.version && item.report.runtime === process.env.FRONTIER_EXPERTS_RUNTIME)) continue;
    let result;
    try {
      const report = await new ExpertCouncilService(db).reviewExpert(target.id, peer.id, `model-review:${process.env.FRONTIER_EXPERTS_RUNTIME}:lens:${peer.id}`);
      result = { name: target.canonical_name, peer: peer.canonical_name, report };
    } catch (error) { result = { name: target.canonical_name, peer: peer.canonical_name, error: error instanceof Error ? error.message : String(error) }; process.exitCode = 1; }
    fs.appendFileSync(log, `${JSON.stringify(result)}\n`);
    console.log(JSON.stringify(result));
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
