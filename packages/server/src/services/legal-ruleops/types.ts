/**
 * Legal RuleOps — core types for PII classification and anonymization.
 *
 * Based on OpenMythos V3.1 engine analysis and JREM schema.
 */

export type Rechtsgebied = 'civiel' | 'straf' | 'bestuursrecht' | 'familierecht' | 'arbeidsrecht' | 'cassatie' | 'onbekend';

export type PseudonimiseerActie = 'pseudonimiseer' | 'niet_pseudonimiseer' | 'handmatige_controle';

export type PIICategory =
  | 'naam' | 'adres' | 'geboortedatum' | 'bsn' | 'telefoon'
  | 'email' | 'rekeningnummer' | 'kenteken' | 'organisatie'
  | 'rechtspersoon' | 'overheid' | 'openbaar_lichaam' | 'professional';

export interface PIIDetection {
  category: PIICategory;
  text: string;
  start: number;
  end: number;
  action: PseudonimiseerActie;
  reason: string;
  confidence: number;
  method: 'regex' | 'context' | 'llm';
  rule_ref: string;
}

export interface ClassificatieResult {
  ecli: string;
  rechtsgebied: Rechtsgebied;
  detections: PIIDetection[];
  te_pseudonimiseren: number;
  niet_pseudonimiseren: number;
  handmatige_controle: number;
}

export interface AnonimisatieResult {
  ecli: string;
  original_text: string;
  geanonimiseerde_text: string;
  classificaties: ClassificatieResult;
  rapport: {
    regels: string[];
    bronverwijzingen: string[];
    warnings: string[];
  };
  metadata: {
    processed_at: string;
    engine_version: string;
    rechtsgebied: string;
  };
}

export interface FeedbackEntry {
  id: string;
  ecli: string;
  detection_index: number;
  original_action: PseudonimiseerActie;
  corrected_action: PseudonimiseerActie;
  reason: string;
  corrected_by: string;
  created_at: string;
  applied: boolean;
}

export interface RegelSpraakRegel {
  id: string;
  naam: string;
  pattern: string;
  actie: PseudonimiseerActie;
  uitzonderingen: string[];
  rechtsgebieden: Rechtsgebied[];
  bronverwijzing: string;
  confidence_threshold: number;
}
