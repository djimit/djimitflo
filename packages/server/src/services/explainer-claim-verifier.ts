/**
 * ExplainerClaimVerifier — P1: claim-level source resolution for the
 * hallucination critic. Extracts citation claims (file:line refs, graph node
 * ids, README headings) from authored sections and verifies that each
 * resolves against the bundle's own facts.json / file system. Follows the
 * claim-extract → source-resolve → verify pattern from NLI-based
 * hallucination detection research (claim grounding instead of keyword
 * matching).
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import type { ExplainerFact } from '@djimitflo/shared';

export interface ClaimVerification {
  claim: string;
  citation: string | null;
  resolved: boolean;
  reason: string;
}

export interface ClaimVerificationReport {
  checked: number;
  resolved: number;
  unresolved: ClaimVerification[];
  grounding_ratio: number;
}

const FILE_LINE_RE = /([\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|md|json|ya?ml)):(\d+)(?:-(\d+))?/g;
const GRAPH_NODE_RE = /graph:(community|hub|bridge|flow):([\w -]+)/g;
const FACT_ID_RE = /\[fact-(\d+)\]/g;

export class ExplainerClaimVerifier {
  /**
   * Verify all citation claims in section content against known facts and
   * (when bundle paths are available) the actual file system.
   */
  verify(
    sections: Record<string, string>,
    facts: ExplainerFact[],
    bundleBasePath?: string,
  ): ClaimVerificationReport {
    const factIds = new Set(facts.map((f) => f.id));
    const factSourceRefs = new Set(facts.map((f) => f.source_ref));
    const allClaims: ClaimVerification[] = [];

    for (const [sectionType, content] of Object.entries(sections)) {
      // 1. fact-id citations like [fact-3] must exist in facts.json
      for (const match of content.matchAll(FACT_ID_RE)) {
        const id = `fact-${match[1]}`;
        allClaims.push({
          claim: `[${id}] cited in ${sectionType}`,
          citation: id,
          resolved: factIds.has(id),
          reason: factIds.has(id) ? 'fact id present in bundle' : `fact id ${id} not found in facts.json`,
        });
      }

      // 2. file:line references must exist and line must be in range
      for (const match of content.matchAll(FILE_LINE_RE)) {
        const [, file, lineStr] = match;
        const line = Number(lineStr);
        const fact = facts.find((f) => f.file_path === file || f.source_ref === `${file}:${line}`);
        let resolved = Boolean(fact);
        let reason = fact ? 'matches cited fact' : 'no matching fact in facts.json';
        if (!resolved && bundleBasePath) {
          const abs = bundleBasePath.startsWith('/') ? join(dirname(bundleBasePath), file) : file;
          resolved = this.fileLineResolves(abs, file, line);
          reason = resolved ? 'file:line resolved on disk' : `file ${file}:${line} not verifiable`;
        }
        allClaims.push({ claim: `${file}:${line}`, citation: `${file}:${line}`, resolved, reason });
      }

      // 3. graph node citations like [graph:community:X]
      for (const match of content.matchAll(GRAPH_NODE_RE)) {
        const citation = match[0];
        allClaims.push({
          claim: citation,
          citation,
          resolved: factSourceRefs.has(citation) || Array.from(factSourceRefs).some((ref) => ref.startsWith(citation)),
          reason: 'graph node citation',
        });
      }
    }

    const unresolved = allClaims.filter((c) => !c.resolved);
    return {
      checked: allClaims.length,
      resolved: allClaims.length - unresolved.length,
      unresolved,
      grounding_ratio: allClaims.length === 0 ? 1 : (allClaims.length - unresolved.length) / allClaims.length,
    };
  }

  private fileLineResolves(absPath: string, file: string, line: number): boolean {
    // Try the absolute path, and fall back to locating the file in the cloned repo
    for (const candidate of [absPath, file, join(absPath, '..', file)]) {
      try {
        if (!existsSync(candidate) || !line || line < 1) continue;
        const content = readFileSync(candidate, 'utf8');
        const lineCount = content.split('\n').length;
        if (line <= lineCount + 5) return true; // small drift tolerance
      } catch {
        // try next candidate
      }
    }
    return false;
  }
}