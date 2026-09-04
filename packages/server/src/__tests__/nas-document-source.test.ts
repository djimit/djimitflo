import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NasDocumentSource } from '../services/nas-document-source';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-nas-source-'));
  tempDirs.push(root);
  for (const [relativePath, text] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, text, 'utf8');
  }
  return root;
}

describe('NasDocumentSource', () => {
  it('turns an allowlisted document into an evidence packet', () => {
    const root = fixture({ 'Claude Cowork/Nieuwsbrief/BUILDPLAN-agent-endpoints.md': '# Agent endpoints\nUse latest and threat-feed endpoints.' });

    const result = new NasDocumentSource().preflight({
      root,
      relativePath: 'Claude Cowork/Nieuwsbrief/BUILDPLAN-agent-endpoints.md',
      domain: 'djimitflo',
    });

    expect(result.accepted).toBe(true);
    expect(result.packet).toMatchObject({
      source_path: 'Claude Cowork/Nieuwsbrief/BUILDPLAN-agent-endpoints.md',
      title: 'Agent endpoints',
      domain: 'djimitflo',
      claim: 'Agent endpoints',
      confidence: 0.7,
      risk_flags: [],
    });
  });

  it('blocks secret-like content instead of producing a packet', () => {
    const root = fixture({ 'Claude Cowork/Nieuwsbrief/deploy.md': 'API_KEY=not-for-ingest' });

    const result = new NasDocumentSource().preflight({ root, relativePath: 'Claude Cowork/Nieuwsbrief/deploy.md', domain: 'security' });

    expect(result.accepted).toBe(false);
    expect(result.blocked_reasons).toContain('secret_like_content');
    expect(result.packet).toBeNull();
  });

  it('blocks export folders and paths outside the mounted root', () => {
    const root = fixture({ 'ChatGPT export/a.md': '# private' });
    const source = new NasDocumentSource();

    expect(source.preflight({ root, relativePath: 'ChatGPT export/a.md', domain: 'private' }).blocked_reasons).toContain('blocked_path_segment');
    expect(source.preflight({ root, relativePath: '../outside.md', domain: 'private' }).blocked_reasons).toContain('outside_root');
  });
});
