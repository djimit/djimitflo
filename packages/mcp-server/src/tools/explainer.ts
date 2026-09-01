/**
 * Explainer MCP tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync } from "node:fs";

type DbLike = any;

function createTask(db: DbLike, input: any): any {
  const id = "task-" + Math.random().toString(36).slice(2);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO explainer_tasks (id, title, description, provider, remote_url, local_path, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.title || "Untitled", input.description || "", "local", input.remote_url || input.repository_url || null, input.local_path || null, "pending", "{}", now, now);
  // Enqueue a pending explainer_jobs row so the ExplainerFleetWorker actually
  // claims and processes this task (review fix: queued-forever without a job row).
  const jobId = "job-" + id;
  db.prepare(
    "INSERT INTO explainer_jobs (id, task_id, scheduled_at, status, priority_score, scheduled_reason, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, 'mcp_createTask', ?, ?)",
  ).run(jobId, id, now, now, now);
  return { id, job_id: jobId, title: input.title, status: "created", queued: true };
}

function getTask(db: DbLike, id: string): any {
  return db.prepare("SELECT * FROM explainer_tasks WHERE id = ?").get(id);
}

/**
 * Runs the real explainer pipeline by delegating to the djimitflo server API
 * (POST /api/explainer/tasks/:id/run) when EXPLAINER_SERVER_URL is set;
 * otherwise reports the task as queued (with a guaranteed explainer_jobs row)
 * so the ExplainerFleetWorker picks it up.
 */
async function runPipeline(db: DbLike, id: string): Promise<any> {
  const task = getTask(db, id);
  if (!task) throw new Error("Task not found: " + id);
  const serverUrl = process.env.EXPLAINER_SERVER_URL;
  if (!serverUrl) {
    // Ensure a pending job row exists — without it the fleet worker never
    // claims the task and it stays pending forever (review fix).
    const existing = db.prepare(
      "SELECT id FROM explainer_jobs WHERE task_id = ? AND status IN ('pending', 'queued', 'running') LIMIT 1",
    ).get(id) as any;
    if (!existing) {
      const now = new Date().toISOString();
      const jobId = "job-" + id + "-" + Math.random().toString(36).slice(2, 6);
      db.prepare(
        "INSERT INTO explainer_jobs (id, task_id, scheduled_at, status, priority_score, scheduled_reason, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, 'mcp_reenqueue', ?, ?)",
      ).run(jobId, id, now, now, now);
      return { task_id: id, job_id: jobId, status: "queued", note: "EXPLAINER_SERVER_URL not configured; explainer_jobs row created for the server worker." };
    }
    return { task_id: id, job_id: existing.id, status: "queued", note: "Task already queued; pipeline runs on the djimitflo server worker." };
  }
  const res = await fetch(`${serverUrl}/api/explainer/tasks/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.DJIMITFLO_API_TOKEN ? { Authorization: `Bearer ${process.env.DJIMITFLO_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`Pipeline run failed via server: ${res.status} ${res.statusText}`);
  }
  const payload = (await res.json()) as { bundle_path?: string };
  return { task_id: id, bundle_path: payload.bundle_path };
}

interface KnowledgeChunkPayload {
  repo_full_name: string;
  chunk_type: string;
  section: string | null;
  fact_id: string | null;
  text: string;
  citation: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  bundle_version: string;
  valid_until: string | null;
}

function chunkLatestBundles(db: DbLike, repo?: string, limit = 10): KnowledgeChunkPayload[] {
  const bundles = repo
    ? db.prepare(
        `SELECT b.id FROM explainer_bundles b JOIN explainer_tasks t ON t.id = b.task_id
         LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
         WHERE b.status = 'published' AND dr.full_name = ? ORDER BY b.created_at DESC LIMIT ?`,
      ).all(repo, limit) as any[]
    : db.prepare(
        `SELECT id FROM explainer_bundles WHERE status = 'published' ORDER BY created_at DESC LIMIT ?`,
      ).all(limit) as any[];
  const chunks: KnowledgeChunkPayload[] = [];
  for (const bundle of bundles) {
    for (const chunk of chunkBundle(db, bundle.id)) chunks.push(chunk);
  }
  return chunks;
}

/** Minimal chunker mirroring ExplainerKnowledgeService.chunkBundle. */
function chunkBundle(db: DbLike, bundleId: string): KnowledgeChunkPayload[] {
  const row = db.prepare("SELECT * FROM explainer_bundles WHERE id = ?").get(bundleId) as any;
  if (!row) return [];
  const task = db.prepare(
    `SELECT COALESCE(dr.full_name, REPLACE(REPLACE(t.remote_url, 'https://github.com/', ''), '.git', '')) AS full_name
     FROM explainer_tasks t LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
     WHERE t.id = ?`,
  ).get(row.task_id) as any;
  const repo = task?.full_name ?? row.task_id;
  // Review fix: anchor expiry to the bundle's creation time (+7d) — recomputing
  // from "now" on every call resurrects stale bundles on old published bundles.
  const createdMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
  const validUntil = new Date(createdMs + 7 * 86400000).toISOString();
  const chunks: KnowledgeChunkPayload[] = [];

  if (row.facts_path && existsSync(row.facts_path)) {
    try {
      const facts = JSON.parse(readFileSync(row.facts_path, "utf8"));
      for (const fact of Array.isArray(facts) ? facts : []) {
        chunks.push({
          repo_full_name: repo,
          chunk_type: "fact",
          section: null,
          fact_id: fact.id ?? null,
          text: String(fact.claim ?? ""),
          citation: fact.source_ref ?? null,
          file_path: fact.file_path ?? null,
          line_start: fact.line_start ?? null,
          line_end: fact.line_end ?? null,
          bundle_version: bundleId,
          valid_until: validUntil,
        });
      }
    } catch { /* unreadable */ }
  }
  if (row.sections_path && existsSync(row.sections_path)) {
    try {
      for (const file of readdirSync(row.sections_path)) {
        if (!file.endsWith(".md")) continue;
        const text = readFileSync(row.sections_path + "/" + file, "utf8");
        chunks.push({
          repo_full_name: repo,
          chunk_type: "section",
          section: file.replace(/\.md$/, ""),
          fact_id: null,
          text: text.slice(0, 900),
          citation: null,
          file_path: null,
          line_start: null,
          line_end: null,
          bundle_version: bundleId,
          valid_until: validUntil,
        });
      }
    } catch { /* unreadable */ }
  }
  if (chunks.length === 0 && row.markdown_path && existsSync(row.markdown_path)) {
    try {
      chunks.push({
        repo_full_name: repo,
        chunk_type: "section",
        section: "explainer",
        fact_id: null,
        text: readFileSync(row.markdown_path, "utf8").slice(0, 900),
        citation: null,
        file_path: null,
        line_start: null,
        line_end: null,
        bundle_version: bundleId,
        valid_until: validUntil,
      });
    } catch { /* unreadable */ }
  }
  return chunks;
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
        const result = await runPipeline(db, args?.id as string);
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

  server.registerTool(
    "explainer_ask",
    {
      description: "Grounded Q&A over de Djimit fleet knowledge pack. Antwoord met citaten [E1]..[En] + claim-verification; weigert (NOT_ENOUGH_EVIDENCE) bij onvoldoende evidence i.p.v. te fantaseren.",
      inputSchema: {
        question: z.string().min(3).max(2000),
        repo: z.string().optional(),
      },
    },
    async (args: any) => {
      const serverUrl = process.env.EXPLAINER_SERVER_URL;
      if (!serverUrl) {
        // Zonder server-URL: extractieve lokale zoekactie over de chunks (geen LLM)
        const results = chunkLatestBundles(db, args?.repo as string | undefined, 20);
        const terms = (args?.question as string).toLowerCase().split(/\s+/).filter((t: string) => t.length > 2);
        const scored = results
          .map((chunk) => {
            const text = chunk.text.toLowerCase();
            let score = 0;
            for (const term of terms) if (text.includes(term)) score += 1;
            return { chunk, score: score / Math.max(1, terms.length) };
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        if (scored.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ refused: true, refusal_reason: "NOT_ENOUGH_EVIDENCE (lexicale fallback vond niets)", citations: [] }, null, 2) }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({
          refused: false,
          mode: "extractive",
          answer: null,
          citations: scored.map((s) => ({ repo: s.chunk.repo_full_name, section: s.chunk.section, excerpt: s.chunk.text.slice(0, 200), score: Math.round(s.score * 1000) / 1000 })),
          note: "EXPLAINER_SERVER_URL niet gezet: extractieve evidence i.p.v. gegeneraliseerd antwoord.",
        }, null, 2) }] };
      }
      try {
        const res = await fetch(`${serverUrl}/api/explainer/ask`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.DJIMITFLO_API_TOKEN ? { Authorization: `Bearer ${process.env.DJIMITFLO_API_TOKEN}` } : {}),
          },
          body: JSON.stringify({ question: args?.question, repo: args?.repo }),
        });
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Ask failed: ${res.status} ${res.statusText}` }], isError: true };
        }
        const answer = await res.json();
        return { content: [{ type: "text" as const, text: JSON.stringify(answer, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: "Error: " + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    "explainer_search_repo",
    {
      description: "Search published explainer knowledge for a repo (citation-linked chunks with valid_until freshness)",
      inputSchema: {
        repo: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async (args: any) => {
      let chunks = chunkLatestBundles(db, args?.repo as string | undefined, 20);
      const query = (args?.query as string | undefined)?.toLowerCase();
      if (query) {
        const terms = query.split(/\s+/).filter((t) => t.length > 2);
        chunks = chunks
          .map((chunk) => {
            const text = chunk.text.toLowerCase();
            let score = 0;
            for (const term of terms) if (text.includes(term)) score += 1;
            return { chunk, score };
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((r) => r.chunk);
      }
      const results = chunks.slice(0, args?.limit ?? 10);
      return { content: [{ type: "text" as const, text: JSON.stringify({ results, count: results.length }, null, 2) }] };
    }
  );

  server.registerTool(
    "explainer_get_fact",
    {
      description: "Get one explainer fact by id with its citation (file:line, graph node, or README heading)",
      inputSchema: { fact_id: z.string(), repo: z.string().optional() },
    },
    async (args: any) => {
      const factId = args?.fact_id as string;
      const repos = args?.repo ? [args.repo] : latestPublishedRepos(db);
      for (const repo of repos) {
        for (const chunk of chunkLatestBundles(db, repo, 3)) {
          // Match on the carried fact_id (review fix: earlier heuristics missed
          // normal generated ids like "fact-1" that don't appear in the text).
          if (chunk.chunk_type === "fact" && chunk.fact_id === factId) {
            return { content: [{ type: "text" as const, text: JSON.stringify(chunk, null, 2) }] };
          }
        }
      }
      return { content: [{ type: "text" as const, text: `Fact not found: ${factId}` }], isError: true };
    }
  );

  server.registerTool(
    "explainer_compare_repos",
    {
      description: "Compare published explainer knowledge across two or more repos (stack, health, score, freshness)",
      inputSchema: { repos: z.array(z.string()).min(2) },
    },
    async (args: any) => {
      const repos = (args?.repos as string[]) ?? [];
      const comparison = repos.map((repo) => {
        const bundle = db.prepare(
          `SELECT b.id, b.openmythos_score, b.created_at FROM explainer_bundles b
           JOIN explainer_tasks t ON t.id = b.task_id
           LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
           WHERE b.status = 'published' AND dr.full_name = ? ORDER BY b.created_at DESC LIMIT 1`,
        ).get(repo) as any;
        const discovered = db.prepare("SELECT language, license, priority_tier FROM discovered_repositories WHERE full_name = ?").get(repo) as any;
        return {
          repo,
          openmythos_score: bundle?.openmythos_score ?? null,
          last_generated: bundle?.created_at ?? null,
          language: discovered?.language ?? null,
          license: discovered?.license ?? null,
          priority_tier: discovered?.priority_tier ?? null,
          chunk_preview: chunkLatestBundles(db, repo, 1).slice(0, 3),
        };
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ comparison }, null, 2) }] };
    }
  );
}

function latestPublishedRepos(db: DbLike): string[] {
  const rows = db.prepare(
    `SELECT COALESCE(dr.full_name, t.remote_url) AS full_name
     FROM explainer_bundles b JOIN explainer_tasks t ON t.id = b.task_id
     LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
     WHERE b.status = 'published' AND full_name IS NOT NULL
     GROUP BY full_name ORDER BY b.created_at DESC LIMIT 30`,
  ).all() as any[];
  return rows.map((r: any) => r.full_name);
}
