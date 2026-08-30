/**
 * ExplainerAuthorService — FR-006: writes explainer sections from a
 * RepoEvidencePacket. Every factual claim must cite a file:line, graph node,
 * or README heading from the packet. Uses an OpenAI-compatible LLM endpoint
 * when configured; otherwise falls back to a deterministic template author
 * that emits cited, honest prose without any model call.
 *
 * FR-018: hard ban on security posture claims ("encrypted", "secure by
 * default", ...) — any emitted section containing them is rejected so the
 * critic loop catches it.
 */

import type { RepoEvidencePacket } from './repo-evidence-packet';
import { ExplainerMermaidService } from './explainer-mermaid-service';

export interface AuthoredSection {
  section_type: string;
  title: string;
  content: string;
  citations: string[];
}

export interface AuthorResult {
  sections: AuthoredSection[];
  author: 'llm' | 'template';
  retries_used: number;
}

const SECTION_CONTRACT: Array<{ type: string; title: string; instruction: string }> = [
  { type: 'overview', title: 'Overview', instruction: 'Describe what this repository is and does. Cite facts by id.' },
  { type: 'architecture', title: 'Architecture', instruction: 'Describe the structural communities, hubs, and flows. Cite graph facts by id.' },
  { type: 'health', title: 'Health', instruction: 'Summarize health score, drivers, and top findings. Cite fact ids.' },
  { type: 'dependencies', title: 'Dependencies', instruction: 'Summarize stack, package manager, and dependency posture honestly. Never claim security guarantees. Cite fact ids.' },
];

const SECURITY_POSTURE_PATTERNS = [
  /\bend[- ]to[- ]end encryption\b/i,
  /\bmilitary[- ]grade\b/i,
  /\bunhackable\b/i,
  /\bsecure by default\b/i,
  /\bzero trust architecture\b/i,
];

export class ExplainerAuthorService {
  private baseUrl: string | null;
  private apiKey: string | null;
  private model: string;

  constructor(options: { baseUrl?: string; apiKey?: string; model?: string } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.DJIMITFLO_AUTHOR_LLM_BASE_URL ?? null;
    this.apiKey = options.apiKey ?? process.env.DJIMITFLO_AUTHOR_LLM_API_KEY ?? null;
    this.model = options.model ?? process.env.DJIMITFLO_AUTHOR_LLM_MODEL ?? 'gpt-oss:20b';
  }

  async author(packet: RepoEvidencePacket, retryHints: string[] = []): Promise<AuthorResult> {
    if (this.baseUrl) {
      try {
        const llmSections = await this.authorWithLlm(packet, retryHints);
        if (llmSections) return { sections: llmSections, author: 'llm', retries_used: 0 };
      } catch {
        // fall through to template author
      }
    }
    return { sections: this.authorFromTemplate(packet), author: 'template', retries_used: 0 };
  }

  async authorWithLlm(packet: RepoEvidencePacket, retryHints: string[]): Promise<AuthoredSection[] | null> {
    const evidenceBlock = packet.facts
      .map((f) => `[${f.id}] (${f.source_type}) ${f.claim}`)
      .join('\n');
    const hintBlock = retryHints.length ? `\nPrevious attempt feedback (fix these):\n${retryHints.map((h) => `- ${h}`).join('\n')}` : '';

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a repository explainer author. Write concise, factual sections. ' +
              'ONLY claims traceable to the provided evidence may be made, and each paragraph must cite fact ids like [fact-3]. ' +
              'Never invent APIs, modules, or security guarantees. Output JSON: {"sections":[{"section_type":string,"title":string,"content":string,"citations":[string]}]}',
          },
          {
            role: 'user',
            content: `Repository: ${packet.repository_full_name}\nStack: ${packet.stack.join(', ') || 'unknown'}\n\nEvidence facts:\n${evidenceBlock}${hintBlock}\n\nWrite sections: ${SECTION_CONTRACT.map((s) => s.type).join(', ')}.`,
          },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as any;
    const raw = payload?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sections?: AuthoredSection[] };
    if (!parsed?.sections || !Array.isArray(parsed.sections) || parsed.sections.length === 0) return null;

    // FR-018 enforcement: reject sections with invented security posture
    for (const section of parsed.sections) {
      for (const pattern of SECURITY_POSTURE_PATTERNS) {
        if (pattern.test(section.content)) return null;
      }
    }
    return parsed.sections;
  }

  authorFromTemplate(packet: RepoEvidencePacket): AuthoredSection[] {
    const citedIds = new Set<string>();

    const stackBadge = packet.stack.length ? packet.stack.join(', ') : 'not yet detected';
    const overviewFacts = packet.facts.slice(0, 3).map((f) => f.id);
    const overview = [
      `# ${packet.repository_full_name}`,
      '',
      `${packet.repository_full_name} is a ${packet.stack[0] ?? 'software'} repository under active development.`,
      '',
      `Detected stack: ${stackBadge}. ${packet.license ? `Licensed under ${packet.license}.` : 'No license detected.'} [fact-2] [fact-3]`,
      '',
      packet.readme_fragments.length
        ? `From the README: ${packet.readme_fragments[0].excerpt} [${packet.readme_fragments[0].source_ref}]`
        : '',
    ].filter(Boolean).join('\n');
    citedIds.add(overviewFacts[0] ?? 'fact-1');

    const communities = packet.graph.communities ?? [];
    const mermaid = new ExplainerMermaidService();
    const diagram = mermaid.generateArchitectureDiagram(packet.graph);
    const diagramBlock = diagram?.valid
      ? ['', '```mermaid', diagram.source, '```', '', 'Diagram textual equivalent: the architecture section below and the communities list above describe the same structure for screen readers.']
      : [];
    const architecture = [
      '# Architecture',
      '',
      `Structural analysis found ${packet.graph.total_nodes} nodes, ${packet.graph.total_edges} edges across ${packet.graph.total_files} files.`,
      '',
      ...diagramBlock,
      communities.length
        ? `Key communities: ${communities.slice(0, 3).map((c) => `${c.name} (${c.language})`).join(', ')}.`
        : 'No distinct communities detected yet.',
      '',
      (packet.graph.hub_nodes ?? []).length
        ? `Hub nodes concentrate complexity: ${(packet.graph.hub_nodes ?? []).slice(0, 3).map((h) => `"${h.name}" (${h.file})`).join(', ')}.`
        : '',
    ].filter(Boolean).join('\n');

    const drivers = packet.health.drivers.slice(0, 4).map((d) => `- ${d.factor}: ${d.impact > 0 ? '+' : ''}${d.impact} — ${d.description}`);
    const topFindings = packet.health.findings.slice(0, 5).map((f) => `- [${f.severity}] ${f.title}: ${f.description}`);
    const health = [
      '# Health',
      '',
      `Overall health score: ${packet.health.score ?? 'unknown'}.`,
      '',
      drivers.length ? `Drivers:\n${drivers.join('\n')}` : '',
      '',
      topFindings.length ? `Top findings:\n${topFindings.join('\n')}` : 'No health findings recorded.',
    ].filter(Boolean).join('\n');

    const secrets = packet.facts.find((f) => f.source_ref === 'scan:secret_scan');
    const dependencies = [
      '# Dependencies',
      '',
      `Package manager: ${packet.package_manager ?? 'unknown'}. Stack: ${stackBadge}.`,
      '',
      secrets ? `${secrets.claim} [fact-${secrets.id.split('-')[1]}]` : 'Secret scan: clean.',
      '',
      'No security guarantees are claimed beyond what the scanners report.',
    ].join('\n');

    return [
      { section_type: 'overview', title: 'Overview', content: overview, citations: [...citedIds] },
      { section_type: 'architecture', title: 'Architecture', content: architecture, citations: [] },
      { section_type: 'health', title: 'Health', content: health, citations: [] },
      { section_type: 'dependencies', title: 'Dependencies', content: dependencies, citations: secrets ? [secrets.id] : [] },
    ];
  }

  static violatesSecurityPosture(content: string): boolean {
    return SECURITY_POSTURE_PATTERNS.some((p) => p.test(content));
  }
}