import type { Database } from 'better-sqlite3';
import { judgmentMode, runJudgment, type JudgmentDef } from './judgment-service';
import type { TsQuestion } from './typesafe-client';

/**
 * Closes the read path of Djimitflo's memory (WS-G / E8). Production 2026-09-23: 67 promoted memories, and no decision point
 * read any of them (only the maker got its top-3 similar runs). Before a decision (today: the specialist panel) this picks
 * at most MAX_SELECTED promoted memories that are about the same file, component or kind of change, and returns them as an
 * advisory block with provenance.
 *
 * Selection: cheap word-overlap prefilter in code (top MAX_CANDIDATES), then one TypeSafe call with one Noul per candidate
 * (docs: re-ranking / classifying RAG passages; jaggedness: filter irrelevant state before judging).
 *   TYPESAFE_DECISION_CONTEXT_MODE=off (default) | shadow (record the selection in `judgments`, inject nothing) | enforce (inject).
 * Fail-open: any error means no advisory block, which is today's behaviour.
 */
const MAX_CANDIDATES = 12;
const MAX_SELECTED = 3;
const RELEVANT = 0.7;
const MAX_MEMORY_CHARS = 600;

export interface MemoryCandidate { id: string; title: string; content: string; memory_type: string }
export interface DecisionContext { text: string; memoryIds: string[] }

const words = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? []));

/** Promoted, non-sensitive memories ranked by word overlap with the decision text (code-side prefilter, no model). */
export function prefilterMemories(db: Database, decisionText: string, limit = MAX_CANDIDATES): MemoryCandidate[] {
  const query = words(decisionText);
  if (!query.size) return [];
  const rows = db.prepare(`SELECT id, title, content, memory_type FROM memory_candidates
    WHERE status = 'promoted' AND sensitivity = 'normal' ORDER BY updated_at DESC LIMIT 500`).all() as MemoryCandidate[];
  return rows
    .map((row) => { const w = words(`${row.title} ${row.content}`); let hits = 0; for (const t of query) if (w.has(t)) hits += 1; return { row, hits }; })
    .filter((x) => x.hits >= 2)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((x) => x.row);
}

export function decisionContextJudgment(count: number): JudgmentDef {
  const questions: Record<string, TsQuestion> = {};
  for (let i = 0; i < count; i += 1) {
    questions[`m${i}`] = {
      type: 'noul',
      instructions: `Does \`memories[${i}]\` describe a lesson about the same file, component or kind of change as \`decision\`?`,
      criteria: { true: 'Same file, component or kind of change; the lesson could change how this decision is judged.', false: 'A different topic, or too generic to apply to this decision.' },
    };
  }
  return {
    id: 'decision_context',
    questions,
    decide(a) {
      const picked = Object.keys(a).filter((k) => (a[k]?.noul ?? 0) > RELEVANT);
      return { decision: picked.length ? 'yes' : 'no', reason: `selected=${picked.join(',') || 'none'}` };
    },
  };
}

export async function buildDecisionContext(db: Database, subject: { type: string; id: string }, decision: Record<string, unknown>): Promise<DecisionContext | null> {
  const mode = judgmentMode('decision_context');
  if (mode === 'off') return null;
  const candidates = prefilterMemories(db, JSON.stringify(decision));
  if (!candidates.length) return null;
  const def = decisionContextJudgment(candidates.length);
  const state = { decision, memories: candidates.map((m) => ({ title: m.title, lesson: m.content.slice(0, MAX_MEMORY_CHARS) })) };
  const record = await runJudgment(db, def, subject, state).catch(() => null);
  if (!record || mode !== 'enforce') return null; // shadow: the selection is recorded, nothing is injected
  const chosen = candidates
    .map((m, i) => ({ m, p: record.answers[`m${i}`]?.noul ?? 0 }))
    .filter((x) => x.p > RELEVANT)
    .sort((a, b) => b.p - a.p)
    .slice(0, MAX_SELECTED)
    .map((x) => x.m);
  if (!chosen.length) return null;
  const text = ['Relevant lessons from earlier outcomes (advisory; they do not override the evidence above):',
    ...chosen.map((m) => `- [memory:${m.id}] ${m.title}: ${m.content.slice(0, MAX_MEMORY_CHARS).replace(/\s+/g, ' ')}`)].join('\n');
  return { text, memoryIds: chosen.map((m) => m.id) };
}
