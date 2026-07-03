import type { Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface RefactoringProposal {
  id: string;
  targetService: string;
  proposalType: 'split' | 'extract' | 'extract_module' | 'merge' | 'simplify';
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
}

export class ServiceRefactoringAnalyzer {
  constructor(private db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS refactoring_proposals (
      id TEXT PRIMARY KEY, target_service TEXT NOT NULL, proposal_type TEXT NOT NULL,
      description TEXT NOT NULL, current_state_json TEXT NOT NULL, proposed_changes_json TEXT NOT NULL,
      expected_impact_json TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  analyzeService(filePath: string): RefactoringProposal[] {
    const resolved = this.resolveServicePath(filePath);
    if (!resolved) return [];

    const content = fs.readFileSync(resolved, 'utf8');
    const targetService = path.relative(process.cwd(), resolved);
    const loc = content.split('\n').length;
    const methods = (content.match(/(?:async\s+)?(?:private\s+|public\s+)?(?:static\s+)?\w+\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>/g) || []).length +
                   (content.match(/(?:async\s+)?(?:private\s+|public\s+)?(?:static\s+)?\w+\s*\([^)]*\)\s*\{/g) || []).length;
    const importStatements = content.match(/import\s+[^'"]+from\s+['"][^'"]+['"];?/g) || [];
    const dependencies = importStatements.reduce((sum, statement) => {
      const names = statement.match(/[a-zA-Z_$][\w$]*/g) || [];
      const keywords = new Set(['import', 'from', 'type', 'as']);
      return sum + names.filter((name) => !keywords.has(name)).length;
    }, 0);
    const complexity = (content.match(/\b(if|else|switch|case|for|while|catch)\b/g) || []).length +
                      (content.match(/\{\s*\{/g) || []).length * 2;

    const proposals: RefactoringProposal[] = [];

    if (loc > 1000) {
      proposals.push(this.createProposal(targetService, 'split',
        `Service has ${loc} LOC (${methods} methods) — consider splitting into domain-specific modules`,
        { loc, methods, dependencies, complexity },
        ['Extract planning logic into separate service', 'Extract execution logic into separate service', 'Extract governance logic into separate service'],
        { locReduction: Math.round(loc * 0.4), complexityReduction: 30, testabilityImprovement: 40 },
        'high'
      ));
    }

    if (methods > 20) {
      proposals.push(this.createProposal(targetService, 'extract_module',
        `Service has ${methods} methods — extract cohesive groups into helper modules`,
        { loc, methods, dependencies, complexity },
        ['Group related methods into sub-modules', 'Extract shared utilities', 'Create facade for external consumers'],
        { locReduction: Math.round(loc * 0.2), complexityReduction: 20, testabilityImprovement: 30 },
        'medium'
      ));
    }

    if (dependencies > 15) {
      proposals.push(this.createProposal(targetService, 'simplify',
        `Service has ${dependencies} import dependencies — consider dependency injection or facade pattern`,
        { loc, methods, dependencies, complexity },
        ['Introduce dependency injection container', 'Create facade for external services', 'Lazy-load heavy dependencies'],
        { locReduction: 0, complexityReduction: 15, testabilityImprovement: 25 },
        'medium'
      ));
    }

    for (const proposal of proposals) {
      this.persistProposal(proposal);
    }

    return proposals;
  }

  private resolveServicePath(filePath: string): string | null {
    if (fs.existsSync(filePath)) return filePath;

    const candidates = [
      path.resolve(process.cwd(), 'packages/server', filePath),
      path.resolve(process.cwd(), 'packages/dashboard', filePath),
      path.resolve(process.cwd(), 'packages/shared', filePath),
      path.resolve(process.cwd(), 'packages/telegram', filePath),
      path.resolve(__dirname, '..', filePath),
      path.resolve(__dirname, filePath),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  analyzeAllServices(): RefactoringProposal[] {
    const allProposals: RefactoringProposal[] = [];

    const possibleDirs = [
      path.resolve(process.cwd(), 'packages/server/src/services'),
      path.resolve(process.cwd(), 'src/services'),
      path.resolve(__dirname, '.'),
    ];

    let servicesDir = '';
    for (const dir of possibleDirs) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.ts') && !f.includes('.test.'))) {
        servicesDir = dir;
        break;
      }
    }

    if (!servicesDir) return [];

    const files = fs.readdirSync(servicesDir).filter(f => f.endsWith('.ts') && !f.includes('.test.'));
    for (const file of files) {
      const filePath = path.join(servicesDir, file);
      allProposals.push(...this.analyzeService(filePath));
    }

    return allProposals;
  }

  getProposals(status?: string): RefactoringProposal[] {
    let query = 'SELECT * FROM refactoring_proposals';
    const params: unknown[] = [];
    if (status) { query += ' WHERE status = ?'; params.push(status); }
    query += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string; target_service: string; proposal_type: string; description: string;
      current_state_json: string; proposed_changes_json: string; expected_impact_json: string;
      risk: string; status: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      targetService: r.target_service,
      proposalType: r.proposal_type as RefactoringProposal['proposalType'],
      description: r.description,
      currentState: JSON.parse(r.current_state_json) as RefactoringProposal['currentState'],
      proposedChanges: JSON.parse(r.proposed_changes_json) as string[],
      expectedImpact: JSON.parse(r.expected_impact_json) as RefactoringProposal['expectedImpact'],
      risk: r.risk as RefactoringProposal['risk'],
      status: r.status as RefactoringProposal['status'],
    }));
  }

  updateProposalStatus(proposalId: string, status: RefactoringProposal['status']): void {
    this.db.prepare('UPDATE refactoring_proposals SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, proposalId);
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
      id: `refactor-${path.basename(targetService)}-${proposalType}`,
      targetService,
      proposalType,
      description,
      currentState,
      proposedChanges,
      expectedImpact,
      risk,
      status: 'proposed',
    };
  }

  private persistProposal(proposal: RefactoringProposal): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO refactoring_proposals (id, target_service, proposal_type, description, current_state_json, proposed_changes_json, expected_impact_json, risk, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.id,
      proposal.targetService,
      proposal.proposalType,
      proposal.description,
      JSON.stringify(proposal.currentState),
      JSON.stringify(proposal.proposedChanges),
      JSON.stringify(proposal.expectedImpact),
      proposal.risk,
      proposal.status
    );
  }
}
