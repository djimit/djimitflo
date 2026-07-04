/**
 * AnonimisatieService — end-to-end PII anonymization pipeline.
 *
 * Pipeline: text → classify → per-detection decision → anonymized text + report
 *
 * Based on OpenMythos deep improvement analysis:
 * - "pseudonimiseer" → replace with token ([geboortedatum], [adres], etc.)
 * - "niet_pseudonimiseer" → leave untouched
 * - "handmatige_controle" → mark with [CONTROLEER: type]
 */

import type { AnonimisatieResult, ClassificatieResult } from './types';
import { PIIClassificationEngine } from './pii-classification-engine';

function getPiiTokens(): Record<string, string> {
  return {
    naam: '[NAAM]',
    adres: '[ADRES]',
    geboortedatum: '[GEBOORTEDATUM]',
    bsn: '[BSN]',
    telefoon: '[TELEFOON]',
    email: '[EMAIL]',
    rekeningnummer: '[REKENINGNUMMER]',
    kenteken: '[KENTEKEN]',
    organisatie: '[ORGANISATIE]',
    rechtspersoon: '[RECHTSPERSOON]',
    overheid: '[OVERHEID]',
    openbaar_lichaam: '[OPENBAAR_LICHAAM]',
    professional: '[PROFESSIONAL]',
  };
}

export class AnonimisatieService {
  private engine: PIIClassificationEngine;

  constructor() {
    this.engine = new PIIClassificationEngine();
  }

  /**
   * Full anonymization pipeline.
   */
  anonymize(text: string, ecli: string, rechtsgebied: any = 'civiel'): AnonimisatieResult {
    // Step 1: Classify
    const classificatie = this.engine.classify(text, rechtsgebied as any);
    classificatie.ecli = ecli;

    // Step 2: Anonymize based on classifications
    let anonymizedText = text;
    const warnings: string[] = [];

    // Process detections in reverse order to preserve offsets
    const sortedDetections = [...classificatie.detections].sort((a, b) => b.start - a.start);

    for (const detection of sortedDetections) {
      const tokens = getPiiTokens();
      const token = tokens[detection.category] || `[${detection.category.toUpperCase()}]`;

      switch (detection.action) {
        case 'pseudonimiseer':
          anonymizedText = anonymizedText.slice(0, detection.start) + token + anonymizedText.slice(detection.end);
          break;
        case 'handmatige_controle':
          anonymizedText = anonymizedText.slice(0, detection.end) + ` [CONTROLEER: ${detection.category}]` + anonymizedText.slice(detection.end);
          warnings.push(`Manual review needed: "${detection.text}" (${detection.category})`);
          break;
        case 'niet_pseudonimiseer':
          // Leave untouched
          break;
      }
    }

    return {
      ecli,
      original_text: text,
      geanonimiseerde_text: anonymizedText,
      classificaties: classificatie,
      rapport: {
        regels: this.getAppliedRules(classificatie),
        bronverwijzingen: this.getBronverwijzingen(classificatie),
        warnings,
      },
      metadata: {
        processed_at: new Date().toISOString(),
        engine_version: this.engine.getVersion(),
        rechtsgebied: rechtsgebied,
      },
    };
  }

  private getAppliedRules(classificatie: ClassificatieResult): string[] {
    return [...new Set(classificatie.detections.map((d) => d.rule_ref))];
  }

  private getBronverwijzingen(classificatie: ClassificatieResult): string[] {
    return [...new Set(classificatie.detections.map((d) => d.reason))] as string[];
  }
}
