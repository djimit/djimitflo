import type { Database } from 'better-sqlite3';
import type { KnowledgeResult, KnowledgeSourceAdapter } from './types';
import { AdapterCache } from './adapter-cache';
import { WikipediaAdapter } from './wikipedia-adapter';
import { ArxivAdapter } from './arxiv-adapter';
import { OkfAdapter } from './okf-adapter';
import { DjimitKBAdapter } from './djimitkb-adapter';

export class KnowledgeAdapterRegistry {
  private adapters: Map<string, KnowledgeSourceAdapter> = new Map();
  private cache: AdapterCache;

  constructor(db: Database) {
    this.cache = new AdapterCache(db);
    this.registerDefaults();
  }

  register(name: string, adapter: KnowledgeSourceAdapter): void {
    this.adapters.set(name, adapter);
  }

  get(name: string): KnowledgeSourceAdapter | undefined {
    return this.adapters.get(name);
  }

  getAvailable(): string[] {
    return Array.from(this.adapters.keys());
  }

  async search(source: string, query: string, limit: number = 5): Promise<KnowledgeResult[]> {
    const adapter = this.adapters.get(source);
    if (!adapter) return [];

    const cached = this.cache.get(source, query);
    if (cached) return cached as KnowledgeResult[];

    const results = await adapter.search(query, limit);
    if (results.length > 0) {
      this.cache.set(source, query, results);
    }

    return results;
  }

  async searchAll(query: string, sources: string[], limit: number = 5): Promise<KnowledgeResult[]> {
    const promises = sources.map(source => this.search(source, query, limit));
    const results = await Promise.all(promises);
    return results.flat();
  }

  async isAvailable(source: string): Promise<boolean> {
    const adapter = this.adapters.get(source);
    if (!adapter) return false;
    return adapter.isAvailable();
  }

  cleanupCache(): number {
    return this.cache.cleanup();
  }

  private registerDefaults(): void {
    this.register('wikipedia', new WikipediaAdapter());
    this.register('arxiv', new ArxivAdapter());
    this.register('okf', new OkfAdapter());
    this.register('djimitkb', new DjimitKBAdapter());
  }
}

export type { KnowledgeResult, KnowledgeSourceAdapter } from './types';
export { WikipediaAdapter } from './wikipedia-adapter';
export { ArxivAdapter } from './arxiv-adapter';
export { OkfAdapter } from './okf-adapter';
export { DjimitKBAdapter } from './djimitkb-adapter';
export { AdapterCache } from './adapter-cache';
