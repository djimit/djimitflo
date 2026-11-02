import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OkfKnowledgeUpdater } from '../services/okf-knowledge-updater';
import type { JudgeVerdict, ExpertAnswer } from '../services/judge-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let updater: OkfKnowledgeUpdater;
let okfBase: string;
const previousOkfBase = process.env.OKF_BASE;

function verdict(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    id: '1',
    score: 85,
    confidence: 0.9,
    reasoning: 'Good',
    contradictions: [],
    recommendations: [],
    verification_status: 'verified',
    promotion_decision: 'VERIFIED_FOR_USE',
    created_at: new Date().toISOString(),
    score_kind: 'heuristic',
    ...over,
  };
}

function answer(over: Partial<ExpertAnswer> = {}): ExpertAnswer {
  return { domain: 'physics', content: 'Test content', source: 'wikipedia', confidence: 0.8, ...over };
}

beforeEach(() => {
  // Isolated writable OKF base so the updater doesn't depend on the repo
  // knowledge symlink (which points outside the repo and is absent in CI).
  okfBase = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-okf-updater-'));
  fs.mkdirSync(path.join(okfBase, 'concepts'), { recursive: true });
  process.env.OKF_BASE = okfBase;

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  updater = new OkfKnowledgeUpdater(db);
});

afterEach(() => {
  db?.close();
  if (previousOkfBase) process.env.OKF_BASE = previousOkfBase;
  else delete process.env.OKF_BASE;
  if (okfBase) fs.rmSync(okfBase, { recursive: true, force: true });
});

describe('G100: OKF Knowledge Updater', () => {
  it('returns false for contradicted verdict', async () => {
    const result = await updater.updateFromVerdict('test', [], verdict({
      verification_status: 'contradicted', contradictions: ['a vs b'], score: 30, confidence: 0.2,
    }));
    expect(result).toBe(false);
  });

  it('returns false for unverifiable verdict', async () => {
    const result = await updater.updateFromVerdict('test', [], verdict({
      verification_status: 'unverifiable', score: 20, confidence: 0.1,
    }));
    expect(result).toBe(false);
  });

  it('returns true and writes a concept file for a verified verdict', async () => {
    const result = await updater.updateFromVerdict('Quantum Physics 101', [answer()], verdict());
    expect(result).toBe(true);

    const history = updater.getUpdateHistory(10);
    expect(history.length).toBe(1);
    expect(history[0].action).toBe('created');
    expect(history[0].topic).toBe('Quantum Physics 101');
    expect(history[0].concept_path).toBe(path.join(okfBase, 'concepts', 'quantum-physics-101.md'));
    expect(fs.existsSync(history[0].concept_path)).toBe(true);
  });

  it('slugifies the topic (lowercase, collapse non-alnum, trim edges, slice 50)', async () => {
    const result = await updater.updateFromVerdict('!  Quantum  Physics  !!', [answer()], verdict());
    expect(result).toBe(true);
    const history = updater.getUpdateHistory(10);
    expect(path.basename(history[0].concept_path)).toBe('quantum-physics.md');
  });

  it('truncates the slug to 50 characters', async () => {
    const longTopic = 'Aaaaaaaaaa Bbbbbbbbbb Cccccccccc Dddddddddd Eeeeeeeeee Ffffff';
    const result = await updater.updateFromVerdict(longTopic, [answer()], verdict());
    expect(result).toBe(true);
    const history = updater.getUpdateHistory(10);
    const slug = path.basename(history[0].concept_path, '.md');
    expect(slug.length).toBe(50);
  });

  it('writes frontmatter and body content into the created concept', async () => {
    const answers = [
      answer({ domain: 'physics', content: 'Test content', source: 'wikipedia', metadata: { url: 'https://example.com/q', title: 'Quantum Page' } }),
      answer({ domain: 'math', content: 'Math content', source: 'arxiv', metadata: { title: 'No URL' } }),
    ];
    const v = verdict({ score: 85, confidence: 0.9, contradictions: ['c1', 'c2'] });
    await updater.updateFromVerdict('Quantum Physics', answers, v);

    const file = path.join(okfBase, 'concepts', 'quantum-physics.md');
    const content = fs.readFileSync(file, 'utf8');

    // frontmatter
    expect(content).toContain('type: Concept');
    expect(content).toContain('title: "Quantum Physics"');
    expect(content).toContain('confidence: 0.90');
    expect(content).toContain('verification: verified');
    expect(content).toMatch(/domains: \[physics, math\]/);
    expect(content).toMatch(/sources: \[https:\/\/example\.com\/q\]/);
    expect(content).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);

    // body
    expect(content).toContain('# Quantum Physics');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Domain Knowledge');
    expect(content).toContain('### physics\n\nTest content');
    expect(content).toContain('### math\n\nMath content');
    expect(content).toContain('## Sources');
    expect(content).toMatch(/- Quantum Page: https:\/\/example\.com\/q/);
    // answer without url is filtered out of sources
    expect(content).not.toMatch(/- No URL:/);

    // verification
    expect(content).toContain('## Verification');
    expect(content).toContain('- Score: 85/100');
    expect(content).toContain('- Confidence: 0.90');
    expect(content).toContain('- Status: verified');
    expect(content).toContain('- Contradictions: 2');
  });

  it('updates an existing concept (append) and records action=updated', async () => {
    const conceptPath = path.join(okfBase, 'concepts', 'quantum-physics.md');
    fs.writeFileSync(conceptPath, 'ORIGINAL CONTENT\n', 'utf8');

    const result = await updater.updateFromVerdict('quantum physics', [answer()], verdict({ confidence: 0.9 }));
    expect(result).toBe(true);

    const history = updater.getUpdateHistory(10);
    expect(history[0].action).toBe('updated');
    expect(history[0].concept_path).toBe(conceptPath);

    const content = fs.readFileSync(conceptPath, 'utf8');
    // original content preserved (readFileSync worked)
    expect(content.startsWith('ORIGINAL CONTENT')).toBe(true);
    // update section appended with date and confidence
    expect(content).toMatch(/## Update \d{4}-\d{2}-\d{2}\n\nConfidence: 0\.90\n\n---/);
  });

  it('finds an existing concept when slug includes the file basename', async () => {
    // file "quantum.md", slug "quantum-physics": file.includes(slug) false, slug.includes("quantum") true
    fs.writeFileSync(path.join(okfBase, 'concepts', 'quantum.md'), 'ORIGINAL\n', 'utf8');
    const result = await updater.updateFromVerdict('quantum physics', [answer()], verdict());
    expect(result).toBe(true);
    expect(updater.getUpdateHistory(10)[0].action).toBe('updated');
  });

  it('creates a new concept when no matching file exists', async () => {
    fs.writeFileSync(path.join(okfBase, 'concepts', 'totally-different.md'), 'ORIGINAL\n', 'utf8');
    const result = await updater.updateFromVerdict('quantum physics', [answer()], verdict());
    expect(result).toBe(true);
    const history = updater.getUpdateHistory(10);
    expect(history[0].action).toBe('created');
    expect(fs.existsSync(path.join(okfBase, 'concepts', 'quantum-physics.md'))).toBe(true);
  });

  it('creates a concept when the concepts directory does not exist', async () => {
    fs.rmSync(path.join(okfBase, 'concepts'), { recursive: true, force: true });
    const result = await updater.updateFromVerdict('brand new topic', [answer()], verdict());
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(okfBase, 'concepts', 'brand-new-topic.md'))).toBe(true);
  });

  it('returns false when writing the concept fails', async () => {
    // Point OKF_BASE at a regular file so concepts/<slug>.md cannot be written.
    const fileAsBase = path.join(okfBase, 'i-am-a-file');
    fs.writeFileSync(fileAsBase, 'x');
    process.env.OKF_BASE = fileAsBase;
    const failingUpdater = new OkfKnowledgeUpdater(db);

    const result = await failingUpdater.updateFromVerdict('topic', [answer()], verdict());
    expect(result).toBe(false);
    expect(updater.getUpdateHistory(10).length).toBe(0);
  });

  it('records update history with limit applied', async () => {
    for (let i = 0; i < 3; i++) {
      await updater.updateFromVerdict(`topic-${i}`, [answer()], verdict());
    }
    const all = updater.getUpdateHistory(100);
    expect(all.length).toBe(3);
    const limited = updater.getUpdateHistory(2);
    expect(limited.length).toBe(2);
  });

  it('tracks update history', async () => {
    await updater.updateFromVerdict('topic1', [answer()], verdict());
    const history = updater.getUpdateHistory(10);
    expect(history.length).toBe(1);
    expect(history[0].topic).toBe('topic1');
  });

  it('records created action for new topic', async () => {
    const uniqueTopic = 'xyz-unique-topic-' + Date.now();
    await updater.updateFromVerdict(uniqueTopic, [answer()], verdict());
    const history = updater.getUpdateHistory(10);
    expect(history[0].action).toBe('created');
  });
});