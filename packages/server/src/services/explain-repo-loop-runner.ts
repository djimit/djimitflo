/**
 * ExplainRepoLoopRunner — registered loop runner for the explain_repo loop.
 */

import type { Database } from "better-sqlite3";
import { ExplainerGenerationService } from "./explainer-generation-service";

export interface ExplainRepoLoopInput {
  repository_url?: string;
  local_path?: string;
  title?: string;
  description?: string;
}

export class ExplainRepoLoopRunner {
  private service: ExplainerGenerationService;

  constructor(db: Database) {
    this.service = new ExplainerGenerationService(db);
  }

  async run(input: ExplainRepoLoopInput): Promise<{ task_id: string; bundle_path: string }> {
    if (!input.repository_url && !input.local_path) {
      throw new Error("Either repository_url or local_path is required");
    }
    const task = await this.service.createTask({
      title: input.title || (input.repository_url || input.local_path || "Untitled explainer"),
      description: input.description || "",
      remote_url: input.repository_url,
      local_path: input.local_path,
      metadata: { loop_name: "explain_repo" },
    });
    const bundlePath = await this.service.runPipeline(task.id, { skipGraph: false, skipEval: false, dryRun: false });
    return { task_id: task.id, bundle_path: bundlePath };
  }
}
