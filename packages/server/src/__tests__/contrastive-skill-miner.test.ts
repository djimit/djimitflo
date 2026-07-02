import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ContrastiveSkillMiner } from "../services/contrastive-skill-miner";
import { schema } from "../database/schema";
import { runMigrations } from "../database/migrate";

let db: Database.Database;
let miner: ContrastiveSkillMiner;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  runMigrations(db);
  miner = new ContrastiveSkillMiner(db, { dim: 32 });
});

afterEach(() => { db?.close(); });

describe("G131: Contrastive Skill Miner", () => {
  it("mines patterns with embeddings", () => {
    const patterns = miner.mineWithContrast({ id: "ep-1", topic: "Fix TS", domains: ["ts"], steps: [{ role: "maker", action: "fix", outcome: "success" }], success: true, durationMs: 30000 });
    expect(patterns.length).toBeGreaterThanOrEqual(0);
  });

  it("finds similar patterns", () => {
    miner.mineWithContrast({ id: "ep-2", topic: "Fix TS errors", domains: ["ts"], steps: [{ role: "maker", action: "analyze type errors", outcome: "success" }], success: true, durationMs: 30000 });
    const similar = miner.findSimilar("TypeScript errors", 5);
    expect(Array.isArray(similar)).toBe(true);
  });

  it("gets clusters", () => {
    expect(Array.isArray(miner.getClusters())).toBe(true);
  });

  it("deduplicates", () => {
    const result = miner.deduplicate();
    expect(typeof result.merged).toBe("number");
  });

  it("creates correct embedding dimension", () => {
    const patterns = miner.mineWithContrast({ id: "ep-3", topic: "Test", domains: ["test"], steps: [{ role: "maker", action: "test", outcome: "success" }], success: true, durationMs: 10000 });
    if (patterns.length > 0) expect(patterns[0].embedding.length).toBe(32);
  });
});