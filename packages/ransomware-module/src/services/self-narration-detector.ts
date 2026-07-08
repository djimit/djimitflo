import { SELF_NARRATION_PATTERNS } from '../patterns';
import { SelfNarrationMatch } from '../types';

export class SelfNarrationDetector {
  detect(code: string): SelfNarrationMatch[] {
    const matches: SelfNarrationMatch[] = [];
    const lines = code.split('\n');

    for (const line of lines) {
      for (const { pattern, category } of SELF_NARRATION_PATTERNS) {
        if (pattern.test(line)) {
          matches.push({
            pattern: pattern.source,
            line: line.trim(),
            category: category as SelfNarrationMatch['category']
          });
        }
      }
    }

    return matches;
  }

  hasLLMIndicators(code: string): boolean {
    return this.detect(code).length > 0;
  }

  getMatchSummary(code: string): Record<string, number> {
    const matches = this.detect(code);
    const summary: Record<string, number> = {};

    for (const match of matches) {
      summary[match.category] = (summary[match.category] || 0) + 1;
    }

    return summary;
  }
}
