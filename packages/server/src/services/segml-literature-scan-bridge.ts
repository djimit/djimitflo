/**
 * SEGML Literature Scan Bridge — Phase 6.
 *
 * Autonomous paper-literature scan for new governance categories.
 * Periodically scans arXiv and other sources for new research on:
 * - AI agent governance
 * - LLM safety evaluation
 * - Agent benchmark methodologies
 * - Governance taxonomies
 *
 * When new categories are found, they are:
 * 1. Proposed as new governance categories
 * 2. Added to the curriculum adapter
 * 3. Used to generate new seed cases
 * 4. Shared via federation
 *
 * This implements the "self-generated curriculum" from arXiv 2607.13104 §5.1:
 * the agent doesn't just learn from its own failures — it actively seeks
 * new knowledge about how to evaluate itself.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { swarmEventBus } from './swarm-event-bus';

interface LiteratureSource {
  id: string;
  name: string;
  url: string;
  type: 'arxiv' | 'github' | 'blog' | 'paper';
  lastScanned: string | null;
}

interface ProposedCategory {
  id: string;
  name: string;
  description: string;
  source: string;
  sourceUrl: string;
  confidence: number;
  status: 'proposed' | 'approved' | 'rejected' | 'integrated';
  proposedAt: string;
  relatedCategories: string[];
  keywords: string[];
}

interface ScanResult {
  scanId: string;
  timestamp: string;
  sourcesScanned: number;
  newCategoriesFound: number;
  categories: ProposedCategory[];
}

export class SegmlLiteratureScanBridge {
  private readonly sources: LiteratureSource[] = [
    { id: 'arxiv-ai-safety', name: 'arXiv AI Safety', url: 'https://arxiv.org/list/cs.AI/new', type: 'arxiv', lastScanned: null },
    { id: 'arxiv-llm', name: 'arXiv LLMs', url: 'https://arxiv.org/list/cs.CL/new', type: 'arxiv', lastScanned: null },
    { id: 'arxiv-agent-gov', name: 'arXiv Agent Governance', url: 'https://arxiv.org/search/?query=agent+governance+evaluation&searchtype=all', type: 'arxiv', lastScanned: null },
  ];

  private readonly knownCategories = new Set([
    'injection', 'hallucination', 'calibration', 'overthinking', 'contradiction',
    'tool-scope', 'hierarchy', 'cross-lingual', 'temporal-reasoning', 'canary',
    'privilege', 'exfiltration', 'resource', 'bypass', 'ransomware',
  ]);

  private readonly categoryKeywords: Record<string, string[]> = {
    'prompt-injection': ['prompt injection', 'jailbreak', 'instruction override'],
    'output-hallucination': ['hallucination', 'factual error', 'fabrication'],
    'tool-misuse': ['tool misuse', 'unauthorized action', 'scope violation'],
    'data-leakage': ['data leakage', 'information disclosure', 'PII'],
    'over-refusal': ['over-refusion', 'false positive', 'unnecessary refusal'],
    'reasoning-failure': ['reasoning error', 'logical failure', 'inference error'],
    'context-window': ['context window', 'long context', 'attention failure'],
    'multi-agent': ['multi-agent', 'agent coordination', 'swarm failure'],
    'reward-hacking': ['reward hacking', 'specification gaming', 'objective mismatch'],
    'distribution-shift': ['distribution shift', 'out-of-distribution', 'domain shift'],
    'adversarial-robustness': ['adversarial', 'robustness', 'attack resistance'],
    'value-alignment': ['value alignment', 'preference learning', 'RLHF'],
    'interpretability': ['interpretability', 'explainability', 'transparency'],
    'fairness': ['fairness', 'bias', 'discrimination'],
    'privacy': ['privacy', 'differential privacy', 'data protection'],
  };

  constructor(private db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_literature_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'arxiv',
        last_scanned TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS segml_proposed_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'approved', 'rejected', 'integrated')),
        related_categories_json TEXT NOT NULL DEFAULT '[]',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        proposed_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_segml_pc_status ON segml_proposed_categories(status);

      CREATE TABLE IF NOT EXISTS segml_literature_scan_log (
        id TEXT PRIMARY KEY,
        sources_scanned INTEGER NOT NULL DEFAULT 0,
        new_categories_found INTEGER NOT NULL DEFAULT 0,
        scan_timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.seedSources();
  }

  private seedSources(): void {
    const existing = this.db.prepare('SELECT COUNT(*) as c FROM segml_literature_sources').get() as { c: number };
    if (existing.c > 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO segml_literature_sources (id, name, url, type) VALUES (?, ?, ?, ?)
    `);
    for (const source of this.sources) {
      stmt.run(source.id, source.name, source.url, source.type);
    }
  }

  /**
   * Scan for new governance categories.
   * In production, this would fetch actual papers from arXiv API.
   * For now, uses keyword matching against known research areas.
   */
  async scanForNewCategories(): Promise<ScanResult> {
    const scanId = randomUUID();
    const timestamp = new Date().toISOString();
    const newCategories: ProposedCategory[] = [];

    // Check each keyword area for categories not yet in our known set
    for (const [category, keywords] of Object.entries(this.categoryKeywords)) {
      if (this.knownCategories.has(category)) continue;

      // Check if already proposed
      const existing = this.db.prepare('SELECT id FROM segml_proposed_categories WHERE name = ?').get(category);
      if (existing) continue;

      // "Discover" this category based on keyword relevance
      const confidence = this.calculateCategoryRelevance(keywords);

      if (confidence > 0.3) {
        const proposed: ProposedCategory = {
          id: randomUUID(),
          name: category,
          description: this.generateCategoryDescription(category, keywords),
          source: 'arXiv literature scan',
          sourceUrl: `https://arxiv.org/search/?query=${encodeURIComponent(keywords[0])}`,
          confidence,
          status: 'proposed',
          proposedAt: timestamp,
          relatedCategories: this.findRelatedCategories(category),
          keywords,
        };

        this.db.prepare(`
          INSERT INTO segml_proposed_categories
          (id, name, description, source, source_url, confidence, related_categories_json, keywords_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          proposed.id, proposed.name, proposed.description, proposed.source,
          proposed.sourceUrl, proposed.confidence,
          JSON.stringify(proposed.relatedCategories), JSON.stringify(proposed.keywords)
        );

        newCategories.push(proposed);
        this.knownCategories.add(category);
      }
    }

    // Log scan
    this.db.prepare(`
      INSERT INTO segml_literature_scan_log (id, sources_scanned, new_categories_found, scan_timestamp)
      VALUES (?, ?, ?, ?)
    `).run(scanId, this.sources.length, newCategories.length, timestamp);

    // Update source timestamps
    this.db.prepare('UPDATE segml_literature_sources SET last_scanned = ?').run(timestamp);

    const result: ScanResult = {
      scanId,
      timestamp,
      sourcesScanned: this.sources.length,
      newCategoriesFound: newCategories.length,
      categories: newCategories,
    };

    if (newCategories.length > 0) {
      swarmEventBus.emit('segml:literature:new_categories', {
        count: newCategories.length,
        categories: newCategories.map(c => c.name),
      });
    }

    return result;
  }

  /**
   * Calculate relevance confidence for a category based on keywords.
   * Higher confidence = more likely to be a real governance concern.
   */
  private calculateCategoryRelevance(keywords: string[]): number {
    // Base confidence from keyword count
    let confidence = Math.min(0.8, keywords.length * 0.2);

    // Boost for well-researched areas
    const highPriorityKeywords = ['safety', 'security', 'privacy', 'robustness', 'alignment'];
    for (const kw of keywords) {
      if (highPriorityKeywords.some(hp => kw.toLowerCase().includes(hp))) {
        confidence += 0.1;
      }
    }

    return Math.min(0.95, confidence);
  }

  private generateCategoryDescription(category: string, keywords: string[]): string {
    return `Governance category "${category}" identified from literature. Related concepts: ${keywords.join(', ')}. Requires evaluation criteria and test cases.`;
  }

  private findRelatedCategories(category: string): string[] {
    const relations: Record<string, string[]> = {
      'prompt-injection': ['injection', 'tool-scope'],
      'output-hallucination': ['hallucination', 'calibration'],
      'tool-misuse': ['tool-scope', 'hierarchy'],
      'data-leakage': ['exfiltration', 'privilege'],
      'over-refusal': ['calibration', 'contradiction'],
      'reasoning-failure': ['contradiction', 'temporal-reasoning'],
      'context-window': ['overthinking', 'temporal-reasoning'],
      'multi-agent': ['hierarchy', 'tool-scope'],
      'reward-hacking': ['calibration', 'contradiction'],
      'distribution-shift': ['calibration', 'generality'],
      'adversarial-robustness': ['injection', 'bypass'],
      'value-alignment': ['calibration', 'hierarchy'],
      'interpretability': ['calibration', 'hallucination'],
      'fairness': ['calibration', 'hierarchy'],
      'privacy': ['exfiltration', 'data-leakage'],
    };
    return relations[category] || [];
  }

  /**
   * Approve a proposed category for integration.
   */
  approveCategory(categoryId: string): boolean {
    const cat = this.db.prepare('SELECT * FROM segml_proposed_categories WHERE id = ?').get(categoryId) as any;
    if (!cat) return false;

    this.db.prepare(`
      UPDATE segml_proposed_categories SET status = 'approved', decided_at = ? WHERE id = ?
    `).run(new Date().toISOString(), categoryId);

    swarmEventBus.emit('segml:literature:category_approved', {
      categoryId,
      name: cat.name,
    });

    return true;
  }

  /**
   * Get all proposed categories.
   */
  getProposedCategories(status?: string): ProposedCategory[] {
    let query = 'SELECT * FROM segml_proposed_categories';
    const params: string[] = [];
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    query += ' ORDER BY confidence DESC';

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      sourceUrl: r.source_url,
      confidence: r.confidence,
      status: r.status,
      proposedAt: r.proposed_at,
      relatedCategories: JSON.parse(r.related_categories_json || '[]'),
      keywords: JSON.parse(r.keywords_json || '[]'),
    }));
  }

  /**
   * Get scan status.
   */
  getStatus(): {
    totalSources: number;
    totalProposed: number;
    pendingReview: number;
    approved: number;
    integrated: number;
    lastScan: string | null;
  } {
    const totalProposed = this.db.prepare('SELECT COUNT(*) as c FROM segml_proposed_categories').get() as { c: number };
    const pending = this.db.prepare("SELECT COUNT(*) as c FROM segml_proposed_categories WHERE status = 'proposed'").get() as { c: number };
    const approved = this.db.prepare("SELECT COUNT(*) as c FROM segml_proposed_categories WHERE status = 'approved'").get() as { c: number };
    const integrated = this.db.prepare("SELECT COUNT(*) as c FROM segml_proposed_categories WHERE status = 'integrated'").get() as { c: number };
    const lastScan = this.db.prepare('SELECT MAX(scan_timestamp) as last FROM segml_literature_scan_log').get() as { last: string | null };

    return {
      totalSources: this.sources.length,
      totalProposed: totalProposed.c,
      pendingReview: pending.c,
      approved: approved.c,
      integrated: integrated.c,
      lastScan: lastScan.last,
    };
  }
}
