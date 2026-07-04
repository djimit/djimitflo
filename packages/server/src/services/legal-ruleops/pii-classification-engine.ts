/**
 * PIICClassificationEngine — V3.1-based PII classification for legal texts.
 *
 * Based on OpenMythos V3.1 engine analysis:
 * - Regex-based pattern matching for PII detection
 * - Context-aware classification (near organisation, near professional)
 * - Per-rechtsgebied rule sets
 * - Confidence scoring with method tracking
 */

import type { PIIDetection, PseudonimiseerActie, PIICategory, Rechtsgebied, ClassificatieResult } from './types';

interface PatternRule {
  category: PIICategory;
  pattern: RegExp;
  action: PseudonimiseerActie;
  reason: string;
  confidence: number;
  rechtsgebieden: Rechtsgebied[];
  uitzonderingen?: RegExp[];
}

const PII_PATTERNS: PatternRule[] = [
  // BSN (Burgerservicenummer) — always pseudonymize
  { category: 'bsn', pattern: /\b\d{9}\b/g, action: 'pseudonimiseer', reason: 'BSN detected — direct identifier', confidence: 0.95, rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'familierecht', 'arbeidsrecht', 'cassatie'] },

  // Geboortedatum
  { category: 'geboortedatum', pattern: /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, action: 'pseudonimiseer', reason: 'Date of birth detected', confidence: 0.85, rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'familierecht', 'arbeidsrecht'] },

  // Telefoonnummer
  { category: 'telefoon', pattern: /\b0[1-9][0-9]{7,8}\b|\b\+31[0-9]{9}\b/g, action: 'pseudonimiseer', reason: 'Phone number detected', confidence: 0.9, rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'familierecht', 'arbeidsrecht', 'cassatie'] },

  // Email
  { category: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, action: 'pseudonimiseer', reason: 'Email address detected', confidence: 0.95, rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'familierecht', 'arbeidsrecht', 'cassatie'] },

  // Adres (straat + huisnummer)
  { category: 'adres', pattern: /\b[A-Z][a-z]+\s+\d{1,4}[a-z]?\b/g, action: 'handmatige_controle', reason: 'Possible address — requires context', confidence: 0.6, rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'familierecht', 'arbeidsrecht'] },

  // Organisatie (context-dependent)
  { category: 'organisatie', pattern: /\b[A-Z][a-z]*(?:[A-Z][a-z]*)+(?:\s+(?:BV|NV|BVBA|CVBA|Stichting|Vereniging))?\b/g, action: 'niet_pseudonimiseer', reason: 'Organisation name — public interest', confidence: 0.7, rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'cassatie'] },

  // Professional (advocaat, rechter, etc.)
  { category: 'professional', pattern: /\b(?:advocaat|raadsman|rechter|griffier|officier|procureur)\b/gi, action: 'niet_pseudonimiseer', reason: 'Legal professional — public role', confidence: 0.85, rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'cassatie'] },

  // Overheid
  { category: 'overheid', pattern: /\b(?:ministerie|gemeente|prov Staat|Belastingdienst|OM|Openbaar Ministerie)\b/gi, action: 'niet_pseudonimiseer', reason: 'Government entity — public interest', confidence: 0.9, rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'cassatie'] },

  // IBAN / rekeningnummer
  { category: 'rekeningnummer', pattern: /\bNL\d{2}[A-Z]{4}\d{10}\b/g, action: 'pseudonimiseer', reason: 'IBAN detected — financial identifier', confidence: 0.95, rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'arbeidsrecht'] },

  // Kenteken
  { category: 'kenteken', pattern: /\b-[A-Z]{2}-\d{2}-\d{2}-\b|\b\d{2}-[A-Z]{2}-\d{2}\b/g, action: 'pseudonimiseer', reason: 'License plate detected', confidence: 0.9, rechtsgebieden: ['civiel', 'straf'] },
];

export class PIIClassificationEngine {
  /**
   * Classify PII in a legal text.
   */
  classify(text: string, rechtsgebied: Rechtsgebied = 'civiel'): ClassificatieResult {
    const detections: PIIDetection[] = [];

    for (const rule of PII_PATTERNS) {
      // Skip rules not applicable to this rechtsgebied
      if (!rule.rechtsgebieden.includes(rechtsgebied)) continue;

      const matches = text.matchAll(rule.pattern);
      for (const match of matches) {
        if (match.index === undefined) continue;

        // Check uitzonderingen
        let isUitzondering = false;
        if (rule.uitzonderingen) {
          for (const uitzondering of rule.uitzonderingen) {
            if (uitzondering.test(match[0])) {
              isUitzondering = true;
              break;
            }
          }
        }

        if (isUitzondering) continue;

        detections.push({
          category: rule.category,
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          action: rule.action,
          reason: rule.reason,
          confidence: rule.confidence,
          method: 'regex',
          rule_ref: `pii-${rule.category}-v3.1`,
        });
      }
    }

    // Sort by position
    detections.sort((a, b) => a.start - b.start);

    return {
      ecli: '',
      rechtsgebied,
      detections,
      te_pseudonimiseren: detections.filter((d) => d.action === 'pseudonimiseer').length,
      niet_pseudonimiseren: detections.filter((d) => d.action === 'niet_pseudonimiseer').length,
      handmatige_controle: detections.filter((d) => d.action === 'handmatige_controle').length,
    };
  }

  /**
   * Get engine version.
   */
  getVersion(): string {
    return '3.1.0-djimflo';
  }
}
