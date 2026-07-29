/**
 * SelfModificationPipeline — autonomous code improvement with evidence gating.
 *
 * Analyzes the codebase for improvement opportunities, generates patches,
 * and creates evidence-gated PRs. Human approval required for merge.
 *
 * Pipeline:
 *   Analyze → Plan → Implement → Test → Evidence → PR (human approval) → Merge
 */

import { createHash, randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
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

export class SelfModificationPipeline {
  private readonly repoRoot: string;

  constructor(private db: Database, repoRoot = process.cwd()) {
    this.repoRoot = repoRoot;
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

    const activeIds = new Set(opportunities.map((opportunity) => opportunity.id));
    for (const opp of opportunities) {
      this.db.prepare(`
        INSERT INTO self_modification_opportunities
        (id, type, severity, file_path, line_number, description, suggestion, estimated_effort,
         detected_at, first_seen_at, last_seen_at, seen_count, analyzer_version, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'v2', NULL)
        ON CONFLICT(id) DO UPDATE SET
          severity = excluded.severity,
          suggestion = excluded.suggestion,
          estimated_effort = excluded.estimated_effort,
          last_seen_at = excluded.last_seen_at,
          seen_count = self_modification_opportunities.seen_count + 1,
          resolved_at = NULL
      `).run(
        opp.id, opp.type, opp.severity, opp.file, opp.line || null,
        opp.description, opp.suggestion, opp.estimatedEffort, opp.detectedAt,
        opp.detectedAt, opp.detectedAt,
      );
    }
    const activeV2 = this.db.prepare("SELECT id FROM self_modification_opportunities WHERE analyzer_version = 'v2' AND resolved_at IS NULL").all() as Array<{ id: string }>;
    const resolve = this.db.prepare('UPDATE self_modification_opportunities SET resolved_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    for (const row of activeV2) {
      if (!activeIds.has(row.id)) resolve.run(now, row.id);
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
   * Get the status of all self-modification activities.
   */
  getStatus(): {
    opportunities: number;
    plans: number;
    implemented: number;
    tested: number;
    rejected: number;
  } {
    const opportunities = (this.db.prepare('SELECT COUNT(*) as c FROM self_modification_opportunities WHERE resolved_at IS NULL').get() as any)?.c || 0;
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
        { encoding: 'utf8', cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
      );

      for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) continue;

        const lines = parseInt(match[1]);
        const filePath = match[2];

        if (filePath !== 'total' && lines > 800) {
          const description = `File has ${lines} lines — consider decomposition`;
          opportunities.push({
            id: this.findingId('complexity', filePath, undefined, description),
            type: 'complexity',
            severity: lines > 1500 ? 'high' : 'medium',
            file: filePath,
            description,
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
      const testImports = this.testImports();
      const output = execSync(
        'find packages/server/src/routes -name "*.ts" ! -name "*.test.ts" 2>/dev/null',
        { encoding: 'utf8', cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
      );

      for (const filePath of output.split('\n').filter(Boolean)) {
        const routeName = basename(filePath, '.ts');
        if (!testImports.has(routeName)) {
          const description = `No test imports route ${filePath}`;
          opportunities.push({
            id: this.findingId('test_gap', filePath, undefined, description),
            type: 'test_gap',
            severity: 'medium',
            file: filePath,
            description,
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
        { encoding: 'utf8', cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
      );

      for (const line of output.split('\n').filter(Boolean)) {
        const match = line.match(/^(.+?):(\d+):\s*(TODO|FIXME|HACK|XXX)[:\s]*(.+)$/i);
        if (!match) continue;

        opportunities.push({
          id: this.findingId('dead_code', match[1], parseInt(match[2]), `${match[3]}: ${match[4].slice(0, 80)}`),
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

  private findingId(type: string, file: string, line: number | undefined, description: string): string {
    const digest = createHash('sha256')
      .update(['v2', type, file, line ?? '', description].join('\0'))
      .digest('hex')
      .slice(0, 24);
    return `selfmod:v2:${digest}`;
  }

  private testImports(): Set<string> {
    const imports = new Set<string>();
    const testsDir = join(this.repoRoot, 'packages/server/src/__tests__');
    for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
      const content = readFileSync(join(testsDir, entry.name), 'utf8');
      for (const match of content.matchAll(/from\s+['"]\.\.\/routes\/([^'"]+)['"]/g)) {
        imports.add(match[1]);
      }
    }
    return imports;
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
    const columns = new Set((this.db.prepare('PRAGMA table_info(self_modification_opportunities)').all() as Array<{ name: string }>).map((column) => column.name));
    const additions: Array<[string, string]> = [
      ['first_seen_at', "TEXT NOT NULL DEFAULT ''"],
      ['last_seen_at', "TEXT NOT NULL DEFAULT ''"],
      ['seen_count', 'INTEGER NOT NULL DEFAULT 1'],
      ['analyzer_version', "TEXT NOT NULL DEFAULT 'legacy'"],
      ['resolved_at', 'TEXT'],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE self_modification_opportunities ADD COLUMN ${name} ${definition}`);
    }
    this.migrateLegacyFindings();
  }

  private migrateLegacyFindings(): void {
    const rows = this.db.prepare(`
      SELECT o.*
      FROM self_modification_opportunities o
      WHERE o.analyzer_version = 'legacy'
        AND NOT EXISTS (
          SELECT 1 FROM self_modification_plans p WHERE p.opportunity_id = o.id
        )
      ORDER BY o.detected_at
    `).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return;

    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const key = [row.type, row.file_path, row.line_number ?? '', row.description].join('\0');
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }

    this.db.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO self_modification_opportunities
        (id, type, severity, file_path, line_number, description, suggestion, estimated_effort,
         detected_at, first_seen_at, last_seen_at, seen_count, analyzer_version, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v2', NULL)
        ON CONFLICT(id) DO UPDATE SET
          first_seen_at = MIN(self_modification_opportunities.first_seen_at, excluded.first_seen_at),
          last_seen_at = MAX(self_modification_opportunities.last_seen_at, excluded.last_seen_at),
          seen_count = self_modification_opportunities.seen_count + excluded.seen_count
      `);
      const remove = this.db.prepare('DELETE FROM self_modification_opportunities WHERE id = ?');

      for (const group of groups.values()) {
        const first = group[0];
        const last = group[group.length - 1];
        const id = this.findingId(
          String(first.type),
          String(first.file_path),
          first.line_number == null ? undefined : Number(first.line_number),
          String(first.description),
        );
        insert.run(
          id,
          first.type,
          first.severity,
          first.file_path,
          first.line_number,
          first.description,
          first.suggestion,
          first.estimated_effort,
          first.detected_at,
          first.detected_at,
          last.detected_at,
          group.length,
        );
        for (const row of group) remove.run(row.id);
      }
    })();
  }
}
