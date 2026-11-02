import type { AgentPort, MacroCall, MicroAction, MicroObservation, RecoveryContext } from '../executor';
import type { FsWorkspace } from '../effects';
import type { AsgTaskSpec, RouteDecision } from '../router';
import type { FixtureTask } from './fixtures';

/**
 * Scripted (mock) agent for the mechanism pilot. No model is called. Micro behaviour is a pure function of the current
 * workspace and the scripted solution, so it continues from whatever state a failed macro left (it never restarts from the
 * base). Its macro plan is the fixture's fixed plan.
 */
export function scriptedAgent(task: FixtureTask): AgentPort {
  return {
    macroPlan(_spec: AsgTaskSpec, _d: RouteDecision, ws: FsWorkspace): MacroCall[] {
      const base: Record<string, string> = {};
      for (const p of ws.list()) base[p] = ws.read(p) ?? '';
      return task.macroPlan(base);
    },
    nextMicro(spec: AsgTaskSpec, ws: FsWorkspace, history: MicroObservation[], _r: RecoveryContext | null): MicroAction | null {
      return nextScriptedMicro(task, spec, ws, history);
    },
  };
}

export function nextScriptedMicro(task: FixtureTask, spec: Pick<AsgTaskSpec, 'targets' | 'declared_writes' | 'lane'>, ws: FsWorkspace, history: MicroObservation[]): MicroAction | null {
  const tests = spec.declared_writes;
  const read = history.some((h) => h.tool === 'read_file');
  for (const w of tests) {
    const cur = ws.read(w);
    const want = task.solution[w];
    if (want === undefined || cur === want) continue;
    if (!read) return { tool: 'read_file', args: { path: spec.lane === 'mutation' ? w : spec.targets.source_path ?? w } };
    const edit = task.microEdit;
    if (edit && edit.path === w && cur !== null && cur.split(edit.find).length === 2) return { tool: 'replace_text', args: { path: w, find: edit.find, replace: edit.replace } };
    return { tool: 'write_file', args: { path: w, content: want } };
  }
  // after the last write, run each declared test once
  const tools = history.map((h) => h.tool);
  const since = Math.max(tools.lastIndexOf('write_file'), tools.lastIndexOf('replace_text'));
  const runsSince = tools.slice(since + 1).filter((t) => t === 'run_test').length;
  const testFiles = tests.filter((t) => /\.test\.m?js$/.test(t) && ws.read(t) !== null);
  if (runsSince < testFiles.length) return { tool: 'run_test', args: { path: testFiles[runsSince] } };
  return { tool: 'done', args: {} };
}
