/**
 * S3 (operator 2026-09-28): what the running server is configured with, read-only. Prod carries ~140 hand-edited flags in
 * runtime.env and nothing showed them. Only UPPER_SNAKE names are listed; anything that looks secret is masked by name
 * (KEY/TOKEN/SECRET/PASSWORD/…) or by value (credential patterns, URLs with user:pass@). Values are never editable here.
 */
const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|COOKIE|SESSION|SALT|PAT|WEBHOOK|DSN|AUTH)(_|$)/i;
const SECRET_VALUE = /(?:apikey_|sk-|ghp_|github_pat_|xox[bp]-|AKIA|nvapi-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|:\/\/[^/\s:@]+:[^/\s@]+@|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const SYSTEM = new Set(['PATH', 'HOME', 'HOSTNAME', 'PWD', 'SHLVL', 'TERM', 'YARN_VERSION', 'NODE_VERSION', 'OLDPWD', '_']);

export interface ConfigEntry { name: string; value: string; masked: boolean; group: string }

export function runtimeConfigView(env: NodeJS.ProcessEnv = process.env): { entries: ConfigEntry[]; masked: number } {
  const entries = Object.entries(env)
    .filter(([name, value]) => /^[A-Z][A-Z0-9_]*$/.test(name) && !SYSTEM.has(name) && typeof value === 'string')
    .map(([name, value]) => {
      const masked = SECRET_NAME.test(name) || SECRET_VALUE.test(value!);
      return { name, value: masked ? (value ? `set (${value.length} chars)` : 'empty') : value!.slice(0, 500), masked, group: name.split('_')[0] };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { entries, masked: entries.filter((e) => e.masked).length };
}
