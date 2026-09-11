
 RUN  v4.1.11 /Users/dlandman/djimitflo-audit-20260909/packages/server

fatal: not a git repository (or any of the parent directories): .git
stderr | src/__tests__/mutation-validation.test.ts > mutation routes fail closed on missing required input > returns validation errors instead of SQLite 500s
[ERROR] POST /policies Error: name is required
    at createError (/Users/dlandman/djimitflo-audit-20260909/packages/server/src/middleware/error-handler.ts:47:17)
    at /Users/dlandman/djimitflo-audit-20260909/packages/server/src/routes/policies.ts:59:15
    at Layer.handleRequest (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/layer.js:152:17)
    at next (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/route.js:157:13)
    at /Users/dlandman/djimitflo-audit-20260909/packages/server/src/__tests__/mutation-validation.test.ts:16:78
    at Layer.handleRequest (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/layer.js:152:17)
    at next (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/route.js:157:13)
    at Route.dispatch (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/route.js:117:3)
    at handle (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/index.js:435:11)
    at Layer.handleRequest (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/layer.js:152:17) {
  status: 400,
  code: 'VALIDATION_ERROR'
}

stderr | src/__tests__/mutation-validation.test.ts > mutation routes fail closed on missing required input > returns validation errors instead of SQLite 500s
[ERROR] POST /swarms/intelligence/missions Error: mission title is required
    at createError (/Users/dlandman/djimitflo-audit-20260909/packages/server/src/middleware/error-handler.ts:47:17)
    at mapSwarmIntelligenceError (/Users/dlandman/djimitflo-audit-20260909/packages/server/src/routes/swarms.ts:82:57)
    at /Users/dlandman/djimitflo-audit-20260909/packages/server/src/routes/swarms.ts:196:13
    at Layer.handleRequest (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/layer.js:152:17)
    at next (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/route.js:157:13)
    at /Users/dlandman/djimitflo-audit-20260909/packages/server/src/__tests__/mutation-validation.test.ts:16:78
    at Layer.handleRequest (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/layer.js:152:17)
    at next (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/route.js:157:13)
    at Route.dispatch (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/lib/route.js:117:3)
    at handle (/Users/dlandman/djimitflo-audit-20260909/node_modules/router/index.js:435:11) {
  status: 400,
  code: 'SWARM_MISSION_TITLE_REQUIRED'
}

 ❯ src/__tests__/mutation-validation.test.ts (1 test | 1 failed) 39ms
     × returns validation errors instead of SQLite 500s 38ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/__tests__/mutation-validation.test.ts > mutation routes fail closed on missing required input > returns validation errors instead of SQLite 500s
AssertionError: expected 404 to be 400 // Object.is equality

- Expected
+ Received

- 400
+ 404

 ❯ src/__tests__/mutation-validation.test.ts:43:25
     41|     expect(mission.status).toBe(400);
     42|     const risk = await request(app).post('/risk/task').send({});
     43|     expect(risk.status).toBe(400);
       |                         ^
     44|     const claim = await request(app).post('/swarms/intelligence/claims…
     45|     expect(claim.status).toBe(400);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 332 passed | 2 skipped (335)
      Tests  1 failed | 2543 passed | 20 skipped (2564)
   Start at  16:01:14
   Duration  35.65s (transform 7.20s, setup 0ms, import 29.18s, tests 260.13s, environment 15ms)

EXIT:1
