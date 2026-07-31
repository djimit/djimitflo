#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const batch = JSON.parse(fs.readFileSync(path.join(here, "goals.batch.json"), "utf8"));

if (!process.argv.includes("--dry-run")) {
  console.error("Preview only. Use --dry-run; goal creation remains an explicit operator action.");
  process.exit(1);
}

console.log(JSON.stringify({
  change: batch.change,
  goals: batch.goals.length,
  ids: batch.goals.map((goal) => goal.id),
  policy: batch.policy
}, null, 2));
