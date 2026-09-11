# G130 explainer pagination validation

The explainer task, fleet, knowledge-search, audit and calibration-sample endpoints now reject malformed `limit` values before service/database reads. The focused HTTP regression passes. The full server suite passes **2452/20 skipped** (307 files, 2 skipped), the full workspace passes **2739/20 skipped**, `/loops` passes **12/12**, the route inventory passes **7/7** with **581 source routes / 263 contract-tested**, **614 instantiated registrations** and **608/608 marked-auth anonymous denials**, and build/type-check/lint are green.

The async knowledge-search handler now preserves structured 400 validation errors instead of converting them to a generic 500. No external provider, deployment, merge or production mutation was performed.
