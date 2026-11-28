// node scripts/test-changed-direct.test.mjs — selection of scripts/test-changed-direct.mjs
import assert from 'node:assert/strict';
import { select } from './test-changed-direct.mjs';

const files = {
  'packages/server/src/__tests__/a.test.ts': "import { a } from '../services/a.js';\n",
  'packages/server/src/__tests__/b.test.ts': "import { b } from '../services/b';\nvi.mock('../services/a');\n",
  'packages/server/src/__tests__/far.test.ts': "import { c } from '../services/c.js'; // c imports a: distance 2, left to CI\n",
  'packages/server/src/__tests__/dyn.test.ts': "const m = await import('../services/dir');\n",
  'packages/dashboard/src/pages/P.test.tsx': "import P from './P';\n",
};
const tests = Object.keys(files);
const read = (f) => files[f];

// a changed source file selects only the tests that import it directly (import, vi.mock), not its transitive users
assert.deepEqual(select(['packages/server/src/services/a.ts'], tests, read),
  { byWorkspace: { server: ['packages/server/src/__tests__/a.test.ts', 'packages/server/src/__tests__/b.test.ts'] } });
// a changed test file is always selected; a directory import resolves to its index
assert.deepEqual(select(['packages/server/src/__tests__/far.test.ts', 'packages/server/src/services/dir/index.ts'], tests, read),
  { byWorkspace: { server: ['packages/server/src/__tests__/far.test.ts', 'packages/server/src/__tests__/dyn.test.ts'] } });
// workspaces are kept apart
assert.deepEqual(select(['packages/dashboard/src/pages/P.tsx'], tests, read), { byWorkspace: { dashboard: ['packages/dashboard/src/pages/P.test.tsx'] } });
// nothing imports it: an empty selection, not a fallback
assert.deepEqual(select(['packages/server/src/services/lonely.ts'], tests, read), { byWorkspace: {} });
// anything that is not a workspace source file is not narrowed
for (const f of ['package.json', 'packages/server/package.json', 'packages/server/vitest.config.ts', 'scripts/x.mjs'])
  assert.match(select(['packages/server/src/services/a.ts', f], tests, read).fallback, /not a workspace source file/);
console.log('test-changed-direct: ok');
