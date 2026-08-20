
import Database from "better-sqlite3";
import { fullSchema } from "./src/database/schema";
import { ExplainerGenerationService } from "./src/services/explainer-generation-service";

async function main() {
  const db = new Database(":memory:");
  db.exec(fullSchema);
  const service = new ExplainerGenerationService(db);
  const task = await service.createTask({ title: "Juraregel explainer", local_path: "/Users/dlandman/juraregel" });
  const bundlePath = await service.runPipeline(task.id);
  console.log(JSON.stringify({ task_id: task.id, bundle_path: bundlePath }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
