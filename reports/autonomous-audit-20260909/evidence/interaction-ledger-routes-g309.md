# Interaction-ledger route proof — G309

An authenticated local HTTP fixture inserted one durable agent message and projected it through `/intelligence/interactions` and `/intelligence/interaction-digest`. The record, actor/target identities, action, source and evidence linkage survived projection; the route honestly reported `DEGRADED` because optional ledger source tables are absent from the minimal fixture. Focused swarm-intel coverage passes 6/6 tests.

This proves durable local interaction projection and explicit degraded observability, not complete multi-store production availability.
