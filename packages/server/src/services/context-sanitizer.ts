import { swarmEventBus } from './swarm-event-bus';

/**
 * G25: ContextSanitizer — prompt injection defense.
 *
 * Sanitizes retrieved context before injection into runtime prompts. Detects
 * adversarial instruction patterns, strips them, and flags suspicious context.
 */

const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore (all )?(previous|prior) instructions/i, label: 'ignore_instructions' },
  { pattern: /you are now (a |an )?\w+/i, label: 'identity_override' },
  { pattern: /\bsystem:\s/i, label: 'system_prefix' },
  { pattern: /\bexecute:\s/i, label: 'execute_prefix' },
  { pattern: /\bdelete all\b/i, label: 'delete_all' },
  { pattern: /\bdisregard (all )?(previous|prior)/i, label: 'disregard_previous' },
  { pattern: /\bact as (if you are|a |an )/i, label: 'act_as' },
  { pattern: /\boverride (your |the )?instructions/i, label: 'override_instructions' },
  { pattern: /\bforget (everything|all|previous)/i, label: 'forget_everything' },
  { pattern: /\bnew (instructions|directive):/i, label: 'new_instructions' },
];

export interface SanitizationResult {
  sanitized: string;
  was_sanitized: boolean;
  detected_patterns: string[];
  original_length: number;
  sanitized_length: number;
}

export class ContextSanitizer {
  /**
   * Sanitize context: detect + strip injection patterns.
   * Returns the sanitized text + metadata about what was detected.
   */
  sanitize(context: string): SanitizationResult {
    const detected: string[] = [];
    let sanitized = context;

    for (const { pattern, label } of INJECTION_PATTERNS) {
      if (pattern.test(sanitized)) {
        detected.push(label);
        // Strip the matched pattern (replace with a harmless placeholder).
        sanitized = sanitized.replace(pattern, '[REMOVED: injection pattern]');
      }
    }

    const wasSanitized = detected.length > 0;

    if (wasSanitized) {
      // Add a [SANITIZED] tag so the receiver knows the context was modified.
      sanitized = `[SANITIZED: ${detected.length} pattern(s) removed] ${sanitized}`;

      // Emit event for audit + observability.
      swarmEventBus.emit('convergence', {
        injection_defense: 'sanitized',
        detected_patterns: detected,
        original_length: context.length,
        sanitized_length: sanitized.length,
      });
    }

    return {
      sanitized,
      was_sanitized: wasSanitized,
      detected_patterns: detected,
      original_length: context.length,
      sanitized_length: sanitized.length,
    };
  }
}
