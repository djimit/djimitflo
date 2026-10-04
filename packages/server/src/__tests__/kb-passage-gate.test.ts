import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { gatePassages } from '../services/kb-corpus';
import type { TypeSafeClient } from '../services/typesafe-client';

let db: Database.Database; const env = { ...process.env };
const pages = [{ path: 'a.md', title: 'A', body: 'relevant' }, { path: 'b.md', title: 'B', body: 'unrelated' }];
let calls = 0;
const client = { systemOne: async () => { calls += 1; return { model: 'jev-1.13.0', answers: { p0: { type: 'noul', noul: 0.8 }, p1: { type: 'noul', noul: 0.1 } } }; } } as unknown as TypeSafeClient;
const failing = { systemOne: async () => { throw new Error('TYPESAFE_FAILED: HTTP 529'); } } as unknown as TypeSafeClient;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); calls = 0; process.env.TYPESAFE_API_KEY = 'test'; });
afterEach(() => { db.close(); process.env = { ...env }; });
const gate = (c = client) => gatePassages(db, { type: 'specialist_panel', id: 'p' }, 'proposal text', pages, c).then((s) => [...s].sort());

it('off: keeps every page and asks nothing', async () => {
  expect(await gate()).toEqual(['a.md', 'b.md']); expect(calls).toBe(0);
});
it('shadow: records one verdict for all pages and keeps them', async () => {
  process.env.TYPESAFE_KB_PASSAGE_RELEVANCE_MODE = 'shadow';
  expect(await gate()).toEqual(['a.md', 'b.md']); expect(calls).toBe(1);
  expect(db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'kb_passage_relevance'").get()).toEqual({ decision: 'yes', reason: 'a.md@0.80 b.md@0.10' });
});
it('enforce: drops pages jev reads as not helpful', async () => {
  process.env.TYPESAFE_KB_PASSAGE_RELEVANCE_MODE = 'enforce';
  expect(await gate()).toEqual(['a.md']);
});
it('enforce fails open when jev is unavailable', async () => {
  process.env.TYPESAFE_KB_PASSAGE_RELEVANCE_MODE = 'enforce';
  expect(await gate(failing)).toEqual(['a.md', 'b.md']);
});
