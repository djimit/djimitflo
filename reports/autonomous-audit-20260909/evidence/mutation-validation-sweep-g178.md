# G178 broad malformed-input replay

The rebuilt runtime replayed all **285 mounted mutating routes** against the production schema plus migrations in a disposable SQLite database using an authenticated admin fixture and empty request bodies.

```text
200: 62
201: 6
202: 1
204: 1
400: 125
403: 1
404: 78
409: 4
451: 1
503: 6 (intentional unavailable integration boundaries)
500: 0
```

The Apex unknown-worker `start` and `stop` calls and unknown Live Canvas sessions now return typed 404 responses instead of false 200 successes. The replay retained 70 parameterless successes, which are not silently relabelled as defects because several are intentional default or asynchronous operations. This remains malformed-input/missing-resource evidence; valid mutation semantics and external provider execution require separate proof.
