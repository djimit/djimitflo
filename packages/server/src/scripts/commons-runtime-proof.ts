/** Real CLI → signed HTTP → production-schema SQLite → peer reply proof, isolated from production. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { schema, explainerSchema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { createAgentSocialRuntimeRoutes } from '../routes/swarm-orchestration';
import { mintSpawnToken } from '../services/spawn-token';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1] || '';
  };
  const runtimes = [...new Set(option('runtimes', 'claude,opencode').split(','))];
  const rounds = Number(option('rounds', '2'));
  assert(runtimes.length >= 2 && runtimes.length <= 6 && runtimes.every(runtime => /^[a-z]+$/.test(runtime)), 'select 2–6 distinct runtimes');
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 6, 'rounds must be 1–6');
  const output = resolve(option('output', '') || mkdtempSync(join(tmpdir(), 'commons-proof-')));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  // A fresh file prevents a proof from modifying a supplied existing database.
  const dbPath = join(output, 'commons.sqlite');
  writeFileSync(dbPath, '', { flag: 'wx', mode: 0o600 });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON'); db.exec(schema); db.exec(explainerSchema); runMigrations(db);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const sourceSnapshot = Object.fromEntries([
    'packages/server/src/scripts/commons-runtime-proof.ts', 'packages/server/src/services/agent-communication-service.ts',
    'packages/server/src/services/self-improvement-service.ts', 'packages/server/src/routes/swarm-orchestration.ts', 'scripts/agent-social-poller.py',
  ].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
  process.env.DJIMITFLO_COMMIT_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  process.env.DJIMITFLO_SPAWN_TOKEN_SECRET = randomBytes(32).toString('hex');
  const comms = new AgentCommunicationService(db);
  const agents = runtimes.map(runtime => ({ id: `commons-proof-${runtime}`, runtime, model: process.env[`${runtime.toUpperCase()}_SOCIAL_MODEL`] || '' }));
  for (const agent of agents) {
    db.prepare('INSERT INTO agents (id,name,description,status,capabilities,metadata) VALUES (?,?,?,\'active\',?,\'{}\')')
      .run(agent.id, agent.id, 'Isolated real-runtime collaboration proof', JSON.stringify([agent.runtime, 'ecosystem-improvement']));
  }
  db.prepare(`INSERT INTO swarm_claims (id,claim,claim_type,subject_ref,predicate,status,created_from,evidence_refs_json)
    VALUES ('commons-proof-gap',?,'hypothesis','djimitflo','gap','proposed','operator-proof',?)`).run(
    option('topic', 'Djimitflo Commons currently requires structured peer answers and stores reflection candidates. Propose a useful functionality improvement for collaboration across Djimitflo, Paperclip or the knowledge cockpit. Challenge assumptions, invent a cheap discriminating test, and suggest a topic you want to explore. Component roles are context; no measured benefit is established.'),
    JSON.stringify(['source:packages/server/src/services/agent-communication-service.ts', 'source:scripts/agent-social-poller.py']),
  );
  const app = express(); app.use(express.json());
  app.use('/api/swarm-v2/social-runtime', createAgentSocialRuntimeRoutes(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolveReady => server.once('listening', resolveReady));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const attempts: Array<{ agent: string; exit: number | null; poller_sha256: string; stdout: string; stderr: string }> = [];
  const poll = async (agent: typeof agents[number]): Promise<void> => {
    const token = mintSpawnToken(process.env.DJIMITFLO_SPAWN_TOKEN_SECRET!, agent.id, 'social-runtime', 30 * 60_000);
    const pollerHash = createHash('sha256').update(readFileSync(join(root, 'scripts/agent-social-poller.py'))).digest('hex');
    const child = spawn('python3', [join(root, 'scripts/agent-social-poller.py')], {
      cwd: root, env: { ...process.env, DJIMITFLO_URL: base, DJIMITFLO_AGENT_ID: agent.id, DJIMITFLO_SOCIAL_TOKEN: token, SOCIAL_RUNTIME: agent.runtime, SOCIAL_MODEL_ID: agent.model },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exit = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
    // Poller output contains summaries, never credentials or raw CLI prompts.
    attempts.push({ agent: agent.id, exit, poller_sha256: pollerHash, stdout: stdout.replaceAll(token, '[REDACTED]'), stderr: stderr.replaceAll(token, '[REDACTED]') });
    writeFileSync(join(output, 'attempts.json'), `${JSON.stringify(attempts, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ agent: agent.id, exit }));
  };
  try {
    // Real poller heartbeats, then two passes per round: responses and peer reflections.
    await Promise.all(agents.map(poll));
    for (let round = 0; round < rounds; round += 1) {
      const exchange = comms.socialize(0, 'operator');
      console.log(JSON.stringify({ round, status: exchange.status, topic: exchange.topic, participants: exchange.participants }));
      if (exchange.status !== 'started') break;
      for (let pass = 0; pass < 2; pass += 1) await Promise.all(agents.filter(agent => exchange.participants.includes(agent.id)).map(poll));
    }
    const commons = comms.listSocialCommons();
    const improvements = db.prepare('SELECT id,title,status,evidence_refs_json,panel_id FROM self_improvements').all();
    const summary = { scope: 'isolated-real-runtime-proof', source_commit: process.env.DJIMITFLO_COMMIT_SHA, source_sha256: sourceSnapshot, rounds, attempts, commons, improvements };
    writeFileSync(join(output, 'evidence.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    const actual = new Set(commons.threads.flatMap(thread => thread.messages).filter(message => message.action !== 'social.question').map(message => message.runtime));
    console.log(JSON.stringify({ output, actual_runtimes: [...actual], threads: commons.threads.length, improvements: improvements.length }));
    assert(runtimes.every(runtime => actual.has(runtime)), 'not every requested runtime actually replied; inspect evidence.json (increase rounds for larger fleets)');
    assert(commons.threads.length === rounds && commons.threads.every(thread => thread.learnings === 2), 'some peer reflections are incomplete');
    assert(attempts.every(attempt => attempt.exit === 0), 'some runtime polls failed; inspect evidence.json');
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    db.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
