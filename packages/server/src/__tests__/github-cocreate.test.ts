import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmStatusService } from '../services/swarm-status-service';
import { WorkItemService } from '../services/work-item-service';
import { buildPrBody, issueToWorkItemInput, parseIssueRef } from '../scripts/github-cocreate';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  return db;
}

function makeRepo(): { repo: string; worktreeRoot: string; restore: () => void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-gh-repo-'));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-gh-worktrees-'));
  tempDirs.push(repo, worktreeRoot);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n', 'utf8');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'codex@example.local'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Codex Test'], { cwd: repo });
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

  const previous = process.env.LOOP_WORKTREE_ROOT;
  process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
  return {
    repo,
    worktreeRoot,
    restore: () => {
      if (previous) process.env.LOOP_WORKTREE_ROOT = previous;
      else delete process.env.LOOP_WORKTREE_ROOT;
    },
  };
}

describe('github co-creation flow', () => {
  it('builds github issue work item inputs and PR evidence bodies', () => {
    const ref = parseIssueRef('djimitflo/app#123');
    const input = issueToWorkItemInput(ref, {
      number: 123,
      title: 'Add durable co-creation loop',
      body: 'Issue body',
      url: ref.url,
      labels: [{ name: 'P2' }],
    }, { repository_path: '.', loop_name: 'repo-maintenance-loop' });

    expect(input).toMatchObject({
      source: 'github_issue',
      source_ref: 'djimitflo/app#123',
      status: 'triaged',
      risk_class: 'medium',
      recommended_loop: 'repo-maintenance-loop',
    });

    const body = buildPrBody({
      issue_ref: ref.source_ref,
      issue_url: ref.url,
      loop_run_id: 'loop-abc',
      status: 'ready_for_human_merge',
      gates: [{ name: 'checker_verdict', status: 'pass', evidence: 'accepted' }],
      leases: [
        { id: 'lease-maker', role: 'maker', runtime: 'mock', status: 'completed', branch_name: 'codex/demo', worktree_path: '/tmp/demo', metadata: {} },
        { id: 'lease-checker', role: 'checker', runtime: 'mock', status: 'completed', branch_name: null, worktree_path: null, metadata: {} },
      ],
    });

    expect(body).toContain('Closes djimitflo/app#123');
    expect(body).toContain('Maker workers: 1');
    expect(body).toContain('checker/mock: completed');
  });

  it('prepares a direct maker/checker assignment for github issue work items', () => {
    const db = makeDb();
    const repo = makeRepo();
    try {
      const ref = parseIssueRef('djimitflo/app#124');
      const workItems = new WorkItemService(db);
      const created = workItems.createIfMissingBySourceRef(issueToWorkItemInput(ref, {
        number: 124,
        title: 'Implement issue specific worker assignment',
        body: 'The repo scanner may find nothing, but the issue is still runnable work.',
        url: ref.url,
        labels: [],
      }, { repository_path: repo.repo, loop_name: 'repo-maintenance-loop' }));

      const scheduler = new SwarmStatusService(db);
      const tick = scheduler.tickScheduler({
        work_item_ids: [created.work_item.id],
        plan_triaged: true,
        prepare_planned: true,
        repository_path: repo.repo,
        runtime: 'mock',
        max_items: 1,
      });

      expect(tick.planned_work_items).toHaveLength(1);
      expect(tick.prepared_work_items).toHaveLength(1);
      expect(tick.prepared_work_items[0]).toMatchObject({
        id: created.work_item.id,
        status: 'leased',
        assigned_runtime: 'mock',
      });

      const loopRunId = String(tick.prepared_work_items[0].metadata.loop_run_id);
      const findings = JSON.parse((db.prepare('SELECT findings_json FROM loop_runs WHERE id = ?').get(loopRunId) as any).findings_json);
      expect(findings[0]).toMatchObject({
        id: `work-item-${created.work_item.id}`,
        type: 'work_item_assignment',
        message: 'Implement issue specific worker assignment',
      });

      const leases = db.prepare('SELECT role, runtime, status, finding_id FROM worker_leases WHERE loop_run_id = ? ORDER BY role ASC').all(loopRunId) as any[];
      expect(leases).toEqual([
        expect.objectContaining({ role: 'checker', status: 'prepared', finding_id: `work-item-${created.work_item.id}` }),
        expect.objectContaining({ role: 'maker', status: 'prepared', finding_id: `work-item-${created.work_item.id}` }),
      ]);
    } finally {
      repo.restore();
      db.close();
    }
  });
});
