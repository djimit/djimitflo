/**
 * SelfModificationPipeline — autonomous code improvement with evidence gating.
 *
 * Analyzes the codebase for improvement opportunities, generates patches,
 * and creates evidence-gated PRs. Human approval required for merge.
 *
 * Pipeline:
 *   Analyze → Plan → Implement → Test → Evidence → PR (human approval) → Merge
 */

import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Database } from 'better-sqlite3';

interface ImprovementOpportunity {
  id: string;
  type: 'complexity' | 'test_gap' | 'dead_code' | 'performance' | 'security';
  severity: 'low' | 'medium' | 'high' | 'critical';
  file: string;
  line?: number;
  description: string;
  suggestion: string;
  estimatedEffort: string;
  detectedAt: string;
}

interface ModificationPlan {
  id: string;
  opportunityId: string;
  title: string;
  description: string;
  changes: PlannedChange[];
  testStrategy: string;
  rollbackPlan: string;
  createdAt: string;
}

interface PlannedChange {
  file: string;
  type: 'add' | 'modify' | 'delete' | 'refactor';
  description: string;
  before?: string;
  after?: string;
}

interface ModificationResult {
  id: string;
  planId: string;
  status: 'pending' | 'implemented' | 'tested' | 'pr_created' | 'merged' | 'rejected';
  prUrl?: string;
  evidence: Record<string, unknown>;
  implementedAt?: string;
  testedAt?: string;
  createdAt: string;
}

export class SelfModificationPipeline {
  private readonly repoRoot: string;

  constructor(private db: Database) {
    this.repoRoot = process.cwd();
    this.ensureTables();
  }

  /**
   * Analyze the codebase for improvement opportunities.
   */
  analyze(): ImprovementOpportunity[] {
    const opportunities: ImprovementOpportunity[] = [];

    // 1. Detect high-complexity functions
    opportunities.push(...this.detectComplexityHotspots());

    // 2. Detect untested critical functions
    opportunities.push(...this.detectTestGaps());

    // 3. Detect TODO/FIXME comments
    opportunities.push(...this.detectTodoComments());

    // Store opportunities
    for (const opp of opportunities) {
      this.db.prepare(`
        INSERT OR IGNORE INTO self_modification_opportunities
        (id, type, severity, file_path, line_number, description, suggestion, estimated_effort, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        opp.id, opp.type, opp.severity, opp.file, opp.line || null,
        opp.description, opp.suggestion, opp.estimatedEffort, opp.detectedAt,
      );
    }

    return opportunities;
  }

  /**
   * Create a modification plan for an opportunity.
   */
  createPlan(opportunityId: string): ModificationPlan | null {
    const opp = this.db.prepare('SELECT * FROM self_modification_opportunities WHERE id = ?').get(opportunityId) as any;
    if (!opp) return null;

    const plan: ModificationPlan = {
      id: randomUUID(),
      opportunityId,
      title: `[Auto] ${opp.type}: ${opp.description.slice(0, 60)}`,
      description: opp.description,
      changes: this.generateChanges(opp),
      testStrategy: 'Run full test suite + targeted unit tests for modified code',
      rollbackPlan: 'Revert via git revert or restore from backup',
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO self_modification_plans
      (id, opportunity_id, title, description, changes_json, test_strategy, rollback_plan, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id, plan.opportunityId, plan.title, plan.description,
      JSON.stringify(plan.changes), plan.testStrategy, plan.rollbackPlan, plan.createdAt,
    );

    return plan;
  }

  /**
   * Execute a modification plan (implement + test).
   */
  async executePlan(planId: string): Promise<ModificationResult> {
    const plan = this.db.prepare('SELECT * FROM self_modification_plans WHERE id = ?').get(planId) as any;
    if (!plan) throw new Error('PLAN_NOT_FOUND');

    const result: ModificationResult = {
      id: randomUUID(),
      planId,
      status: 'pending',
      evidence: {},
      createdAt: new Date().toISOString(),
    };

    try {
      // Apply changes
      const changes = JSON.parse(plan.changes_json);
      for (const change of changes) {
        this.applyChange(change);
      }
      result.status = 'implemented';
      result.implementedAt = new Date().toISOString();

      // Run tests
      const testResult = this.runTests();
      result.evidence.tests = testResult;

      if (testResult.success) {
        result.status = 'tested';
        result.testedAt = new Date().toISOString();
      } else {
        // Rollback on test failure
        this.rollback(planId);
        result.status = 'rejected';
        result.evidence.rollbackReason = 'Tests failed';
      }
    } catch (error) {
      result.status = 'rejected';
      result.evidence.error = error instanceof Error ? error.message : String(error);
      this.rollback(planId);
    }

    // Store result
    this.db.prepare(`
      INSERT INTO self_modification_results
      (id, plan_id, status, evidence_json, implemented_at, tested_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id, result.planId, result.status,
      JSON.stringify(result.evidence), result.implementedAt || null,
      result.testedAt || null, result.createdAt,
    );

    return result;
  }

  /**
   * Get the status of all self-modification activities.
   */
  getStatus(): {
    opportunities: number;
    plans: number;
    implemented: number;
    tested: number;
    rejected: number;
  } {
    const opportunities = (this.db.prepare('SELECT COUNT(*) as c FROM self_modification_opportunities').get() as any)?.c || 0;
    const plans = (this.db.prepare('SELECT COUNT(*) as c FROM self_modification_plans').get() as any)?.c || 0;
    const implemented = (this.db.prepare("SELECT COUNT(*) as c FROM self_modification_results WHERE status IN ('implemented', 'tested', 'pr_created', 'merged')").get() as any)?.c || 0;
    const tested = (this.db.prepare("SELECT COUNT(*) as c FROM self_modification_results WHERE status IN ('tested', 'pr_created', 'merged')").get() as any)?.c || 0;
    const rejected = (this.db.prepare("SELECT COUNT(*) as c FROM self_modification_results WHERE status = 'rejected'").get() as any)?.c || 0;

    return { opportunities, plans, implemented, tested, rejected };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private detectComplexityHotspots(): ImprovementOpportunity[] {
    const opportunities: ImprovementOpportunity[] = [];

    try {
      // Use simple heuristics: files > 500 lines with many methods
      const output = execSync(
        'find packages/server/src/services -name "*.ts" -exec wc -l {} + 2>/dev/null | sort -rn | head -10',
        { encoding: 'utf8', cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) continue;

        const lines = parseInt(match[1]);
        const filePath = match[2];

        if (lines > 800) {
          opportunities.push({
            id: randomUUID(),
            type: 'complexity',
            severity: lines > 1500 ? 'high' : 'medium',
            file: filePath,
            description: `File has ${lines} lines — consider decomposition`,
            suggestion: 'Extract focused services following single-responsibility principle',
            estimatedEffort: lines > 1500 ? '4-8 hours' : '1-2 hours',
            detectedAt: new Date().toISOString(),
          });
        }
      }
    } catch {
      // Best-effort analysis
    }

    return opportunities;
  }

  private detectTestGaps(): ImprovementOpportunity[] {
    const opportunities: ImprovementOpportunity[] = [];

    try {
      // Find route files without corresponding test files
      const output = execSync(
        'find packages/server/src/routes -name "*.ts" ! -name "*.test.ts" 2>/dev/null',
        { encoding: 'utf8', cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      for (const filePath of output.split('\n').filter(Boolean)) {
        const testPath = filePath.replace('.ts', '.test.ts');
        if (!existsSync(join(this.repoRoot, testPath))) {
          opportunities.push({
            id: randomUUID(),
            type: 'test_gap',
            severity: 'medium',
            file: filePath,
            description: `No test file found for ${filePath}`,
            suggestion: 'Create integration tests for route handlers',
            estimatedEffort: '30-60 minutes',
            detectedAt: new Date().toISOString(),
          });
        }
      }
    } catch {
      // Best-effort analysis
    }

    return opportunities;
  }

  private detectTodoComments(): ImprovementOpportunity[] {
    const opportunities: ImprovementOpportunity[] = [];

    try {
      const output = execSync(
        'grep -rn "TODO\\|FIXME\\|HACK\\|XXX" packages/server/src/services/ --include="*.ts" 2>/dev/null | head -20',
        { encoding: 'utf8', cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      for (const line of output.split('\n').filter(Boolean)) {
        const match = line.match(/^(.+?):(\d+):\s*(TODO|FIXME|HACK|XXX)[:\s]*(.+)$/i);
        if (!match) continue;

        opportunities.push({
          id: randomUUID(),
          type: 'dead_code',
          severity: 'low',
          file: match[1],
          line: parseInt(match[2]),
          description: `${match[3]}: ${match[4].slice(0, 80)}`,
          suggestion: 'Address TODO or convert to tracked issue',
          estimatedEffort: '15-30 minutes',
          detectedAt: new Date().toISOString(),
        });
      }
    } catch {
      // Best-effort analysis
    }

    return opportunities;
  }

  private generateChanges(opp: Record<string, unknown>): PlannedChange[] {
    // Generate a simple plan based on opportunity type
    const changes: PlannedChange[] = [];

    switch (opp.type) {
      case 'complexity':
        changes.push({
          file: opp.file_path as string,
          type: 'refactor',
          description: `Decompose ${opp.file_path} into focused services`,
        });
        break;
      case 'test_gap':
        changes.push({
          file: (opp.file_path as string).replace('.ts', '.test.ts'),
          type: 'add',
          description: `Create integration tests for ${opp.file_path}`,
        });
        break;
      case 'dead_code':
        changes.push({
          file: opp.file_path as string,
          type: 'modify',
          description: `Address TODO at line ${opp.line_number}`,
        });
        break;
    }

    return changes;
  }

  private applyChange(change: PlannedChange): void {
    if (change.type === 'add' && change.after) {
      const fullPath = join(this.repoRoot, change.file);
      writeFileSync(fullPath, change.after);
    }
    // For modify/refactor, we'd need LLM-generated patches (v2)
  }

  private runTests(): { success: boolean; output: string } {
    try {
      const output = execSync('npx vitest run --reporter=verbose 2>&1 | tail -20', {
        encoding: 'utf8',
        cwd: this.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      });
      return { success: output.includes('passed') && !output.includes('failed'), output };
    } catch {
      return { success: false, output: 'Test execution failed' };
    }
  }

  private rollback(_planId: string): void {
    try {
      execSync('git checkout -- .', { cwd: this.repoRoot, stdio: 'ignore' });
    } catch {
      // Best-effort rollback
    }
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS self_modification_opportunities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('complexity', 'test_gap', 'dead_code', 'performance', 'security')),
        severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
        file_path TEXT NOT NULL,
        line_number INTEGER,
        description TEXT NOT NULL DEFAULT '',
        suggestion TEXT NOT NULL DEFAULT '',
        estimated_effort TEXT NOT NULL DEFAULT '',
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS self_modification_plans (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        changes_json TEXT NOT NULL DEFAULT '[]',
        test_strategy TEXT NOT NULL DEFAULT '',
        rollback_plan TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (opportunity_id) REFERENCES self_modification_opportunities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS self_modification_results (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'implemented', 'tested', 'pr_created', 'merged', 'rejected')),
        pr_url TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        implemented_at TEXT,
        tested_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (plan_id) REFERENCES self_modification_plans(id) ON DELETE CASCADE
      );
    `);
  }
}
