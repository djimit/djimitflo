import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { DataClassification } from '../services/data-classification';
import { DataClassificationEnforcement } from '../services/data-classification-enforcement';
import { checkProviderRoutingV2, classifyDestination, egressEvidence } from '../services/egress-classification';

it('UX-20: known providers are classified from the recorded provider, model and configured base URLs', () => {
  const env = { SOCIAL_COMPAT_BASE_URL: 'https://ollama.com/v1', OLLAMA_URL: 'http://localhost:11434' } as NodeJS.ProcessEnv;
  expect(classifyDestination({ provider: 'nvidia', model: 'nemotron' }, env)).toBe('us_cloud');
  expect(classifyDestination({ provider: 'ollama:https://ollama.com', model: 'glm-5.2' }, env)).toBe('us_cloud');
  expect(classifyDestination({ provider: null, model: 'kimi-k3:cloud' }, env)).toBe('us_cloud'); // panel review records no provider
  expect(classifyDestination({ provider: 'openai-compatible', model: 'kimi-k2.6' }, env)).toBe('us_cloud'); // residents → configured base URL
  expect(classifyDestination({ provider: 'ollama', model: 'gemma' }, env)).toBe('local');
  expect(classifyDestination({ provider: 'ollama:http://10.1.2.3:11434', model: 'x' }, env)).toBe('local');
  expect(classifyDestination({ provider: 'openai:http://100.70.1.1:4000', model: 'x' }, env)).toBe('local'); // tailnet range
});

it('UX-20: an unknown provider stays unknown — never guessed', () => {
  expect(classifyDestination({ provider: 'typesafe', model: 'jev-1.13.0' }, {})).toBe('unknown'); // jurisdiction not verified
  expect(classifyDestination({ provider: 'openai:https://llm.example.org', model: 'x' }, {})).toBe('unknown');
  expect(classifyDestination({ provider: 'embedding-provider', model: 'nomic' }, {})).toBe('unknown'); // base URL not configured
  expect(classifyDestination({ provider: 'something-new', model: 'm' }, {})).toBe('unknown');
});

it('UX-20: V2 private_only refuses US clouds and unknown destinations; the old checkProviderRouting is unchanged', () => {
  expect(checkProviderRoutingV2(DataClassification.CONFIDENTIAL, 'us_cloud').allowed).toBe(false);
  expect(checkProviderRoutingV2(DataClassification.CONFIDENTIAL, 'unknown').allowed).toBe(false);
  expect(checkProviderRoutingV2(DataClassification.CONFIDENTIAL, 'local').allowed).toBe(true);
  expect(checkProviderRoutingV2(DataClassification.CONFIDENTIAL, 'eu_hosted').allowed).toBe(true);
  expect(checkProviderRoutingV2(DataClassification.RESTRICTED, 'eu_hosted').allowed).toBe(false);
  expect(checkProviderRoutingV2(DataClassification.INTERNAL, 'us_cloud').allowed).toBe(true);
  // the original rule still lists openai/anthropic as private_only — V2 sits beside it, not in its place
  const old = new DataClassificationEnforcement();
  expect(old.checkProviderRouting(DataClassification.CONFIDENTIAL, 'openai').allowed).toBe(true);
  expect(old.checkProviderRouting(DataClassification.RESTRICTED, 'openai').allowed).toBe(false);
});

it('UX-20: evidence counts calls per consumer × destination and what V2 would block, equal to hand SQL', () => {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON');
  const now = Date.parse('2026-10-06T12:00:00Z'); const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const ins = db.prepare('INSERT INTO llm_model_calls (consumer, model, ok, latency_ms, out_chars, shadow, provider, created_at) VALUES (?, ?, 1, 10, 0, 0, ?, ?)');
  ins.run('jev', 'jev-1.13.0', 'typesafe', at(1)); ins.run('jev', 'jev-1.13.0', 'typesafe', at(2));
  ins.run('panel_review', 'kimi-k3:cloud', null, at(3));
  ins.run('content_safety', 'nemotron', 'nvidia', at(4));
  ins.run('fallback', 'gemma', 'ollama:http://localhost:11434', at(5));
  ins.run('jev', 'jev-1.13.0', 'typesafe', at(24 * 9)); // outside the 7-day window
  const e = egressEvidence(db, {}, now, 7);
  const hand = (db.prepare('SELECT COUNT(*) AS n FROM llm_model_calls WHERE created_at >= ?').get(new Date(now - 7 * 86_400_000).toISOString()) as { n: number }).n;
  const total = e.by_consumer.reduce((a, c) => a + c.local + c.eu_hosted + c.us_cloud + c.unknown, 0);
  expect(total).toBe(hand); expect(total).toBe(5);
  expect(e.by_consumer).toEqual(expect.arrayContaining([
    { consumer: 'jev', data_class: 'confidential', local: 0, eu_hosted: 0, us_cloud: 0, unknown: 2 },
    { consumer: 'panel_review', data_class: 'internal', local: 0, eu_hosted: 0, us_cloud: 1, unknown: 0 },
    { consumer: 'fallback', data_class: 'internal', local: 1, eu_hosted: 0, us_cloud: 0, unknown: 0 },
  ]));
  // only the confidential jev calls (unknown destination) would be blocked under V2
  expect(e.would_block_v2).toEqual(expect.arrayContaining([{ data_class: 'confidential', calls: 2, blocked: 2 }, { data_class: 'internal', calls: 3, blocked: 0 }]));
  expect(egressEvidence(new Database(':memory:'), {}, now).by_consumer).toEqual([]); // no table → empty, never throws
});
