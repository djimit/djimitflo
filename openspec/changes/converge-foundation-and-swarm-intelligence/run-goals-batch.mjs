#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'openspec/changes/converge-foundation-and-swarm-intelligence/goals.batch.json');
const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--apply');

console.log(JSON.stringify({
  change: payload.change,
  dry_run: dryRun,
  goal_count: payload.goals.length,
  goals: payload.goals.map((goal, index) => ({
    order: index + 1,
    key: goal.key,
    objective: goal.objective,
    depends_on: goal.depends_on || [],
  })),
}, null, 2));
