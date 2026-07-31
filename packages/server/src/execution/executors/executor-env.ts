// Shared env allowlist for tasks-path executors. Matches the loop-path
// RUNTIME_ENV_ALLOWLIST in loop-service.ts — server secrets stay out of
// spawned CLI children. RUNTIME_ENV_PASSTHROUGH=NAME,NAME adds extras.
const ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'TMPDIR', 'TMP', 'TEMP',
  'CODEX_BIN_PATH', 'OPENCODE_BIN_PATH', 'CLAUDE_BIN_PATH', 'GEMINI_BIN_PATH', 'CLINE_BIN_PATH',
  'DJIMITFLO_OPENCODE_MODEL', 'DJIMITFLO_CLAUDE_MODEL', 'DJIMITFLO_GEMINI_MODEL', 'DJIMITFLO_CLINE_MODEL', 'DJIMITFLO_CLINE_THINKING',
  'DJIMITFLO_CONTROL_URL', 'DJIMITFLO_SPAWN_TOKEN',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'OLLAMA_API_KEY', 'LOCALAI_BASE_URL', 'OLLAMA_BASE_URL', 'OLLAMA_HOST',
  'OPENCODE_OLLAMA_API_KEY', 'OPENCODE_OPENAI_API_KEY', 'OPENCODE_ANTHROPIC_API_KEY', 'OPENCODE_DEEPSEEK_API_KEY',
  'OPENCODE_GEMINI_API_KEY', 'OPENCODE_MOONSHOT_API_KEY', 'OPENCODE_NVIDIA_API_KEY', 'OPENCODE_OPENROUTER_API_KEY', 'OPENCODE_REQUESTY_API_KEY',
];

export function buildExecutorEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const names = new Set(ALLOWLIST);
  const extra = process.env.RUNTIME_ENV_PASSTHROUGH;
  if (extra) for (const n of extra.split(',').map((v) => v.trim()).filter(Boolean)) names.add(n);
  const env: NodeJS.ProcessEnv = {};
  for (const n of names) { const v = process.env[n]; if (v !== undefined) env[n] = v; }
  if (overrides) Object.assign(env, overrides);
  return env;
}
