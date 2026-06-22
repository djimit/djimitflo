// Tolerant Markdown agent-file parser, calibrated to msitarzewski/agency-agents.
// frontmatter: name/description/color/emoji/vibe; division = top-level dir;
// level-2 (##) sections with emoji titles matched by keyword; fence-aware.

function normalizeTitle(t: string): string {
  return String(t || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/[^A-Za-z0-9 &/+-]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function classifySection(title: string): string | null {
  const t = normalizeTitle(title);
  if (/(identity|memory)/.test(t)) return 'memory_policy';
  if (/(core mission|mission|doel)/.test(t)) return 'mission';
  if (/(critical rule|rule|guardrail)/.test(t)) return 'rules';
  if (/deliverable/.test(t)) return 'deliverables';
  if (/(workflow|process)/.test(t)) return 'workflows';
  if (/communication/.test(t)) return 'communication_style';
  if (/learning/.test(t)) return 'learning';
  if (/(success metric|metrics)/.test(t)) return 'success_metrics';
  if (/(advanced capabilit|capabilit|tools)/.test(t)) return 'tools_required';
  if (/description/.test(t)) return 'description';
  if (/(persona|personality)/.test(t)) return 'persona';
  return null;
}

function stripVal(v: string): string {
  v = String(v || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

function parseFrontmatter(text: string): { frontmatter: Record<string, any>; body: string } {
  const fm: Record<string, any> = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: fm, body: text };
  const block = m[1]; const body = m[2];
  let key: string | null = null; let arr: string[] = [];
  const flush = () => { if (key && arr.length && !(key in fm)) fm[key] = arr; arr = []; };
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) {
      flush(); key = kv[1];
      const val = kv[2].trim();
      if (val === '') arr = []; else fm[key] = stripVal(val);
    } else if (/^\s*-\s+/.test(line) && key) arr.push(stripVal(line.replace(/^\s*-\s+/, '')));
  }
  flush();
  return { frontmatter: fm, body };
}

function splitSections(body: string): { sections: Record<string, string>; preamble: string } {
  const sections: Record<string, string> = {};
  let preamble = ''; let current: string | null = null; let buf: string[] = []; let inCode = false;
  const push = () => {
    const text = buf.join('\n').trim();
    if (current) sections[current] = (sections[current] ? sections[current] + '\n' : '') + text;
    else preamble = (preamble ? preamble + '\n' : '') + text;
    buf = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^(`{3,}|~{3,})/.test(line)) { inCode = !inCode; buf.push(line); continue; }
    if (!inCode) {
      const h2 = line.match(/^##\s+(.*)$/);
      if (h2) { push(); current = classifySection(h2[1]) || normalizeTitle(h2[1]); continue; }
    }
    buf.push(line);
  }
  push();
  return { sections, preamble };
}

function cleanInline(s: string): string { return String(s).replace(/\*\*/g, '').replace(/`/g, '').trim(); }

export function toList(text?: string): string[] {
  if (!text) return [];
  const out: string[] = []; let inCode = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^(`{3,}|~{3,})/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) out.push(cleanInline(b[1]));
  }
  return out.filter(Boolean);
}

export function firstParagraph(text?: string): string {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).join(' ');
}

export interface ParsedAgent { frontmatter: Record<string, any>; sections: Record<string, string>; preamble: string; sourceRepo: string; sourcePath: string; raw: string }

export function parseAgentMarkdown(text: string, opts: { sourceRepo?: string; sourcePath?: string } = {}): ParsedAgent {
  const { frontmatter, body } = parseFrontmatter(text);
  const { sections, preamble } = splitSections(body);
  return { frontmatter, sections, preamble, sourceRepo: opts.sourceRepo || '', sourcePath: opts.sourcePath || '', raw: text };
}
