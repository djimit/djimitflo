/**
 * RuntimeCommandService — owns runtime contract probing, command building,
 * process spawning with bounded concurrency, and process lifecycle.
 *
 * Extracted from LoopService (buildRuntimeCommand 170 LOC + getRuntimeContract
 * 170 LOC + executeRuntimeCommand 120 LOC + semaphore management).
 */

import { spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { RuntimeProcessHandle } from './loop-service';
import type { Database } from 'better-sqlite3';
import type { LoopService, RuntimeContract, RuntimeUsage, RuntimeExecutionResult, RuntimeStopResult } from './loop-service';

const DEFAULT_MAX_CONCURRENCY = 4;

export class RuntimeCommandService {
  private static readonly runtimeLeases = new Map<string, RuntimeProcessHandle>();
  private static readonly runtimeSemaphore: { active: Set<string>; queue: Array<{ leaseId: string; resolve: () => void; reject: (err: Error) => void }> } = { active: new Set(), queue: [] };
  private runtimeContractCache = new Map<string, { expiresAt: number; contract: RuntimeContract }>();
  private readonly runtimeContractCacheMs = Math.max(500, Math.min(Number(process.env.LOOP_RUNTIME_CONTRACT_CACHE_MS ?? 5_000), 60_000));

  constructor(private db: Database, private loopService: LoopService) {}

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
    if (runtime === 'codex') {
      const args = skipPermissions
        ? ['exec', '--sandbox', 'workspace-write', '-c', worktreePath, 'approval_policy=never', '--json', '--cd', worktreePath, prompt]
        : ['exec', '--json', '--cd', worktreePath, prompt];
      return { command: process.env.CODEX_BIN_PATH || 'codex', args };
    }
    if (runtime === 'opencode') {
      const args = skipPermissions
        ? ['run', '--dangerously-skip-permissions', '--format', 'json', '--dir', worktreePath, prompt]
        : ['run', '--format', 'json', '--dir', worktreePath, prompt];
      return { command: process.env.OPENCODE_BIN_PATH || 'opencode', args };
    }
    if (runtime === 'claude') {
      const args = ['-p', prompt, '--output-format', 'json'];
      if (skipPermissions) args.push('--dangerously-skip-permissions');
      const model = process.env.DJIMITFLO_CLAUDE_MODEL;
      if (model) args.push('--model', model);
      return { command: process.env.CLAUDE_BIN_PATH || 'claude', args };
    }
    if (runtime === 'gemini') {
      const args = ['-p', prompt, '-o', 'json'];
      if (skipPermissions) args.push('-y');
      const model = process.env.DJIMITFLO_GEMINI_MODEL;
      if (model) args.push('-m', model);
      return { command: process.env.GEMINI_BIN_PATH || 'gemini', args };
    }
    if (runtime === 'editor') {
      const args = ['--json', '--auto-approve', skipPermissions ? 'true' : 'false', '-c', worktreePath];
      args.push('--thinking', process.env.DJIMITFLO_CLINE_THINKING || 'medium');
      const model = process.env.DJIMITFLO_CLINE_MODEL;
      if (model) args.push('-m', model);
      args.push(prompt);
      return { command: process.env.CLINE_BIN_PATH || 'cline', args };
    }
    if (runtime === 'pi') {
      const args = ['--mode', 'json', '-p', '--no-session'];
      if ((process.env.PI_NO_APPROVE ?? '1') === '1') args.push('--no-approve');
      if (process.env.PI_NO_CONTEXT_FILES === '1') args.push('--no-context-files');
      if ((process.env.PI_NO_EXTENSIONS ?? '1') === '1') args.push('--no-extensions');
      if ((process.env.PI_NO_SKILLS ?? '1') === '1') args.push('--no-skills');
      if (process.env.PI_OFFLINE === '1') args.push('--offline');
      if (process.env.PI_TOOLS) args.push('--tools', process.env.PI_TOOLS);
      if (process.env.PI_PROVIDER) args.push('--provider', process.env.PI_PROVIDER);
      if (process.env.PI_MODEL) args.push('--model', process.env.PI_MODEL);
      args.push(prompt);
      return { command: process.env.PI_BIN_PATH || 'pi', args };
    }
    throw new Error('MAKER_RUNTIME_UNSUPPORTED');
  }

  // ─── Runtime Contract Probing ─────────────────────────────────────────

  getRuntimeContract(runtime: string): RuntimeContract {
    if (runtime === 'manual') {
      return { runtime: 'manual', available: true, command: null, version: 'manual', status: 'ok', supports_json_events: false, supports_usage_parsing: false, supports_timeout_kill: false, evidence: ['manual runtime requires human execution'] };
    }
    if (runtime === 'mock') {
      return { runtime: 'mock', available: true, command: process.execPath, version: 'mock-runtime', status: 'ok', cwd_flag: 'argv', json_flag: 'stdout-json', supports_json_events: true, supports_usage_parsing: true, supports_timeout_kill: true, evidence: ['deterministic in-process mock runtime'] };
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
      return { runtime: 'manual', available: false, command: null, status: 'unavailable', supports_json_events: false, supports_usage_parsing: false, supports_timeout_kill: false, evidence: [], reason: 'unsupported runtime' };
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
    const timeoutMs = Math.max(100, Math.min(Number(process.env.LOOP_RUNTIME_PROBE_TIMEOUT_MS || 1_000), 5_000));
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 512 * 1024 });
    if (result.error) {
      return { runtime: typedRuntime, available: false, command, status: 'unavailable', supports_json_events: false, supports_usage_parsing: false, supports_timeout_kill: true, evidence: [], reason: result.error.message };
    }
    if (result.status !== 0) {
      return { runtime: typedRuntime, available: false, command, status: 'unavailable', supports_json_events: false, supports_usage_parsing: false, supports_timeout_kill: true, evidence: [], reason: result.stderr || `exit ${result.status}` };
    }
    const helpResult = spawnSync(command, probe.helpArgs, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 512 * 1024 });
    const help = `${helpResult.stdout || ''}\n${helpResult.stderr || ''}`;
    const evidence = [(result.stdout || result.stderr || '').trim(), help.split(/\r?\n/).slice(0, 20).join('\n')].filter(Boolean);
    const lowerHelp = help.toLowerCase();
    const hasJsonFlag = lowerHelp.includes(probe.jsonFlagHelp.toLowerCase());
    const hasCwdFlag = probe.cwdFlag ? lowerHelp.includes(probe.cwdFlag) : true;
    const hasHeadlessFlag = lowerHelp.includes(probe.headlessFlag.toLowerCase());
    const drifted = !hasJsonFlag || !hasCwdFlag || !hasHeadlessFlag;
    const contract: RuntimeContract = {
      runtime: typedRuntime, available: !drifted, command,
      version: (result.stdout || result.stderr || '').trim() || 'unknown',
      status: drifted ? 'drifted' : 'ok',
      ...(probe.cwdFlag ? { cwd_flag: probe.cwdFlag } : {}),
      json_flag: probe.jsonFlag === '--format' ? ['--format', 'json'] : probe.jsonFlag,
      supports_json_events: !drifted, supports_usage_parsing: !drifted, supports_timeout_kill: true, evidence,
      ...(drifted ? { reason: `missing required flags: ${[!hasJsonFlag ? 'json' : '', !hasCwdFlag ? 'cwd' : '', !hasHeadlessFlag ? 'headless' : ''].filter(Boolean).join(', ')}` } : {}),
    };
    const probedAt = new Date().toISOString();
    contract.probed_at = probedAt;
    this.db.prepare(`INSERT INTO runtime_contract_probes (runtime, command, status, available, contract_json, probed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(runtime) DO UPDATE SET command = excluded.command, status = excluded.status, available = excluded.available, contract_json = excluded.contract_json, probed_at = excluded.probed_at, updated_at = excluded.updated_at`).run(contract.runtime, contract.command, contract.status, contract.available ? 1 : 0, JSON.stringify(contract), probedAt, probedAt);
    this.runtimeContractCache.set(cacheKey, { expiresAt: Date.now() + this.runtimeContractCacheMs, contract });
    return contract;
  }

  // ─── Process Execution ────────────────────────────────────────────────

  async executeRuntimeCommand(
    leaseId: string, command: string, args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number; enforceCwdBoundary?: boolean } = {}
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
      let settled = false;
      const safeTrim = (input: string) => input.length > maxBuffer ? input.slice(-maxBuffer) : input;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let child: ChildProcess;
      try {
        child = spawn(command, args, { cwd: options.cwd, env: options.env || this.loopService.buildRuntimeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        this.releaseRuntimePermit(leaseId);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!child.pid) { this.releaseRuntimePermit(leaseId); reject(new Error('RUNTIME_PROCESS_START_FAILED')); return; }
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (!timedOutHandled) {
            timedOut = true; timedOutAt = new Date().toISOString(); timedOutHandled = true;
            try { child.kill('SIGKILL'); } catch { /* best effort */ }
          }
        }, timeoutMs);
      }
      this.registerRuntimeLease(leaseId, child, command, args, timeoutHandle);
      const finalize = () => {
        if (settled) return;
        settled = true;
        this.clearRuntimeLease(leaseId);
        this.releaseRuntimePermit(leaseId);
        resolve({ exitCode, signal, timedOut, timedOutAt, stdout: safeTrim(stdout), stderr: safeTrim(stderr), runtimePid: child.pid || undefined });
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout += chunk; if (stdout.length > maxBuffer) stdout = stdout.slice(-maxBuffer); });
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer); });
      child.on('error', (error) => { this.clearRuntimeLease(leaseId); this.releaseRuntimePermit(leaseId); if (!settled) { settled = true; reject(error); } });
      child.on('close', (code, childSignal) => { exitCode = code === null ? exitCode : code; signal = childSignal || null; if (timedOut && typeof code === 'number' && code === 0) timedOut = true; finalize(); });
    });
  }

  stopWorkerLeaseRuntime(leaseId: string): RuntimeStopResult {
    const runtimeLease = RuntimeCommandService.runtimeLeases.get(leaseId) || null;
    if (!runtimeLease) {
      this.cancelRuntimePermit(leaseId);
      return { stopMode: 'best_effort_no_process_handle', killAttempted: false };
    }
    const child = runtimeLease.child;
    let killAttempted = false;
    try {
      if (!child.killed) child.kill('SIGTERM');
      killAttempted = true;
      this.loopService.patchWorkerLeaseMetadata(leaseId, { runtime_stop_requested_at: new Date().toISOString(), runtime_stop_attempted: true, runtime_stop_mode: 'stop' });
    } catch { killAttempted = false; }
    if (child.killed) { this.clearRuntimeLease(leaseId); return { stopMode: 'stop', killAttempted }; }
    try { child.kill('SIGKILL'); killAttempted = killAttempted || true; this.clearRuntimeLease(leaseId); return { stopMode: 'kill', killAttempted }; }
    catch { return { stopMode: 'best_effort_no_process_handle', killAttempted }; }
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

  runtimeConcurrencyInUse(): number { return RuntimeCommandService.runtimeSemaphore.active.size; }

  // ─── Semaphore ────────────────────────────────────────────────────────

  private runtimeSemaphoreLimit(): number {
    const raw = process.env.RUNTIME_MAX_CONCURRENCY;
    if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_MAX_CONCURRENCY;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : DEFAULT_MAX_CONCURRENCY;
  }

  private acquireRuntimePermit(leaseId: string): Promise<void> {
    const sem = RuntimeCommandService.runtimeSemaphore;
    if (sem.active.has(leaseId)) return Promise.resolve();
    if (sem.active.size < this.runtimeSemaphoreLimit()) { sem.active.add(leaseId); return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => { sem.queue.push({ leaseId, resolve, reject }); });
  }

  private releaseRuntimePermit(leaseId: string): void {
    const sem = RuntimeCommandService.runtimeSemaphore;
    if (sem.active.has(leaseId)) {
      sem.active.delete(leaseId);
      const next = sem.queue.shift();
      if (next) { sem.active.add(next.leaseId); next.resolve(); }
    } else {
      const idx = sem.queue.findIndex((w) => w.leaseId === leaseId);
      if (idx >= 0) sem.queue.splice(idx, 1);
    }
  }

  private cancelRuntimePermit(leaseId: string): void {
    const sem = RuntimeCommandService.runtimeSemaphore;
    const idx = sem.queue.findIndex((w) => w.leaseId === leaseId);
    if (idx >= 0) { const [waiter] = sem.queue.splice(idx, 1); waiter.reject(new Error('RUNTIME_PERMIT_CANCELLED')); }
  }

  private registerRuntimeLease(leaseId: string, child: ChildProcess, command: string, args: string[], timeoutHandle?: NodeJS.Timeout): void {
    RuntimeCommandService.runtimeLeases.set(leaseId, { child, leaseId, command, args, startedAt: new Date().toISOString(), timeoutHandle });
  }

  private clearRuntimeLease(leaseId: string): void {
    const lease = RuntimeCommandService.runtimeLeases.get(leaseId);
    if (!lease) return;
    if (lease.timeoutHandle) clearTimeout(lease.timeoutHandle);
    RuntimeCommandService.runtimeLeases.delete(leaseId);
  }
}
