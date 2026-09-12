# G269 table reachability

Fresh `npm run audit:tables --silent` scan against the local SQLite database found 167 tables, 160 empty, and 10 with no source-level runtime reader or writer:

`agents_md_issues`, `audit_logs`, `council_reliability`, `explainer_feedback`, `instruction_profiles`, `repository_scan_artifacts`, `sandbox_policies`, `sub_agent_scratch`, `sub_agent_tool_outputs`, `task_artifacts`.

Source tracing shows these are schema/migration-only or fixture-only surfaces with no mounted product route. They are therefore classified as `LEGACY`/`EXPERIMENTAL` pending an explicit product contract; no speculative reader/writer was added. The scanner is regex-based and remains evidence of reachability, not semantic certification.
