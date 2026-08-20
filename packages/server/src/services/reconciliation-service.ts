/**
 * ReconciliationService — the system stops lying to itself.
 *
 * The self-improvement machinery generates claims (GitHub issues, findings)
 * but nothing ever re-verifies them against current source, so fixed problems
 * stay "open" and poison downstream reasoning (issues #30–#37 were all stale
 * by 2026-07-15 while the code had long been fixed). This service re-verifies
 * each claim with a cheap local check, reports which are stale, optionally
 * closes stale GitHub issues with an evidence comment, and records generator
 * precision over time.
 *
 * Claim checkers (keyed to the generator's issue-title templates):
 *   loc           — "[Refactor] Reduce complexity in <file.ts> (<N> LOC)"
 *   test-coverage — "[Test Coverage] Add tests for <target>"
 *   exec-timeout  — "[Security] execSync calls without timeout"
 * Anything else is reported as unverifiable and left alone.
 *
 * GitHub apply needs GITHUB_TOKEN + GITHUB_REPOSITORY (owner/repo); without
 * them reconcile() still produces the report. Default is report-only —
 * closing requires apply: true.
 *
 * Nightly cadence (default-off, same pattern as the eval scheduler):
 *   RECONCILIATION_NIGHTLY_ENABLED=true
 *   RECONCILIATION_NIGHTLY_HOUR=4       (server-local hour, default 4)
 *   RECONCILIATION_NIGHTLY_APPLY=true   (optional; default report-only)
 * One GitHub reconciliation per UTC day, deduped against reconciliation_runs.
 */

import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import type { Database } from 'better-sqlite3';

export interface ClaimVerdict {
  claim: string;
  issueNumber: number | null;
  checker: 'loc' | 'test-coverage' | 'exec-timeout' | 'unverifiable';
  stillValid: boolean | null; // null = unverifiable
  evidence: string;
}

export interface ReconciliationReport {
  id: string;
  source: string;
  totalClaims: number;
  staleClaims: number;
  validClaims: number;
  unverifiableClaims: number;
  /** Of the verifiable claims, the fraction that still hold — the generator's precision. */
  generatorPrecision: number | null;
  applied: boolean;
  closedIssues: number[];
  verdicts: ClaimVerdict[];
  createdAt: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ReconciliationService {
  constructor(
    private db: Database,
    // ponytail: __dirname-anchored, not cwd — the server may be launched from anywhere
    private repoRoot: string = join(__dirname, '..', '..', '..', '..'),
    private fetchImpl: FetchLike = fetch,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reconciliation_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        total_claims INTEGER NOT NULL DEFAULT 0,
        stale_claims INTEGER NOT NULL DEFAULT 0,
        valid_claims INTEGER NOT NULL DEFAULT 0,
        unverifiable_claims INTEGER NOT NULL DEFAULT 0,
        applied INTEGER NOT NULL DEFAULT 0,
        closed_issues_json TEXT NOT NULL DEFAULT '[]',
        verdicts_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  // ── claim checkers ──────────────────────────────────────────────────────

  private findFileByBasename(name: string): string | null {
    const roots = [join(this.repoRoot, 'packages')];
    const stack = [...roots];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist' && !entry.name.startsWith('.')) {
            stack.push(join(dir, entry.name));
          }
        } else if (entry.name === name) {
          return join(dir, entry.name);
        }
      }
    }
    return null;
  }

  private checkLocClaim(claim: string): ClaimVerdict | null {
    const match = claim.match(/\bin\s+([\w./-]+\.ts)\s*\((\d+)\s*LOC\)/i);
    if (!match) return null;
    const fileName = basename(match[1]);
    const claimedLoc = Number(match[2]);
    const path = this.findFileByBasename(fileName);
    if (!path) {
      return { claim, issueNumber: null, checker: 'loc', stillValid: false, evidence: `${fileName} no longer exists in the repo` };
    }
    const actualLoc = readFileSync(path, 'utf8').split('\n').length;
    const stillValid = actualLoc >= claimedLoc * 0.8;
    return {
      claim, issueNumber: null, checker: 'loc', stillValid,
      evidence: `${fileName} is now ${actualLoc} LOC (claim said ${claimedLoc})${stillValid ? '' : ' — materially reduced, claim is stale'}`,
    };
  }

  private listTestFiles(): string[] {
    const dir = join(this.repoRoot, 'packages', 'server', 'src', '__tests__');
    try { return readdirSync(dir).filter((f) => f.endsWith('.test.ts')); } catch { return []; }
  }

  private checkTestCoverageClaim(claim: string): ClaimVerdict | null {
    // Linear string ops instead of regex — claims are user-provided (ReDoS).
    const lower = claim.toLowerCase();
    if (!lower.includes('[test coverage]')) return null;
    const marker = ['add tests for ', 'add test for '].find((m) => lower.includes(m));
    if (!marker) return null;
    const target = claim.slice(lower.indexOf(marker) + marker.length).trim();
    if (!target) return null;
    const testFiles = this.listTestFiles();

    // Significant words of the target ("execution-engine.ts" → execution-engine; "middleware layer" → middleware)
    const words = target.toLowerCase().replace(/\.ts$/, '').split(/[\s/]+/)
      .filter((w) => w.length > 3 && !['layer', 'implementations', 'database'].includes(w));
    const matches = testFiles.filter((f) => words.some((w) => f.toLowerCase().includes(w.replace(/s$/, ''))));

    if (matches.length > 0) {
      return {
        claim, issueNumber: null, checker: 'test-coverage', stillValid: false,
        evidence: `tests exist: ${matches.slice(0, 5).join(', ')}`,
      };
    }
    return { claim, issueNumber: null, checker: 'test-coverage', stillValid: true, evidence: `no test file matches '${target}'` };
  }

  private checkExecTimeoutClaim(claim: string): ClaimVerdict | null {
    // Linear string ops instead of regex — claims are user-provided (ReDoS).
    const lower = claim.toLowerCase();
    if (!lower.includes('execsync')) return null;
    if (!lower.includes('without timeout') && !lower.includes('[security]')) return null;
    const servicesDir = join(this.repoRoot, 'packages', 'server', 'src', 'services');
    const unsafe: string[] = [];
    let total = 0;
    let files: string[] = [];
    try { files = readdirSync(servicesDir).filter((f) => f.endsWith('.ts')); } catch { /* no dir */ }
    for (const file of files) {
      const lines = readFileSync(join(servicesDir, file), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('execSync(')) continue;
        total++;
        const window = lines.slice(i, i + 5).join('\n');
        if (!/timeout/i.test(window)) unsafe.push(`${file}:${i + 1}`);
      }
    }
    const stillValid = unsafe.length > 0;
    return {
      claim, issueNumber: null, checker: 'exec-timeout', stillValid,
      evidence: stillValid
        ? `${unsafe.length}/${total} execSync call sites lack a timeout: ${unsafe.slice(0, 5).join(', ')}`
        : `all ${total} execSync call sites carry a timeout`,
    };
  }

  verifyClaim(claim: string): ClaimVerdict {
    return this.checkLocClaim(claim)
      ?? this.checkTestCoverageClaim(claim)
      ?? this.checkExecTimeoutClaim(claim)
      ?? { claim, issueNumber: null, checker: 'unverifiable', stillValid: null, evidence: 'no checker matches this claim' };
  }

  // ── reconciliation ──────────────────────────────────────────────────────

  reconcile(claims: Array<{ title: string; issueNumber?: number }>, source = 'manual'): ReconciliationReport {
    const verdicts = claims.map((c) => ({ ...this.verifyClaim(c.title), issueNumber: c.issueNumber ?? null }));
    return this.persistReport(verdicts, source, false, []);
  }

  /**
   * Reconcile open auto-generated GitHub issues. Report-only unless apply
   * is true AND GITHUB_TOKEN is set; then stale issues get an evidence
   * comment and are closed as not_planned.
   */
  async reconcileGitHub(options: { apply?: boolean; label?: string } = {}): Promise<ReconciliationReport> {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    if (!repo) throw new Error('GITHUB_REPOSITORY_REQUIRED');
    if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');
    const label = options.label ?? 'auto-generated';

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
    const listResponse = await this.fetchImpl(
      `https://api.github.com/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
      { headers },
    );
    if (!listResponse.ok) throw new Error(`GITHUB_LIST_FAILED:${listResponse.status}`);
    const issues = await listResponse.json() as Array<{ number: number; title: string; pull_request?: unknown }>;

    const verdicts: ClaimVerdict[] = issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({ ...this.verifyClaim(issue.title), issueNumber: issue.number }));

    const closed: number[] = [];
    if (options.apply) {
      for (const verdict of verdicts) {
        if (verdict.stillValid !== false || verdict.issueNumber === null) continue;
        const body = `Reconciliation (${new Date().toISOString().slice(0, 10)}): this claim no longer holds against current source.\n\n**Evidence:** ${verdict.evidence}\n\nClosed automatically by the DjimFlo reconciliation service.`;
        await this.fetchImpl(`https://api.github.com/repos/${repo}/issues/${verdict.issueNumber}/comments`, {
          method: 'POST', headers, body: JSON.stringify({ body }),
        });
        const closeResponse = await this.fetchImpl(`https://api.github.com/repos/${repo}/issues/${verdict.issueNumber}`, {
          method: 'PATCH', headers, body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
        });
        if (closeResponse.ok) closed.push(verdict.issueNumber);
      }
    }

    return this.persistReport(verdicts, `github:${repo}`, Boolean(options.apply), closed);
  }

  private persistReport(verdicts: ClaimVerdict[], source: string, applied: boolean, closedIssues: number[]): ReconciliationReport {
    const stale = verdicts.filter((v) => v.stillValid === false).length;
    const valid = verdicts.filter((v) => v.stillValid === true).length;
    const unverifiable = verdicts.filter((v) => v.stillValid === null).length;
    const verifiable = stale + valid;

    const report: ReconciliationReport = {
      id: randomUUID(),
      source,
      totalClaims: verdicts.length,
      staleClaims: stale,
      validClaims: valid,
      unverifiableClaims: unverifiable,
      generatorPrecision: verifiable > 0 ? Number((valid / verifiable).toFixed(3)) : null,
      applied,
      closedIssues,
      verdicts,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO reconciliation_runs (id, source, total_claims, stale_claims, valid_claims, unverifiable_claims, applied, closed_issues_json, verdicts_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(report.id, source, report.totalClaims, stale, valid, unverifiable, applied ? 1 : 0,
      JSON.stringify(closedIssues), JSON.stringify(verdicts), report.createdAt);

    return report;
  }

  // ── nightly cadence ─────────────────────────────────────────────────────

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Arm the hourly scheduler. Returns false (no-op) unless explicitly enabled. */
  start(): boolean {
    if (process.env.RECONCILIATION_NIGHTLY_ENABLED !== 'true') return false;
    if (!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_TOKEN) {
      console.warn('Reconciliation nightly: enabled but GITHUB_REPOSITORY/GITHUB_TOKEN missing — not arming');
      return false;
    }
    this.timer = setInterval(() => void this.tick(), 60 * 60 * 1000);
    this.timer.unref();
    void this.tick(); // catch-up on boot
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  targetHour(): number {
    const hour = Number(process.env.RECONCILIATION_NIGHTLY_HOUR ?? '4');
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 4;
  }

  /** Due when past the target hour and no GitHub reconciliation ran today (UTC). */
  shouldRun(now: Date = new Date()): boolean {
    if (now.getHours() < this.targetHour()) return false;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM reconciliation_runs
      WHERE source LIKE 'github:%' AND substr(created_at, 1, 10) = date('now')
    `).get() as { n: number };
    return row.n === 0;
  }

  async tick(now: Date = new Date()): Promise<ReconciliationReport | null> {
    if (!this.shouldRun(now)) return null;
    try {
      const apply = process.env.RECONCILIATION_NIGHTLY_APPLY === 'true';
      const report = await this.reconcileGitHub({ apply });
      console.log(`Reconciliation nightly: ${report.totalClaims} claims → ${report.staleClaims} stale, precision ${report.generatorPrecision ?? 'n/a'}${apply ? `, closed ${report.closedIssues.length}` : ' (report-only)'}`);
      return report;
    } catch (error) {
      console.error('Reconciliation nightly failed —', error instanceof Error ? error.message : error);
      return null;
    }
  }

  latestReport(): ReconciliationReport | null {
    const row = this.db.prepare('SELECT * FROM reconciliation_runs ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      source: row.source as string,
      totalClaims: row.total_claims as number,
      staleClaims: row.stale_claims as number,
      validClaims: row.valid_claims as number,
      unverifiableClaims: row.unverifiable_claims as number,
      generatorPrecision: (row.stale_claims as number) + (row.valid_claims as number) > 0
        ? Number(((row.valid_claims as number) / ((row.stale_claims as number) + (row.valid_claims as number))).toFixed(3))
        : null,
      applied: Boolean(row.applied),
      closedIssues: JSON.parse((row.closed_issues_json as string) || '[]'),
      verdicts: JSON.parse((row.verdicts_json as string) || '[]'),
      createdAt: row.created_at as string,
    };
  }
}
