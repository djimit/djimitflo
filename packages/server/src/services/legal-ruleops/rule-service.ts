/**
 * LegalRuleService — main service orchestrating PII classification and anonymization.
 *
 * Exposes the UC-06: Publicatie Rule Service endpoint:
 * POST /api/legal/check-pii → classify + anonymize + report
 */

import type { AnonimisatieResult, ClassificatieResult, FeedbackEntry, Rechtsgebied } from './types';
import { RechtsgebiedDetector } from './rechtsgebied-detector';
import { PIIClassificationEngine } from './pii-classification-engine';
import { AnonimisatieService } from './anonimisatie-service';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export class LegalRuleService {
  private rechtsgebiedDetector: RechtsgebiedDetector;
  private classificationEngine: PIIClassificationEngine;
  private anonymizationService: AnonimisatieService;

  constructor(private db: Database) {
    this.rechtsgebiedDetector = new RechtsgebiedDetector();
    this.classificationEngine = new PIIClassificationEngine();
    this.anonymizationService = new AnonimisatieService();
  }

  /**
   * Check PII in a legal text (UC-06: Publicatie Rule Service).
   */
  checkPII(input: {
    ecli: string;
    bodyText: string;
    rechtsgebied?: Rechtsgebied;
  }): AnonimisatieResult {
    const validation = this.rechtsgebiedDetector.validateEcli(input.ecli);
    if (!validation.valid) throw new Error(validation.error);

    const rechtsgebied = (input.rechtsgebied || this.rechtsgebiedDetector.detect(input.ecli)) as any;

    return this.anonymizationService.anonymize(input.bodyText, input.ecli, rechtsgebied);
  }

  /**
   * Classify only (no anonymization).
   */
  classifyOnly(input: {
    text: string;
    rechtsgebied?: Rechtsgebied;
  }): ClassificatieResult {
    return this.classificationEngine.classify(input.text, input.rechtsgebied || 'civiel');
  }

  /**
   * Detect rechtsgebied from ECLI.
   */
  detectRechtsgebied(ecli: string): Rechtsgebied {
    return this.rechtsgebiedDetector.detect(ecli);
  }

  /**
   * Submit feedback on a classification (C6: feedback loop).
   */
  submitFeedback(input: {
    ecli: string;
    detection_index: number;
    original_action: string;
    corrected_action: string;
    reason: string;
    corrected_by: string;
  }): FeedbackEntry {
    const entry: FeedbackEntry = {
      id: randomUUID(),
      ecli: input.ecli,
      detection_index: input.detection_index,
      original_action: input.original_action as FeedbackEntry['original_action'],
      corrected_action: input.corrected_action as FeedbackEntry['corrected_action'],
      reason: input.reason,
      corrected_by: input.corrected_by,
      created_at: new Date().toISOString(),
      applied: false,
    };

    this.db.prepare(`
      INSERT INTO governance_feedback (id, source, category, original_decision, corrected_decision, reason, confidence, created_at)
      VALUES (?, 'human_correction', 'legal-pii', ?, ?, ?, 1.0, ?)
    `).run(entry.id, entry.original_action, entry.corrected_action, entry.reason, entry.created_at);

    return entry;
  }

  /**
   * Get service status.
   */
  getStatus(): {
    engine_version: string;
    rechtsgebieden: string[];
    feedback_count: number;
  } {
    const feedbackCount = (this.db.prepare("SELECT COUNT(*) as c FROM governance_feedback WHERE source = 'human_correction'").get() as any)?.c || 0;

    return {
      engine_version: this.classificationEngine.getVersion(),
      rechtsgebieden: ['civiel', 'straf', 'bestuursrecht', 'familierecht', 'arbeidsrecht', 'cassatie'],
      feedback_count: feedbackCount,
    };
  }
}
