/**
 * RechtsgebiedDetector — detect legal domain from ECLI identifier.
 *
 * ECLI format: ECLI:NL:<RECHTBANK>:<JAAR>:<NUMMER>
 * Examples:
 *   ECLI:NL:RBAMS:2026:1234 → Rechtbank Amsterdam → civiel/straf
 *   ECLI:NL:RVS:2026:5678 → Raad van State → bestuursrecht
 *   ECLI:NL:HR:2026:9012 → Hoge Raad → cassatie
 */

import type { Rechtsgebied } from './types';

const ECLI_RECHTSGEBIED_MAP: Record<string, Rechtsgebied> = {
  // Rechtbanken — civiel/straf (afhankelijk van afdeling)
  RBAMS: 'civiel',
  RBDHA: 'civiel',
  RBMNE: 'civiel',
  RBNHO: 'civiel',
  RBOBR: 'civiel',
  RBSGR: 'civiel',
  RBZLY: 'civiel',
  RBZUT: 'civiel',
  RBDOR: 'civiel',
  RBALK: 'civiel',
  RBGEL: 'civiel',
  RBONE: 'civiel',
  RBROE: 'civiel',
  RBSHE: 'civiel',
  RBTEN: 'civiel',
  RBZWB: 'civiel',
  // Bestuursrecht
  RVS: 'bestuursrecht',
  CBB: 'bestuursrecht',
  // Cassatie
  HR: 'cassatie',
  // Gerechtshoven
  GHAMS: 'cassatie',
  GHC: 'cassatie',
  GHARN: 'cassatie',
  GHSGR: 'cassatie',
  GHZNL: 'cassatie',
  // Speciaal
  CRVB: 'bestuursrecht',
  RVB: 'bestuursrecht',
};

export class RechtsgebiedDetector {
  /**
   * Detect legal domain from ECLI identifier.
   */
  detect(ecli: string): Rechtsgebied {
    if (!ecli?.trim()) return 'onbekend';

    const parts = ecli.trim().split(':');
    if (parts.length < 4) return 'onbekend';

    // ECLI:NL:<RECHTBANK>:<JAAR>:<NUMMER>
    const rechtbank = parts[2]?.toUpperCase();
    if (!rechtbank) return 'onbekend';

    return ECLI_RECHTSGEBIED_MAP[rechtbank] || 'onbekend';
  }

  /**
   * Get all ECLI codes for a legal domain.
   */
  getEcliCodesForDomain(domain: Rechtsgebied): string[] {
    return Object.entries(ECLI_RECHTSGEBIED_MAP)
      .filter(([, d]) => d === domain)
      .map(([code]) => code);
  }

  /**
   * Validate ECLI format.
   */
  validateEcli(ecli: string): { valid: boolean; error?: string } {
    if (!ecli?.trim()) return { valid: false, error: 'ECLI is required' };

    const pattern = /^ECLI:[A-Z]{2}:[A-Z]+:\d{4}:.+$/;
    if (!pattern.test(ecli.trim())) {
      return { valid: false, error: 'Invalid ECLI format. Expected: ECLI:NL:<RECHTBANK>:<JAAR>:<NUMMER>' };
    }

    return { valid: true };
  }
}
