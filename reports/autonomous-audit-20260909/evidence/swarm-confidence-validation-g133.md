# G133 swarm knowledge confidence validation

The swarm-intelligence knowledge query now rejects non-finite and out-of-range `min_confidence` values before claim reads. Focused HTTP coverage passes. Full server verification passes **2454/20 skipped** (308 files, 2 skipped); full workspace passes **2741/20 skipped**; `/loops` **12/12**; route inventory **7/7** with **581 source routes / 263 contract-tested**, **614 registrations** and **608/608 marked-auth denials**; type-check/lint and capability-graph registration checks pass.

No external provider, deployment, merge or production mutation was performed.
