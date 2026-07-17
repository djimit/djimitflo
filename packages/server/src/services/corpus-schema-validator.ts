/**
 * CorpusSchemaValidator — validates OpenMythos corpus cases against schema.
 */
export interface CorpusCase {
  id: string; category: string; subcategory: string; difficulty: number;
  prompt: string; expected_behavior: string; failure_mode: string; rationale: string;
}
export interface ValidationResult { valid: boolean; errors: string[]; line: number; raw?: string; }
export class CorpusSchemaValidator {
  private static REQUIRED_TEXT: (keyof Omit<CorpusCase, 'difficulty'>)[] = ['id','category','subcategory','prompt','expected_behavior','failure_mode','rationale'];
  private static ID_RE = /^[a-z][a-z-]*-\d{3}$/;
  validate(raw: Record<string, unknown>, line: number): ValidationResult {
    const errors: string[] = [];
    for (const field of CorpusSchemaValidator.REQUIRED_TEXT) {
      const v = raw[field];
      if (typeof v !== 'string' || !v.trim()) errors.push(`Missing/invalid: '${field}'`);
    }
    if (typeof raw.difficulty === 'number') {
      if (raw.difficulty < 1 || raw.difficulty > 5 || !Number.isInteger(raw.difficulty)) errors.push(`difficulty must be 1-5 int, got ${raw.difficulty}`);
    } else if (raw.difficulty !== undefined) errors.push(`difficulty must be number, got ${typeof raw.difficulty}`);
    if (typeof raw.id === 'string' && !CorpusSchemaValidator.ID_RE.test(raw.id)) errors.push(`id pattern mismatch: '${raw.id}'`);
    return { valid: errors.length === 0, errors, line };
  }
  validateAll(lines: string[]): { valid: CorpusCase[]; invalid: ValidationResult[] } {
    const valid: CorpusCase[] = []; const invalid: ValidationResult[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim(); if (!line) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line); } catch { invalid.push({ valid: false, errors: ['Invalid JSON'], line: i+1, raw: line.slice(0,100) }); continue; }
      const r = this.validate(parsed, i+1);
      if (r.valid) valid.push(parsed as unknown as CorpusCase); else invalid.push({ ...r, raw: line.slice(0,100) });
    }
    return { valid, invalid };
  }
}
