import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { aceLane, similarExamples, similarKbPages } from '../services/ace-001';
import type { AceLane } from '../services/ace-001';

let db: Database.Database;
let checkout: string;
const now = new Date().toISOString();
const blob = (v: number[]) => { const f = new Float32Array(v); return Buffer.from(f.buffer, f.byteOffset, f.byteLength); };
const proposal = (id: string, status: string, refs: string[], artifact?: string) =>
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES (?, 'feature', ?, 'd', 'r', 'gap_analysis', ?, 0.5, ?, ?, ?, ?)`)
    .run(id, `t-${id}`, status, JSON.stringify(refs), artifact ? JSON.stringify({ target: 'x', artifactPath: artifact }) : null, now, now);
const embedding = (id: string, v: number[]) =>
  db.prepare('INSERT INTO proposal_embeddings (proposal_id, model, vector, created_at) VALUES (?, ?, ?, ?)').run(id, 'test', blob(v), now);
const goal = (id: string, improvementId: string) =>
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, ?, ?)`)
    .run(id, improvementId, now, now);
const kb = (p: string, v: number[], body = `body of ${p}`) =>
  db.prepare('INSERT INTO kb_pages (path, host, title, body, sha, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p, 'ws', `title ${p}`, body, createHash('sha256').update(body).digest('hex'), blob(v), now);
const writeFile = (rel: string) => { const f = path.join(checkout, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '// v'); return rel; };

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  db.exec('CREATE TABLE IF NOT EXISTS proposal_embeddings (proposal_id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS kb_pages (path TEXT PRIMARY KEY, host TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)');
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-exp-'));
});
afterEach(() => { db.close(); fs.rmSync(checkout, { recursive: true, force: true }); });

describe('aceLane', () => {
  it('returns null for a null or missing goal id', () => {
    expect(aceLane(db, null)).toBeNull();
    expect(aceLane(db, 'missing')).toBeNull();
  });
  it('classifies test-gap and mutation-gap goals', () => {
    proposal('tg', 'executing', ['"test-gap:x"']); goal('g-tg', 'tg');
    expect(aceLane(db, 'g-tg')).toEqual({ lane: 'test-gap' as AceLane, improvementId: 'tg' });
    proposal('mut', 'executing', ['"mutation-gap:x"']); goal('g-mut', 'mut');
    expect(aceLane(db, 'g-mut')).toEqual({ lane: 'mutation' as AceLane, improvementId: 'mut' });
  });
  it('returns null when refs contain neither lane marker', () => {
    proposal('other', 'executing', ['"reflection:x"']); goal('g-other', 'other');
    expect(aceLane(db, 'g-other')).toBeNull();
  });
});

describe('similarExamples', () => {
  it('returns null when the improvement has no proposal vector', () => {
    proposal('nv', 'verified', ['"test-gap:nv"'], writeFile('a.test.ts'));
    expect(similarExamples(db, 'nv', 'test-gap', checkout)).toBeNull();
  });
  it('returns null when no verified same-lane improvements with existing artifacts exist', () => {
    embedding('q', [1, 0, 0]); proposal('q', 'executing', ['"test-gap:q"']);
    expect(similarExamples(db, 'q', 'test-gap', checkout)).toBeNull();
  });
  it('returns closest verified same-lane artifacts sorted by cosine, excluding self, non-verified, and other lanes', () => {
    embedding('q', [1, 0, 0]); proposal('q', 'verified', ['"test-gap:q"'], writeFile('q.test.ts'));
    const close = writeFile('close.test.ts'); embedding('close', [0.9, 0.1, 0]); proposal('close', 'verified', ['"test-gap:close"'], close);
    const far = writeFile('far.test.ts'); embedding('far', [0.1, 0.9, 0]); proposal('far', 'verified', ['"test-gap:far"'], far);
    embedding('pending', [0.99, 0.01, 0]); proposal('pending', 'executing', ['"test-gap:pending"'], writeFile('p.test.ts'));
    embedding('mut', [0.95, 0.05, 0]); proposal('mut', 'verified', ['"mutation-gap:mut"'], writeFile('m.test.ts'));

    const result = similarExamples(db, 'q', 'test-gap', checkout, 5);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0]).toContain('close.test.ts');
    expect(result![1]).toContain('far.test.ts');
  });
  it('skips artifacts absent on disk and vectors of mismatched dimension', () => {
    embedding('q', [1, 0, 0]); proposal('q', 'executing', ['"test-gap:q"']);
    embedding('ghost', [0.99, 0.01, 0]); proposal('ghost', 'verified', ['"test-gap:ghost"'], 'no/ghost.test.ts');
    const dim = writeFile('dim.test.ts'); embedding('dim', [1, 0]); proposal('dim', 'verified', ['"test-gap:dim"'], dim);
    expect(similarExamples(db, 'q', 'test-gap', checkout)).toBeNull();
  });
});

describe('similarKbPages', () => {
  it('returns null when the improvement has no proposal vector', () => {
    proposal('nv', 'executing', ['"test-gap:nv"']);
    expect(similarKbPages(db, 'nv')).toBeNull();
  });
  it('returns pages sorted by cosine above the minimum, respecting k and skipping stale-sha and mismatched-dim pages', () => {
    embedding('q', [1, 0, 0]); proposal('q', 'executing', ['"test-gap:q"']);
    kb('a.md', [0.9, 0.1, 0]); kb('b.md', [0.8, 0.2, 0]); kb('c.md', [0.1, 0.9, 0]);
    db.prepare('INSERT INTO kb_pages (path, host, title, body, sha, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('stale.md', 'ws', 't', 'body', 'deadbeef', blob([0.99, 0.01, 0]), now);
    kb('dim.md', [1, 0]);

    const result = similarKbPages(db, 'q', 2, 0.3);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].path).toBe('a.md');
    expect(result![1].path).toBe('b.md');
    expect(result!.find((r) => r.path === 'stale.md')).toBeUndefined();
    expect(result!.find((r) => r.path === 'dim.md')).toBeUndefined();
  });
  it('returns an empty array when the kb_pages table is missing', () => {
    embedding('q', [1, 0, 0]); proposal('q', 'executing', ['"test-gap:q"']);
    db.exec('DROP TABLE kb_pages');
    expect(similarKbPages(db, 'q')).toEqual([]);
  });
});