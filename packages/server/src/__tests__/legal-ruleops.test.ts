import { describe, it, expect, beforeEach } from 'vitest';
import { RechtsgebiedDetector } from '../services/legal-ruleops/rechtsgebied-detector';
import { PIIClassificationEngine } from '../services/legal-ruleops/pii-classification-engine';
import { AnonimisatieService } from '../services/legal-ruleops/anonimisatie-service';
import { LegalRuleService } from '../services/legal-ruleops/rule-service';
import Database from 'better-sqlite3';

describe('RechtsgebiedDetector', () => {
  let detector: RechtsgebiedDetector;

  beforeEach(() => {
    detector = new RechtsgebiedDetector();
  });

  it('detects civiel from ECLI', () => {
    expect(detector.detect('ECLI:NL:RBAMS:2026:1234')).toBe('civiel');
  });

  it('detects bestuursrecht from ECLI', () => {
    expect(detector.detect('ECLI:NL:RVS:2026:5678')).toBe('bestuursrecht');
  });

  it('detects cassatie from ECLI', () => {
    expect(detector.detect('ECLI:NL:HR:2026:9012')).toBe('cassatie');
  });

  it('returns onbekend for invalid ECLI', () => {
    expect(detector.detect('INVALID')).toBe('onbekend');
  });

  it('returns onbekend for empty ECLI', () => {
    expect(detector.detect('')).toBe('onbekend');
  });

  it('validates correct ECLI format', () => {
    const result = detector.validateEcli('ECLI:NL:RBAMS:2026:1234');
    expect(result.valid).toBe(true);
  });

  it('rejects invalid ECLI format', () => {
    const result = detector.validateEcli('not-an-ecli');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('PIIClassificationEngine', () => {
  let engine: PIIClassificationEngine;

  beforeEach(() => {
    engine = new PIIClassificationEngine();
  });

  it('detects BSN', () => {
    const result = engine.classify('De BSN is 123456789', 'civiel');
    expect(result.detections.some((d) => d.category === 'bsn')).toBe(true);
  });

  it('detects email', () => {
    const result = engine.classify('Contact: john@example.com', 'civiel');
    expect(result.detections.some((d) => d.category === 'email')).toBe(true);
  });

  it('detects phone number', () => {
    const result = engine.classify('Bel 0612345678', 'civiel');
    expect(result.detections.some((d) => d.category === 'telefoon')).toBe(true);
  });

  it('does NOT pseudonymize legal professionals', () => {
    const result = engine.classify('De advocaat heeft verzonden', 'civiel');
    const profDetection = result.detections.find((d) => d.category === 'professional');
    if (profDetection) {
      expect(profDetection.action).toBe('niet_pseudonimiseer');
    }
  });

  it('does NOT pseudonymize government entities', () => {
    const result = engine.classify('Het Openbaar Ministerie heeft aangegeven', 'civiel');
    const govDetection = result.detections.find((d) => d.category === 'overheid');
    if (govDetection) {
      expect(govDetection.action).toBe('niet_pseudonimiseer');
    }
  });

  it('counts detections correctly', () => {
    const text = 'De BSN is 123456789 en email is test@example.com';
    const result = engine.classify(text, 'civiel');
    expect(result.te_pseudonimiseren).toBeGreaterThanOrEqual(2);
  });

  it('returns engine version', () => {
    expect(engine.getVersion()).toBe('3.1.0-djimflo');
  });
});

describe('AnonimisatieService', () => {
  let service: AnonimisatieService;

  beforeEach(() => {
    service = new AnonimisatieService();
  });

  it('anonymizes BSN with token', () => {
    const result = service.anonymize('De BSN is 123456789', 'ECLI:NL:RBAMS:2026:1234');
    expect(result.geanonimiseerde_text).toContain('[BSN]');
    expect(result.geanonimiseerde_text).not.toContain('123456789');
  });

  it('anonymizes email with token', () => {
    const result = service.anonymize('Contact: john@example.com', 'ECLI:NL:RBAMS:2026:1234');
    expect(result.geanonimiseerde_text).toContain('[EMAIL]');
    expect(result.geanonimiseerde_text).not.toContain('john@example.com');
  });

  it('leaves professionals untouched', () => {
    const result = service.anonymize('De advocaat heeft verzonden', 'ECLI:NL:RBAMS:2026:1234');
    expect(result.geanonimiseerde_text).toContain('advocaat');
  });

  it('marks manual review items', () => {
    const result = service.anonymize('Adres is Kalverstraat 123', 'ECLI:NL:RBAMS:2026:1234');
    expect(result.geanonimiseerde_text).toContain('[CONTROLEER: adres]');
  });

  it('generates report with rules and bronverwijzingen', () => {
    const result = service.anonymize('De BSN is 123456789', 'ECLI:NL:RBAMS:2026:1234');
    expect(result.rapport.regels.length).toBeGreaterThan(0);
    expect(result.rapport.bronverwijzingen.length).toBeGreaterThan(0);
  });

  it('includes metadata', () => {
    const result = service.anonymize('Test text', 'ECLI:NL:RBAMS:2026:1234');
    expect(result.metadata.engine_version).toBe('3.1.0-djimflo');
    expect(result.metadata.rechtsgebied).toBeDefined();
    expect(result.metadata.processed_at).toBeDefined();
  });
});

describe('LegalRuleService', () => {
  let db: Database.Database;
  let service: LegalRuleService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE governance_feedback (
        id TEXT PRIMARY KEY, source TEXT, category TEXT, original_decision TEXT,
        corrected_decision TEXT, reason TEXT, confidence REAL, applied INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    service = new LegalRuleService(db);
  });

  it('checks PII with ECLI and text', () => {
    const result = service.checkPII({
      ecli: 'ECLI:NL:RBAMS:2026:1234',
      bodyText: 'De BSN is 123456789 en email is john@example.com',
    });
    expect(result.ecli).toBe('ECLI:NL:RBAMS:2026:1234');
    expect(result.classificaties.te_pseudonimiseren).toBeGreaterThanOrEqual(2);
  });

  it('auto-detects rechtsgebied from ECLI', () => {
    const result = service.checkPII({
      ecli: 'ECLI:NL:RVS:2026:5678',
      bodyText: 'Test text',
    });
    expect(result.metadata.rechtsgebied).toBe('bestuursrecht');
  });

  it('rejects invalid ECLI', () => {
    expect(() => service.checkPII({
      ecli: 'invalid',
      bodyText: 'Test',
    })).toThrow();
  });

  it('classifies only without anonymization', () => {
    const result = service.classifyOnly({
      text: 'De BSN is 123456789',
      rechtsgebied: 'civiel',
    });
    expect(result.detections.length).toBeGreaterThan(0);
  });

  it('detects rechtsgebied', () => {
    expect(service.detectRechtsgebied('ECLI:NL:HR:2026:9012')).toBe('cassatie');
  });

  it('submits feedback', () => {
    const entry = service.submitFeedback({
      ecli: 'ECLI:NL:RBAMS:2026:1234',
      detection_index: 0,
      original_action: 'pseudonimiseer',
      corrected_action: 'niet_pseudonimiseer',
      reason: 'This is a public professional',
      corrected_by: 'test-jurist',
    });
    expect(entry.id).toBeDefined();
    expect(entry.applied).toBe(false);
  });

  it('provides status', () => {
    const status = service.getStatus();
    expect(status.engine_version).toBe('3.1.0-djimflo');
    expect(status.rechtsgebieden.length).toBeGreaterThan(0);
  });
});
