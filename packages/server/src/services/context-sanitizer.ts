import { swarmEventBus } from './swarm-event-bus';

/**
 * G25: ContextSanitizer — prompt injection defense.
 *
 * Sanitizes retrieved context before injection into runtime prompts. Detects
 * adversarial instruction patterns, strips them, and flags suspicious context.
 */

// G25: Conservative injection patterns — only match clearly adversarial instructions
// that would NOT appear in legitimate technical documentation. Patterns like "system:"
// or "execute:" are too common in technical docs and would cause false positives.
const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore (all )?(previous|prior) instructions/i, label: 'ignore_instructions' },
  { pattern: /disregard (all )?(previous|prior) instructions/i, label: 'disregard_instructions' },
  { pattern: /you are now (a |an )?(malicious|evil|harmful|destructive)\s*\w+/i, label: 'identity_override' },
  { pattern: /act as if you are (a |an )?(malicious|evil|harmful|destructive)/i, label: 'act_as_malicious' },
  { pattern: /override (your |the )?(system |safety )?instructions/i, label: 'override_instructions' },
  { pattern: /forget (everything|all previous|your instructions)/i, label: 'forget_instructions' },
  { pattern: /new (instructions|directive):\s*(ignore|disregard|override)/i, label: 'new_instructions_override' },
  { pattern: /delete all (files|data|records|repositories)/i, label: 'delete_all_files' },
  { pattern: /\bexecute:\s*(rm |del |delete |format )/i, label: 'execute_destructive' },
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
