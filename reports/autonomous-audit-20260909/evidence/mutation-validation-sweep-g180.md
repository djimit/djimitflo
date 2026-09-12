# G180 broad malformed-input replay

The rebuilt runtime replayed all **285 mounted mutating routes** against the production schema plus migrations in a disposable SQLite database using an authenticated admin fixture and empty request bodies.

```text
200: 61
201: 6
202: 1
204: 1
400: 125
403: 1
404: 80
409: 4
451: 1
503: 6 (intentional unavailable integration boundaries)
500: 0
```

Unknown Apex workers, Live Canvas sessions, repository indexes and runtime-governance agents now fail with typed resource errors instead of false success responses. The replay retains 68 parameterless/default or asynchronous successes; these are not silently relabelled as defects. Valid mutation semantics and external provider execution require separate proof.
