# G131 observability window validation

The observability risk-trends and execution-activity endpoints now reject malformed or out-of-range `days`/`hours` values before database reads. The focused HTTP regression passes. The full server suite passes **2453/20 skipped** (308 files, 2 skipped), the full workspace passes **2740/20 skipped**, `/loops` passes **12/12**, route inventory passes **7/7** with **581 source routes / 263 contract-tested**, **614 instantiated registrations** and **608/608 marked-auth anonymous denials**, and build/type-check/lint are green. Table reachability remains **161 static tables / 11 unreachable**.

No external provider, deployment, merge or production mutation was performed.
