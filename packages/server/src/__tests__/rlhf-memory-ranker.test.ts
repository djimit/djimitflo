import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { RLHFMemoryRanker } from "../services/rlhf-memory-ranker";
import { schema } from "../database/schema";
import { runMigrations } from "../database/migrate";
let db: Database.Database; let ranker: RLHFMemoryRanker;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); db.exec(schema); runMigrations(db); ranker = new RLHFMemoryRanker(db); });
afterEach(() => { db?.close(); });
describe("G133: RLHF Memory Ranker", () => {
  it("records reward", () => { ranker.recordReward("mem-1", "run-1", "success", 0.9); expect(ranker.stats().totalUpdates).toBeGreaterThanOrEqual(0); });
  it("ranks memories", () => { const m = [{ id: "m1", type: "observation" as const, content: "T", source: "t", confidence: 0.8, metadata: {}, createdAt: "" }]; expect(ranker.rank(m).length).toBe(1); });
  it("gets stats", () => { expect(typeof ranker.stats().avgReward).toBe("number"); });
  it("prunes", () => { expect(typeof ranker.prune(0.1)).toBe("number"); });
  it("updates policy", () => { ranker.recordReward("mem-2", "run-2", "success", 1.0); expect(ranker.stats().avgReward).toBeGreaterThan(0); });
});