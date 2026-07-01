export interface KnowledgeResult {
  id: string;
  title: string;
  content: string;
  source: string;
  url?: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface KnowledgeSourceAdapter {
  name: string;
  search(query: string, limit?: number): Promise<KnowledgeResult[]>;
  fetch(id: string): Promise<KnowledgeResult | null>;
  isAvailable(): Promise<boolean>;
}

export interface AdapterCacheEntry {
  id: string;
  source: string;
  query_hash: string;
  result_json: string;
  expires_at: string;
  created_at: string;
}
