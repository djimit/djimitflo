# pstack checker policy

DjimitFlo now carries the useful part of pstack `interrogate` in the existing
checker prompt. `LoopService.buildCheckerPrompt()` adds a pinned policy to every
dispatched checker and security-checker lease. The existing checker runtime,
read-only contract, deterministic checks, evidence store and human merge gate
remain authoritative.

The policy requires a reproducible command, test, or observed output for every
retained finding and rejects unverified hypotheses. It does not ask the checker
to edit, merge, push, deploy, or relax a gate.

## Provenance

The source and byte hashes are in
[`pstack-inventory.json`](./pstack-inventory.json). The local policy is a
paraphrase, not an executable copy of the upstream skill. Its effective prompt
hash is exported by `pstack-interrogate.ts` and is included in the checker
prompt.

## Verification

Run the focused server tests from the repository root:

```sh
npm run test --workspace=@djimitflo/server -- pstack-interrogate.test.ts f1-harness.test.ts
```

The first test checks provenance and the policy contract. The harness test calls
the same `buildCheckerPrompt()` used by a normal loop dispatch and checks that
the policy reaches the checker prompt. A green unit test is static/runtime-path
evidence; it is not proof of a real external model run.

## Rollback

Revert the integration commit after confirming the exact head and rerun the two
focused tests. This restores the previous checker prompt while leaving the
existing checker and merge gates unchanged. Do not disable the checker gate as a
rollback shortcut.
