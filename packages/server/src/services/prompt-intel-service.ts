import { Database } from "better-sqlite3";
import { readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";

export interface PromptIntelFinding {
  category: string;
  path: string;
  matched_keywords: string[];
  relevance_score: number;
  content_preview: string;
  content_hash: string;
  content_length: number;
}

interface PromptIntelEvent {
  source: string;
  sha: string;
  context: string;
  task_title: string;
  severity: string;
}

const CATEGORY_TO_DOMAIN: Record<string, string> = {
  dispatch: "orchestration",
  skill: "skill-design",
  safety: "agent-lifecycle",
  memory: "agent-memory",
  anti_extract: "security",
  agent_lifecycle: "agent-lifecycle",
  governance: "governance",
};

const MIN_RELEVANCE = 0.4;

export class PromptIntelService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_intel_imports (
        id TEXT PRIMARY KEY,
        source_repo TEXT NOT NULL,
        source_sha TEXT NOT NULL,
        file_path TEXT NOT NULL,
        category TEXT NOT NULL,
        relevance_score REAL NOT NULL,
        content_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL DEFAULT (datetime("now")),
        UNIQUE(source_sha, file_path, category)
      )
    `);
  }

  ingestFromPending(pendingPath: string): { imported: number; skipped: number } {
    if (!existsSync(pendingPath)) {
      return { imported: 0, skipped: 0 };
    }

    const lines = readFileSync(pendingPath, "utf-8").trim().split("\n");
    let imported = 0;
    let skipped = 0;

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO prompt_intel_imports
        (id, source_repo, source_sha, file_path, category, relevance_score, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const registerPatternStmt = this.db.prepare(`
      INSERT OR IGNORE INTO prompt_patterns (id, name, template, domain)
      VALUES (?, ?, ?, ?)
    `);

    for (const line of lines) {
      if (!line.trim()) continue;

      let event: PromptIntelEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.source !== "prompt-intel") continue;

      let finding: PromptIntelFinding;
      try {
        finding = JSON.parse(event.context);
      } catch {
        continue;
      }

      if (finding.relevance_score < MIN_RELEVANCE) {
        skipped++;
        continue;
      }

      const id = randomUUID();
      const domain = CATEGORY_TO_DOMAIN[finding.category] || "general";

      const result = insertStmt.run(
        id,
        "asgeirtj/system_prompts_leaks",
        event.sha,
        finding.path,
        finding.category,
        finding.relevance_score,
        finding.content_hash,
      );

      if (result.changes > 0) {
        registerPatternStmt.run(
          randomUUID(),
          "prompt-intel:" + finding.category + ":" + finding.path,
          finding.content_preview.slice(0, 500),
          domain,
        );
        imported++;
      } else {
        skipped++;
      }
    }

    return { imported, skipped };
  }

  getImportStats(): { total: number; byCategory: Record<string, number> } {
    const total = (this.db
      .prepare("SELECT COUNT(*) as c FROM prompt_intel_imports")
      .get() as { c: number }).c;

    const rows = this.db
      .prepare("SELECT category, COUNT(*) as c FROM prompt_intel_imports GROUP BY category")
      .all() as Array<{ category: string; c: number }>;

    const byCategory: Record<string, number> = {};
    for (const row of rows) {
      byCategory[row.category] = row.c;
    }

    return { total, byCategory };
  }

  getRecentImports(limit: number = 20): Array<{
    file_path: string;
    category: string;
    relevance_score: number;
    imported_at: string;
  }> {
    return this.db
      .prepare(
        "SELECT file_path, category, relevance_score, imported_at FROM prompt_intel_imports ORDER BY imported_at DESC LIMIT ?",
      )
      .all(limit) as Array<{
      file_path: string;
      category: string;
      relevance_score: number;
      imported_at: string;
    }>;
  }
}
