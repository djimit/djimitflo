import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { SelfCodeAnalysisService } from './self-code-analysis-service';

export interface RefactoringProposal {
  id: string;
  targetService: string;
  proposalType: 'extract_module' | 'simplify' | 'merge' | 'split';
  description: string;
  currentState: {
    loc: number;
    methods: number;
    dependencies: number;
    complexity: number;
  };
  proposedChanges: string[];
  expectedImpact: {
    locReduction: number;
    complexityReduction: number;
    testabilityImprovement: number;
  };
  risk: 'low' | 'medium' | 'high';
  status: 'proposed' | 'approved' | 'applied' | 'rejected';
  createdAt: string;
}

interface ProposalRow {
  id: string;
  target_service: string;
  proposal_type: string;
  description: string;
  current_state_json: string;
  proposed_changes_json: string;
  expected_impact_json: string;
  risk: string;
  status: string;
  created_at: string;
}

export class ServiceRefactoringAnalyzer {
  private analysis: SelfCodeAnalysisService;

  constructor(private db: Database) {
    this.analysis = new SelfCodeAnalysisService(db);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refactoring_proposals (
        id TEXT PRIMARY KEY,
        target_service TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        description TEXT NOT NULL,
        current_state_json TEXT NOT NULL,
        proposed_changes_json TEXT NOT NULL,
        expected_impact_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_refactor_status ON refactoring_proposals(status)');
  }

  analyzeService(servicePath: string): RefactoringProposal[] {
    const proposals: RefactoringProposal[] = [];
    const content = this.readFile(servicePath);
    if (!content) return proposals;

    const loc = content.split('\n').length;
    const methods = this.countMethods(content);
    const dependencies = this.countDependencies(content);
    const complexity = this.estimateComplexity(content);

    if (loc > 1000) {
      proposals.push(this.createProposal(servicePath, 'split',
        `Service has ${loc} LOC (${methods} methods) — consider splitting into domain-specific modules`,
        { loc, methods, dependencies, complexity },
        ['Extract planning logic into separate service', 'Extract execution logic into separate service', 'Extract governance logic into separate service'],
        { locReduction: Math.round(loc * 0.4), complexityReduction: 30, testabilityImprovement: 40 },
        'high'
      ));
    }

    if (methods > 20) {
      proposals.push(this.createProposal(servicePath, 'extract_module',
        `Service has ${methods} methods — extract cohesive groups into helper modules`,
        { loc, methods, dependencies, complexity },
        ['Group related methods into sub-modules', 'Extract shared utilities', 'Create facade for external consumers'],
        { locReduction: Math.round(loc * 0.2), complexityReduction: 20, testabilityImprovement: 30 },
        'medium'
      ));
    }

    if (dependencies > 15) {
      proposals.push(this.createProposal(servicePath, 'simplify',
        `Service has ${dependencies} import dependencies — consider dependency injection or facade pattern`,
        { loc, methods, dependencies, complexity },
        ['Introduce dependency injection container', 'Create facade for external services', 'Lazy-load heavy dependencies'],
        { locReduction: 0, complexityReduction: 15, testabilityImprovement: 25 },
        'medium'
      ));
    }

    const deadExports = this.analysis.analyze(servicePath).deadExports;
    if (deadExports.length > 5) {
      proposals.push(this.createProposal(servicePath, 'simplify',
        `Found ${deadExports.length} potentially dead exports — remove or document`,
        { loc, methods, dependencies, complexity },
        deadExports.slice(0, 5).map(e => `Remove or document: ${e}`),
        { locReduction: deadExports.length * 5, complexityReduction: 5, testabilityImprovement: 10 },
        'low'
      ));
    }

    for (const proposal of proposals) {
      this.persistProposal(proposal);
    }

    return proposals;
  }

  analyzeAllServices(): RefactoringProposal[] {
    const allProposals: RefactoringProposal[] = [];
    const servicesDir = path.resolve(process.cwd(), 'src/services');

    if (!fs.existsSync(servicesDir)) {
      const altDir = path.resolve(process.cwd(), 'packages/server/src/services');
      if (fs.existsSync(altDir)) {
        return this.scanDirectory(altDir);
      }
    }

    return this.scanDirectory(servicesDir);
  }

  private scanDirectory(dir: string): RefactoringProposal[] {
    const proposals: RefactoringProposal[] = [];
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !f.includes('.test.'));
      for (const file of files) {
        const servicePath = path.join(dir, file);
        const serviceProposals = this.analyzeService(servicePath);
        proposals.push(...serviceProposals);
      }
    } catch { /* skip */ }
    return proposals;
  }

  getProposals(status?: string): RefactoringProposal[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM refactoring_proposals WHERE status = ? ORDER BY created_at DESC').all(status) as ProposalRow[]
      : this.db.prepare('SELECT * FROM refactoring_proposals ORDER BY created_at DESC').all() as ProposalRow[];
    return rows.map(this.rowToProposal);
  }

  updateProposalStatus(proposalId: string, status: RefactoringProposal['status']): void {
    this.db.prepare('UPDATE refactoring_proposals SET status = ? WHERE id = ?').run(status, proposalId);
  }

  private createProposal(
    targetService: string,
    proposalType: RefactoringProposal['proposalType'],
    description: string,
    currentState: RefactoringProposal['currentState'],
    proposedChanges: string[],
    expectedImpact: RefactoringProposal['expectedImpact'],
    risk: RefactoringProposal['risk']
  ): RefactoringProposal {
    return {
      id: randomUUID(),
      targetService,
      proposalType,
      description,
      currentState,
      proposedChanges,
      expectedImpact,
      risk,
      status: 'proposed',
      createdAt: new Date().toISOString(),
    };
  }

  private persistProposal(proposal: RefactoringProposal): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO refactoring_proposals (id, target_service, proposal_type, description, current_state_json, proposed_changes_json, expected_impact_json, risk, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed')
    `).run(
      proposal.id,
      proposal.targetService,
      proposal.proposalType,
      proposal.description,
      JSON.stringify(proposal.currentState),
      JSON.stringify(proposal.proposedChanges),
      JSON.stringify(proposal.expectedImpact),
      proposal.risk
    );
  }

  private readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  private countMethods(content: string): number {
    const matches = content.match(/(?:async\s+)?(?:private\s+|public\s+)?(?:static\s+)?\w+\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>/g);
    const methodMatches = content.match(/(?:async\s+)?(?:private\s+|public\s+)?(?:static\s+)?\w+\s*\([^)]*\)\s*\{/g);
    return (matches?.length ?? 0) + (methodMatches?.length ?? 0);
  }

  private countDependencies(content: string): number {
    const imports = content.match(/import\s+.*from/g);
    return imports?.length ?? 0;
  }

  private estimateComplexity(content: string): number {
    const branches = (content.match(/\b(if|else|switch|case|for|while|catch)\b/g) || []).length;
    const nesting = (content.match(/\{\s*\{/g) || []).length;
    return branches + nesting * 2;
  }

  private rowToProposal(row: ProposalRow): RefactoringProposal {
    return {
      id: row.id,
      targetService: row.target_service,
      proposalType: row.proposal_type as RefactoringProposal['proposalType'],
      description: row.description,
      currentState: JSON.parse(row.current_state_json) as RefactoringProposal['currentState'],
      proposedChanges: JSON.parse(row.proposed_changes_json) as string[],
      expectedImpact: JSON.parse(row.expected_impact_json) as RefactoringProposal['expectedImpact'],
      risk: row.risk as RefactoringProposal['risk'],
      status: row.status as RefactoringProposal['status'],
      createdAt: row.created_at,
    };
  }
}
