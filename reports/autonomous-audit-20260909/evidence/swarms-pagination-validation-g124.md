# G124 swarms pagination validation

The legacy swarm specialist-panel, hypothesis and mission list endpoints now reject malformed `limit` values before domain reads. The focused HTTP regression passes; the full server suite passes **2446/20 skipped**, the full workspace passes **2733/20 skipped**, `/loops` passes **12/12**, the route inventory passes **581 source routes / 263 contract-tested; 608/608 marked-auth anonymous denials** (614 instantiated registrations), and build/type-check/lint are green. No external provider, deployment, merge or production mutation was performed.
