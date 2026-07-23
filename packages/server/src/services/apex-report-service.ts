/**
 * ApexReportService — read-only ingestion of the OpenMythos APEX research
 * reports (APEX_R<round>_<SLUG>.md) so the benchmark program's provenance is
 * queryable from the platform instead of living only as markdown in a
 * sibling repo.
 *
 * Configure with OPENMYTHOS_REPORTS_PATH (the apex-runs reports directory).
 * Unset → empty listing. Formats vary across 40+ rounds, so parsing is
 * tolerant: round comes from the filename, title from the first heading,
 * decision from a `Decision: ...` line or a `## Decision` section when
 * present. A round may have several reports (e.g. R13/R14 reliability sets).
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface ApexReportSummary {
  round: number;
  file: string;
  title: string;
  decision: string | null;
  modifiedAt: string;
}

export interface ApexReport extends ApexReportSummary {
  body: string;
}

const FILE_PATTERN = /^APEX_R(\d+)_[\w-]+\.md$/;

export class ApexReportService {
  constructor(private reportsPath: string = process.env.OPENMYTHOS_REPORTS_PATH || '') {}

  private parseHeader(body: string): { title: string | null; decision: string | null } {
    const lines = body.split('\n', 60);
    let title: string | null = null;
    let decision: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!title && line.startsWith('# ')) title = line.slice(2).trim();
      if (!decision) {
        const inline = line.match(/^Decision:\s*`?([A-Za-z_-]+)`?/);
        if (inline) decision = inline[1];
        else if (/^##\s+Decision\b/.test(line)) {
          // first non-empty line of the Decision section
          for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j].trim();
            if (!next) continue;
            const word = next.match(/`?([A-Za-z_-]+)`?/);
            decision = word ? word[1] : null;
            break;
          }
        }
      }
      if (title && decision) break;
    }
    return { title, decision };
  }

  list(): ApexReportSummary[] {
    if (!this.reportsPath) return [];
    let entries: string[];
    try { entries = readdirSync(this.reportsPath); } catch { return []; }

    const summaries: ApexReportSummary[] = [];
    for (const file of entries) {
      const match = file.match(FILE_PATTERN);
      if (!match) continue;
      try {
        const path = join(this.reportsPath, file);
        const body = readFileSync(path, 'utf8');
        const { title, decision } = this.parseHeader(body);
        summaries.push({
          round: Number(match[1]),
          file,
          title: title ?? file.replace(/\.md$/, ''),
          decision,
          modifiedAt: statSync(path).mtime.toISOString(),
        });
      } catch { /* unreadable file — skip */ }
    }
    return summaries.sort((a, b) => b.round - a.round || a.file.localeCompare(b.file));
  }

  /** All reports for one round, with bodies. */
  get(round: number): ApexReport[] {
    return this.list()
      .filter((summary) => summary.round === round)
      .map((summary) => ({
        ...summary,
        body: readFileSync(join(this.reportsPath, summary.file), 'utf8'),
      }));
  }
}
