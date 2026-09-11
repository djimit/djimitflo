import { beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@djimitflo/shared';
import type { ExecutorOptions } from '../execution/types';
import { CodexExecutor } from '../execution/executors/codex-executor';
import { EventEmitter } from 'node:events';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-id',
    title: 'Test task',
    description: 'echo hello world',
    status: 'pending' as any,
    priority: 'medium' as any,
    risk_level: 'low' as any,
    execution_mode: 'local' as any,
    agent_id: null,
    parent_task_id: null,
    repository_id: null,
    instruction_profile_id: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    execution_time_ms: null,
    token_usage: null,
    tags: [],
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('CodexExecutor', () => {
  let executor: CodexExecutor;

  beforeEach(() => {
    executor = new CodexExecutor('/usr/bin/codex');
  });

  it('uses the current Codex JSON and working-directory flags', () => {
    const task = makeTask({ description: 'test prompt' });
    const options: ExecutorOptions = { workingDirectory: '/tmp/project', format: 'json' };
    const args = (executor as any).buildCodexArgs(task, options);

    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--cd');
    expect(args[args.indexOf('--cd') + 1]).toBe('/tmp/project');
    expect(args).not.toContain('--format');
    expect(args).not.toContain('--dir');
    expect(args[args.length - 1]).toBe('test prompt');
  });

  it('uses the current Codex bypass flag only when explicitly requested', () => {
    const task = makeTask({ description: 'test prompt' });
    const defaultArgs = (executor as any).buildCodexArgs(task, {});
    expect(defaultArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(defaultArgs).not.toContain('--dangerously-skip-permissions');

    const bypassArgs = (executor as any).buildCodexArgs(task, { skipPermissions: true });
    expect(bypassArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(bypassArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('omits JSON flag when default output is requested', () => {
    const task = makeTask({ description: 'test prompt' });
    const args = (executor as any).buildCodexArgs(task, { format: 'default' });
    expect(args).not.toContain('--json');
  });

  it('configures Astra model, reasoning and workspace sandbox through existing options', () => {
    const command = executor.buildCommand(makeTask(), { model: 'gpt-6-astra', reasoningEffort: 'max', codexSandbox: 'workspace-write' });
    expect(command.args).toEqual(['exec', '--json', '--model', 'gpt-6-astra', '-c', 'model_reasoning_effort="max"', '--sandbox', 'workspace-write', 'echo hello world']);
    expect(() => executor.buildCommand(makeTask(), { reasoningEffort: 'invalid' as any })).toThrow('INVALID_REASONING_EFFORT');
  });

  it('maps native Codex command and usage events instead of anonymous logs', () => {
    const map = (event: unknown) => (executor as any).mapJsonEventToExecutionEvent('task', event);
    expect(map({ type: 'item.started', item: { id: 'item-1', type: 'command_execution', command: 'npm test' } })).toMatchObject({ event_type: 'tool.call', tool_name: 'command_execution' });
    expect(map({ type: 'item.completed', item: { id: 'item-1', type: 'command_execution', exit_code: 0, aggregated_output: 'passed' } })).toMatchObject({ event_type: 'tool.result', tool_output: { exit_code: 0 } });
    expect(map({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })).toMatchObject({ message: 'done' });
    expect(map({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })).toMatchObject({ metadata: { usage: { input_tokens: 10, output_tokens: 5 } } });
    expect(map({ type: 'turn.failed', error: { message: 'provider unavailable' } })).toMatchObject({ event_type: 'error', message: 'provider unavailable' });
  });

  it('persists reported Codex token usage in the execution result', async () => {
    const emitter = new EventEmitter();
    const result = (executor as any).createResultPromise(makeTask(), emitter);
    emitter.emit('output', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }) + '\n', 'stdout');
    emitter.emit('exit', 0);
    expect(await result).toMatchObject({ status: 'completed', metrics: { tokenUsage: 15 } });
  });

  async function parseWire(chunks: Array<[string, 'stdout' | 'stderr']>, options?: ExecutorOptions, synchronous = false) {
    const emitter = new EventEmitter();
    const emit = () => {
      for (const [text, stream] of chunks) emitter.emit('output', text, stream);
      emitter.emit('exit', 0);
    };
    const stream = (executor as any).createEventStream(makeTask(), emitter, () => {
      if (synchronous) emit(); else setImmediate(emit);
    }, false, options);
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it('keeps native stdout structured after the observed Codex stdin diagnostic on stderr', async () => {
    const events = await parseWire([
      ['Reading additional input from stdin...\n', 'stderr'],
      [JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }) + '\n', 'stdout'],
      [JSON.stringify({ type: 'item.completed', item: { id: 'warning-command', type: 'command_execution', command: 'git status --short', aggregated_output: 'git: warning: confstr() failed with code 5; using /tmp instead', exit_code: 0, status: 'completed' } }) + '\n', 'stdout'],
      [JSON.stringify({ type: 'item.completed', item: { id: 'failed-command', type: 'command_execution', command: 'rg --files scripts', aggregated_output: 'No such file or directory', exit_code: 2, status: 'failed' } }) + '\n', 'stdout'],
      [JSON.stringify({ type: 'item.completed', item: { id: 'summary', type: 'agent_message', text: 'The earlier error was corrected; verification passed.' } }) + '\n', 'stdout'],
    ]);
    expect(events.find(event => event.message === 'Reading additional input from stdin...')).toMatchObject({ event_type: 'log', level: 'info' });
    expect(events.filter(event => event.metadata?.parsing_mode === 'heuristic_fallback')).toHaveLength(0);
    expect(events.find(event => event.metadata?.item_id === 'warning-command')).toMatchObject({ event_type: 'tool.result', level: 'info', tool_output: { exit_code: 0 } });
    expect(events.find(event => event.metadata?.item_id === 'failed-command')).toMatchObject({ event_type: 'tool.result', level: 'error', tool_output: { exit_code: 2 } });
    expect(events.find(event => event.metadata?.item_id === 'summary')).toMatchObject({ event_type: 'log', level: 'info' });
  });

  it('keeps separate partial-line buffers for stdout and stderr and flushes final lines', async () => {
    const wire = JSON.stringify({ type: 'item.completed', item: { id: 'split', type: 'agent_message', text: 'complete' } });
    const events = await parseWire([
      [wire.slice(0, 24), 'stdout'], ['warning: diagnostic', 'stderr'],
      [wire.slice(24), 'stdout'], [' continued\n', 'stderr'],
    ]);
    expect(events.find(event => event.metadata?.item_id === 'split')).toMatchObject({ message: 'complete', level: 'info' });
    expect(events.find(event => event.message === 'warning: diagnostic continued')).toMatchObject({ event_type: 'log', level: 'warning' });
  });

  it('recovers structured parsing after malformed stdout, retaining legacy structured events and trailing plain output', async () => {
    const events = await parseWire([
      ['not-json\n{broken-json\n', 'stdout'],
      [JSON.stringify({ type: 'text', text: 'legacy structured message' }) + '\n', 'stdout'],
      [JSON.stringify({ type: 'item.completed', item: { id: 'recovered', type: 'agent_message', text: 'native recovered' } }) + '\n', 'stdout'],
      ['trailing plain diagnostic', 'stdout'],
    ]);
    expect(events.filter(event => event.metadata?.parsing_mode === 'heuristic_fallback')).toHaveLength(1);
    expect(events.some(event => event.message === 'legacy structured message')).toBe(true);
    expect(events.find(event => event.metadata?.item_id === 'recovered')).toMatchObject({ message: 'native recovered' });
    expect(events.some(event => event.message === 'trailing plain diagnostic')).toBe(true);
  });

  it('honors explicitly requested legacy text mode without claiming structured output failed', async () => {
    const events = await parseWire([['Using tool: bash\nSuccess: done\n', 'stdout']], { format: 'default' });
    expect(events.filter(event => event.metadata?.parsing_mode === 'heuristic_fallback')).toHaveLength(0);
    expect(events.some(event => event.event_type === 'tool.call' && event.tool_name === 'bash')).toBe(true);
    expect(events.some(event => event.event_type === 'tool.result')).toBe(true);
    expect(events[0].metadata.output_format).toBe('default');
  });

  it('drains output emitted synchronously with child close before the initial event is consumed', async () => {
    const events = await parseWire([
      [JSON.stringify({ type: 'item.completed', item: { id: 'fast-child', type: 'agent_message', text: 'fast result' } }) + '\n', 'stdout'],
    ], undefined, true);
    expect(events.find(event => event.metadata?.item_id === 'fast-child')).toMatchObject({ message: 'fast result' });
    expect(events.at(-1)).toMatchObject({ event_type: 'task.completed' });
  });

  it('bounds unterminated output lines and resumes only at the next newline without losing subsequent JSON', async () => {
    const events = await parseWire([
      ['x'.repeat(1024 * 1024 + 1), 'stdout'],
      ['discarded tail', 'stdout'],
      ['stderr remains observable\n', 'stderr'],
      ['\n' + JSON.stringify({ type: 'item.completed', item: { id: 'after-long-line', type: 'agent_message', text: 'recovered' } }) + '\n', 'stdout'],
    ]);
    expect(events.filter(event => event.metadata?.parsing_mode === 'truncated')).toHaveLength(1);
    expect(events.some(event => event.message === 'discarded tail')).toBe(false);
    expect(events.some(event => event.message === 'stderr remains observable')).toBe(true);
    expect(events.find(event => event.metadata?.item_id === 'after-long-line')).toMatchObject({ message: 'recovered' });
    expect(events.every(event => event.message.length < 1024)).toBe(true);
  });
});
