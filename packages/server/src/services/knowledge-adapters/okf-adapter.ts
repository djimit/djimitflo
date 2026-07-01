import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { KnowledgeResult, KnowledgeSourceAdapter } from './types';
import { KnowledgeRuntimeService } from '../knowledge-runtime-service';

export class OkfAdapter implements KnowledgeSourceAdapter {
  name = 'okf';
  private okfBase: string;

  constructor() {
    this.okfBase = KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true });
  }

  async search(query: string, limit: number = 5): Promise<KnowledgeResult[]> {
    if (!this.okfBase || !fs.existsSync(this.okfBase)) return [];

    try {
      const conceptsDir = path.join(this.okfBase, 'concepts');
      const skillsDir = path.join(this.okfBase, 'skills');
      const results: KnowledgeResult[] = [];

      for (const dir of [conceptsDir, skillsDir]) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

        for (const file of files) {
          if (results.length >= limit) break;
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          const lower = content.toLowerCase();
          const queryLower = query.toLowerCase();

          if (lower.includes(queryLower) || file.toLowerCase().includes(queryLower.replace(/[^a-z0-9]/g, '-'))) {
            const title = this.extractTitle(content) || file.replace('.md', '');
            const body = this.extractBody(content);
            results.push({
              id: randomUUID(),
              title,
              content: body.slice(0, 500),
              source: this.name,
              url: `okf://${path.join(path.basename(dir), file)}`,
              confidence: 0.6,
              metadata: {
                file,
                type: dir.includes('skills') ? 'skill' : 'concept',
              },
            });
          }
        }
      }

      return results.slice(0, limit);
    } catch {
      return [];
    }
  }

  async fetch(id: string): Promise<KnowledgeResult | null> {
    const results = await this.search(id, 1);
    return results[0] ?? null;
  }

  async isAvailable(): Promise<boolean> {
    return this.okfBase !== '' && fs.existsSync(this.okfBase);
  }

  private extractTitle(content: string): string | null {
    const match = content.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() ?? null;
  }

  private extractBody(content: string): string {
    const frontmatterEnd = content.indexOf('---', 3);
    if (frontmatterEnd > 0) {
      return content.slice(frontmatterEnd + 3).trim();
    }
    return content;
  }
}
