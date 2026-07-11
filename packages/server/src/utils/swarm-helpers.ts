/**
 * Shared helpers for swarm services.
 *
 * Extracted from SwarmIntelligenceService to enable method extraction
 * without duplicating utility logic.
 */

/**
 * Convert input to a string array. Handles arrays only (original SwarmIntelligenceService behavior).
 */
export function stringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * Clamp a value between 1 and 500 (original SwarmIntelligenceService behavior).
 */
export function limit(value: number): number {
  return Math.max(1, Math.min(Number(value || 100), 500));
}

/**
 * Normalize a score to [0, 1] range.
 */
export function normalizedScore(value: number): number {
  return Math.max(0, Math.min(Number(value), 1));
}

/**
 * Trim a value to string or return null if empty.
 */
export function trimStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reject values that look like secrets (original SwarmIntelligenceService behavior).
 */
export function rejectSecretLike(...values: unknown[]): void {
  const text = JSON.stringify(values);
  if (/(api[_-]?key\s*[:=]|secret\s*[:=]|private[_-]?key|bearer\s+[a-z0-9._-]{12,}|sk-[a-z0-9]{12,})/i.test(text)) {
    throw new Error('SWARM_INTELLIGENCE_SECRET_DETECTED');
  }
}
