/**
 * RuntimeCommandService — owns runtime contract probing, command building,
 * process spawning with bounded concurrency, and process lifecycle.
 *
 * Extracted from LoopService (buildRuntimeCommand 170 LOC + getRuntimeContract
 * 170 LOC + executeRuntimeCommand 120 LOC + semaphore management).
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import type { ChildProcess } from 'child_process';
import type { Database } from 'better-sqlite3';
import type { LoopService } from './loop-service';
import type { RuntimeProcessHandle, RuntimeContract, RuntimeUsage, RuntimeExecutionResult, RuntimeStopResult } from './loop-types';
import { startRuntimeProcess, type RuntimeProcess } from '../execution/executors/runtime-process';
import { structuredRuntimeEvent } from '../execution/executors/structured-runtime-event';
import type { ExecutionEventCreateInput, Task } from '@djimitflo/shared';
import { ConcurrencySemaphore } from './concurrency-semaphore';
import type { TaskExecutor } from '../execution/types';
import { CodexExecutor } from '../execution/executors/codex-executor';
import { OpenCodeExecutor } from '../execution/executors/opencode-executor';
import { ClaudeExecutor } from '../execution/executors/claude-executor';
import { GeminiExecutor } from '../execution/executors/gemini-executor';
import { EditorExecutor } from '../execution/executors/editor-executor';
import { PiExecutor } from '../execution/executors/pi-executor';

const DEFAULT_MAX_CONCURRENCY = 4;

export class RuntimeCommandService {
  private static readonly runtimeLeases = new Map<string, RuntimeProcessHandle>();
  private static readonly runtimeSemaphore = new ConcurrencySemaphore();
  private runtimeContractCache = new Map<string, { expiresAt: number; contract: RuntimeContract }>();
  private readonly executorFactories = new Map<string, () => TaskExecutor>([
    ['codex', () => new CodexExecutor()],
    ['opencode', () => new OpenCodeExecutor()],
    ['claude', () => new ClaudeExecutor()],
    ['gemini', () => new GeminiExecutor()],
    ['editor', () => new EditorExecutor()],
    ['pi', () => new PiExecutor()],
  ]);
  private readonly runtimeContractCacheMs = Math.max(500, Math.min(Number(process.env.LOOP_RUNTIME_CONTRACT_CACHE_MS ?? 5_000), 60_000));

  constructor(private db: Database, private loopService: LoopService) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_contract_probes (
        runtime TEXT PRIMARY KEY,
        command TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        available INTEGER NOT NULL DEFAULT 0,
        contract_json TEXT NOT NULL DEFAULT '{}',
        probed_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // ─── Command Building ─────────────────────────────────────────────────

  buildRuntimeCommand(runtime: string, worktreePath: string, prompt: string, skipPermissions = false): { command: string; args: string[] } {
    if (runtime === 'mock') {
      const script = [
        'const dir = process.argv[1];',
        'const log = (m) => console.log("[mock-worker] " + m);',
        'log("starting");',
        'console.log(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));',
        'const caps = process.env.DJIMITFLO_CAPABILITIES;',
        'let capsCount = 0; try { capsCount = caps ? JSON.parse(caps).length : 0; } catch (e) {}',
        'log("capabilities=" + capsCount);',
        'const url = process.env.DJIMITFLO_CONTROL_URL;',
        'const token = process.env.DJIMITFLO_SPAWN_TOKEN;',
        'const leaseId = process.env.DJIMITFLO_LEASE_ID;',
        'const treeId = process.env.DJIMITFLO_SPAWN_TREE_ID;',
        'const depth = process.env.DJIMITFLO_DEPTH;',
        'if (!url || !token || !leaseId || !treeId || typeof fetch !== "function") {',
        '  log("no control env / no fetch; echo-only");',
        '  log("dir=" + dir);',
        '} else {',
        '  log("lease=" + leaseId + " tree=" + treeId + " depth=" + depth + " -> self-spawn via " + url);',
        '  const body = JSON.stringify({ requested_by_lease_id: leaseId, parent_lease_id: leaseId, spawn_tree_id: treeId, role: "maker", runtime: "mock", prompt: "mock child of " + leaseId });',
        '  const ctrl = new AbortController();',
        '  const to = setTimeout(() => ctrl.abort(), 5000);',
        '  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Spawn-Token": token }, body, signal: ctrl.signal })',
        '    .then((res) => res.text().then((text) => ({ status: res.status, text })))',
        '    .then(({ status, text }) => {',
        '      clearTimeout(to);',
        '      log("spawn POST status=" + status + " body=" + text);',
        '      let childId = null;',
        '      let childToken = null;',
        '      try { const parsed = JSON.parse(text); childId = parsed.child_lease_id || null; childToken = parsed.control_token || null; } catch (e) {}',
        '      if (status >= 200 && status < 300 && childId && childToken) {',
        '        return fetch(url + "/" + childId + "/status", { headers: { "X-Spawn-Token": childToken } })',
        '          .then((s) => s.text())',
        '          .then((st) => log("child status body=" + st));',
        '      }',
        '      if (status >= 200 && status < 300 && childId) {',
        '        log("child status token unavailable at depth floor");',
        '      }',
        '      if (status >= 400 && status < 500 && text.indexOf("gated_out") >= 0) {',
        '        log("child gated_out (legitimate terminal state at depth floor)");',
        '      } else if (status >= 400) {',
        '        log("control-plane error status=" + status + " (non-fatal; echo work already done)");',
        '      }',
        '    })',
        '    .catch((e) => { clearTimeout(to); log("control-plane call failed: " + (e && e.message || e) + " (non-fatal)"); });',
        '}',
      ].join('\n');
      return { command: process.execPath, args: ['-e', script, worktreePath] };
    }
    const executor = this.executorFactories.get(runtime)?.();
    if (executor?.buildCommand) {
      return executor.buildCommand({ id: `loop-${runtime}`, title: prompt, description: prompt } as Task, {
        workingDirectory: worktreePath,
        skipPermissions,
        ...(runtime === 'opencode' && process.env.DJIMITFLO_OPENCODE_MODEL
          ? { model: process.env.DJIMITFLO_OPENCODE_MODEL }
          : {}),
      });
    }
    throw new Error('MAKER_RUNTIME_UNSUPPORTED');
  }

  // ─── Runtime Contract Probing ─────────────────────────────────────────

  getRuntimeContract(runtime: string): RuntimeContract {
    if (runtime === 'manual') {
      return this.withConformance({ runtime: 'manual', available: true, command: null, version: 'manual', status: 'ok', supports_json_events: false, supports_usage_parsing: false, supports_timeout_kill: false, evidence: ['manual runtime requires human execution'] });
    }
    if (runtime === 'mock') {
      return this.withConformance({ runtime: 'mock', available: true, command: process.execPath, version: 'mock-runtime', status: 'ok', cwd_flag: 'argv', json_flag: 'stdout-json', supports_json_events: true, supports_usage_parsing: true, supports_timeout_kill: true, evidence: ['deterministic in-process mock runtime'] });
    }
    const PROBES: Record<string, { binEnv: string; defaultBin: string; helpArgs: string[]; jsonFlag: string; jsonFlagHelp: string; cwdFlag: string | null; headlessFlag: string }> = {
      codex: { binEnv: 'CODEX_BIN_PATH', defaultBin: 'codex', helpArgs: ['exec', '--help'], jsonFlag: '--json', jsonFlagHelp: '--json', cwdFlag: '--cd', headlessFlag: '--json' },
      opencode: { binEnv: 'OPENCODE_BIN_PATH', defaultBin: 'opencode', helpArgs: ['run', '--help'], jsonFlag: '--format', jsonFlagHelp: '--format', cwdFlag: '--dir', headlessFlag: '--format' },
      claude: { binEnv: 'CLAUDE_BIN_PATH', defaultBin: 'claude', helpArgs: ['--help'], jsonFlag: '--output-format', jsonFlagHelp: '--output-format', cwdFlag: null, headlessFlag: '-p' },
      gemini: { binEnv: 'GEMINI_BIN_PATH', defaultBin: 'gemini', helpArgs: ['--help'], jsonFlag: '-o', jsonFlagHelp: '-o', cwdFlag: null, headlessFlag: '-p' },
      editor: { binEnv: 'CLINE_BIN_PATH', defaultBin: 'cline', helpArgs: ['--help'], jsonFlag: '--json', jsonFlagHelp: '--json', cwdFlag: '-c', headlessFlag: '--json' },
      pi: { binEnv: 'PI_BIN_PATH', defaultBin: 'pi', helpArgs: ['--help'], jsonFlag: '--mode', jsonFlagHelp: '--mode', cwdFlag: null, headlessFlag: '-p' },
    };
    const probe = PROBES[runtime];
    if (!probe) {
      return this.withConformance({ runtime: 'manual', available: false, command: null, status: 'unavailable', supports_json_events: false, supports_usage_parsing: false, supports_timeout_kill: false, evidence: [], reason: 'unsupported runtime' });
    }
    const typedRuntime = runtime as RuntimeContract['runtime'];
    const command = process.env[probe.binEnv] || probe.defaultBin;
    const cacheKey = `${runtime}::${command}`;
    const cached = this.runtimeContractCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.contract;
    if (cached) this.runtimeContractCache.delete(cacheKey);
    if (this.runtimeContractCache.size > 100) {
      const now = Date.now();
      for (const [key, entry] of this.runtimeContractCache) {
        if (entry.expiresAt <= now) this.runtimeContractCache.delete(key);
      }
    }
    const timeoutMs = Math.max(100, Math.min(Number(process.env.LOOP_RUNTIME_PROBE_TIMEOUT_MS ?? 2_000), 5_000));
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 512 * 1024 });
    if (result.error) {
      return this.withConformance({ runtime: typedRuntime, available: false, command, status: 'unavailable', supports_json_events: false, supports_usage_parsing: false, supports_timeout_kill: true, evidence: [], reason: result.error.message });
    }
    if (result.status !== 0) {
      return this.withConformance({ runtime: typedRuntime, available: false, command, status: 'unavailable', supports_json_events: false, supports_usage_parsing: false, supports_timeout_kill: true, evidence: [], reason: result.stderr || `exit ${result.status}` });
    }
    const helpResult = spawnSync(command, probe.helpArgs, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 512 * 1024 });
    const help = `${helpResult.stdout || ''}\n${helpResult.stderr || ''}`;
    const evidence = [(result.stdout || result.stderr || '').trim(), help.split(/\r?\n/).slice(0, 20).join('\n')].filter(Boolean);
    const lowerHelp = help.toLowerCase();
    const hasJsonFlag = lowerHelp.includes(probe.jsonFlagHelp.toLowerCase());
    const hasCwdFlag = probe.cwdFlag ? lowerHelp.includes(probe.cwdFlag) : true;
    const hasHeadlessFlag = lowerHelp.includes(probe.headlessFlag.toLowerCase());
    const drifted = !hasJsonFlag || !hasCwdFlag || !hasHeadlessFlag;
    const contract = this.withConformance({
      runtime: typedRuntime, available: !drifted, command,
      version: (result.stdout || result.stderr || '').trim() || 'unknown',
      status: drifted ? 'drifted' : 'ok',
      ...(probe.cwdFlag ? { cwd_flag: probe.cwdFlag } : {}),
      json_flag: probe.jsonFlag === '--format' ? ['--format', 'json'] : probe.jsonFlag,
      supports_json_events: !drifted, supports_usage_parsing: !drifted, supports_timeout_kill: true, evidence,
      ...(drifted ? { reason: `missing required flags: ${[!hasJsonFlag ? 'json' : '', !hasCwdFlag ? 'cwd' : '', !hasHeadlessFlag ? 'headless' : ''].filter(Boolean).join(', ')}` } : {}),
    });
    const probedAt = new Date().toISOString();
    contract.probed_at = probedAt;
    this.db.prepare(`INSERT INTO runtime_contract_probes (runtime, command, status, available, contract_json, probed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(runtime) DO UPDATE SET command = excluded.command, status = excluded.status, available = excluded.available, contract_json = excluded.contract_json, probed_at = excluded.probed_at, updated_at = excluded.updated_at`).run(contract.runtime, contract.command, contract.status, contract.available ? 1 : 0, JSON.stringify(contract), probedAt, probedAt);
    this.runtimeContractCache.set(cacheKey, { expiresAt: Date.now() + this.runtimeContractCacheMs, contract });
    return contract;
  }

  private withConformance(contract: RuntimeContract): RuntimeContract {
    const checks = [
      { name: 'runtime_available', passed: contract.available, evidence: contract.available ? 'Runtime binary is available.' : contract.reason || 'Runtime binary is unavailable.' },
      { name: 'contract_not_drifted', passed: contract.status === 'ok', evidence: `Runtime contract status is ${contract.status}.` },
      { name: 'structured_events', passed: contract.supports_json_events, evidence: contract.json_flag ? `Structured output flag: ${JSON.stringify(contract.json_flag)}.` : 'No structured output flag.' },
      { name: 'usage_accounting', passed: contract.supports_usage_parsing, evidence: contract.supports_usage_parsing ? 'Runtime output supports usage parsing.' : 'Usage parsing is not supported.' },
      { name: 'bounded_lifecycle', passed: contract.supports_timeout_kill, evidence: contract.supports_timeout_kill ? 'Timeout and kill are supported.' : 'Runtime requires manual lifecycle control.' },
    ];
    const canonical = JSON.stringify({
      runtime: contract.runtime,
      command: contract.command,
      version: contract.version || null,
      cwd_flag: contract.cwd_flag || null,
      json_flag: contract.json_flag || null,
      checks: checks.map(({ name, passed }) => ({ name, passed })),
    });
    return {
      ...contract,
      conformance: {
        status: contract.runtime === 'manual' ? 'manual' : checks.every((check) => check.passed) ? 'pass' : 'fail',
        proof_class: contract.runtime === 'manual' || contract.runtime === 'mock' ? 'static' : 'runtime_probe',
        contract_hash: createHash('sha256').update(canonical).digest('hex'),
        checks,
      },
    };
  }

  // ─── Process Execution ────────────────────────────────────────────────

  async executeRuntimeCommand(
    leaseId: string, command: string, args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number; enforceCwdBoundary?: boolean; runtime?: string } = {}
  ): Promise<RuntimeExecutionResult> {
    const maxBuffer = options.maxBuffer || 5 * 1024 * 1024;
    const timeoutMs = options.timeoutMs || 120_000;
    if (options.enforceCwdBoundary && options.cwd) {
      this.loopService.assertWithinWorktreeRoot(options.cwd);
    }
    await this.acquireRuntimePermit(leaseId);
    return new Promise<RuntimeExecutionResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timedOutAt: string | undefined;
      let timedOutHandled = false;
      let exitCode: number | null = null;
      let signal: string | null = null;
      const events: ExecutionEventCreateInput[] = [];
      let eventBuffer = '';
      let settled = false;
      const safeTrim = (input: string) => input.length > maxBuffer ? input.slice(-maxBuffer) : input;
      let child: ChildProcess;
      let runtime: RuntimeProcess;
      const finalize = () => {
        if (settled) return;
        settled = true;
        this.clearRuntimeLease(leaseId);
        this.releaseRuntimePermit(leaseId);
        resolve({ exitCode, signal, timedOut, timedOutAt, stdout: safeTrim(stdout), stderr: safeTrim(stderr), runtimePid: child.pid || undefined, events });
      };
      try {
        runtime = startRuntimeProcess({
          command, args, cwd: options.cwd, env: options.env || this.loopService.buildRuntimeEnv(), timeoutMs,
          onOutput: (text, stream) => {
            if (stream === 'stdout') {
              stdout = safeTrim(stdout + text);
              if (options.runtime && ['claude', 'gemini', 'editor', 'codex', 'opencode', 'pi'].includes(options.runtime)) {
                eventBuffer += text;
                const lines = eventBuffer.split(/\r?\n/);
                eventBuffer = lines.pop() || '';
                for (const line of lines) {
                  try { if (events.length < 500) events.push(structuredRuntimeEvent(options.runtime as any, leaseId, JSON.parse(line))); }
                  catch { /* raw non-JSON output remains in stdout */ }
                }
              }
            } else stderr = safeTrim(stderr + text);
          },
          onExit: (code, childSignal) => {
            if (eventBuffer.trim() && options.runtime) {
              try { if (events.length < 500) events.push(structuredRuntimeEvent(options.runtime as any, leaseId, JSON.parse(eventBuffer))); }
              catch { /* raw non-JSON output remains in stdout */ }
            }
            exitCode = code; signal = childSignal; finalize();
          },
          onError: error => { this.clearRuntimeLease(leaseId); this.releaseRuntimePermit(leaseId); if (!settled) { settled = true; reject(error); } },
          onTimeout: () => { if (!timedOutHandled) { timedOut = true; timedOutAt = new Date().toISOString(); timedOutHandled = true; } },
        });
        child = runtime.child;
      } catch (error) {
        this.releaseRuntimePermit(leaseId);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!child.pid) { this.releaseRuntimePermit(leaseId); reject(new Error('RUNTIME_PROCESS_START_FAILED')); return; }
      this.registerRuntimeLease(leaseId, runtime, command, args);
    });
  }

  stopWorkerLeaseRuntime(leaseId: string): RuntimeStopResult {
    const runtimeLease = RuntimeCommandService.runtimeLeases.get(leaseId) || null;
    if (!runtimeLease) {
      this.cancelRuntimePermit(leaseId);
      return { stopMode: 'best_effort_no_process_handle', killAttempted: false };
    }
    let killAttempted = false;
    try {
      runtimeLease.stop?.();
      killAttempted = true;
      this.loopService.patchWorkerLeaseMetadata(leaseId, { runtime_stop_requested_at: new Date().toISOString(), runtime_stop_attempted: true, runtime_stop_mode: 'stop' });
    } catch { killAttempted = false; }
    this.clearRuntimeLease(leaseId);
    return { stopMode: 'stop', killAttempted };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  extractRuntimeWarnings(stdout: string, stderr: string): Array<Record<string, unknown>> {
    const text = `${stdout}\n${stderr}`;
    const warnings: Array<Record<string, unknown>> = [];
    const patterns: Array<{ pattern: RegExp; class_name: string; severity: 'advisory' | 'warning' | 'blocking' }> = [
      { pattern: /failed to parse plugin hooks config[^\n]*/i, class_name: 'plugin_hook_config_parse', severity: 'warning' },
      { pattern: /Skill descriptions were shortened[^\n]*/i, class_name: 'skill_context_budget', severity: 'advisory' },
      { pattern: /fail to delete session[^\n]*/i, class_name: 'runtime_session_cleanup', severity: 'advisory' },
      { pattern: /structured output unavailable[^\n]*/i, class_name: 'structured_output_unavailable', severity: 'warning' },
      { pattern: /unknown field|unexpected argument[^\n]*/i, class_name: 'runtime_contract_warning', severity: 'warning' },
      { pattern: /trust boundary[^\n]*/i, class_name: 'trust_boundary_warning', severity: 'blocking' },
    ];
    for (const item of patterns) {
      const match = text.match(item.pattern);
      if (match?.[0]) warnings.push({ class_name: item.class_name, severity: item.severity, message: match[0].slice(0, 500) });
    }
    return warnings;
  }

  runtimeWarningsBlockCompletion(warnings: Array<Record<string, unknown>>, run: any): boolean {
    if (warnings.length === 0) return false;
    const highRisk = this.loopService.isHighRiskRun(run);
    return warnings.some((warning) => {
      const message = String(warning.message || '').toLowerCase();
      const severity = String(warning.severity || '').toLowerCase();
      const className = String(warning.class_name || '').toLowerCase();
      if (highRisk && (message.includes('trust boundary') || className.includes('trust_boundary'))) return true;
      return severity === 'blocking';
    });
  }

  runtimeWarningsEvidence(warnings: Array<Record<string, unknown>>, run: any): string {
    if (warnings.length === 0) return 'No runtime warnings detected.';
    const classes = warnings.map((warning) => String(warning.class_name || 'unknown')).join(', ');
    const blocked = this.runtimeWarningsBlockCompletion(warnings, run);
    if (blocked) return `Runtime warnings include trust boundary classes on a high-risk run: ${classes}.`;
    return `Runtime warnings are advisory on a non-high-risk run or do not affect trust boundaries: ${classes}.`;
  }

  calculateWorkerEfficiency(runtimeUsage: RuntimeUsage | null, diffLines: number): Record<string, unknown> {
    if (!runtimeUsage) return { usage_source: 'unknown' };
    return { total_tokens: runtimeUsage.total_tokens, diff_lines: diffLines, tokens_per_diff_line: diffLines > 0 ? runtimeUsage.total_tokens / diffLines : null, tokens_per_successful_worker: runtimeUsage.total_tokens };
  }

  runtimeConcurrencyInUse(): number { return RuntimeCommandService.runtimeSemaphore.activeCount(); }

  // ─── Semaphore ────────────────────────────────────────────────────────

  private runtimeSemaphoreLimit(): number {
    const raw = process.env.RUNTIME_MAX_CONCURRENCY;
    if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_MAX_CONCURRENCY;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : DEFAULT_MAX_CONCURRENCY;
  }

  private acquireRuntimePermit(leaseId: string): Promise<void> {
    return RuntimeCommandService.runtimeSemaphore.acquire(leaseId, this.runtimeSemaphoreLimit());
  }

  private releaseRuntimePermit(leaseId: string): void {
    RuntimeCommandService.runtimeSemaphore.release(leaseId);
  }

  private cancelRuntimePermit(leaseId: string): void {
    RuntimeCommandService.runtimeSemaphore.cancel(leaseId, 'RUNTIME_PERMIT_CANCELLED');
  }

  private registerRuntimeLease(leaseId: string, runtime: RuntimeProcess, command: string, args: string[]): void {
    RuntimeCommandService.runtimeLeases.set(leaseId, { child: runtime.child, stop: runtime.stop, leaseId, command, args, startedAt: new Date().toISOString() });
  }

  private clearRuntimeLease(leaseId: string): void {
    const lease = RuntimeCommandService.runtimeLeases.get(leaseId);
    if (!lease) return;
    if (lease.timeoutHandle) clearTimeout(lease.timeoutHandle);
    RuntimeCommandService.runtimeLeases.delete(leaseId);
  }
}
