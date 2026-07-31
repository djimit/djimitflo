/**
 * ExplainerPreflightService — validates a bundle before publication.
 *
 * Checks the mandatory pre-flight items required by SC-003:
 * - OpenMythos score >= threshold
 * - Secret scan clean
 * - Fact citations verified
 * - License footer present
 * - Accessibility labels present (static validation)
 * - Bundle files exist
 */

import { existsSync, readFileSync } from 'fs';
import type { ExplainerBundleContent, ExplainerCriticResult } from '@djimitflo/shared';

export interface PreflightCheck {
  name: string;
  passed: boolean;
  required: boolean;
  message: string;
}

export interface PreflightReport {
  passed: boolean;
  checks: PreflightCheck[];
  blocking_checks: string[];
}

export class ExplainerPreflightService {
  constructor(private openmythosThreshold = 85, private minFacts = 5) {}

  check(bundle: ExplainerBundleContent, critic: ExplainerCriticResult, secretScanFindings: string[]): PreflightReport {
    const checks: PreflightCheck[] = [];

    // 1. OpenMythos score
    const score = critic.overall_score;
    checks.push({
      name: 'openmythos_score',
      passed: score >= this.openmythosThreshold,
      required: true,
      message: score >= this.openmythosThreshold
        ? `OpenMythos score ${score} meets threshold ${this.openmythosThreshold}`
        : `OpenMythos score ${score} below threshold ${this.openmythosThreshold}`,
    });

    // 2. Secret scan clean
    checks.push({
      name: 'secret_scan_clean',
      passed: secretScanFindings.length === 0,
      required: true,
      message: secretScanFindings.length === 0
        ? 'No secrets detected in cloned repository'
        : `${secretScanFindings.length} secret finding(s) detected; redaction required`,
    });

    // 3. Fact citations
    const validFacts = bundle.facts.filter((f) => f.source_ref && f.source_ref.trim().length > 0);
    checks.push({
      name: 'fact_citations_verified',
      passed: validFacts.length >= this.minFacts,
      required: true,
      message: validFacts.length >= this.minFacts
        ? `${validFacts.length} cited facts meet minimum ${this.minFacts}`
        : `Only ${validFacts.length} valid cited facts; minimum ${this.minFacts} required`,
    });

    // 4. License footer
    const fileContents = [bundle.explainer_md, bundle.llms_txt]
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => {
        try {
          return readFileSync(p, 'utf-8');
        } catch {
          return '';
        }
      });
    const sectionContents = Object.values(bundle.sections ?? {});
    const allText = [...fileContents, ...sectionContents].join('\n').toLowerCase();
    const licensePresent = /licensed under|license|mit|apache|gpl|bsd/.test(allText);
    checks.push({
      name: 'license_footer_present',
      passed: licensePresent,
      required: true,
      message: licensePresent
        ? 'License attribution present in generated content'
        : 'License attribution missing from generated content',
    });

    // 5. Accessibility labels
    const hasDiagram = allText.includes('architecture') || bundle.sections.architecture;
    const hasAriaHint = allText.includes('aria-label') || allText.includes('aria-describedby');
    checks.push({
      name: 'accessibility_labels_present',
      passed: !hasDiagram || hasAriaHint,
      required: true,
      message: !hasDiagram || hasAriaHint
        ? 'Accessibility labels present for diagrams'
        : 'Architecture content present but no accessibility labels found',
    });

    // 6. Bundle files exist
    const paths = [
      bundle.manifest,
      bundle.explainer_md,
      bundle.llms_txt,
      bundle.facts,
    ]
      .filter(Boolean)
      .map((p) => (typeof p === 'string' ? p : ''))
      .filter(Boolean);
    const allPathsExist = paths.length > 0 && paths.every((p) => existsSync(p));
    checks.push({
      name: 'bundle_files_exist',
      passed: allPathsExist,
      required: true,
      message: allPathsExist
        ? 'Bundle content files exist on disk'
        : 'One or more bundle content files are missing',
    });

    const blocking = checks.filter((c) => c.required && !c.passed).map((c) => c.name);
    return {
      passed: blocking.length === 0,
      checks,
      blocking_checks: blocking,
    };
  }
}
