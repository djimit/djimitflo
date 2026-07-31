import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Database from "better-sqlite3";
import { registerExplainerTools } from "../tools/explainer";
import { fullSchema } from "../database/schema";

describe("Explainer MCP tools", () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(fullSchema);
    server = new McpServer({ name: "test", version: "0.0.1" });
    registerExplainerTools(server, db as any);
  });

  afterEach(() => {
    db.close();
  });

  function getTool(name: string): any {
    return (server as any)._registeredTools?.[name]?.handler;
  }

  it("registers explainer MCP tools", () => {
    expect(getTool("explainer_create_task")).toBeDefined();
    expect(getTool("explainer_run_task")).toBeDefined();
    expect(getTool("explainer_list_tasks")).toBeDefined();
    expect(getTool("explainer_get_task")).toBeDefined();
    expect(getTool("explainer_list_bundles")).toBeDefined();
  });

  it("creates a task via MCP", async () => {
    const tool = getTool("explainer_create_task");
    expect(tool).toBeDefined();
    const res = await tool({ title: "Test" });
    const body = JSON.parse(res.content[0].text);
    expect(body.id).toBeDefined();
  });

  it("runs a task via MCP", async () => {
    const create = getTool("explainer_create_task");
    const created = await create({ title: "Test" });
    const { id } = JSON.parse(created.content[0].text);
    const run = getTool("explainer_run_task");
    expect(run).toBeDefined();
    const res = await run({ id });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.bundle_path).toBeDefined();
  });
});
