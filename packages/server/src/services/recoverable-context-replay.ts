import { compress, expand, isStructured, MemoryBlobStore, PRESERVED, isPreserved } from './recoverable-context';

type PreservedClass = keyof typeof PRESERVED;
export type ClassTally = Record<PreservedClass, { seen: number; dropped: number }>;
const emptyTally = (): ClassTally => ({ error: { seen: 0, dropped: 0 }, security: { seen: 0, dropped: 0 }, injection: { seen: 0, dropped: 0 }, sourceRef: { seen: 0, dropped: 0 } });

/** Per preserved class: lines of `original` in that class, and how many are missing as whole lines from `compressed`. */
export function tallyPreserved(original: string, compressed: string, tally: ClassTally = emptyTally()): ClassTally {
  const kept = new Set(compressed.split('\n'));
  for (const line of original.split('\n')) {
    if (!isPreserved(line)) continue;
    for (const c of Object.keys(PRESERVED) as PreservedClass[]) {
      if (!PRESERVED[c].test(line)) continue;
      tally[c].seen++;
      if (!kept.has(line)) tally[c].dropped++;
    }
  }
  return tally;
}

/**
 * Offline replay of recorded opencode runs (worker-output/<lease>/stdout.log, `opencode run --format json`) through
 * recoverable-context. Nothing here touches a live maker.
 *
 * Model: a tool output produced in step k is part of the context re-sent by every later step of the same run, so its
 * estimated saving is (chars saved / 4) × (steps after k). Token figures are a chars/4 ESTIMATE against the run's
 * measured per-step context (input + cache read + cache write from step_finish). It is an upper bound when the runtime
 * prunes or compacts old tool outputs itself.
 */

export interface ReplayOptions {
  budget: number;
  minChars?: number;
  /** tools whose output may be compressed; null = all tools (upper bound: read/edit output is code the maker needs) */
  tools: string[] | null;
}

export interface ToolOutputStat { tool: string; chars: number; compressedChars: number; resends: number }

export interface RunReplay {
  opencodeJson: boolean;
  steps: number;
  /** sum over steps of input + cache.read + cache.write, as reported by the runtime */
  measuredContextTokens: number;
  outputs: ToolOutputStat[];
  estimatedSavedTokens: number;
  integrity: { compressed: number; structuredPassThrough: number; recoveryFailures: number; preserved: ClassTally };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function replayRun(stdout: string, options: ReplayOptions): RunReplay {
  const store = new MemoryBlobStore();
  const run: RunReplay = { opencodeJson: false, steps: 0, measuredContextTokens: 0, outputs: [], estimatedSavedTokens: 0,
    integrity: { compressed: 0, structuredPassThrough: 0, recoveryFailures: 0, preserved: emptyTally() } };
  const pending: Array<{ stat: ToolOutputStat; atStep: number }> = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: { type?: string; part?: Record<string, unknown> };
    try { event = JSON.parse(line); } catch { continue; }
    const part = event.part ?? {};
    if (event.type === 'step_finish') {
      run.opencodeJson = true;
      run.steps++;
      const t = (part.tokens ?? {}) as { input?: unknown; cache?: { read?: unknown; write?: unknown } };
      run.measuredContextTokens += num(t.input) + num(t.cache?.read) + num(t.cache?.write);
      continue;
    }
    if (event.type !== 'tool_use') continue;
    run.opencodeJson = true;
    const tool = String(part.tool ?? 'unknown');
    const output = (part.state as { output?: unknown } | undefined)?.output;
    if (typeof output !== 'string') continue;
    let compressedChars = output.length;
    if (!options.tools || options.tools.includes(tool)) {
      const out = compress(output, options.budget, store, { minChars: options.minChars });
      compressedChars = out.text.length;
      if (out.handle) {
        run.integrity.compressed++;
        try { if (expand(out.handle, store) !== output) run.integrity.recoveryFailures++; } catch { run.integrity.recoveryFailures++; }
        tallyPreserved(output, out.text, run.integrity.preserved);
      } else if (output.length >= (options.minChars ?? 4_000) && isStructured(output)) {
        run.integrity.structuredPassThrough++;
      }
    }
    // the tool runs inside step `run.steps + 1`; its output is first sent by the step after that
    const stat = { tool, chars: output.length, compressedChars, resends: 0 };
    run.outputs.push(stat);
    pending.push({ stat, atStep: run.steps + 1 });
  }
  for (const { stat, atStep } of pending) {
    stat.resends = Math.max(0, run.steps - atStep);
    run.estimatedSavedTokens += ((stat.chars - stat.compressedChars) / 4) * stat.resends;
  }
  return run;
}

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** Integrity + ratio over standalone log files (deterministic-check logs); these are not re-sent per step. */
export function replayLog(text: string, budget: number, minChars?: number) {
  const store = new MemoryBlobStore();
  const out = compress(text, budget, store, { minChars });
  let recoveryFailure = false;
  if (out.handle) { try { recoveryFailure = expand(out.handle, store) !== text; } catch { recoveryFailure = true; } }
  return { chars: text.length, compressedChars: out.text.length, compressed: out.handle !== null, recoveryFailure, preserved: tallyPreserved(text, out.text) };
}
