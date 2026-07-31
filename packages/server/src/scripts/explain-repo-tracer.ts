/**
 * Tracer bullet for the explain_repo backend pipeline.
 * Runs end-to-end against a real local repository without touching the production DB.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { schema, explainerSchema } from "../database/schema";
import { runMigrations } from "../database/migrate";
import { ExplainRepoLoopRunner } from "../services/explain-repo-loop-runner";

async function main() {
  const repoPath = process.argv[2] || "/Users/dlandman/juraregel";
  const dbPath = join(mkdtempSync(join(tmpdir(), "djimitflo-explainer-tracer-")), "tracer.sqlite");
  const scratchDir = join(tmpdir(), "djimitflo-explainer-tracer-output-" + Date.now());
  process.env.DJIMITFLO_EXPLAINER_SCRATCH = scratchDir;

  console.log(`🎯 Tracer bullet: ${repoPath}`);
  console.log(`🗄️  Temp DB: ${dbPath}`);
  console.log(`📝 Scratch dir: ${scratchDir}`);

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  db.exec(explainerSchema);
  runMigrations(db);

  const runner = new ExplainRepoLoopRunner(db);
  const result = await runner.run({
    local_path: repoPath,
    title: `Tracer bullet: ${repoPath.split("/").pop() || "repository"}`,
    description: "End-to-end explain_repo tracer run",
  });

  console.log("✅ Tracer completed");
  console.log(`   task_id:     ${result.task_id}`);
  console.log(`   bundle_path: ${result.bundle_path}`);

  const task = db.prepare("SELECT * FROM explainer_tasks WHERE id = ?").get(result.task_id) as any;
  const bundle = db.prepare("SELECT * FROM explainer_bundles WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(result.task_id) as any;
  console.log(`   status:      ${task?.status}`);
  console.log(`   provider:    ${task?.provider}`);
  console.log(`   scan_id:     ${task?.scan_id || "null"}`);
  console.log(`   repository_id: ${task?.repository_id || "null"}`);
  console.log(`   bundle openmythos_score: ${bundle?.openmythos_score ?? "null"}`);

  db.close();
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch {}
  try { rmSync(join(dbPath, ".."), { recursive: true, force: true }); } catch {}
}

main().catch((err) => {
  console.error("❌ Tracer failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
