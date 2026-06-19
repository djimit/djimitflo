#!/usr/bin/env node

// Batch runner for the nested-swarm-control-loop OpenSpec change.
// Models the g15 pair: POSTs goals to the djimitflo HTTP API with workers/loops
// disabled. No git, no direct codex, no auto-commit. Safe.

import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const batchPath = process.argv.find((arg) => arg.startsWith('--batch='))?.slice('--batch='.length)
  || path.join(here, 'goals.batch.json');
const shouldDecompose = process.argv.includes('--decompose');
const dryRun = process.argv.includes('--dry-run');
const apiBase = process.env.DJIMITFLO_API_BASE || 'http://127.0.0.1:3001/api';
const token = process.env.DJIMITFLO_TOKEN;

if (!dryRun && !token) {
  console.error('DJIMITFLO_TOKEN is required unless --dry-run is used.');
  process.exit(2);
}

const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const created = new Map();

async function request(method, route, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${route} failed: ${response.status} ${text}`);
  }
  return parsed;
}

for (const goal of batch.ordered_goals) {
  for (const dep of goal.depends_on || []) {
    if (!created.has(dep)) {
      throw new Error(`Goal ${goal.key} depends on ${dep}, but ${dep} has not been created in this batch.`);
    }
  }

  const body = {
    ...goal.api.body,
    metadata: {
      ...(goal.api.body.metadata || {}),
      batch_key: goal.key,
      depends_on: goal.depends_on || [],
      dependency_goal_ids: (goal.depends_on || []).map((dep) => created.get(dep)),
      batch_change: batch.change,
      batch_policy: batch.policy,
    },
  };

  if (dryRun) {
    console.log(JSON.stringify({ action: 'create_goal', key: goal.key, body }, null, 2));
    created.set(goal.key, `dry-run:${goal.key}`);
    continue;
  }

  const createdGoal = await request(goal.api.method, goal.api.path, body);
  created.set(goal.key, createdGoal.id);
  console.log(JSON.stringify({ action: 'created_goal', key: goal.key, goal_id: createdGoal.id }));

  if (shouldDecompose) {
    const decomposed = await request('POST', `/goals/${createdGoal.id}/decompose`);
    console.log(JSON.stringify({
      action: 'decomposed_goal',
      key: goal.key,
      goal_id: createdGoal.id,
      candidate_count: decomposed.candidates?.length ?? 0,
    }));
  }
}

if (!dryRun) {
  console.log(JSON.stringify({
    action: 'batch_complete',
    created_goals: Object.fromEntries(created.entries()),
    auto_spawn_workers: false,
    auto_start_loops: false,
    auto_promote_memory: false,
  }));
}