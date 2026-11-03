# USER.md — how the operator works

> Not for private data. This file is sent to cloud models with every session: working style only, no names, contacts,
> hosts, accounts, keys or personal details. Owner: the operator.

## Batches, not drips

- Prefer large autonomous batches: several builders in parallel, one merge train, one deploy. Not one small PR per turn.
- Record decisions in the plan (the plan file or the PR body), not only in chat.
- Report only what changed: PR numbers, flags, results, known limits. No recap of what was read.

## Always ask first

- Anything that costs money (new plans, credits, paid APIs).
- Security boundaries: auth, permissions, secrets, network exposure.
- Data deletion, in any store.
- A new external service or host.

## Secrets

- Never echo, log or commit a secret.
- A secret the operator pastes into a session counts as exposed: say so and have it rotated.

## Data and models

- jev (TypeSafe) is the only System One backend; it never decides approval, promotion, code, risk or fitness (NE-001).
- Private data never goes to external APIs or cloud models.

## Language

- Answer in the language the operator writes in (Dutch or English).
