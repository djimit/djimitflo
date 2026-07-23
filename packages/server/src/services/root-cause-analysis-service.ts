/**
 * RootCauseAnalysisService — identifies root causes of governance failures.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface RootCauseAnalysis {
  analysis_id: string;
  failure_id: string;
  category: string;
  symptoms: string[];
  root_cause: string;
  contributing_factors: string[];
  confidence: number;
  recommended_fixes: string[];
  timestamp: string;
}

export class RootCauseAnalysisService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  analyze(failureId: string, category: string, symptoms: string[]): RootCauseAnalysis {
    const rootCause = this.identifyRootCause(category, symptoms);
    const factors = this.identifyContributingFactors(category, symptoms);

    return {
      analysis_id: `rca-${randomUUID().slice(0, 8)}`,
      failure_id: failureId,
      category,
      symptoms,
      root_cause: rootCause.cause,
      contributing_factors: factors,
      confidence: rootCause.confidence,
      recommended_fixes: this.generateFixes(rootCause.cause, category),
      timestamp: new Date().toISOString(),
    };
  }

  private identifyRootCause(category: string, symptoms: string[]): { cause: string; confidence: number } {
    const causeMap: Record<string, Record<string, string>> = {
      injection: { 'prompt manipulation': 'Insufficient input validation', 'tool misuse': 'Missing tool scope enforcement' },
      hierarchy: { 'authority conflict': 'Missing escalation process', 'self-approval': 'Separation of duties violation' },
      hallucination: { 'fabricated citation': 'Missing citation verification', 'false claim': 'No fact-checking pipeline' },
      canary: { 'canary leak': 'Missing canary isolation', 'premature promotion': 'Insufficient canary duration' },
    };

    for (const symptom of symptoms) {
      const cause = causeMap[category]?.[symptom];
      if (cause) return { cause, confidence: 0.85 };
    }

    return { cause: `Unknown root cause for ${category}`, confidence: 0.3 };
  }

  private identifyContributingFactors(_category: string, symptoms: string[]): string[] {
    const factors: string[] = [];
    if (symptoms.length > 2) factors.push('Multiple compounding issues');
    if (symptoms.some(s => /pressure|urgent/i.test(s))) factors.push('Time pressure');
    if (symptoms.some(s => /senior|executive/i.test(s))) factors.push('Authority pressure');
    return factors;
  }

  private generateFixes(rootCause: string, category: string): string[] {
    const fixes: string[] = [];
    if (rootCause.includes('validation')) fixes.push('Add input validation layer');
    if (rootCause.includes('scope')) fixes.push('Enforce tool scope boundaries');
    if (rootCause.includes('escalation')) fixes.push('Define escalation procedures');
    if (rootCause.includes('verification')) fixes.push('Add fact-checking pipeline');
    if (fixes.length === 0) fixes.push(`Review ${category} governance controls`);
    return fixes;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS root_cause_analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id TEXT NOT NULL UNIQUE,
        failure_id TEXT NOT NULL,
        category TEXT NOT NULL,
        root_cause TEXT NOT NULL,
        symptoms_json TEXT NOT NULL DEFAULT '[]',
        factors_json TEXT NOT NULL DEFAULT '[]',
        fixes_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}
