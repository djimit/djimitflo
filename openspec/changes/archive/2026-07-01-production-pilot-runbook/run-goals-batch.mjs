#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const batch = JSON.parse(fs.readFileSync(path.join(here, "goals.batch.json"), "utf8"));

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({
    change: batch.change,
    goals: batch.goals.length,
    ids: batch.goals.map((goal) => goal.key),
    policy: batch.policy
  }, null, 2));
  process.exit(0);
}

console.error("This helper only previews the batch. Use --dry-run.");
process.exit(1);
