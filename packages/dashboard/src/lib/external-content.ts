/**
 * Truth audit 2026-11-12: goals created from GitHub PRs store their objective as an untrusted envelope
 * (`BEGIN_EXTERNAL_CONTENT source=github_pull_request trust=untrusted\n{"title":…,"url":…}\nEND_EXTERNAL_CONTENT`, 1,941 of
 * 2,582 goals) and pages printed the raw envelope. This reads a title out of it for display. The result is plain text: render it
 * as a React text node only (never as HTML), and keep the external marker so untrusted text never reads as the operator's own.
 */
const ENVELOPE = /^BEGIN_EXTERNAL_CONTENT source=(\S+) trust=\S+\s([\s\S]*?)\s*END_EXTERNAL_CONTENT$/;

export type ReadableObjective = { text: string; external: boolean; source: string | null };

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();

export function readableObjective(raw: string | null | undefined): ReadableObjective {
  const value = raw ?? '';
  const match = ENVELOPE.exec(value.trim());
  if (!match) return { text: value, external: false, source: null };
  const body = match[2].trim();
  let text = body;
  try {
    const parsed: unknown = JSON.parse(body);
    const title = parsed && typeof parsed === 'object' ? (parsed as { title?: unknown }).title : parsed;
    if (typeof title === 'string' && title.trim()) text = title;
  } catch { /* not JSON: show the body as text */ }
  return { text: oneLine(text), external: true, source: match[1] };
}

/** One-line label for a goal objective; external content carries a visible "(from external content)" marker. */
export function objectiveLabel(raw: string | null | undefined): string {
  const { text, external } = readableObjective(raw);
  return external ? `${text} (from external content)` : text;
}
