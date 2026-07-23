/**
 * RefactoringProposalService — generates automated refactoring proposals.
 *
 * Implements:
 * - Extract method refactoring
 * - Simplify conditional expressions
 * - Remove dead code
 * - Consolidate duplicate code
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface RefactoringProposal {
  proposal_id: string;
  file_path: string;
  refactoring_type: 'extract_method' | 'simplify_conditional' | 'remove_dead_code' | 'consolidate_duplicates' | 'rename';
  original_code: string;
  proposed_code: string;
  description: string;
  confidence: number;
  estimated_benefit: number;
  risk_level: 'low' | 'medium' | 'high';
  automated: boolean;
  status: 'proposed' | 'approved' | 'applied' | 'rejected';
}

export class RefactoringProposalService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Generate refactoring proposals for a file.
   */
  generateProposals(content: string, filePath: string): RefactoringProposal[] {
    const proposals: RefactoringProposal[] = [];

    // Detect extract method opportunities
    const extractProposals = this.detectExtractMethod(content, filePath);
    proposals.push(...extractProposals);

    // Detect simplify conditional opportunities
    const simplifyProposals = this.detectSimplifyConditional(content, filePath);
    proposals.push(...simplifyProposals);

    // Detect dead code
    const deadCodeProposals = this.detectDeadCodeRefactoring(content, filePath);
    proposals.push(...deadCodeProposals);

    // Detect duplicate consolidation
    const duplicateProposals = this.detectDuplicateConsolidation(content, filePath);
    proposals.push(...duplicateProposals);

    return proposals.sort((a, b) => b.confidence - a.confidence);
  }

  private detectExtractMethod(content: string, filePath: string): RefactoringProposal[] {
    const proposals: RefactoringProposal[] = [];
    const lines = content.split('\n');

    let inFunction = false;
    let funcStart = 0;
    let funcName = '';
    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/(?:function|const|let|var)\s+(\w+)/.test(line) && !inFunction) {
        inFunction = true;
        funcStart = i;
        funcName = line.match(/(?:function|const|let|var)\s+(\w+)/)?.[1] || 'unknown';
        braceCount = 0;
      }

      if (inFunction) {
        for (const ch of line) {
          if (ch === '{') braceCount++;
          if (ch === '}') braceCount--;
        }

        if (braceCount === 0 && i > funcStart + 50) {
          // Large function detected
          proposals.push({
            proposal_id: `ref-${randomUUID().slice(0, 8)}`,
            file_path: filePath,
            refactoring_type: 'extract_method',
            original_code: lines.slice(funcStart, i + 1).join('\n'),
            proposed_code: `// Extracted from ${funcName}\nfunction extractedLogic() {\n  // ... extracted code\n}\n\nfunction ${funcName}() {\n  extractedLogic();\n}`,
            description: `Extract logic from ${funcName} (${i - funcStart + 1} lines) into smaller functions`,
            confidence: 0.8,
            estimated_benefit: (i - funcStart) * 2,
            risk_level: 'medium',
            automated: true,
            status: 'proposed',
          });
          inFunction = false;
        }
      }
    }

    return proposals;
  }

  private detectSimplifyConditional(content: string, filePath: string): RefactoringProposal[] {
    const proposals: RefactoringProposal[] = [];
    const nestedIfPattern = /if\s*\([^)]*\)\s*\{\s*if\s*\([^)]*\)\s*\{\s*if\s*\(/g;

    let match;
    while ((match = nestedIfPattern.exec(content)) !== null) {
      proposals.push({
        proposal_id: `ref-${randomUUID().slice(0, 8)}`,
        file_path: filePath,
        refactoring_type: 'simplify_conditional',
        original_code: match[0],
        proposed_code: `// Use early return or switch statement\nif (!condition1) return;\nif (!condition2) return;\n// Main logic`,
        description: 'Simplify nested conditionals using early returns',
        confidence: 0.75,
        estimated_benefit: 15,
        risk_level: 'low',
        automated: true,
        status: 'proposed',
      });
    }

    return proposals;
  }

  private detectDeadCodeRefactoring(content: string, filePath: string): RefactoringProposal[] {
    const proposals: RefactoringProposal[] = [];

    // Detect unreachable code after return
    const unreachablePattern = /return\s+[^;]+;\s*\n\s*([^}]+)/g;
    let match;

    while ((match = unreachablePattern.exec(content)) !== null) {
      proposals.push({
        proposal_id: `ref-${randomUUID().slice(0, 8)}`,
        file_path: filePath,
        refactoring_type: 'remove_dead_code',
        original_code: match[0],
        proposed_code: '// Remove unreachable code after return',
        description: `Remove ${match[1].split('\n').length} lines of unreachable code`,
        confidence: 0.9,
        estimated_benefit: 10,
        risk_level: 'low',
        automated: true,
        status: 'proposed',
      });
    }

    return proposals;
  }

  private detectDuplicateConsolidation(content: string, filePath: string): RefactoringProposal[] {
    const proposals: RefactoringProposal[] = [];
    const lines = content.split('\n');
    const seen = new Map<string, number[]>();

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.length < 15) continue;
      const existing = seen.get(trimmed) || [];
      existing.push(i);
      seen.set(trimmed, existing);
    }

    for (const [line, positions] of seen) {
      if (positions.length >= 3) {
        proposals.push({
          proposal_id: `ref-${randomUUID().slice(0, 8)}`,
          file_path: filePath,
          refactoring_type: 'consolidate_duplicates',
          original_code: line,
          proposed_code: `// Extracted to utility function\nconst sharedLogic = () => { ${line} }`,
          description: `Consolidate ${positions.length} duplicate occurrences into shared utility`,
          confidence: 0.7,
          estimated_benefit: positions.length * 5,
          risk_level: 'low',
          automated: true,
          status: 'proposed',
        });
      }
    }

    return proposals;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refactoring_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        refactoring_type TEXT NOT NULL,
        original_code TEXT NOT NULL DEFAULT '',
        proposed_code TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0,
        estimated_benefit REAL NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'low',
        automated INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'approved', 'applied', 'rejected')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rp_file ON refactoring_proposals(file_path);
      CREATE INDEX IF NOT EXISTS idx_rp_status ON refactoring_proposals(status);
    `);
  }
}
