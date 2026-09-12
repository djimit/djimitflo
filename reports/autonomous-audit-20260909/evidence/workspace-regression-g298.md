
 RUN  v4.1.11 /Users/dlandman/djimitflo-audit-20260909/packages/agent-catalog


 Test Files  2 passed (2)
      Tests  26 passed (26)
   Start at  16:45:39
   Duration  143ms (transform 82ms, setup 0ms, import 113ms, tests 35ms, environment 0ms)


 RUN  v4.1.11 /Users/dlandman/djimitflo-audit-20260909/packages/dashboard


 Test Files  28 passed (28)
      Tests  151 passed (151)
   Start at  16:45:39
   Duration  3.02s (transform 2.05s, setup 0ms, import 6.20s, tests 7.00s, environment 15.83s)


 RUN  v4.1.11 /Users/dlandman/djimitflo-audit-20260909/packages/mcp-server


 Test Files  8 passed (8)
      Tests  41 passed (41)
   Start at  16:45:43
   Duration  468ms (transform 310ms, setup 0ms, import 1.07s, tests 421ms, environment 0ms)


 RUN  v4.1.11 /Users/dlandman/djimitflo-audit-20260909/packages/ransomware-module


 Test Files  6 passed (6)
      Tests  40 passed (40)
   Start at  16:45:43
   Duration  118ms (transform 158ms, setup 0ms, import 213ms, tests 24ms, environment 0ms)


 RUN  v4.1.11 /Users/dlandman/djimitflo-audit-20260909/packages/server

fatal: not a git repository (or any of the parent directories): .git
 ❯ src/__tests__/swarm-governance-pagination.test.ts (1 test | 1 failed) 19ms
     × rejects malformed limits before assurance or memory reads 18ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/__tests__/swarm-governance-pagination.test.ts > swarm governance pagination > rejects malformed limits before assurance or memory reads
AssertionError: /swarms/assurance/capability-tokens: expected 200 to be 400 // Object.is equality

- Expected
+ Received

- 400
+ 200

 ❯ src/__tests__/swarm-governance-pagination.test.ts:19:37
     17|     for (const path of ['/swarms/assurance/capability-tokens', '/swarm…
     18|       const response = await request(app).get(`${path}?limit=NaN`);
     19|       expect(response.status, path).toBe(400);
       |                                     ^
     20|       expect(response.body.error.code, path).toBe('VALIDATION_ERROR');
     21|     }

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 333 passed | 2 skipped (336)
      Tests  1 failed | 2545 passed | 20 skipped (2566)
   Start at  16:45:44
   Duration  35.70s (transform 6.53s, setup 0ms, import 29.81s, tests 263.28s, environment 16ms)



 RUN  v4.1.11 /Users/dlandman/djimitflo-audit-20260909/packages/shared


 Test Files  2 passed (2)
      Tests  3 passed (3)
   Start at  16:46:19
   Duration  84ms (transform 27ms, setup 0ms, import 39ms, tests 4ms, environment 0ms)


 RUN  v4.1.11 /Users/dlandman/djimitflo-audit-20260909/packages/telegram


 Test Files  4 passed (4)
      Tests  30 passed (30)
   Start at  16:46:20
   Duration  121ms (transform 89ms, setup 0ms, import 175ms, tests 27ms, environment 0ms)

EXIT:1
