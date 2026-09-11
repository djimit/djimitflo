
 RUN  v4.1.11 /Users/dlandman/djimitflo-audit-20260909/packages/server

stdout | src/__tests__/route-permissions-http.test.ts > route permissions preserve existing role and activation boundaries
📦 Registered executor: mock
📦 Registered executor: opencode
📦 Registered executor: codex
📦 Registered executor: claude
📦 Registered executor: hermes
📦 Registered executor: gemini
📦 Registered executor: editor
📦 Registered executor: pi

 ❯ src/__tests__/route-permissions-http.test.ts (8 tests | 1 failed) 2055ms
     × uses domain write permissions for persisted knowledge, candidate genomes and reported outcomes 39ms
stderr | src/__tests__/openmythos-attestation-http.test.ts > OpenMythos attestation HTTP contract > imports and reads a verified attestation, while rejecting unauthenticated and tampered requests
WARNING: JWT_SECRET not set. Using generated development secret. Do not use in production.

 ❯ src/__tests__/openmythos-attestation-http.test.ts (2 tests | 1 failed) 500ms
     × imports and reads a verified attestation, while rejecting unauthenticated and tampered requests 258ms
fatal: not a git repository (or any of the parent directories): .git

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/__tests__/openmythos-attestation-http.test.ts > OpenMythos attestation HTTP contract > imports and reads a verified attestation, while rejecting unauthenticated and tampered requests
AssertionError: expected 404 to be 401 // Object.is equality

- Expected
+ Received

- 401
+ 404

 ❯ src/__tests__/openmythos-attestation-http.test.ts:47:102
     45| describe('OpenMythos attestation HTTP contract', () => {
     46|   it('imports and reads a verified attestation, while rejecting unauth…
     47|     expect((await request(app).post('/api/openmythos/attestations/impo…
       |                                                                                                      ^
     48|     const imported = await request(app).post('/api/openmythos/attestat…
     49|       .set('Authorization', `Bearer ${token}`).send(artifact());

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  src/__tests__/route-permissions-http.test.ts > route permissions preserve existing role and activation boundaries > uses domain write permissions for persisted knowledge, candidate genomes and reported outcomes
AssertionError: checker: expected 200 to be 403 // Object.is equality

- Expected
+ Received

- 403
+ 200

 ❯ src/__tests__/route-permissions-http.test.ts:76:125
     74|       const author = [UserRole.ADMIN, UserRole.MAKER].includes(role);
     75|       const evidenceWriter = [UserRole.ADMIN, UserRole.MAKER, UserRole…
     76|       expect((await call(role, '/intel/knowledge/subscribe', { agentId…
       |                                                                                                                             ^
     77|       expect((await call(role, '/intel/evolution/register', { skillId:…
     78|       expect((await call(role, '/intel/evolution/evolve')).status, rol…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  2 failed | 332 passed | 2 skipped (336)
      Tests  2 failed | 2543 passed | 20 skipped (2565)
   Start at  16:38:54
   Duration  35.68s (transform 8.26s, setup 0ms, import 31.04s, tests 270.48s, environment 15ms)

EXIT:1
