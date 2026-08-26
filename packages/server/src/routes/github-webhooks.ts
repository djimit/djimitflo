import { createHmac, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { IntegrationInboxService } from '../services/integration-inbox-service';
import { LoopService } from '../services/loop-service';

function repositoryPaths(): Record<string, string> {
  try { return JSON.parse(process.env.GITHUB_REPOSITORY_PATHS || '{}'); } catch { return {}; }
}

function validSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createGitHubWebhookRoutes(db: Database): Router {
  const router = Router();
  const inbox = new IntegrationInboxService(db);
  const loops = new LoopService(db);
  db.exec("CREATE TABLE IF NOT EXISTS github_webhook_deliveries (id TEXT PRIMARY KEY, event TEXT NOT NULL, source_ref TEXT, result_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");

  router.post('/', (req, res) => {
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!validSignature(rawBody, req.get('X-Hub-Signature-256'))) return void res.status(401).json({ error: 'Invalid GitHub webhook signature' });
    if (req.get('X-GitHub-Event') !== 'issues') return void res.status(202).json({ status: 'ignored', reason: 'unsupported_event' });

    const deliveryId = req.get('X-GitHub-Delivery');
    const { action, issue, repository, label } = req.body || {};
    if (!deliveryId || !['opened', 'labeled'].includes(action) || !issue?.number || !issue?.title || !repository?.full_name) {
      return void res.status(400).json({ error: 'Invalid GitHub issues payload' });
    }
    if (action === 'labeled' && String(label?.name || '') !== (process.env.GITHUB_LOOP_LABEL || 'djimitflo')) {
      return void res.status(202).json({ status: 'ignored', reason: 'label_not_selected' });
    }
    const sourceRef = `${repository.full_name}#${issue.number}`;
    const repositoryPath = repositoryPaths()[repository.full_name];
    if (!repositoryPath) return void res.status(422).json({ error: 'Repository path is not configured', source_ref: sourceRef });
    const inserted = db.prepare('INSERT OR IGNORE INTO github_webhook_deliveries (id,event) VALUES (?,?)').run(deliveryId, action);
    if (inserted.changes === 0) return void res.status(200).json({ status: 'duplicate', delivery_id: deliveryId });
    const externalContent = [
      'BEGIN_EXTERNAL_CONTENT source=github_issue trust=untrusted',
      JSON.stringify({ title: issue.title, body: issue.body || '', url: issue.html_url || '' }),
      'END_EXTERNAL_CONTENT',
    ].join('\n');
    const labels = (issue.labels || []).map((item: string | { name?: string }) => typeof item === 'string' ? item : item.name || '');
    const riskClass = labels.some((item: string) => ['critical', 'p0'].includes(item.toLowerCase())) ? 'critical'
      : labels.some((item: string) => ['high', 'p1'].includes(item.toLowerCase())) ? 'high' : 'low';
    const workItem = inbox.importEvent({
      source: 'github_issue', source_ref: sourceRef, title: issue.title, description: externalContent,
      risk_class: riskClass, recommended_loop: 'repo-maintenance-loop',
      metadata: { github: { delivery_id: deliveryId, labels, issue_url: issue.html_url }, external_content: true },
    });
    const existing = db.prepare("SELECT g.id AS goal_id, l.id AS loop_run_id FROM goals g LEFT JOIN loop_runs l ON l.goal_id=g.id WHERE json_extract(g.metadata,'$.github.source_ref')=? ORDER BY l.created_at DESC LIMIT 1").get(sourceRef) as { goal_id: string; loop_run_id?: string } | undefined;
    if (existing?.loop_run_id) return void res.status(200).json({ status: 'already_started', work_item_id: workItem.work_item.id, ...existing });

    const goal = existing ? loops.getGoal(existing.goal_id) : loops.createGoal({
      objective: externalContent,
      acceptance_criteria: [`Resolve ${sourceRef} with tests and an independent checker verdict`],
      risk_class: riskClass,
      metadata: { github: { source_ref: sourceRef, delivery_id: deliveryId }, external_content: true, work_item_id: workItem.work_item.id },
    });
    const run = loops.startLoop({ goal_id: goal.id, repository_path: repositoryPath, loop_name: 'repo-maintenance-loop' });
    const result = { status: 'started', delivery_id: deliveryId, source_ref: sourceRef, work_item_id: workItem.work_item.id, goal_id: goal.id, loop_run_id: run.id };
    db.prepare('UPDATE github_webhook_deliveries SET source_ref=?,result_json=? WHERE id=?').run(sourceRef, JSON.stringify(result), deliveryId);
    res.status(202).json(result);
  });

  return router;
}
