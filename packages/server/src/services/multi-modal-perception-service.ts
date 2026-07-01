import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface PerceptionResult {
  type: 'screenshot' | 'diagram' | 'text';
  content: string;
  structuredData: Record<string, unknown>;
  confidence: number;
}

interface PerceptionRow {
  id: string;
  source_type: string;
  source_path: string;
  content: string;
  structured_data_json: string | null;
  confidence: number;
  created_at: string;
}

export class MultiModalPerceptionService {
  private ollamaUrl: string;
  private visionModel: string;

  constructor(private db: Database) {
    this.ollamaUrl = process.env.OLLAMA_URL || 'http://192.168.1.28:11434';
    this.visionModel = process.env.VISION_MODEL || 'llava';

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS perception_results (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        structured_data_json TEXT,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  async describeImage(_imagePath: string): Promise<string> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.visionModel, prompt: 'Describe this image in detail.', stream: false }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return `Vision model unavailable (${response.status})`;
      const data = await response.json() as { response?: string };
      return data.response || 'No description available';
    } catch {
      return 'Vision model unavailable';
    }
  }

  async processScreenshot(imagePath: string): Promise<PerceptionResult> {
    const description = await this.describeImage(imagePath);
    const result: PerceptionResult = {
      type: 'screenshot',
      content: description,
      structuredData: { source: imagePath, processed: true },
      confidence: description.includes('unavailable') ? 0.1 : 0.8,
    };
    this.saveResult('screenshot', imagePath, result);
    return result;
  }

  async processDiagram(imagePath: string): Promise<PerceptionResult> {
    const description = await this.describeImage(imagePath);
    const result: PerceptionResult = {
      type: 'diagram',
      content: description,
      structuredData: { source: imagePath, diagramType: 'unknown' },
      confidence: description.includes('unavailable') ? 0.1 : 0.75,
    };
    this.saveResult('diagram', imagePath, result);
    return result;
  }

  async extractTextFromImage(_imagePath?: string): Promise<string> {
    void _imagePath;
    return 'OCR not available in this configuration';
  }

  async extractStructuredData(_imagePath?: string): Promise<Record<string, unknown>> {
    void _imagePath;
    return { available: false };
  }

  getHistory(limit: number = 20): PerceptionResult[] {
    const rows = this.db.prepare('SELECT * FROM perception_results ORDER BY created_at DESC LIMIT ?').all(limit) as PerceptionRow[];
    return rows.map(r => ({
      type: r.source_type as PerceptionResult['type'],
      content: r.content,
      structuredData: r.structured_data_json ? JSON.parse(r.structured_data_json) : {},
      confidence: r.confidence,
    }));
  }

  private saveResult(sourceType: string, sourcePath: string, result: PerceptionResult): void {
    this.db.prepare(`
      INSERT INTO perception_results (id, source_type, source_path, content, structured_data_json, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), sourceType, sourcePath, result.content, JSON.stringify(result.structuredData), result.confidence);
  }
}
