# G265 server regression

Command: `npm test --silent`

Result: server 323 test files passed, 2 skipped; 2,522 tests passed, 20 skipped; zero failures. The existing fixture diagnostic `fatal: not a git repository` remains non-fatal and is not treated as product proof.

Focused social proof: `npx vitest run packages/server/src/__tests__/agent-social-runtime.test.ts` — 1/1 passed.
