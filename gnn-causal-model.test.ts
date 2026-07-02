import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { GNNCausalModel } from "../services/gnn-causal-model";
import { schema } from "../database/schema";
import { runMigrations } from "../database/migrate";

let db: Database.Database;
let gnn: GNNCausalModel;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  runMigrations(db);
  gnn = new GNNCausalModel(db);
});

afterEach(() => { db?.close(); });

describe("G134: GNN Causal Model", () => {
  it("adds nodes", () => {
    gnn.addNode({ id: "n1", features: [0.1, 0.2], nodeType: "agent", label: "Agent 1" });
    expect(gnn.stats().nodes).toBe(1);
  });

  it("adds edges", () => {
    gnn.addNode({ id: "n2", features: [0.1], nodeType: "action", label: "Action 1" });
    gnn.addNode({ id: "n3", features: [0.5], nodeType: "outcome", label: "Success" });
    gnn.addEdge({ id: "e1", from: "n2", to: "n3", relation: "causes", weight: 0.9 });
    expect(gnn.stats().edges).toBe(1);
  });

  it("predicts intervention", () => {
    gnn.addNode({ id: "n4", features: [0.2], nodeType: "context", label: "codex" });
    gnn.addNode({ id: "n5", features: [0.8], nodeType: "outcome", label: "success" });
    gnn.addEdge({ id: "e2", from: "n4", to: "n5", relation: "leads_to", weight: 0.8 });
    const prediction = gnn.predict("n4");
    expect(prediction.predictedOutcome).toBeGreaterThanOrEqual(0);
    expect(prediction.predictedOutcome).toBeLessThanOrEqual(1);
  });

  it("learns from observation", () => {
    gnn.learn({ runtime: "codex", capability: "ts-fix" }, 1.0);
    expect(gnn.stats().nodes).toBeGreaterThanOrEqual(2);
  });

  it("gets stats", () => {
    const stats = gnn.stats();
    expect(typeof stats.nodes).toBe("number");
    expect(typeof stats.edges).toBe("number");
  });
});