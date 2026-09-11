# AGI observe projection proof — G307

The authenticated AGI route test now executes `POST /agi/reason` followed by a literal `GET /agi/observe` and asserts that the observe projection equals the engine's persisted/current observation shape. Focused AGI plus governance coverage passes 4/4 tests. Contract inventory now records 480/585 direct route references and zero critical unclassified routes.

The full server rerun was started but did not complete within the available execution window; the last complete G306 server/workspace regressions remain green (2,552/20 and 2,843/20). No production code changed in G307; this checkpoint adds executable route coverage only.
