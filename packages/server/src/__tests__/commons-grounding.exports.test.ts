import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wikiPagesFor } from '../services/commons-grounding';

let root: string;
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-export-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('wikiPagesFor', () => {
  it('returns an empty list when there are no files', () => {
    expect(wikiPagesFor([], root)).toEqual([]);
  });

  it('returns an empty list when the openwiki directory does not exist', () => {
    expect(wikiPagesFor(['packages/server/src/services/x.ts'], root)).toEqual([]);
  });

  it('lists wiki pages whose front matter cites one of the requested files', () => {
    write('openwiki/operations/hygiene.md',
      '---\ntype: concept\nsources:\n  - id: s1\n    resource: repo://packages/server/src/services/queue-hygiene-service.ts\n---\n# Hygiene\n');
    write('openwiki/concepts/unrelated.md',
      '---\nsources:\n  - id: s2\n    resource: repo://packages/server/src/services/other.ts\n---\n# Other\n');
    expect(wikiPagesFor(['packages/server/src/services/queue-hygiene-service.ts'], root))
      .toEqual(['openwiki/operations/hygiene.md']);
  });

  it('matches multiple requested files and returns them sorted', () => {
    write('openwiki/operations/hygiene.md',
      '---\nsources:\n  - id: s1\n    resource: repo://packages/server/src/services/queue-hygiene-service.ts\n---\n# Hygiene\n');
    write('openwiki/concepts/other.md',
      '---\nsources:\n  - id: s2\n    resource: repo://packages/server/src/services/other.ts\n---\n# Other\n');
    expect(wikiPagesFor([
      'packages/server/src/services/queue-hygiene-service.ts',
      'packages/server/src/services/other.ts',
    ], root)).toEqual([
      'openwiki/concepts/other.md',
      'openwiki/operations/hygiene.md',
    ]);
  });

  it('respects the max cap', () => {
    write('openwiki/a.md', '---\nsources:\n  - id: s1\n    resource: repo://packages/server/src/services/a.ts\n---\n# A\n');
    write('openwiki/b.md', '---\nsources:\n  - id: s2\n    resource: repo://packages/server/src/services/b.ts\n---\n# B\n');
    write('openwiki/c.md', '---\nsources:\n  - id: s3\n    resource: repo://packages/server/src/services/c.ts\n---\n# C\n');
    expect(wikiPagesFor([
      'packages/server/src/services/a.ts',
      'packages/server/src/services/b.ts',
      'packages/server/src/services/c.ts',
    ], root, 2)).toHaveLength(2);
  });

  it('uses the default max of 3', () => {
    write('openwiki/a.md', '---\nsources:\n  - id: s1\n    resource: repo://packages/server/src/services/a.ts\n---\n# A\n');
    write('openwiki/b.md', '---\nsources:\n  - id: s2\n    resource: repo://packages/server/src/services/b.ts\n---\n# B\n');
    write('openwiki/c.md', '---\nsources:\n  - id: s3\n    resource: repo://packages/server/src/services/c.ts\n---\n# C\n');
    write('openwiki/d.md', '---\nsources:\n  - id: s4\n    resource: repo://packages/server/src/services/d.ts\n---\n# D\n');
    expect(wikiPagesFor([
      'packages/server/src/services/a.ts',
      'packages/server/src/services/b.ts',
      'packages/server/src/services/c.ts',
      'packages/server/src/services/d.ts',
    ], root)).toHaveLength(3);
  });

  it('skips hidden files and non-markdown files', () => {
    write('openwiki/.hidden.md', '---\nsources:\n  - id: s1\n    resource: repo://packages/server/src/services/x.ts\n---\n# Hidden\n');
    write('openwiki/notes.txt', 'resource: repo://packages/server/src/services/x.ts\n');
    write('openwiki/page.md', '---\nsources:\n  - id: s2\n    resource: repo://packages/server/src/services/x.ts\n---\n# Page\n');
    expect(wikiPagesFor(['packages/server/src/services/x.ts'], root))
      .toEqual(['openwiki/page.md']);
  });

  it('returns an empty list when a walk error occurs (unreadable directory)', () => {
    write('openwiki/page.md', '---\nsources:\n  - id: s1\n    resource: repo://packages/server/src/services/x.ts\n---\n# Page\n');
    fs.chmodSync(path.join(root, 'openwiki'), 0o000);
    try {
      expect(wikiPagesFor(['packages/server/src/services/x.ts'], root)).toEqual([]);
    } finally {
      fs.chmodSync(path.join(root, 'openwiki'), 0o755);
    }
  });

  it('returns paths relative to root, not absolute', () => {
    write('openwiki/page.md', '---\nsources:\n  - id: s1\n    resource: repo://packages/server/src/services/x.ts\n---\n# Page\n');
    const [page] = wikiPagesFor(['packages/server/src/services/x.ts'], root);
    expect(page).toBe('openwiki/page.md');
    expect(path.isAbsolute(page)).toBe(false);
  });

  it('cites a nested markdown page under a subdirectory', () => {
    write('openwiki/area/sub/deep.md', '---\nsources:\n  - id: s1\n    resource: repo://packages/server/src/services/x.ts\n---\n# Deep\n');
    expect(wikiPagesFor(['packages/server/src/services/x.ts'], root))
      .toEqual(['openwiki/area/sub/deep.md']);
  });

  it('deduplicates pages that cite the same file once', () => {
    write('openwiki/page.md',
      '---\nsources:\n  - id: s1\n    resource: repo://packages/server/src/services/x.ts\n  - id: s2\n    resource: repo://packages/server/src/services/x.ts\n---\n# Page\n');
    expect(wikiPagesFor(['packages/server/src/services/x.ts'], root))
      .toEqual(['openwiki/page.md']);
  });
});