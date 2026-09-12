import type { Profile } from './db';

export type Target = 'openclaw' | 'codex' | 'claude-code' | 'cursor' | 'gemini-cli' | 'djimit-native';
export const TARGETS: Target[] = ['openclaw', 'codex', 'claude-code', 'cursor', 'gemini-cli', 'djimit-native'];
export interface CompiledArtifact { target: Target; files: Record<string, string>; stub?: boolean }

function clamp(s?: string): string { return String(s ?? '').trim(); }

export function compile(profile: Profile, target: Target): CompiledArtifact {
  switch (target) {
    case 'openclaw': return compileOpenClaw(profile);
    case 'codex': return compileCodex(profile);
    case 'claude-code': return compileClaudeCode(profile);
    case 'cursor': return compileCursor(profile);
    case 'gemini-cli': return compileGeminiCli(profile);
    case 'djimit-native': return { target, files: { 'djimit-agent.yaml': `id: ${profile.id}\nname: ${profile.name}\ndivision: ${profile.division}\nmission: ${JSON.stringify(profile.mission)}\nruntime_targets: [${profile.runtime_targets.join(', ')}]\n` } };
  }
}

function compileOpenClaw(p: Profile): CompiledArtifact {
  const soul = `# SOUL — ${p.name}\n\n${clamp(p.persona) || 'Persona not specified.'}\n\n## Mission\n${clamp(p.mission)}\n`;
  const agents = [
    `# AGENTS — ${p.name}`, '', `Division: ${p.division}`, `Source: ${p.source_repo}/${p.source_path}`, '',
    '## Mission', clamp(p.mission), '',
    '## Critical Rules', ...(p.rules.length ? p.rules.map(r => `- ${r}`) : ['- (none)']), '',
    '## Workflow', ...(p.workflows.length ? p.workflows.map(w => `- ${w}`) : ['- (none)']), '',
    '## Deliverables', ...(p.deliverables.length ? p.deliverables.map(d => `- ${d}`) : ['- (none)']), '',
    '## Success Metrics', ...(p.success_metrics.length ? p.success_metrics.map(m => `- ${m}`) : ['- (none)']), '',
    '## Memory Policy', clamp(p.memory_policy) || '(default — retain task-relevant context only)', '',
    '## Tools Required', ...(p.tools_required.length ? p.tools_required.map(t => `- ${t}`) : ['- (none)']), '',
  ].join('\n');
  const identity = `# IDENTITY — ${p.name}\n\nid: ${p.id}\nname: ${p.name}\ndivision: ${p.division}\nruntime_targets: ${p.runtime_targets.join(', ') || '(none)'}\n`;
  return { target: 'openclaw', files: { 'SOUL.md': soul, 'AGENTS.md': agents, 'IDENTITY.md': identity } };
}

function compileCodex(p: Profile): CompiledArtifact {
  const instructions = [
    `You are ${p.name} (${p.division}).`,
    clamp(p.persona) && `Persona: ${p.persona}`,
    `Mission: ${clamp(p.mission)}`,
    p.rules.length && `Rules:\n${p.rules.map(r => `- ${r}`).join('\n')}`,
    p.workflows.length && `Workflow:\n${p.workflows.map(w => `- ${w}`).join('\n')}`,
    p.tools_required.length && `Tools: ${p.tools_required.join(', ')}`,
  ].filter(Boolean).join('\n\n');
  return { target: 'codex', files: { 'agent.toml': `[agent]\nname = ${JSON.stringify(p.name)}\nmodel = "gpt-4o"\ninstructions = ${JSON.stringify(instructions)}\n` } };
}

function fileStem(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]+/g, '-');
  let start = 0;
  let end = cleaned.length;
  while (start < end && cleaned[start] === '-') start++;
  while (end > start && cleaned[end - 1] === '-') end--;
  return cleaned.slice(start, end) || 'agent';
}
function yamlString(value: string): string { return JSON.stringify(clamp(value)); }
function markdownBody(p: Profile): string {
  return [
    `# ${p.name}`,
    '',
    `## Mission\n${clamp(p.mission) || 'Mission not specified.'}`,
    '',
    `## Persona\n${clamp(p.persona) || 'Persona not specified.'}`,
    '',
    '## Rules', ...(p.rules.length ? p.rules.map(rule => `- ${rule}`) : ['- None specified.']),
    '',
    '## Workflow', ...(p.workflows.length ? p.workflows.map(step => `- ${step}`) : ['- None specified.']),
    '',
    '## Deliverables', ...(p.deliverables.length ? p.deliverables.map(item => `- ${item}`) : ['- None specified.']),
    '',
    '## Success Metrics', ...(p.success_metrics.length ? p.success_metrics.map(metric => `- ${metric}`) : ['- None specified.']),
    '',
    `## Memory Policy\n${clamp(p.memory_policy) || 'Retain task-relevant context only.'}`,
    '',
    '## Tools Required', ...(p.tools_required.length ? p.tools_required.map(tool => `- ${tool}`) : ['- None specified.']),
    '',
  ].join('\n');
}

function compileClaudeCode(p: Profile): CompiledArtifact {
  const description = clamp(p.mission) || `Agent for ${p.division}`;
  const tools = p.tools_required.length ? p.tools_required.join(', ') : 'Read, Edit, Bash';
  const content = [`---`, `name: ${yamlString(p.name)}`, `description: ${yamlString(description)}`, `tools: ${yamlString(tools)}`, `---`, '', markdownBody(p)].join('\n');
  return { target: 'claude-code', files: {[`${fileStem(p.id)}.md`]: content} };
}

function compileCursor(p: Profile): CompiledArtifact {
  const content = [`---`, `description: ${yamlString(clamp(p.mission) || `Agent for ${p.division}`)}`, 'globs: **/*', 'alwaysApply: false', `---`, '', markdownBody(p)].join('\n');
  return { target: 'cursor', files: {[`${fileStem(p.id)}.mdc`]: content} };
}

function compileGeminiCli(p: Profile): CompiledArtifact {
  const content = [`---`, `name: ${yamlString(fileStem(p.id))}`, `description: ${yamlString(clamp(p.mission) || `Agent for ${p.division}`)}`, '---', '', markdownBody(p)].join('\n');
  return { target: 'gemini-cli', files: {'SKILL.md': content} };
}
