# G174 broad mutation validation sweep

The first broad replay against a fully migrated in-memory database found real malformed/missing-resource 500 paths in canvas tool results, agent approval, worker execution, catalog deactivation, explainer/repository indexing and several unwrapped swarm/fleet/governance errors. The shared error boundary now maps domain markers safely, explicit pipeline/index catches preserve typed 404s, and canvas/runtime-governance validate required input before service calls.

The corrected built-runtime replay exercised **285 mounted POST/PATCH/PUT/DELETE routes** with an authenticated disposable admin and empty JSON input:

```text
200: 69
201: 6
202: 1
204: 1
400: 121
403: 1
404: 75
409: 4
451: 1
503: 6 (intentional unavailable integration boundaries)
500: 0
```

The sweep uses the production schema plus explainer schema and migrations in a disposable database. It is malformed-input/missing-resource evidence, not proof of every valid mutation's domain outcome. The 69 empty-input successes are retained for manual classification; parameterless local/default operations are not silently relabelled as defects.

Follow-up after hardening all canvas stream payloads reduced empty-input successes to 73 and raised typed 400 responses to 125; the same 285-route replay still produced **0×500** and the same intentional 503 boundaries.
