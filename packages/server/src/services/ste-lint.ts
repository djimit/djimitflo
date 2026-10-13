/**
 * ASD-STE100-style lint for instruction templates (STE-001, operator 11-10). Deterministic, no LLM, no dependency: it flags
 * the four STE rules that matter most for agent prompts —
 *   sentence_length        a sentence longer than 20 words (STE procedural limit)
 *   vague_word             a word that leaves the reading to the agent ('relevant', 'small', 'as needed', ...)
 *   passive_voice          be-verb + past participle ('is required', 'are reverted')
 *   multiple_instructions  more than one imperative in one sentence ('Install X; never edit Y')
 * ponytail: heuristics, not a parser — a participle list and a verb list. Upgrade to a POS tagger only if false positives
 * block a real template.
 */
export type SteRule = 'sentence_length' | 'vague_word' | 'passive_voice' | 'multiple_instructions';
export interface SteFinding { rule: SteRule; sentence: string; detail: string }

export const STE_MAX_WORDS = 20;
const VAGUE = /\b(relevant|appropriate(?:ly)?|small|as needed|properly|suitable|adequate(?:ly)?|reasonabl[ey]|sufficient(?:ly)?|etc|minor|significant(?:ly)?|if possible|where possible|as appropriate|concise)\b/gi;
const PARTICIPLE = '(?:\\w+ed|built|done|given|made|run|shown|written|taken|seen|known|read|kept|left|set|put|sent|found|held|got|gotten)';
const PASSIVE = new RegExp(`\\b(?:am|is|are|was|were|be|been|being)\\s+(?:not\\s+)?(?:\\w+ly\\s+)?${PARTICIPLE}\\b`, 'gi');
const VERBS = 'keep|do|run|install|change|use|add|write|read|make|return|review|judge|say|work|prefer|respond|cite|leave|invent|edit|merge|push|deploy|modify|stop|check|open|look|retry|give|relax|attack|audit|treat|reply|output';
// an imperative starts the sentence or follows a clause joiner ('; ', ': ', ', and ', ' and ', ' or ', ' then ')
const IMPERATIVE = new RegExp(`(?:^|;\\s+|:\\s+|,?\\s+(?:and|or|then)\\s+)(?:do not |don't |never |only )?(?:${VERBS})\\b`, 'gi');

/** Split a template into sentences: headings dropped, list markers stripped, inline code and wrapped lines joined. */
export function steSentences(text: string): string[] {
  const blocks: string[] = []; let cur: string[] = [];
  const flush = () => { if (cur.length) blocks.push(cur.join(' ')); cur = []; };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('{') || line.startsWith('"')) { flush(); continue; }
    const item = /^(?:[-*]|\d+\.)\s+/.test(line);
    if (item) flush();
    cur.push(line.replace(/^(?:[-*]|\d+\.)\s+/, ''));
    if (item) flush();
  }
  flush();
  return blocks.flatMap((b) => b.replace(/`[^`]*`/g, 'CODE').split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter(Boolean);
}

export function steLint(text: string): SteFinding[] {
  const out: SteFinding[] = [];
  for (const sentence of steSentences(text)) {
    const words = sentence.split(/\s+/).filter(Boolean).length;
    if (words > STE_MAX_WORDS) out.push({ rule: 'sentence_length', sentence, detail: `${words} words > ${STE_MAX_WORDS}` });
    for (const m of sentence.matchAll(VAGUE)) out.push({ rule: 'vague_word', sentence, detail: m[0].toLowerCase() });
    for (const m of sentence.matchAll(PASSIVE)) out.push({ rule: 'passive_voice', sentence, detail: m[0].toLowerCase() });
    const imperatives = [...sentence.matchAll(IMPERATIVE)].length;
    if (imperatives > 1) out.push({ rule: 'multiple_instructions', sentence, detail: `${imperatives} imperatives` });
  }
  return out;
}

/** Findings per rule, for a compact report / snapshot. */
export function steSummary(text: string): Record<SteRule, number> {
  const s: Record<SteRule, number> = { sentence_length: 0, vague_word: 0, passive_voice: 0, multiple_instructions: 0 };
  for (const f of steLint(text)) s[f.rule]++;
  return s;
}
