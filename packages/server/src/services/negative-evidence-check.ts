import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * K3 (NE_GENERATOR_CHECK_MODE, default off): the negative-evidence registry (docs/research/negative-evidence) was recorded
 * but no generator read it, so a falsified idea could be proposed again. At proposal creation, dream mutant generation and
 * discovery unit admission the generated text is matched against the registry; under `shadow` every match is recorded as a
 * `negative_evidence_match` judgment with the entry id and its reopen condition. Nothing is ever blocked or altered.
 *
 * Matching is deliberately narrow (a lexical match risks false positives): an entry's `forbidden_code_patterns` match as an
 * exact, case-sensitive substring (confidence `exact_pattern`); its optional `match_terms` (distinctive dependency or
 * repository names, populated conservatively) match case-insensitively on word boundaries (confidence `keyword`). The
 * patterns are read from the registry at runtime — never written into the server source (the B29 guard forbids them there).
 */
export type NeCheckMode = 'off' | 'shadow';
export type NeSource = 'proposal' | 'dream_mutant' | 'discovery_unit';
export interface NeEntry { id: string; verdict: string; reopen_condition: string; forbidden_code_patterns?: string[]; match_terms?: string[] }
export interface NeMatch { entry_id: string; verdict: string; matched: string; confidence: 'exact_pattern' | 'keyword'; reopen_condition: string }

export const neGeneratorCheckMode = (env: NodeJS.ProcessEnv = process.env): NeCheckMode =>
  (env.NE_GENERATOR_CHECK_MODE || '').trim().toLowerCase() === 'shadow' ? 'shadow' : 'off';

// same depth from src/services and dist/services; the Dockerfile copies the registry to /app/docs
export const NE_REGISTRY_PATH = path.resolve(__dirname, '../../../../docs/research/negative-evidence/NEGATIVE_EVIDENCE.yaml');
let cache: { file: string; entries: NeEntry[] | null } | null = null;

/** The registry entries (JSON syntax = YAML 1.2), or null when the file is missing or unreadable — unknown, not empty. */
export function loadNegativeEvidence(file = NE_REGISTRY_PATH): NeEntry[] | null {
  if (cache?.file === file) return cache.entries;
  let entries: NeEntry[] | null = null;
  try { entries = (JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: NeEntry[] }).entries; } catch { /* registry absent */ }
  cache = { file, entries };
  return entries;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every registry entry the text names, one match per (entry, pattern/term). Pure; `entries` defaults to the registry. */
export function checkNegativeEvidence(text: string, context: { source: NeSource; entries?: NeEntry[] | null }): NeMatch[] {
  const entries = context.entries === undefined ? loadNegativeEvidence() : context.entries;
  if (!entries || !text) return [];
  const out: NeMatch[] = [];
  for (const e of entries) {
    const base = { entry_id: e.id, verdict: e.verdict, reopen_condition: e.reopen_condition };
    for (const p of e.forbidden_code_patterns ?? []) if (p && text.includes(p)) out.push({ ...base, matched: p, confidence: 'exact_pattern' });
    for (const t of e.match_terms ?? []) {
      if (t && new RegExp(`(?<![A-Za-z0-9_])${escape(t)}(?![A-Za-z0-9_])`, 'i').test(text)) out.push({ ...base, matched: t, confidence: 'keyword' });
    }
  }
  return out;
}

/**
 * Shadow record: one `negative_evidence_match` judgment per matched entry (subject = the generated proposal / genome / unit).
 * Off → nothing, not even the check. Fail-open: never throws, so the generator always proceeds unchanged.
 */
export function recordNegativeEvidenceMatches(db: Database, subject: { type: string; id: string }, text: string, source: NeSource,
  env: NodeJS.ProcessEnv = process.env, entries?: NeEntry[] | null): NeMatch[] {
  if (neGeneratorCheckMode(env) === 'off') return [];
  try {
    const matches = checkNegativeEvidence(text, { source, entries });
    const now = new Date().toISOString();
    for (const id of [...new Set(matches.map((m) => m.entry_id))]) {
      const own = matches.filter((m) => m.entry_id === id);
      const confidence = own.some((m) => m.confidence === 'exact_pattern') ? 'exact_pattern' : 'keyword';
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
        VALUES (?, 'negative_evidence_match', ?, ?, ?, 'shadow', 'match', ?, ?, ?)`)
        .run(randomUUID(), subject.type, subject.id, id, `${id} (${own[0].verdict}) ${confidence}: ${own.map((m) => m.matched).join(', ')}`.slice(0, 300),
          JSON.stringify({ entry_id: id, verdict: own[0].verdict, source, confidence, matched: own.map((m) => ({ term: m.matched, confidence: m.confidence })), reopen_condition: own[0].reopen_condition }), now);
    }
    return matches;
  } catch { return []; }
}

/**
 * evolution-evidence `negative_evidence`: matches per entry per source in the window, and for proposals how many matched
 * ones later verified (a match on a verified proposal is the false-positive signal). Missing table → null (unknown, not 0).
 */
export function negativeEvidenceEvidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  const registry = loadNegativeEvidence();
  type EntryRow = { entry_id: string; source: string; confidence: string; matches: number; subjects: number };
  let by_entry: EntryRow[] | null = null;
  let proposals: { matched: number; verified: number; regressed: number; settled: number; verified_share: number | null } | null = null;
  try {
    by_entry = db.prepare(`SELECT state_hash AS entry_id, COALESCE(json_extract(answers_json, '$.source'), 'unknown') AS source,
        COALESCE(json_extract(answers_json, '$.confidence'), 'unknown') AS confidence, COUNT(*) AS matches, COUNT(DISTINCT subject_id) AS subjects
      FROM judgments WHERE judgment = 'negative_evidence_match' AND created_at >= ? GROUP BY 1, 2, 3 ORDER BY matches DESC, 1, 2, 3`).all(since) as EntryRow[];
    const r = db.prepare(`SELECT COUNT(DISTINCT j.subject_id) AS matched,
        COUNT(DISTINCT CASE WHEN s.status = 'verified' THEN j.subject_id END) AS verified,
        COUNT(DISTINCT CASE WHEN s.status = 'regressed' THEN j.subject_id END) AS regressed
      FROM judgments j LEFT JOIN self_improvements s ON s.id = j.subject_id
      WHERE j.judgment = 'negative_evidence_match' AND j.subject_type = 'self_improvement' AND j.created_at >= ?`).get(since) as { matched: number; verified: number; regressed: number };
    const settled = r.verified + r.regressed;
    proposals = { ...r, settled, verified_share: settled ? +(r.verified / settled).toFixed(3) : null };
  } catch { /* judgments / self_improvements absent: unknown */ }
  return { mode: neGeneratorCheckMode(env), registry_entries: registry ? registry.length : null, by_entry, proposals,
    note: 'shadow only: a negative_evidence_match judgment per matched registry entry at proposal creation, dream mutant generation and discovery unit admission; nothing is blocked. exact_pattern = forbidden_code_patterns substring, keyword = match_terms on word boundaries. proposals.verified = matched proposals that later verified (false-positive signal); verified_share null while none settled. registry_entries null = registry file unreadable.' };
}
