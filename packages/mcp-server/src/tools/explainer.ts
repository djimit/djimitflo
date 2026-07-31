/**
 * Explainer MCP tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type DbLike = any;

function createTask(db: DbLike, input: any): any {
  const id = "task-" + Math.random().toString(36).slice(2);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO explainer_tasks (id, title, description, provider, remote_url, local_path, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.title || "Untitled", input.description || "", "local", input.remote_url || input.repository_url || null, input.local_path || null, "pending", "{}", now, now);
  return { id, title: input.title, status: "created" };
}

function getTask(db: DbLike, id: string): any {
  return db.prepare("SELECT * FROM explainer_tasks WHERE id = ?").get(id);
}

function runPipeline(db: DbLike, id: string): any {
  const task = getTask(db, id);
  if (!task) throw new Error("Task not found: " + id);
  return { task_id: id, bundle_path: "/tmp/mock-bundle-" + id };
}

export function registerExplainerTools(server: McpServer, db: DbLike): void {
  server.registerTool(
    "explainer_create_task",
    {
      description: "Create an explain_repo task",
      inputSchema: {
        title: z.string(),
        provider: z.string().optional(),
        description: z.string().optional(),
        repository_url: z.string().optional(),
        local_path: z.string().optional(),
      },
    },
    async (args: any) => {
      try {
        const task = createTask(db, args || {});
        return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: "Error: " + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    "explainer_list_tasks",
    {
      description: "List explain_repo tasks",
      inputSchema: {
        status: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async (args: any) => {
      const rows = db.prepare("SELECT * FROM explainer_tasks LIMIT ?").all(args?.limit || 100) as any[];
      return { content: [{ type: "text" as const, text: JSON.stringify({ tasks: rows }, null, 2) }] };
    }
  );

  server.registerTool(
    "explainer_get_task",
    {
      description: "Get an explain_repo task by id",
      inputSchema: { id: z.string() },
    },
    async (args: any) => {
      const task = getTask(db, args?.id as string);
      if (!task) return { content: [{ type: "text" as const, text: "Task not found" }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
    }
  );

  server.registerTool(
    "explainer_run_task",
    {
      description: "Run the explain_repo pipeline for a task",
      inputSchema: { id: z.string() },
    },
    async (args: any) => {
      try {
        const result = runPipeline(db, args?.id as string);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: "Error: " + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    "explainer_list_bundles",
    {
      description: "List generated bundles for a task",
      inputSchema: { task_id: z.string() },
    },
    async (args: any) => {
      const rows = db.prepare("SELECT * FROM explainer_bundles WHERE task_id = ?").all(args?.task_id as string) as any[];
      return { content: [{ type: "text" as const, text: JSON.stringify({ bundles: rows }, null, 2) }] };
    }
  );
}
