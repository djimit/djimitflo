/**
 * ExplainerMermaidService — P1: generates Mermaid C4-style diagrams from the
 * graph summary and validates syntax before publication. Follows the
 * Litho/deepwiki-rs verification pattern: every diagram must pass a syntax
 * check (balanced nodes, no invalid characters, known diagram type) or it
 * gets repaired/skipped instead of leaking broken markup into bundles.
 */

import type { GraphSummary } from '@djimitflo/shared';

export interface MermaidDiagram {
  type: 'flowchart' | 'component';
  title: string;
  source: string;
  valid: boolean;
}

export class ExplainerMermaidService {
  /** Flowchart of top communities and their hub nodes. */
  generateArchitectureDiagram(graph: GraphSummary): MermaidDiagram | null {
    const communities = (graph.communities ?? []).slice(0, 6);
    if (communities.length === 0) return null;

    const lines: string[] = ['flowchart LR'];
    const ids = new Map<string, string>();
    communities.forEach((c, i) => {
      const id = `C${i}`;
      ids.set(c.name, id);
      lines.push(`  ${id}["${escapeLabel(c.name)} (${c.language}, ${c.size})"]`);
    });
    // Hub nodes rendered inside their dominant community (best-effort: first community that "contains" name)
    const hubs = (graph.hub_nodes ?? []).slice(0, 5);
    for (const hub of hubs) {
      const host = communities.find((c) => hub.file?.includes(c.name.split(' ')[0]?.toLowerCase() ?? '\u0000'));
      if (host && ids.has(host.name)) {
        lines.push(`  ${ids.get(host.name)} --- H${sanitize(hub.name)}["${escapeLabel(hub.name)}"]`);
      }
    }
    // Implicit edge flow: connect communities in sequence (visual grouping, no real edges available)
    for (let i = 0; i + 1 < communities.length; i++) {
      lines.push(`  C${i} -.-> C${i + 1}`);
    }

    const source = lines.join('\n');
    return { type: 'flowchart', title: 'Architecture Overview', source, valid: this.validate(source) };
  }

  /** Syntax gate: blocks broken mermaid from entering published bundles. */
  validate(source: string): boolean {
    if (!source.trim()) return false;
    const lines = source.trim().split('\n');
    // First line must declare a known diagram type
    const first = lines[0].trim();
    if (!/^(flowchart|graph|sequenceDiagram|classDiagram|erDiagram|gantt|pie|stateDiagram|mindmap)\b/.test(first)) {
      return false;
    }
    let square = 0;
    let round = 0;
    let curly = 0;
    for (const line of lines) {
      for (const ch of line) {
        if (ch === '[') square++;
        if (ch === ']') square--;
        if (ch === '(') round++;
        if (ch === ')') round--;
        if (ch === '{') curly++;
        if (ch === '}') curly--;
        if (square < 0 || round < 0 || curly < 0) return false;
      }
    }
    return square === 0 && round === 0 && curly === 0;
  }

  /** Auto-repair: strip invalid lines, re-validate. Returns null if unrepairable. */
  repair(source: string): string | null {
    const lines = source.split('\n');
    const header = lines[0];
    const body = lines.slice(1).filter((line) => {
      if (!line.trim()) return false;
      // node/edge lines must contain an identifier and not end mid-label
      if (!/[A-Za-z0-9_]/.test(line)) return false;
      const opens = (line.match(/\[/g) ?? []).length;
      const closes = (line.match(/\]/g) ?? []).length;
      return opens === closes;
    });
    if (body.length === 0) return null;
    const repaired = `${header}\n${body.join('\n')}`;
    return this.validate(repaired) ? repaired : null;
  }
}

function escapeLabel(text: string): string {
  return text.replace(/["\n]/g, ' ').slice(0, 60);
}

function sanitize(text: string): string {
  return text.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30).replace(/^_+/, 'N_');
}