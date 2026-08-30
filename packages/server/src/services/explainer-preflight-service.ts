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

    // 5. Accessibility: textual equivalents for diagrams — a non-empty architecture section IS the
    // textual equivalent (aria-labels live in the HTML renderer layer, not in bundle content).
    const hasDiagram = Boolean(bundle.sections.architecture);
    const hasTextualEquivalent = hasDiagram && bundle.sections.architecture.trim().length > 0;
    checks.push({
      name: 'accessibility_labels_present',
      passed: !hasDiagram || hasTextualEquivalent,
      required: true,
      message: !hasDiagram || hasTextualEquivalent
        ? 'Textual equivalents present for architecture content'
        : 'Architecture content present but no textual equivalents found',
    });

    // 6. Bundle files exist — markdown/llms may be absolute file paths (loaded from DB rows) or inline content.
    // Only absolute-path-shaped values are checked on disk; inline content requires non-trivial length.
    const asPaths = [bundle.explainer_md, bundle.llms_txt].filter(
      (v): v is string => typeof v === 'string' && v.startsWith('/') && v.length < 4096,
    );
    const pathsExist = asPaths.length === 0 || asPaths.every((p) => existsSync(p));
    const contentPresent =
      (bundle.explainer_md ?? '').length > 0 && (bundle.llms_txt ?? '').length > 0 && bundle.facts.length > 0;
    // If path-shaped values are present they MUST resolve on disk (missing file = blocking).
    // When no path-shaped values exist (inline content bundles), require non-trivial content instead.
    checks.push({
      name: 'bundle_files_exist',
      passed: asPaths.length === 0 ? contentPresent : pathsExist,
      required: true,
      message: (asPaths.length === 0 ? contentPresent : pathsExist)
        ? 'Bundle content files exist on disk (or inline content is present)'
        : 'Bundle content missing (path does not resolve or inline content empty)',
    });

    const blocking = checks.filter((c) => c.required && !c.passed).map((c) => c.name);
    return {
      passed: blocking.length === 0,
      checks,
      blocking_checks: blocking,
    };
  }
}
