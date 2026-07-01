import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { execFileSync } from 'child_process';
import { initializeDatabase } from '../database';
import { LoopService, type LoopName } from '../services/loop-service';
import { SwarmStatusService, type WorkerPoolPlanInput } from '../services/swarm-status-service';
import { type WorkItemCreateInput } from '../services/work-item-service';
import { IntegrationInboxService } from '../services/integration-inbox-service';

type RiskClass = 'low' | 'medium' | 'high' | 'critical';
type WorkerRuntime = 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'mock' | 'manual';

const LOOP_NAMES = new Set<LoopName>([
  'doc-drift-and-small-fix-loop',
  'repo-maintenance-loop',
  'skill-quality-loop',
  'mcp-connector-validation-loop',
  'security-regression-loop',
  'okf-synchronization-loop',
  'overwatch-policy-drift-loop',
]);

interface ParsedIssueRef {
  owner: string;
  repo: string;
  number: number;
  repo_slug: string;
  source_ref: string;
  url: string;
}

interface GithubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state?: string;
  labels?: Array<string | { name?: string }>;
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseIssueRef(input: string): ParsedIssueRef {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[?#].*)?$/);
  const shorthandMatch = trimmed.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  const match = urlMatch || shorthandMatch;
  if (!match) {
    throw new Error('ISSUE_REF_INVALID');
  }

  const owner = match[1];
  const repo = match[2];
  const number = Number(match[3]);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('ISSUE_REF_INVALID');
  }

  return {
    owner,
    repo,
    number,
    repo_slug: `${owner}/${repo}`,
    source_ref: `${owner}/${repo}#${number}`,
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
  };
}

export function issueLabels(issue: GithubIssue): string[] {
  return (issue.labels || [])
    .map((label) => typeof label === 'string' ? label : String(label.name || ''))
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

export function riskFromIssue(issue: GithubIssue, override?: string | boolean): RiskClass {
  if (typeof override === 'string' && ['low', 'medium', 'high', 'critical'].includes(override)) {
    return override as RiskClass;
  }
  const labels = issueLabels(issue);
  if (labels.some((label) => ['critical', 'sev1', 'p0'].includes(label))) return 'critical';
  if (labels.some((label) => ['high', 'sev2', 'p1'].includes(label))) return 'high';
  if (labels.some((label) => ['medium', 'p2'].includes(label))) return 'medium';
  return 'low';
}

export function issueToWorkItemInput(
  ref: ParsedIssueRef,
  issue: GithubIssue,
  options: { repository_path?: string; loop_name?: string; risk_class?: string | boolean } = {},
): WorkItemCreateInput {
  const loopName = LOOP_NAMES.has(options.loop_name as LoopName)
    ? options.loop_name as LoopName
    : 'repo-maintenance-loop';
  const description = [
    issue.body?.trim() || `Resolve GitHub issue ${ref.source_ref}.`,
    '',
    `Source: ${issue.url || ref.url}`,
  ].join('\n').trim();

  return {
    title: issue.title,
    description,
    source: 'github_issue',
    source_ref: ref.source_ref,
    risk_class: riskFromIssue(issue, options.risk_class),
    value_score: 85,
    confidence: 0.82,
    status: 'triaged',
    recommended_loop: loopName,
    metadata: {
      github: {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.number,
        issue_url: issue.url || ref.url,
        state: issue.state || null,
        labels: issueLabels(issue),
      },
      repository_path: options.repository_path ? path.resolve(options.repository_path) : null,
    },
  };
}

export function buildPrBody(input: {
  issue_ref?: string;
  issue_url?: string;
  loop_run_id: string;
  status: string;
  gates: Array<{ name?: string; status?: string; evidence?: string }>;
  leases: Array<{ id: string; role: string; runtime: string; status: string; branch_name: string | null; worktree_path: string | null; metadata: Record<string, unknown> }>;
  state_file?: string | null;
}): string {
  const makerLeases = input.leases.filter((lease) => lease.role === 'maker');
  const checkerLeases = input.leases.filter((lease) => lease.role === 'checker');
  const gateLines = input.gates.length > 0
    ? input.gates.map((gate) => `- ${gate.status || 'unknown'}: ${gate.name || 'gate'}${gate.evidence ? ` - ${gate.evidence}` : ''}`)
    : ['- skipped: no gates recorded'];
  const leaseLines = input.leases.length > 0
    ? input.leases.map((lease) => `- ${lease.role}/${lease.runtime}: ${lease.status} (${lease.id})`)
    : ['- no worker leases recorded'];
  const closeLine = input.issue_ref ? `\nCloses ${input.issue_ref}\n` : '';

  return [
    '## Djimitflo co-creation run',
    '',
    closeLine.trim(),
    '',
    `Loop run: ${input.loop_run_id}`,
    `Loop status: ${input.status}`,
    input.issue_url ? `Issue: ${input.issue_url}` : '',
    input.state_file ? `State file: ${input.state_file}` : '',
    '',
    '## Worker evidence',
    '',
    `Maker workers: ${makerLeases.length}`,
    `Checker workers: ${checkerLeases.length}`,
    '',
    ...leaseLines,
    '',
    '## Gates',
    '',
    ...gateLines,
    '',
    '## Merge policy',
    '',
    'This PR is prepared by Djimitflo. Merge remains human-approved; the loop does not auto-merge.',
  ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n').trim() + '\n';
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }

  return { command, positionals, flags };
}

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boolFlag(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

function runtimeFlag(flags: ParsedArgs['flags'], name: string, fallback: WorkerRuntime): WorkerRuntime {
  const value = stringFlag(flags, name) || fallback;
  if (!['codex', 'opencode', 'claude', 'gemini', 'editor', 'mock', 'manual'].includes(value)) {
    throw new Error(`RUNTIME_INVALID:${value}`);
  }
  return value as WorkerRuntime;
}

function readIssueFromFile(filePath: string, ref: ParsedIssueRef): GithubIssue {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<GithubIssue>;
  return {
    number: Number(parsed.number || ref.number),
    title: String(parsed.title || '').trim(),
    body: String(parsed.body || ''),
    url: String(parsed.url || ref.url),
    state: parsed.state,
    labels: parsed.labels || [],
  };
}

function fetchIssue(ref: ParsedIssueRef, flags: ParsedArgs['flags']): GithubIssue {
  const issueFile = stringFlag(flags, 'issue-file');
  if (issueFile) {
    const issue = readIssueFromFile(issueFile, ref);
    if (!issue.title) throw new Error('ISSUE_TITLE_REQUIRED');
    return issue;
  }

  const title = stringFlag(flags, 'title');
  if (title) {
    return {
      number: ref.number,
      title,
      body: stringFlag(flags, 'body') || '',
      url: ref.url,
      state: 'OPEN',
      labels: [],
    };
  }

  const raw = execFileSync('gh', [
    'issue',
    'view',
    String(ref.number),
    '--repo',
    ref.repo_slug,
    '--json',
    'number,title,body,url,state,labels',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const issue = JSON.parse(raw) as GithubIssue;
  if (!issue.title?.trim()) throw new Error('ISSUE_TITLE_REQUIRED');
  return issue;
}

function commandImportIssue(args: ParsedArgs): Record<string, unknown> {
  const issueRef = args.positionals[0];
  if (!issueRef) throw new Error('Usage: github:cocreate import-issue <owner/repo#issue|url>');

  const ref = parseIssueRef(issueRef);
  const issue = fetchIssue(ref, args.flags);
  const db = initializeDatabase();
  try {
    const service = new IntegrationInboxService(db);
    const result = service.importEvent(issueToWorkItemInput(ref, issue, {
      repository_path: stringFlag(args.flags, 'repo-path'),
      loop_name: stringFlag(args.flags, 'loop'),
      risk_class: args.flags.risk,
    }) as any);
    return {
      action: 'imported',
      created: result.created,
      work_item: result.work_item,
    };
  } finally {
    db.close();
  }
}

function commandSchedule(args: ParsedArgs): Record<string, unknown> {
  const workItemId = args.positionals[0];
  if (!workItemId) throw new Error('Usage: github:cocreate schedule <work-item-id> --repo-path <path>');

  const db = initializeDatabase();
  try {
    const scheduler = new SwarmStatusService(db);
    const tick = scheduler.tickScheduler({
      work_item_ids: [workItemId],
      plan_triaged: true,
      prepare_planned: true,
      repository_path: stringFlag(args.flags, 'repo-path'),
      runtime: runtimeFlag(args.flags, 'runtime', 'manual'),
      max_assignments_per_item: Number(stringFlag(args.flags, 'max-assignments') || 1),
      max_items: 1,
    });
    return { action: 'scheduled', tick };
  } finally {
    db.close();
  }
}

async function commandDrain(args: ParsedArgs): Promise<Record<string, unknown>> {
  const db = initializeDatabase();
  try {
    const fleet = new SwarmStatusService(db);
    const input: WorkerPoolPlanInput = {
      runtime: runtimeFlag(args.flags, 'runtime', 'mock'),
      max_workers: Number(stringFlag(args.flags, 'max-workers') || 1),
      timeout_ms: Number(stringFlag(args.flags, 'timeout-ms') || 120_000),
      diff_max_lines: Number(stringFlag(args.flags, 'diff-max-lines') || 400),
      skip_permissions: boolFlag(args.flags, 'skip-permissions'),
      ignore_capacity: boolFlag(args.flags, 'ignore-capacity'),
      allow_high_risk: boolFlag(args.flags, 'allow-high-risk'),
    };
    const checkerRuntime = stringFlag(args.flags, 'checker-runtime');
    if (checkerRuntime && checkerRuntime !== 'manual') {
      input.checker_runtime = runtimeFlag(args.flags, 'checker-runtime', 'mock') as Exclude<WorkerRuntime, 'manual'>;
    }
    const drain = await fleet.drainWorkerPool(input);
    const sync = fleet.syncBacklogFromFleet();
    return { action: 'drained', drain, sync };
  } finally {
    db.close();
  }
}

async function commandRunIssue(args: ParsedArgs): Promise<Record<string, unknown>> {
  const imported = commandImportIssue(args) as { work_item: { id: string } };
  const scheduled = commandSchedule({
    ...args,
    command: 'schedule',
    positionals: [imported.work_item.id],
  });
  let drain: Record<string, unknown> | null = null;
  if (boolFlag(args.flags, 'start-workers')) {
    drain = await commandDrain(args);
  }
  return {
    action: 'run_issue',
    imported,
    scheduled,
    drain,
  };
}

function commandPrBundle(args: ParsedArgs): Record<string, unknown> {
  const loopRunId = args.positionals[0];
  if (!loopRunId) throw new Error('Usage: github:cocreate pr-bundle <loop-run-id>');

  const db = initializeDatabase();
  try {
    const loops = new LoopService(db);
    const bundle = loops.getReviewBundle(loopRunId);
    const issueRef = stringFlag(args.flags, 'issue');
    const issueUrl = issueRef ? parseIssueRef(issueRef).url : undefined;
    const body = buildPrBody({
      issue_ref: issueRef,
      issue_url: issueUrl,
      loop_run_id: bundle.run.id,
      status: bundle.run.status,
      gates: bundle.run.gates,
      leases: bundle.leases,
      state_file: bundle.run.state_file,
    });

    const bodyFile = path.join(os.tmpdir(), `djimitflo-pr-${loopRunId}.md`);
    fs.writeFileSync(bodyFile, body, 'utf8');
    const makerBranch = bundle.leases.find((lease) => lease.role === 'maker' && lease.branch_name)?.branch_name;
    const title = stringFlag(args.flags, 'title') || `Djimitflo co-creation run ${loopRunId.slice(0, 8)}`;

    let createdPr: string | null = null;
    if (boolFlag(args.flags, 'create')) {
      const repo = stringFlag(args.flags, 'repo');
      if (!repo) throw new Error('PR_REPO_REQUIRED');
      if (!makerBranch) throw new Error('PR_HEAD_BRANCH_REQUIRED');
      createdPr = execFileSync('gh', [
        'pr',
        'create',
        '--repo',
        repo,
        '--head',
        makerBranch,
        '--base',
        stringFlag(args.flags, 'base') || 'main',
        '--title',
        title,
        '--body-file',
        bodyFile,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    }

    return {
      action: 'pr_bundle',
      loop_run_id: loopRunId,
      body_file: bodyFile,
      head_branch: makerBranch || null,
      created_pr: createdPr,
      body,
    };
  } finally {
    db.close();
  }
}

function commandSelfTest(): Record<string, unknown> {
  const ref = parseIssueRef('openai/codex#42');
  assert.equal(ref.source_ref, 'openai/codex#42');
  assert.equal(parseIssueRef('https://github.com/openai/codex/issues/42').repo_slug, 'openai/codex');

  const input = issueToWorkItemInput(ref, {
    number: 42,
    title: 'Ship co-creation loop',
    body: 'Make issue to PR work end to end.',
    url: ref.url,
    labels: [{ name: 'P2' }],
  }, { repository_path: '.', loop_name: 'repo-maintenance-loop' });
  assert.equal(input.source, 'github_issue');
  assert.equal(input.status, 'triaged');
  assert.equal(input.risk_class, 'medium');

  const body = buildPrBody({
    issue_ref: ref.source_ref,
    issue_url: ref.url,
    loop_run_id: 'loop-1',
    status: 'ready_for_human_merge',
    gates: [{ name: 'checker_verdict', status: 'pass', evidence: 'accepted' }],
    leases: [{ id: 'lease-1', role: 'maker', runtime: 'mock', status: 'completed', branch_name: 'codex/demo', worktree_path: '/tmp/demo', metadata: {} }],
  });
  assert.match(body, /Closes openai\/codex#42/);
  assert.match(body, /Maker workers: 1/);
  return { action: 'self_test', passed: true };
}

function printHelp(): Record<string, unknown> {
  return {
    usage: [
      'npm run github:cocreate -- import-issue <owner/repo#issue|url> [--repo-path .]',
      'npm run github:cocreate -- schedule <work-item-id> --repo-path . [--runtime mock]',
      'npm run github:cocreate -- drain [--runtime codex] [--checker-runtime mock] [--max-workers 2]',
      'npm run github:cocreate -- run-issue <owner/repo#issue|url> --repo-path . [--start-workers]',
      'npm run github:cocreate -- pr-bundle <loop-run-id> [--issue owner/repo#issue] [--create --repo owner/repo]',
      'npm run github:cocreate -- self-test',
    ],
  };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  let result: Record<string, unknown>;
  if (args.command === 'import-issue') result = commandImportIssue(args);
  else if (args.command === 'schedule') result = commandSchedule(args);
  else if (args.command === 'drain') result = await commandDrain(args);
  else if (args.command === 'run-issue') result = await commandRunIssue(args);
  else if (args.command === 'pr-bundle') result = commandPrBundle(args);
  else if (args.command === 'self-test') result = commandSelfTest();
  else result = printHelp();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  });
}
