import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';
import { Router, raw, type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import { IntegrationInboxService } from '../services/integration-inbox-service';
import { ComplianceAuditService } from '../services/compliance-audit-service';
import { GithubPrReviewService } from '../services/github-pr-review-service';
import { LoopService } from '../services/loop-service';
import { createError } from '../middleware/error-handler';

const issuePayload = z.object({
  action: z.enum(['opened', 'labeled']),
  repository: z.object({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }),
  issue: z.object({
    number: z.number().int().positive(), title: z.string().trim().min(1).max(256),
    body: z.string().max(200_000).nullable().optional(), html_url: z.string().max(2048).optional(),
    labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).max(1000).default([]),
  }),
  label: z.object({ name: z.string() }).nullable().optional(),
});

const pullRequestPayload = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened']),
  repository: z.object({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().trim().min(1).max(256),
    html_url: z.string().max(2048).optional(),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), ref: z.string().min(1).max(256) }),
    base: z.object({ ref: z.string().min(1).max(256) }),
  }),
});

const STABLE_ANCHOR_FILES = ['package.json', 'README.md', 'AGENTS.md'];

/** A real relative file the review loop_run can point its bookkeeping finding at. */
function stableAnchorFile(repositoryPath: string): string {
  const found = STABLE_ANCHOR_FILES.find((name) => statSync(`${repositoryPath}/${name}`, { throwIfNoEntry: false })?.isFile());
  if (!found) throw createError(422, 'No stable anchor file (package.json/README.md/AGENTS.md) found in repository', 'GITHUB_WEBHOOK_NO_ANCHOR_FILE');
  return found;
}

function configuredRepository(name: string): string | null {
  try {
    const paths: unknown = JSON.parse(process.env.GITHUB_REPOSITORY_PATHS || '{}');
    if (!paths || typeof paths !== 'object' || Array.isArray(paths) || !Object.hasOwn(paths, name)) return null;
    const path = (paths as Record<string, unknown>)[name];
    if (typeof path !== 'string' || !isAbsolute(path) || !statSync(path).isDirectory()) return null;
    return realpathSync(path);
  } catch { return null; }
}

function validSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  return timingSafeEqual(expected, Buffer.from(signature.slice('sha256='.length)));
}

/** Mount before express.json(): signatures authenticate exact wire bytes, never reserialized JSON. */
export function createGitHubWebhookRoutes(db: Database): Router {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }));
  router.use(raw({ type: 'application/json', limit: '256kb', inflate: false }));
  const inbox = new IntegrationInboxService(db);
  const audit = new ComplianceAuditService(db);
  const loops = new LoopService(db);
  const prReview = new GithubPrReviewService(db, loops);
  db.exec("CREATE TABLE IF NOT EXISTS github_webhook_deliveries (id TEXT PRIMARY KEY, event TEXT NOT NULL, source_ref TEXT, result_json TEXT, payload_sha256 TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  if (!(db.prepare('PRAGMA table_info(github_webhook_deliveries)').all() as Array<{ name: string }>).some(column => column.name === 'payload_sha256')) {
    db.exec('ALTER TABLE github_webhook_deliveries ADD COLUMN payload_sha256 TEXT');
  }

  router.post('/', (req, res, next) => {
    try {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      if (!secret?.trim()) throw createError(503, 'GitHub webhook intake is not configured', 'GITHUB_WEBHOOK_UNCONFIGURED');
      if (!Buffer.isBuffer(req.body)) throw createError(400, 'Exact JSON request bytes are required', 'GITHUB_WEBHOOK_RAW_BODY_REQUIRED');
      const body: Buffer = req.body;
      if (!validSignature(body, req.get('X-Hub-Signature-256'), secret)) throw createError(401, 'Invalid GitHub webhook signature', 'GITHUB_WEBHOOK_SIGNATURE_INVALID');
      const githubEvent = req.get('X-GitHub-Event');
      if (githubEvent === 'pull_request') return void handlePullRequest(req, res, next, body);
      if (githubEvent !== 'issues') return void res.status(202).json({ status: 'ignored', reason: 'unsupported_event' });
      let json: unknown;
      try { json = JSON.parse(body.toString('utf8')); } catch { throw createError(400, 'Invalid JSON', 'GITHUB_WEBHOOK_PAYLOAD_INVALID'); }
      const parsed = issuePayload.safeParse(json);
      const deliveryId = req.get('X-GitHub-Delivery');
      if (!parsed.success || !deliveryId || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)) throw createError(400, 'Invalid GitHub issues payload', 'GITHUB_WEBHOOK_PAYLOAD_INVALID');
      const { action, issue, repository, label } = parsed.data;
      if (action === 'labeled' && label?.name !== (process.env.GITHUB_LOOP_LABEL || 'djimitflo')) return void res.status(202).json({ status: 'ignored', reason: 'label_not_selected' });
      const repositoryPath = configuredRepository(repository.full_name);
      if (!repositoryPath) throw createError(422, 'Repository path is not configured as an existing absolute directory', 'GITHUB_WEBHOOK_REPOSITORY_UNCONFIGURED');
      const sourceRef = `${repository.full_name}#${issue.number}`;
      const payloadHash = createHash('sha256').update(body).digest('hex');
      const result = db.transaction(() => {
        const previous = db.prepare('SELECT event, source_ref, payload_sha256, result_json FROM github_webhook_deliveries WHERE id=?').get(deliveryId) as { event: string; source_ref: string | null; payload_sha256: string | null; result_json: string | null } | undefined;
        if (previous) {
          if (previous.payload_sha256 !== payloadHash || previous.source_ref !== sourceRef || previous.event !== action || !previous.result_json) throw createError(409, 'Delivery ID is already bound to different or unverifiable content', 'GITHUB_WEBHOOK_DELIVERY_CONFLICT');
          return { code: 200, body: { ...JSON.parse(previous.result_json), status: 'duplicate' } };
        }
        const labels = issue.labels.map(item => typeof item === 'string' ? item : item.name);
        const riskClass = labels.some(item => ['critical', 'sev1', 'p0'].includes(item.toLowerCase())) ? 'critical'
          : labels.some(item => ['high', 'sev2', 'p1'].includes(item.toLowerCase())) ? 'high'
          : labels.some(item => ['medium', 'p2'].includes(item.toLowerCase())) ? 'medium' : 'low';
        const description = [
          'BEGIN_EXTERNAL_CONTENT source=github_issue trust=untrusted',
          JSON.stringify({ title: issue.title, body: issue.body || '', url: issue.html_url || '' }),
          'END_EXTERNAL_CONTENT',
        ].join('\n');
        const imported = inbox.importEvent({
          source: 'github_issue', source_ref: sourceRef, title: issue.title, description,
          risk_class: riskClass, recommended_loop: 'repo-maintenance-loop',
          metadata: { github: { delivery_id: deliveryId, labels, issue_url: issue.html_url }, repository_path: repositoryPath, external_content: true },
        });
        const response = { status: 'imported', delivery_id: deliveryId, source_ref: sourceRef, work_item_id: imported.work_item.id, created: imported.created, execution_started: false, operator_review_required: true };
        audit.appendEntry({
          actor: 'github-webhook', action: 'github_issue_imported', resource: imported.work_item.id, outcome: 'success',
          evidence: { source_ref: sourceRef, delivery_id: deliveryId, payload_sha256: payloadHash, created: imported.created, authentication: 'github_hmac_sha256', execution_started: false },
          event: { eventType: 'integration.imported', resourceType: 'work_item', riskLevel: imported.work_item.risk_class },
        });
        db.prepare('INSERT INTO github_webhook_deliveries (id,event,source_ref,payload_sha256,result_json) VALUES (?,?,?,?,?)').run(deliveryId, action, sourceRef, payloadHash, JSON.stringify(response));
        return { code: 202, body: response };
      }).immediate();
      res.status(result.code).json(result.body);
    } catch (error) { next(error); }
  });

  /**
   * Unlike the issues branch above (which only creates a work_item and
   * requires operator review before any execution, since arbitrary issue
   * body text could be a prompt-injection vector for an eventual maker
   * run), this auto-starts and auto-completes the review synchronously —
   * matching how a CI check is expected to behave. This is safe for
   * Phase 1 specifically because no LLM/untrusted-content interpretation
   * happens yet; Phase 2's real LLM checker must wrap PR content in the
   * same BEGIN_EXTERNAL_CONTENT convention used for the objective below.
   */
  function handlePullRequest(req: Request, res: Response, next: NextFunction, body: Buffer): void {
    try {
      let json: unknown;
      try { json = JSON.parse(body.toString('utf8')); } catch { throw createError(400, 'Invalid JSON', 'GITHUB_WEBHOOK_PAYLOAD_INVALID'); }
      const parsed = pullRequestPayload.safeParse(json);
      const deliveryId = req.get('X-GitHub-Delivery');
      if (!parsed.success || !deliveryId || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)) throw createError(400, 'Invalid GitHub pull_request payload', 'GITHUB_WEBHOOK_PAYLOAD_INVALID');
      const { action, repository, pull_request: pr } = parsed.data;
      const repositoryPath = configuredRepository(repository.full_name);
      if (!repositoryPath) throw createError(422, 'Repository path is not configured as an existing absolute directory', 'GITHUB_WEBHOOK_REPOSITORY_UNCONFIGURED');
      const [owner, repo] = repository.full_name.split('/');
      const sourceRef = `${repository.full_name}#${pr.number}@${pr.head.sha}`;
      const payloadHash = createHash('sha256').update(body).digest('hex');

      const prepared = db.transaction(() => {
        const previous = db.prepare('SELECT event, source_ref, payload_sha256, result_json FROM github_webhook_deliveries WHERE id=?').get(deliveryId) as { event: string; source_ref: string | null; payload_sha256: string | null; result_json: string | null } | undefined;
        if (previous) {
          if (previous.payload_sha256 !== payloadHash || previous.source_ref !== sourceRef || previous.event !== action || !previous.result_json) throw createError(409, 'Delivery ID is already bound to different or unverifiable content', 'GITHUB_WEBHOOK_DELIVERY_CONFLICT');
          return { duplicate: true as const, body: { ...JSON.parse(previous.result_json), status: 'duplicate' } };
        }
        const objective = [
          'BEGIN_EXTERNAL_CONTENT source=github_pull_request trust=untrusted',
          JSON.stringify({ title: pr.title, url: pr.html_url || '' }),
          'END_EXTERNAL_CONTENT',
        ].join('\n');
        const goal = loops.createGoal({
          objective,
          acceptance_criteria: ['Post an automated review comment and Check Run for this pull request.'],
          metadata: { github_pull_request: { owner, repo, number: pr.number, head_sha: pr.head.sha, delivery_id: deliveryId }, external_content: true },
        });
        const run = loops.startLoop({
          goal_id: goal.id, repository_path: repositoryPath, loop_name: 'repo-maintenance-loop',
          target_finding: { file_path: stableAnchorFile(repositoryPath), description: `Automated review for PR #${pr.number}: ${pr.title}`, category: 'refactor' },
        });
        const response = { status: 'accepted', delivery_id: deliveryId, source_ref: sourceRef, loop_run_id: run.id };
        db.prepare('INSERT INTO github_webhook_deliveries (id,event,source_ref,payload_sha256,result_json) VALUES (?,?,?,?,?)').run(deliveryId, action, sourceRef, payloadHash, JSON.stringify(response));
        return { duplicate: false as const, body: response, loopRunId: run.id };
      }).immediate();

      if (prepared.duplicate) {
        res.status(200).json(prepared.body);
        return;
      }

      // Shelling to `gh` must happen after the transaction commits — never inside it.
      const review = prReview.startReview({
        owner, repo, number: pr.number, headSha: pr.head.sha, baseRef: pr.base.ref, headRef: pr.head.ref,
        repositoryPath, loopRunId: prepared.loopRunId, deliveryId,
      });
      res.status(202).json({ ...prepared.body, review });
    } catch (error) { next(error); }
  }

  return router;
}
