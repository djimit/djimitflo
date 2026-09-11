import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { SocialLearningCampaignService } from '../services/social-learning-campaign-service';

const args = process.argv.slice(2);
const command = args.shift();
const option = (name: string, fallback = ''): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const required = (name: string): string => { const value = option(name); if (!value) throw new Error(`--${name} is required`); return value; };
const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

const dbPath = resolve(required('db'));
const output = resolve(required('output'));
const database = new Database(dbPath, { fileMustExist: true });
database.pragma('busy_timeout = 5000');
database.pragma('foreign_keys = ON');

try {
  const service = new SocialLearningCampaignService(database);
  if (command === 'start') {
    const result = service.start({
      campaign_id: required('campaign-id'), started_at: option('at', new Date().toISOString()),
      days: Number(option('days', '7')), minimum_pairs: Number(option('minimum-pairs', '30')),
      runtime_commit: required('runtime-commit'), analyzer_commit: required('analyzer-commit'),
    });
    writeJson(join(output, 'manifest.json'), { ...result.state.manifest, manifest_hash: `sha256:${result.manifest_hash}` });
    writeJson(join(output, 'state.json'), result.state);
    console.log(JSON.stringify({ campaign_id: result.state.campaign_id, status: result.state.status, duplicate: result.duplicate, manifest_hash: `sha256:${result.manifest_hash}` }));
  } else if (command === 'tick') {
    const worldlabPath = option('worldlab-evidence');
    const worldlab = worldlabPath && existsSync(worldlabPath) ? JSON.parse(readFileSync(worldlabPath, 'utf8')) : undefined;
    const report = service.tick({ observed_at: option('at', new Date().toISOString()), worldlab });
    const stamp = report.generated_at.replace(/[:.]/g, '-');
    writeJson(join(output, 'observations', `${stamp}.json`), report);
    writeJson(join(output, 'latest.json'), report);
    writeJson(join(output, 'worldlab-replay-input.json'), { schema: 'djimit.social-learning-campaign.worldlab-input.v1', campaign_id: report.campaign_id, generated_at: report.generated_at, report_hash: report.report_hash, pairs: report.pairs });
    writeJson(join(output, 'independent-checker.json'), report.independent_checker);
    writeJson(join(output, 'state.json'), service.getState());
    if (report.observation_window.complete) writeJson(join(output, 'report.json'), report);
    if (report.goal_batch) writeJson(join(output, 'djimitflo-goal-batch.json'), report.goal_batch);
    console.log(JSON.stringify({ campaign_id: report.campaign_id, status: report.status, pairs: report.pairs.length, peer_signal: report.signals.peer_learning, outcome_signal: report.signals.operational_outcome_lift, checker: report.independent_checker.status, worldlab: report.worldlab?.status || 'UNDETERMINED', goal_batch: Boolean(report.goal_batch), report_hash: report.report_hash }));
  } else if (command === 'status') {
    console.log(JSON.stringify(service.getState()));
  } else {
    throw new Error('command must be start, tick, or status');
  }
} finally {
  database.close();
}
