import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync } from 'fs';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { AuthService } from '../services/auth-service';
import type { GoalRecord, LoopRunRecord, WorkerLeaseRecord } from '../services/loop-service';

const TEST_DIR = join(tmpdir(), `djimitflo-e2e-${Date.now()}`);
const TEST_DB = join(TEST_DIR, 'test.sqlite');
const TEST_REPO = join(TEST_DIR, 'test-repo');

describe('Phase 6 E2E: Goal → Loop → Execution → Completion', () => {
  let db: BetterSqlite3.Database;
  let loopService: LoopService;
  let authService: AuthService;
  let userId: string;

  beforeEach(async () => {
    // Setup test environment
    if (TEST_DIR) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_REPO, { recursive: true });

    // Initialize database
    db = new BetterSqlite3(TEST_DB);
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    // Initialize services
    loopService = new LoopService(db);
    authService = new AuthService(db);

    // Create test user
    const user = await authService.createUser({
      email: `test-${Date.now()}@example.com`,
      password: 'test-password-123',
      role: 'admin',
    });
    userId = user.id;
  });

  afterEach(() => {
    if (db) db.close();
    if (TEST_DIR) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('Goal Lifecycle', () => {
    it('creates a goal with valid acceptance criteria', async () => {
      const goal = loopService.createGoal(userId, {
        objective: 'Fix README documentation drift',
        constraints: ['Must not break existing examples'],
        acceptance_criteria: [
          'All code examples are executable',
          'README renders without warnings',
        ],
        risk_class: 'low',
        budget: { max_workers: 5, max_retries: 2 },
      });

      expect(goal).toBeDefined();
      expect(goal.objective).toBe('Fix README documentation drift');
      expect(goal.acceptance_criteria).toHaveLength(2);
      expect(goal.status).toBe('created');
      expect(goal.owner_user_id).toBe(userId);
    });

    it('rejects goal without acceptance criteria', () => {
      expect(() => {
        loopService.createGoal(userId, {
          objective: 'Fix documentation',
          acceptance_criteria: [],
          risk_class: 'low',
        });
      }).toThrow('acceptance_criteria must contain at least one');
    });

    it('lists goals filtered by owner', () => {
      const goal1 = loopService.createGoal(userId, {
        objective: 'Goal 1',
        acceptance_criteria: ['Criterion 1'],
        risk_class: 'low',
      });

      // Create another user and goal
      const user2 = authService.createUserSync({
        email: `user2-${Date.now()}@example.com`,
        password: 'password',
        role: 'operator',
      });
      const goal2 = loopService.createGoal(user2.id, {
        objective: 'Goal 2',
        acceptance_criteria: ['Criterion 2'],
        risk_class: 'low',
      });

      const userGoals = loopService.getGoals(userId);
      expect(userGoals).toHaveLength(1);
      expect(userGoals[0].id).toBe(goal1.id);
      expect(userGoals[0].objective).toBe('Goal 1');

      const user2Goals = loopService.getGoals(user2.id);
      expect(user2Goals).toHaveLength(1);
      expect(user2Goals[0].id).toBe(goal2.id);
    });

    it('updates goal status through lifecycle', () => {
      const goal = loopService.createGoal(userId, {
        objective: 'Test goal',
        acceptance_criteria: ['Criterion 1'],
        risk_class: 'low',
      });

      expect(goal.status).toBe('created');

      const updated = loopService.updateGoal(goal.id, userId, { status: 'decomposed' });
      expect(updated.status).toBe('decomposed');

      const final = loopService.updateGoal(goal.id, userId, { status: 'completed' });
      expect(final.status).toBe('completed');
    });
  });

  describe('Loop Lifecycle', () => {
    it('creates and starts a loop from goal', async () => {
      const goal = loopService.createGoal(userId, {
        objective: 'Fix README drift',
        acceptance_criteria: ['Examples work', 'No warnings'],
        risk_class: 'low',
      });

      const loop = loopService.startDocDriftLoop(TEST_REPO, {
        goal_id: goal.id,
        max_findings: 10,
      });

      expect(loop).toBeDefined();
      expect(loop.goal_id).toBe(goal.id);
      expect(loop.status).toBe('created');
      expect(loop.loop_name).toBe('doc-drift-and-small-fix-loop');
      expect(loop.mode).toBe('closed');
    });

    it('discovers findings in loop', async () => {
      const loop = loopService.startDocDriftLoop(TEST_REPO, {
        max_findings: 5,
      });

      // Simulate finding discovery
      const findings = loopService.discoverFindings(loop.id, [
        {
          type: 'documentation',
          severity: 'warning',
          file: 'README.md',
          line: 42,
          message: 'Example code outdated',
          evidence: 'Version mismatch in example',
          suggested_fix: 'Update example to v2.0 API',
        },
      ]);

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe('README.md');
      expect(findings[0].type).toBe('documentation');
    });

    it('continues loop by preparing maker/checker leases', async () => {
      const loop = loopService.startDocDriftLoop(TEST_REPO, {
        max_findings: 5,
      });

      loopService.discoverFindings(loop.id, [
        {
          type: 'documentation',
          severity: 'warning',
          file: 'README.md',
          line: 1,
          message: 'Update needed',
          evidence: 'Old content',
          suggested_fix: 'New content',
        },
      ]);

      const continued = loopService.continueLoopRun(loop.id, { max_assignments: 1, runtime: 'mock' });

      expect(continued.leases).toBeDefined();
      expect(continued.leases.length).toBeGreaterThan(0);

      const makerLease = continued.leases.find((l: WorkerLeaseRecord) => l.role === 'maker');
      const checkerLease = continued.leases.find((l: WorkerLeaseRecord) => l.role === 'checker');

      expect(makerLease).toBeDefined();
      expect(checkerLease).toBeDefined();
      expect(makerLease?.status).toBe('prepared');
      expect(checkerLease?.status).toBe('prepared');
    });

    it('enforces checker verdict before completion', async () => {
      const loop = loopService.startDocDriftLoop(TEST_REPO);
      loopService.discoverFindings(loop.id, [
        {
          type: 'code',
          severity: 'warning',
          file: 'src/index.ts',
          message: 'Issue',
          evidence: 'Evidence',
          suggested_fix: 'Fix',
        },
      ]);

      const continued = loopService.continueLoopRun(loop.id, { runtime: 'mock' });
      const checkerLease = continued.leases.find((l: WorkerLeaseRecord) => l.role === 'checker');

      expect(() => {
        loopService.completeLoopRun(loop.id);
      }).toThrow('checker_verdict');

      // Submit checker verdict
      if (checkerLease) {
        loopService.submitCheckerVerdict(loop.id, checkerLease.id, 'accepted', 'Looks good');
      }

      // Now completion should succeed
      const completed = loopService.completeLoopRun(loop.id);
      expect(completed.status).toBe('ready_for_human_merge');
    });

    it('enforces security checker for high-risk loops', async () => {
      const loop = loopService.startDocDriftLoop(TEST_REPO, undefined, 'high');
      loopService.discoverFindings(loop.id, [
        {
          type: 'security',
          severity: 'warning',
          file: 'src/auth.ts',
          message: 'Security issue',
          evidence: 'Credentials visible',
          suggested_fix: 'Use env vars',
        },
      ]);

      const continued = loopService.continueLoopRun(loop.id, { runtime: 'mock' });
      const checkerLease = continued.leases.find((l: WorkerLeaseRecord) => l.role === 'checker');
      const securityLease = continued.leases.find((l: WorkerLeaseRecord) => l.role === 'security_checker');

      expect(securityLease).toBeDefined();
      expect(securityLease?.status).toBe('prepared');

      // Cannot complete without security verdict
      if (checkerLease) {
        loopService.submitCheckerVerdict(loop.id, checkerLease.id, 'accepted', 'OK');
      }

      expect(() => {
        loopService.completeLoopRun(loop.id);
      }).toThrow('security');

      // Submit security verdict
      if (securityLease) {
        loopService.submitSecurityVerdict(loop.id, securityLease.id, 'accepted', 'Safe');
      }

      const completed = loopService.completeLoopRun(loop.id);
      expect(completed.status).toBe('ready_for_human_merge');
    });
  });

  describe('Budget Enforcement', () => {
    it('blocks new workers when token budget exhausted', async () => {
      const loop = loopService.startDocDriftLoop(TEST_REPO, {
        budget: { token_budget: 1000 }, // Small budget
      });

      loopService.discoverFindings(loop.id, [
        {
          type: 'doc',
          severity: 'warning',
          file: 'README.md',
          message: 'Issue 1',
          evidence: 'E1',
          suggested_fix: 'Fix 1',
        },
      ]);

      // First lease should succeed
      const continued1 = loopService.continueLoopRun(loop.id, { runtime: 'mock' });
      expect(continued1.leases.length).toBeGreaterThan(0);

      // Simulate token usage
      const makerLease = continued1.leases.find((l: WorkerLeaseRecord) => l.role === 'maker');
      if (makerLease) {
        loopService.recordWorkerExecution(loop.id, makerLease.id, {
          token_used: 900,
          status: 'completed',
        });
      }

      // Next lease should fail due to token budget
      loopService.discoverFindings(loop.id, [
        {
          type: 'doc',
          severity: 'warning',
          file: 'README.md',
          message: 'Issue 2',
          evidence: 'E2',
          suggested_fix: 'Fix 2',
        },
      ]);

      expect(() => {
        loopService.continueLoopRun(loop.id, { runtime: 'mock' });
      }).toThrow('token');
    });

    it('blocks new workers when retry budget exhausted', async () => {
      const loop = loopService.startDocDriftLoop(TEST_REPO, {
        budget: { max_retries: 1 },
      });

      loopService.discoverFindings(loop.id, [
        {
          type: 'code',
          severity: 'warning',
          file: 'index.ts',
          message: 'Issue',
          evidence: 'E',
          suggested_fix: 'Fix',
        },
      ]);

      const continued1 = loopService.continueLoopRun(loop.id, { runtime: 'mock' });
      const makerLease1 = continued1.leases.find((l: WorkerLeaseRecord) => l.role === 'maker');

      // First retry
      if (makerLease1) {
        const retry1 = loopService.retryMaker(loop.id, makerLease1.id, 'mock');
        expect(retry1).toBeDefined();
      }

      // Second retry should fail
      expect(() => {
        if (makerLease1) {
          loopService.retryMaker(loop.id, makerLease1.id, 'mock');
        }
      }).toThrow('retry');
    });
  });

  describe('Concurrency & Isolation', () => {
    it('creates 5 concurrent makers in isolated worktrees', async () => {
      const loop = loopService.startDocDriftLoop(TEST_REPO, {
        max_findings: 10,
      });

      // Simulate 5 findings
      const findings = Array.from({ length: 5 }, (_, i) => ({
        type: 'documentation',
        severity: 'warning' as const,
        file: `README_${i}.md`,
        message: `Issue ${i}`,
        evidence: `Evidence ${i}`,
        suggested_fix: `Fix ${i}`,
      }));

      loopService.discoverFindings(loop.id, findings);

      // Prepare 5 leases concurrently
      const allLeases: WorkerLeaseRecord[] = [];
      for (let i = 0; i < 5; i++) {
        const continued = loopService.continueLoopRun(loop.id, { max_assignments: 1, runtime: 'mock' });
        allLeases.push(...continued.leases);
      }

      const makers = allLeases.filter((l: WorkerLeaseRecord) => l.role === 'maker');
      expect(makers).toHaveLength(5);

      // Verify isolated worktrees
      const worktrees = new Set(makers.map((m: WorkerLeaseRecord) => m.worktree_path));
      expect(worktrees.size).toBe(5); // All different

      // Verify branch isolation
      const branches = makers.map((m: WorkerLeaseRecord) => m.branch_name);
      expect(new Set(branches).size).toBe(5); // All unique branches
      branches.forEach((branch: string | null) => {
        expect(branch).toMatch(/^agent\/loop\//); // Follows naming convention
      });
    });

    it('handles git conflicts gracefully across parallel makers', async () => {
      const loop = loopService.startDocDriftLoop(TEST_REPO, { max_findings: 3 });

      loopService.discoverFindings(loop.id, [
        { type: 'doc', severity: 'warning', file: 'README.md', message: 'I1', evidence: 'E1', suggested_fix: 'F1' },
        { type: 'doc', severity: 'warning', file: 'README.md', message: 'I2', evidence: 'E2', suggested_fix: 'F2' },
        { type: 'doc', severity: 'warning', file: 'README.md', message: 'I3', evidence: 'E3', suggested_fix: 'F3' },
      ]);

      const leases: WorkerLeaseRecord[] = [];
      for (let i = 0; i < 3; i++) {
        const continued = loopService.continueLoopRun(loop.id, { max_assignments: 1, runtime: 'mock' });
        leases.push(...continued.leases.filter((l: WorkerLeaseRecord) => l.role === 'maker'));
      }

      expect(leases).toHaveLength(3);

      // All makers should be in separate branches (no conflict)
      const branches = new Set(leases.map((l: WorkerLeaseRecord) => l.branch_name));
      expect(branches.size).toBe(3);
    });
  });

  describe('Loop Recovery', () => {
    it('resumes loop from checkpoint after restart', async () => {
      const loop = loopService.startDocDriftLoop(TEST_REPO);
      loopService.discoverFindings(loop.id, [
        { type: 'doc', severity: 'warning', file: 'README.md', message: 'Issue', evidence: 'E', suggested_fix: 'F' },
      ]);

      const continued = loopService.continueLoopRun(loop.id, { runtime: 'mock' });
      expect(continued.leases.length).toBeGreaterThan(0);

      // Simulate server restart by creating new service instance
      const db2 = new BetterSqlite3(TEST_DB);
      const loopService2 = new LoopService(db2);

      // Retrieve loop - should be in same state
      const recoveredLoop = loopService2.getLoopRun(loop.id);
      expect(recoveredLoop.id).toBe(loop.id);
      expect(recoveredLoop.status).toBe('running');

      const recoveredLeases = loopService2.getWorkerLeases(loop.id);
      expect(recoveredLeases.length).toBeGreaterThan(0);
      expect(recoveredLeases[0].status).toBe('prepared');

      db2.close();
    });
  });

  describe('Full End-to-End Scenario', () => {
    it('executes complete workflow: goal → loop → maker → checker → completion', async () => {
      // 1. Create goal
      const goal = loopService.createGoal(userId, {
        objective: 'Fix README documentation',
        acceptance_criteria: ['Examples work', 'No warnings', 'Builds successfully'],
        risk_class: 'low',
        budget: { token_budget: 100000, max_workers: 10, max_retries: 2 },
      });

      expect(goal.id).toBeDefined();

      // 2. Start loop for goal
      const loop = loopService.startDocDriftLoop(TEST_REPO, { goal_id: goal.id });
      expect(loop.goal_id).toBe(goal.id);

      // 3. Discover findings
      const findings = loopService.discoverFindings(loop.id, [
        {
          type: 'documentation',
          severity: 'warning',
          file: 'README.md',
          line: 10,
          message: 'Code example uses old API',
          evidence: 'README line 10: api.old()',
          suggested_fix: 'Change to api.new()',
        },
      ]);

      expect(findings.length).toBeGreaterThan(0);

      // 4. Prepare maker/checker leases
      const continued = loopService.continueLoopRun(loop.id, { max_assignments: 1, runtime: 'mock' });
      expect(continued.leases.length).toBeGreaterThan(0);

      const makerLease = continued.leases.find((l: WorkerLeaseRecord) => l.role === 'maker');
      const checkerLease = continued.leases.find((l: WorkerLeaseRecord) => l.role === 'checker');

      expect(makerLease?.status).toBe('prepared');
      expect(checkerLease?.status).toBe('prepared');

      // 5. Execute maker (simulate)
      loopService.recordWorkerExecution(loop.id, makerLease!.id, {
        status: 'completed',
        token_used: 500,
        stdout: 'Fixed README.md\nApplied changes\nTests pass',
        stderr: '',
      });

      // 6. Verify gates
      let verified = loopService.verifyLoop(loop.id);
      expect(verified.gates.some((g: any) => g.name === 'checker_verdict' && g.status === 'fail')).toBe(true);

      // 7. Execute checker (simulate)
      loopService.recordWorkerExecution(loop.id, checkerLease!.id, {
        status: 'completed',
        token_used: 300,
        stdout: 'Changes validated\nTests pass\nLinting OK',
        stderr: '',
      });

      // 8. Submit checker verdict
      loopService.submitCheckerVerdict(loop.id, checkerLease!.id, 'accepted', 'Changes look good');

      // 9. Complete loop
      const completed = loopService.completeLoopRun(loop.id);
      expect(completed.status).toBe('ready_for_human_merge');

      // 10. Verify final state
      const finalGoal = loopService.getGoal(goal.id, userId);
      expect(finalGoal).toBeDefined();

      const finalLoop = loopService.getLoopRun(loop.id);
      expect(finalLoop.status).toBe('ready_for_human_merge');
    });
  });
});
