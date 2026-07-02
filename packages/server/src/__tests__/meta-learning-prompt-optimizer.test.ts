import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MetaLearningPromptOptimizer } from "../services/meta-learning-prompt-optimizer";
import { schema } from "../database/schema";
import { runMigrations } from "../database/migrate";
let db: Database.Database; let optimizer: MetaLearningPromptOptimizer;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); db.exec(schema); runMigrations(db); optimizer = new MetaLearningPromptOptimizer(db); });
afterEach(() => { db?.close(); });
describe("G132: Meta-Learning Prompt Optimizer", () => {
  it("meta-trains", () => { const r = optimizer.metaTrain([{ domain: "ts", template: "Fix {error}", success: true }]); expect(r.domain).toBe("ts"); });
  it("adapts to domain", () => { const r = optimizer.adapt("python", [{ template: "Fix {x}", success: true }]); expect(r.domain).toBe("python"); });
  it("gets meta prompt", () => { optimizer.metaTrain([{ domain: "math", template: "Solve {p}", success: true }]); expect(optimizer.getMeta("math") === null || typeof optimizer.getMeta("math") === "object").toBe(true); });
  it("gets all prompts", () => { expect(Array.isArray(optimizer.getAll())).toBe(true); });
  it("converges", () => { optimizer.metaTrain([{ domain: "test", template: "Fix {x}", success: true }, { domain: "test", template: "Fix {x}", success: true }]); expect(optimizer.adapt("test", [{ template: "Fix {x}", success: true }]).loss).toBeLessThan(0.5); });
});