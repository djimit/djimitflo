import { RUNBOOK_DEFAULTS, SCHEDULER_FLAGS } from './config-defaults.generated';
import { buildProvenance, type BuildProvenance } from '../utils/build-provenance';

/**
 * S3 (operator 2026-09-28): what the running server is configured with, read-only. Prod carries ~140 hand-edited flags in
 * runtime.env and nothing showed them. Only UPPER_SNAKE names are listed; anything that looks secret is masked by name
 * (KEY/TOKEN/SECRET/PASSWORD/…) or by value (credential patterns, URLs with user:pass@). Values are never editable here.
 *
 * DF-08 (UX audit 2026-10-23): per key also where the value comes from and what it means —
 * - source: `env` (set in this process), `default` (unset; the runbook documents a comparable code default), `unset`
 *   (unset; no comparable default known). Registry keys (runbook defaults, scheduler gating flags) are listed even when unset.
 * - default: the documented code default (config-defaults.generated.ts ← runbook flag tables; never parsed from code).
 * - overridden: set and ≠ default; null when the default is prose the view cannot compare, or the value is masked.
 * - takes_effect: always `restart`. process.env is fixed at boot (docker reads runtime.env on container start and nothing in
 *   the server writes a flag later), so even code that re-reads env every tick only sees a change after a restart.
 * - area: the operator task the key belongs to: scheduler gating flags first, then name patterns (first match wins; a
 *   cap is a cap whatever its domain).
 * The response also carries the running artifact identity (baked build commit); DJIMITFLO_COMMIT_SHA is flagged stale when
 * it differs, so a leftover runtime.env value is never shown as provenance.
 */
const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|COOKIE|SESSION|SALT|PAT|WEBHOOK|DSN|AUTH)(_|$)/i;
const SECRET_VALUE = /(?:apikey_|sk-|ghp_|github_pat_|xox[bp]-|AKIA|nvapi-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|:\/\/[^/\s:@]+:[^/\s@]+@|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const SYSTEM = new Set(['PATH', 'HOME', 'HOSTNAME', 'PWD', 'SHLVL', 'TERM', 'YARN_VERSION', 'NODE_VERSION', 'OLDPWD', '_']);

export const CONFIG_AREAS = ['models/routing', 'budgets/caps', 'schedulers', 'experiments', 'integrations', 'security/auth', 'knowledge', 'other'] as const;
export type ConfigArea = typeof CONFIG_AREAS[number];
const SCHEDULER_FLAG_SET = new Set(SCHEDULER_FLAGS);
const AREA_RULES: Array<[ConfigArea, RegExp]> = [
  ['budgets/caps', /_MAX(_|$)|_BUDGET(_|$)|_LIMIT(_|$)|_THROTTLE|_TIMEOUT_MS$|_CAP$|^RETENTION_/],
  ['security/auth', /^(AUTH0?|OIDC|JWT|KEYCLOAK|SESSION|SECRET|CORS|CONTENT_SAFETY|HACK_DETECTOR|POLICY|RANSOMWARE|COMPLIANCE|GOVERNANCE|APPROVAL|SELF_APPROVAL|FLEET_EVENT_SIGNATURES|AUTONOMY|LOOP_AUTO_APPROVE|ORACLE_LANES_AUTO_APPROVE|LOOP_AUTO_MERGE)(_|$)|_SPAWN_TOKEN_|_ALLOWED_USERS$/],
  ['schedulers', /_INTERVAL(_MS)?$|^SCHEDULE(D|R)_|_SCHEDULER_|_HOUR$|^(QUEUE_HYGIENE|DISK_GUARD|STALL_WATCH|OPERATOR_DIGEST|RECONCILIATION)_/],
  ['experiments', /^(DREAM|GYM|TRIAL|HOLDOUT|GENOME|EVOLUTION|LOOP_BANDIT|LOOP_EVOLVE|FITNESS|GRADED|ACE_001|STE_001|TG_001|EFFORT|CHECKER_FAMILY|CHECKER_CROSS|MEMORY_HOLDOUT|JEV_CHALLENGER|ARENA|MERGE_SURVIVAL|EXPERIMENT|OPENMYTHOS|SUBSCRIPTION_GYM|TRAINING_DATASET|VALUE_ALLOCATOR|SHIPPED_CODE|WEAK_ASSERTION|FAIL_BEFORE_PASS_AFTER|MUTATION|SPEC_GAP|NE_GENERATOR_CHECK|VALUE_ANOMALY|RESOURCE_LEDGER|OUTCOME_ATTRIBUTION|MAKER)(_|$)/],
  ['models/routing', /^(OLLAMA|LITELLM|MODEL|PANEL_FALLBACK|LLM|OPENAI|ANTHROPIC|GEMINI|NVIDIA|OPENROUTER|CLAUDE|CODEX|OPENCODE|CLINE|PI|HERMES|ATOMIC|RUNTIME|COUNCIL|SPECIALIST|CASCADE|INFERENCE|SOCIAL_COMPAT|AZURE|GOOGLE)(_|$)/],
  ['knowledge', /^(QDRANT|KNOWLEDGE|OKF|KB|DJIMITKB|DISCOVERY|FRONTIER|MEMORY|SKILL|RETRIEVAL|VECTOR|EMBEDDING|UAMS|OPENALEX|TECHNIQUE)(_|$)/],
  ['integrations', /^(GITHUB|TELEGRAM|FEDERATION|PAPERCLIP|ROBOREV|DJIMIT|EVENT|MCP|DOCKER|REMOTE|OUTBOUND|DEPLOY|PG|DATABASE|DEERFLOW|PLUGIN|HOST_AGENT|COMMONS|SOCIAL|AUTONOMOUS_LURES|LOOP_AUTO_DRAFT_PR|EXTRA_REPOS)(_|$)/],
];

export function configArea(name: string): ConfigArea {
  if (SCHEDULER_FLAG_SET.has(name)) return 'schedulers'; // arms a background scheduler at boot (HEARTBEAT.md)
  return AREA_RULES.find(([, re]) => re.test(name))?.[0] ?? 'other';
}

type ParsedDefault = { kind: 'off' } | { kind: 'empty' } | { kind: 'number'; n: number } | { kind: 'string'; s: string };

/** The comparable head of a runbook default cell, or null when it is prose ("the primary repo … only"). */
export function parseDefault(text: string): ParsedDefault | null {
  const t = text.trim();
  if (/^(off|unset = off|`?''`? = off)\b/i.test(t)) return { kind: 'off' };
  if (/^unset\b/i.test(t) || /^`?''`?(\s|$)/.test(t)) return { kind: 'empty' };
  const num = t.match(/^(-?\d+(?:\.\d+)?)(\s|$)/);
  if (num) return { kind: 'number', n: Number(num[1]) };
  const word = t.match(/^`([^`]+)`(\s|$)/) ?? t.match(/^([a-z][a-z0-9_-]*)(\s+\(|$)/i);
  return word ? { kind: 'string', s: word[1] } : null;
}

const label = (d: ParsedDefault) => (d.kind === 'off' ? 'off' : d.kind === 'empty' ? 'unset' : d.kind === 'number' ? String(d.n) : d.s);

function differs(value: string, d: ParsedDefault): boolean | null {
  const v = value.trim();
  if (d.kind === 'off') return !['', 'off', 'false', '0', 'no'].includes(v.toLowerCase());
  if (d.kind === 'empty') return v !== '';
  if (v === '') return null; // empty for a number/word default: `||` vs `??` in the reading code decides, unknown here
  if (d.kind === 'number') return Number(v) !== d.n;
  return v.toLowerCase() !== d.s.toLowerCase();
}

const sameCommit = (a: string, b: string) => { const x = a.trim().toLowerCase(); const y = b.trim().toLowerCase(); return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x)); };

export interface ConfigEntry {
  name: string;
  /** null when the key is not set in this process */
  value: string | null;
  masked: boolean;
  group: string;
  area: ConfigArea;
  source: 'env' | 'default' | 'unset';
  default: string | null;
  overridden: boolean | null;
  takes_effect: 'restart';
  /** DJIMITFLO_COMMIT_SHA only: differs from the running build (null = no baked build commit to compare with) */
  stale?: boolean | null;
}

export function runtimeConfigView(env: NodeJS.ProcessEnv = process.env): { entries: ConfigEntry[]; masked: number; build: BuildProvenance } {
  const build = buildProvenance(env);
  const set = Object.entries(env).filter(([name, value]) => /^[A-Z][A-Z0-9_]*$/.test(name) && !SYSTEM.has(name) && typeof value === 'string') as Array<[string, string]>;
  const registry = [...Object.keys(RUNBOOK_DEFAULTS), ...SCHEDULER_FLAGS].filter((name) => env[name] === undefined);
  const entries = [...set, ...[...new Set(registry)].map((name): [string, null] => [name, null])].map(([name, raw]): ConfigEntry => {
    const masked = raw !== null && (SECRET_NAME.test(name) || SECRET_VALUE.test(raw));
    const docText = RUNBOOK_DEFAULTS[name] ?? null;
    const parsed = docText === null ? null : parseDefault(docText);
    const entry: ConfigEntry = {
      name,
      value: raw === null ? null : masked ? (raw ? `set (${raw.length} chars)` : 'empty') : raw.slice(0, 500),
      masked,
      group: name.split('_')[0],
      area: configArea(name),
      source: raw !== null ? 'env' : parsed ? 'default' : 'unset',
      default: parsed ? label(parsed) : docText,
      overridden: raw === null ? (parsed ? false : null) : masked || !parsed ? null : differs(raw, parsed),
      takes_effect: 'restart',
    };
    if (name === 'DJIMITFLO_COMMIT_SHA' && raw !== null) entry.stale = build.built_commit ? !sameCommit(raw, build.built_commit) : null;
    return entry;
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { entries, masked: entries.filter((e) => e.masked).length, build };
}
