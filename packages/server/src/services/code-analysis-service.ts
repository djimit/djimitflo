/**
 * CodeAnalysisService — analyzes code quality and complexity.
 *
 * Provides metrics for self-evolution:
 * - Cyclomatic complexity
 * - Coupling between objects
 * - Lines of code per function
 * - Duplicate code detection
 * - Dead code identification
 */

import type { Database } from 'better-sqlite3';

export interface CodeMetrics {
  file_path: string;
  lines_of_code: number;
  function_count: number;
  avg_function_length: number;
  max_function_length: number;
  cyclomatic_complexity: number;
  duplicate_lines: number;
  dead_code_indicators: number;
  quality_score: number;  // 0-100
  recommendations: string[];
}

export interface EvolutionPlan {
  plan_id: string;
  target_file: string;
  current_metrics: CodeMetrics;
  target_metrics: Partial<CodeMetrics>;
  steps: EvolutionStep[];
  estimated_impact: number;
  risk_level: 'low' | 'medium' | 'high';
}

export interface EvolutionStep {
  step_number: number;
  action: string;
  description: string;
  automated: boolean;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export class CodeAnalysisService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Analyze a source file.
   */
  analyzeFile(content: string, filePath: string): CodeMetrics {
    const lines = content.split('\n');
    const functions = this.extractFunctions(content);
    const complexity = this.computeCyclomaticComplexity(content);
    const duplicates = this.detectDuplicates(lines);
    const deadCode = this.detectDeadCode(content);

    const avgFuncLength = functions.length > 0
      ? functions.reduce((s, f) => s + f.length, 0) / functions.length
      : 0;

    const maxFuncLength = functions.length > 0
      ? Math.max(...functions.map(f => f.length))
      : 0;

    const qualityScore = this.computeQualityScore({
      avg_function_length: avgFuncLength,
      max_function_length: maxFuncLength,
      cyclomatic_complexity: complexity,
      duplicate_lines: duplicates,
      dead_code_indicators: deadCode,
    });

    return {
      file_path: filePath,
      lines_of_code: lines.length,
      function_count: functions.length,
      avg_function_length: avgFuncLength,
      max_function_length: maxFuncLength,
      cyclomatic_complexity: complexity,
      duplicate_lines: duplicates,
      dead_code_indicators: deadCode,
      quality_score: qualityScore,
      recommendations: this.generateRecommendations({
        avg_function_length: avgFuncLength,
        max_function_length: maxFuncLength,
        cyclomatic_complexity: complexity,
        duplicate_lines: duplicates,
        dead_code_indicators: deadCode,
      }),
    };
  }

  /**
   * Generate an evolution plan for a file.
   */
  generateEvolutionPlan(metrics: CodeMetrics): EvolutionPlan {
    const steps: EvolutionStep[] = [];
    let stepNum = 0;

    // Step 1: Break up large functions
    if (metrics.max_function_length > 50) {
      steps.push({
        step_number: ++stepNum,
        action: 'extract_functions',
        description: `Break ${metrics.max_function_length}-line function into smaller units`,
        automated: true,
        status: 'pending',
      });
    }

    // Step 2: Reduce complexity
    if (metrics.cyclomatic_complexity > 10) {
      steps.push({
        step_number: ++stepNum,
        action: 'simplify_conditionals',
        description: `Reduce cyclomatic complexity from ${metrics.cyclomatic_complexity} to <10`,
        automated: true,
        status: 'pending',
      });
    }

    // Step 3: Remove duplicates
    if (metrics.duplicate_lines > 5) {
      steps.push({
        step_number: ++stepNum,
        action: 'extract_common_code',
        description: `Extract ${metrics.duplicate_lines} duplicate lines into shared utility`,
        automated: true,
        status: 'pending',
      });
    }

    // Step 4: Remove dead code
    if (metrics.dead_code_indicators > 0) {
      steps.push({
        step_number: ++stepNum,
        action: 'remove_dead_code',
        description: `Remove ${metrics.dead_code_indicators} dead code indicators`,
        automated: true,
        status: 'pending',
      });
    }

    return {
      plan_id: `evo-${Date.now()}`,
      target_file: metrics.file_path,
      current_metrics: metrics,
      target_metrics: {
        max_function_length: 30,
        cyclomatic_complexity: 8,
        duplicate_lines: 0,
        dead_code_indicators: 0,
        quality_score: 85,
      },
      steps,
      estimated_impact: 100 - metrics.quality_score,
      risk_level: steps.length > 3 ? 'high' : steps.length > 1 ? 'medium' : 'low',
    };
  }

  private extractFunctions(content: string): Array<{ name: string; length: number }> {
    const functions: Array<{ name: string; length: number }> = [];
    const funcPattern = /(?:function|const|let|var)\s+(\w+)\s*(?:=\s*)?(?:\([^)]*\)|\([^)]*\)\s*=>)\s*\{/g;
    let match;

    while ((match = funcPattern.exec(content)) !== null) {
      const start = match.index;
      let braceCount = 0;
      let end = start;

      for (let i = start; i < content.length; i++) {
        if (content[i] === '{') braceCount++;
        if (content[i] === '}') braceCount--;
        if (braceCount === 0) { end = i; break; }
      }

      functions.push({ name: match[1], length: end - start });
    }

    return functions;
  }

  private computeCyclomaticComplexity(content: string): number {
    let complexity = 1;
    const decisionPoints = [
      /\bif\b/g, /\belse\b/g, /\bfor\b/g, /\bwhile\b/g,
      /\bcase\b/g, /\bcatch\b/g, /\?\b/g, /&&/g, /\|\|/g,
    ];

    for (const pattern of decisionPoints) {
      const matches = content.match(pattern);
      if (matches) complexity += matches.length;
    }

    return complexity;
  }

  private detectDuplicates(lines: string[]): number {
    const seen = new Map<string, number>();
    let duplicates = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 10) continue;
      const count = seen.get(trimmed) || 0;
      seen.set(trimmed, count + 1);
      if (count > 0) duplicates++;
    }

    return duplicates;
  }

  private detectDeadCode(content: string): number {
    let deadCode = 0;
    if (/return\s+[^;]+;\s*[^}]*$/gm.test(content)) deadCode++;
    if (/unreachable|never.*reach/i.test(content)) deadCode++;
    if (/console\.log\(['"]DEBUG/gi.test(content)) deadCode++;
    return deadCode;
  }

  private computeQualityScore(metrics: {
    avg_function_length: number;
    max_function_length: number;
    cyclomatic_complexity: number;
    duplicate_lines: number;
    dead_code_indicators: number;
  }): number {
    let score = 100;

    // Penalize long functions
    if (metrics.max_function_length > 50) score -= 20;
    else if (metrics.max_function_length > 30) score -= 10;

    // Penalize high complexity
    if (metrics.cyclomatic_complexity > 15) score -= 25;
    else if (metrics.cyclomatic_complexity > 10) score -= 15;
    else if (metrics.cyclomatic_complexity > 5) score -= 5;

    // Penalize duplicates
    score -= Math.min(20, metrics.duplicate_lines * 2);

    // Penalize dead code
    score -= metrics.dead_code_indicators * 5;

    return Math.max(0, Math.min(100, score));
  }

  private generateRecommendations(metrics: {
    avg_function_length: number;
    max_function_length: number;
    cyclomatic_complexity: number;
    duplicate_lines: number;
    dead_code_indicators: number;
  }): string[] {
    const recs: string[] = [];

    if (metrics.max_function_length > 50) {
      recs.push(`Extract functions from ${metrics.max_function_length}-line monster`);
    }
    if (metrics.cyclomatic_complexity > 10) {
      recs.push(`Simplify conditionals (complexity: ${metrics.cyclomatic_complexity})`);
    }
    if (metrics.duplicate_lines > 5) {
      recs.push(`Extract ${metrics.duplicate_lines} duplicate lines into utility`);
    }
    if (metrics.dead_code_indicators > 0) {
      recs.push(`Remove ${metrics.dead_code_indicators} dead code indicators`);
    }

    if (recs.length === 0) recs.push('Code quality is acceptable');
    return recs;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        quality_score REAL NOT NULL DEFAULT 0,
        analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ca_file ON code_analysis(file_path);
      CREATE INDEX IF NOT EXISTS idx_ca_score ON code_analysis(quality_score);
    `);
  }
}
