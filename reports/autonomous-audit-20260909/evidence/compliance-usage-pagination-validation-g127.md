# G127 compliance and usage pagination validation

The compliance audit-log and usage recent-log endpoints now reject malformed `limit` values before audit or usage reads. The focused HTTP regression passes; the full server suite passes **2449/20 skipped**, the full workspace passes **2736/20 skipped**, `/loops` passes **12/12**, the route inventory passes **581 source routes / 263 contract-tested; 608/608 marked-auth anonymous denials** (614 instantiated registrations), and build/type-check/lint are green. No external provider, deployment, merge or production mutation was performed.
