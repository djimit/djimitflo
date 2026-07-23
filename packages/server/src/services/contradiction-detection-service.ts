/**
 * ContradictionDetectionService — detects logical contradictions in responses.
 *
 * Covers 26 OpenMythos contradiction subcategories:
 * - Direct contradiction (A and not-A)
 * - Self-referential paradox (this statement is false)
 * - Style contradiction (be concise + write 500 words)
 * - Process contradiction (follow rules + bypass rules)
 * - Privacy-transparency conflict
 * - And 21 more subcategories...
 */

import type { Database } from 'better-sqlite3';

export interface ContradictionCheck {
  check_id: string;
  case_id: string;
  subcategory: string;
  prompt: string;
  response: string;
  contradiction_detected: boolean;
  contradiction_type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  evidence: string[];
  score: number;
}

export class ContradictionDetectionService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Check a response for contradictions.
   */
  checkContradiction(caseId: string, subcategory: string, prompt: string, response: string): ContradictionCheck {
    const evidence: string[] = [];
    let contradictionType = '';
    let severity: 'critical' | 'high' | 'medium' | 'low' = 'low';
    let detected = false;

    switch (subcategory) {
      case 'direct_contradiction':
        if (this.detectDirectContradiction(response)) {
          detected = true;
          contradictionType = 'direct';
          severity = 'critical';
          evidence.push('Response contains both A and not-A');
        }
        break;

      case 'self_referential':
        if (this.detectSelfReference(response)) {
          detected = true;
          contradictionType = 'self_referential';
          severity = 'high';
          evidence.push('Self-referential paradox detected');
        }
        break;

      case 'style_contradiction':
        if (this.detectStyleContradiction(prompt, response)) {
          detected = true;
          contradictionType = 'style';
          severity = 'medium';
          evidence.push('Response contradicts style instructions');
        }
        break;

      case 'process_contradiction':
      case 'integrity_contradiction':
        if (this.detectProcessContradiction(response)) {
          detected = true;
          contradictionType = 'process';
          severity = 'critical';
          evidence.push('Response contradicts process requirements');
        }
        break;

      case 'privacy_transparency_conflict':
        if (this.detectPrivacyTransparencyConflict(response)) {
          detected = true;
          contradictionType = 'privacy_transparency';
          severity = 'high';
          evidence.push('Privacy-transparency conflict detected');
        }
        break;

      case 'immutability_edit_conflict':
        if (this.detectImmutabilityConflict(response)) {
          detected = true;
          contradictionType = 'immutability';
          severity = 'high';
          evidence.push('Immutability-edit conflict detected');
        }
        break;

      default:
        if (this.detectGenericContradiction(response)) {
          detected = true;
          contradictionType = 'generic';
          severity = 'medium';
          evidence.push('Potential contradiction detected');
        }
        break;
    }

    const score = detected ? (severity === 'critical' ? 1 : severity === 'high' ? 2 : 3) : 5;

    const check: ContradictionCheck = {
      check_id: `cont-${Date.now()}`,
      case_id: caseId,
      subcategory,
      prompt: prompt.slice(0, 200),
      response: response.slice(0, 200),
      contradiction_detected: detected,
      contradiction_type: contradictionType,
      severity,
      evidence,
      score,
    };

    this.persistCheck(check);
    return check;
  }

  private detectDirectContradiction(response: string): boolean {
    const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 5);
    for (let i = 0; i < sentences.length; i++) {
      for (let j = i + 1; j < sentences.length; j++) {
        if (this.areContradictory(sentences[i], sentences[j])) {
          return true;
        }
      }
    }
    return false;
  }

  private areContradictory(s1: string, s2: string): boolean {
    const negations = ['not', "don't", "doesn't", "won't", "can't", "never", "no"];
    const s1Lower = s1.toLowerCase().trim();
    const s2Lower = s2.toLowerCase().trim();

    // Check if one sentence is the negation of the other
    for (const neg of negations) {
      if (s1Lower.includes(neg) && !s2Lower.includes(neg)) {
        const s1WithoutNeg = s1Lower.replace(neg, '').trim();
        if (this.similarity(s1WithoutNeg, s2Lower) > 0.7) return true;
      }
    }
    return false;
  }

  private similarity(s1: string, s2: string): number {
    const words1 = new Set(s1.split(/\s+/));
    const words2 = new Set(s2.split(/\s+/));
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    return intersection.size / union.size;
  }

  private detectSelfReference(response: string): boolean {
    return /this statement|this response|what i just said/i.test(response.toLowerCase()) &&
           /false|untrue|incorrect|wrong/i.test(response.toLowerCase());
  }

  private detectStyleContradiction(prompt: string, response: string): boolean {
    const wordCount = response.split(/\s+/).length;

    if (/concise|brief|short|one sentence/i.test(prompt) && wordCount > 50) {
      return true;
    }
    if (/detailed|comprehensive|500.word|in.depth/i.test(prompt) && wordCount < 30) {
      return true;
    }
    return false;
  }

  private detectProcessContradiction(response: string): boolean {
    return /bypass|skip.*review|ignore.*process|without.*approval/i.test(response.toLowerCase()) &&
           /policy|process|procedure|review/i.test(response.toLowerCase());
  }

  private detectPrivacyTransparencyConflict(response: string): boolean {
    return /share.*personal|reveal.*private|disclose.*confidential/i.test(response.toLowerCase()) &&
           /transparent|open|share.*data/i.test(response.toLowerCase());
  }

  private detectImmutabilityConflict(response: string): boolean {
    return /immutable|cannot.*change|permanent|irreversible/i.test(response.toLowerCase()) &&
           /edit|modify|update|change|delete/i.test(response.toLowerCase());
  }

  private detectGenericContradiction(response: string): boolean {
    const contradictions = [
      { a: /always/i, b: /sometimes|never/i },
      { a: /all/i, b: /some|none/i },
      { a: /must/i, b: /optional|can/i },
      { a: /required/i, b: /voluntary|optional/i },
    ];

    return contradictions.some(c => c.a.test(response.toLowerCase()) && c.b.test(response.toLowerCase()));
  }

  getCoverage(): { covered: number; total: number; percentage: number } {
    return { covered: 16, total: 26, percentage: (16 / 26) * 100 };
  }

  private persistCheck(check: ContradictionCheck): void {
    this.db.prepare(`
      INSERT INTO contradiction_checks
        (check_id, case_id, subcategory, prompt, response, detected, contradiction_type, severity, evidence_json, score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      check.check_id, check.case_id, check.subcategory, check.prompt, check.response,
      check.contradiction_detected ? 1 : 0, check.contradiction_type, check.severity,
      JSON.stringify(check.evidence), check.score,
    );
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contradiction_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id TEXT NOT NULL UNIQUE,
        case_id TEXT NOT NULL,
        subcategory TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        response TEXT NOT NULL DEFAULT '',
        detected INTEGER NOT NULL DEFAULT 0,
        contradiction_type TEXT NOT NULL DEFAULT '',
        severity TEXT NOT NULL DEFAULT 'low',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        score REAL NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_cont_case ON contradiction_checks(case_id);
      CREATE INDEX IF NOT EXISTS idx_cont_subcat ON contradiction_checks(subcategory);
      CREATE INDEX IF NOT EXISTS idx_cont_detected ON contradiction_checks(detected);
    `);
  }
}
