# Evaluation Report

## Methodology

Benchmarks are run against real open-source repositories.
Token counts use a consistent `len(text) // 4` approximation.
Impact accuracy reports two ground-truth modes: graph-derived (circular — upper bound) and co-change (files co-changed in the same commit, seed excluded).
Rows with `status=error` are kept for forensics but excluded from all aggregates.

## Token Efficiency

| repo | commit | description | changed_files | naive_tokens | standard_tokens | graph_tokens | naive_to_graph_ratio | standard_to_graph_ratio | status | error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| code-review-graph | 528801f841e519567ef54d6e52e9b9831d162e1b | feat: add multi-platform MCP server installation support | 3 | 10858 | 4147 | 162925 | 0.1 | 0.0 | ok |  |
| code-review-graph | 84bde35459c52e1e0c4b25c6c4799743021e0fc7 | feat: add Google Antigravity platform support for MCP install | 2 | 8113 | 394 | 153608 | 0.1 | 0.0 | ok |  |
| express | 925a1dff1e42f1b393c977b8b77757fcf633e09f | fix: bump qs minimum to ^6.14.2 for CVE-2026-2391 | 1 | 682 | 82 | 1015 | 0.7 | 0.1 | ok |  |
| express | b4ab7d65d7724d9309b6faaaf82ad492da2a6d35 | test: include edge case tests for res.type() | 1 | 703 | 510 | 64392 | 0.0 | 0.0 | ok |  |
| fastapi | fa3588c38c7473aca7536b12d686102de4b0f407 | Fix typo for client_secret in OAuth2 form docstrings | 1 | 6045 | 299 | 146352 | 0.0 | 0.0 | ok |  |
| fastapi | 0227991a01e61bf5cdd93cc00e9e243f52b47a4a | Exclude spam comments from statistics in scripts/people.py | 1 | 3844 | 735 | 98913 | 0.0 | 0.0 | ok |  |
| flask | fbb6f0bc4c60a0bada0e03c3480d0ccf30a3c1df | all teardown callbacks are called despite errors | 10 | 72069 | 4656 | 321538 | 0.2 | 0.0 | ok |  |
| flask | a29f88ce6f2f9843bd6fcbbfce1390a2071965d6 | document that headers must be set before streaming | 4 | 12917 | 1136 | 87784 | 0.1 | 0.0 | ok |  |
| gin | 052d1a79aafe3f04078a2716f8e77d4340308383 | feat(render): add PDF renderer and tests | 5 | 44085 | 958 | 271726 | 0.2 | 0.0 | ok |  |
| gin | 472d086af2acd924cb4b9d7be0525f7d790f69bc | fix(tree): panic in findCaseInsensitivePathRec with RedirectFixedPath | 2 | 13879 | 1347 | 79386 | 0.2 | 0.0 | ok |  |
| gin | 5c00df8afadd06cc5be530dde00fe6d9fa4a2e4a | fix(render): write content length in Data.Render | 2 | 4702 | 517 | 140578 | 0.0 | 0.0 | ok |  |
| httpx | ae1b9f66238f75ced3ced5e4485408435de10768 | Expose FunctionAuth in __all__ | 3 | 16816 | 267 | 127576 | 0.1 | 0.0 | ok |  |
| httpx | b55d4635701d9dc22928ee647880c76b078ba3f2 | Upgrade Python type checker mypy | 4 | 7248 | 820 | 133647 | 0.1 | 0.0 | ok |  |

## Impact Accuracy

| repo | commit | ground_truth_mode | seed_file | predicted_files | actual_files | true_positives | precision | recall | f1 | status | error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| code-review-graph | 528801f841e519567ef54d6e52e9b9831d162e1b | graph-derived (circular — upper bound) |  | 6 | 3 | 3 | 0.5 | 1.0 | 0.667 | ok |  |
| code-review-graph | 528801f841e519567ef54d6e52e9b9831d162e1b | co-change (same commit, seed excluded) | code_review_graph/cli.py | 0 | 2 | 0 | 0.0 | 0.0 | 0.0 | ok |  |
| code-review-graph | 84bde35459c52e1e0c4b25c6c4799743021e0fc7 | graph-derived (circular — upper bound) |  | 3 | 2 | 2 | 0.667 | 1.0 | 0.8 | ok |  |
| code-review-graph | 84bde35459c52e1e0c4b25c6c4799743021e0fc7 | co-change (same commit, seed excluded) | code_review_graph/cli.py | 0 | 1 | 0 | 0.0 | 0.0 | 0.0 | ok |  |
| express | 925a1dff1e42f1b393c977b8b77757fcf633e09f | graph-derived (circular — upper bound) |  | 2 | 1 | 1 | 0.5 | 1.0 | 0.667 | ok |  |
| express | 925a1dff1e42f1b393c977b8b77757fcf633e09f | co-change (same commit, seed excluded) | package.json |  |  |  |  |  |  | skipped | single-file commit: no co-changed files to grade against |
| express | b4ab7d65d7724d9309b6faaaf82ad492da2a6d35 | graph-derived (circular — upper bound) |  | 2 | 1 | 1 | 0.5 | 1.0 | 0.667 | ok |  |
| express | b4ab7d65d7724d9309b6faaaf82ad492da2a6d35 | co-change (same commit, seed excluded) | test/res.type.js |  |  |  |  |  |  | skipped | single-file commit: no co-changed files to grade against |
| fastapi | fa3588c38c7473aca7536b12d686102de4b0f407 | graph-derived (circular — upper bound) |  | 1 | 1 | 1 | 1.0 | 1.0 | 1.0 | ok |  |
| fastapi | fa3588c38c7473aca7536b12d686102de4b0f407 | co-change (same commit, seed excluded) | fastapi/security/oauth2.py |  |  |  |  |  |  | skipped | single-file commit: no co-changed files to grade against |
| fastapi | 0227991a01e61bf5cdd93cc00e9e243f52b47a4a | graph-derived (circular — upper bound) |  | 2 | 1 | 1 | 0.5 | 1.0 | 0.667 | ok |  |
| fastapi | 0227991a01e61bf5cdd93cc00e9e243f52b47a4a | co-change (same commit, seed excluded) | scripts/people.py |  |  |  |  |  |  | skipped | single-file commit: no co-changed files to grade against |
| flask | fbb6f0bc4c60a0bada0e03c3480d0ccf30a3c1df | graph-derived (circular — upper bound) |  | 33 | 10 | 10 | 0.303 | 1.0 | 0.465 | ok |  |
| flask | fbb6f0bc4c60a0bada0e03c3480d0ccf30a3c1df | co-change (same commit, seed excluded) | CHANGES.rst | 0 | 9 | 0 | 0.0 | 0.0 | 0.0 | ok |  |
| flask | a29f88ce6f2f9843bd6fcbbfce1390a2071965d6 | graph-derived (circular — upper bound) |  | 6 | 4 | 4 | 0.667 | 1.0 | 0.8 | ok |  |
| flask | a29f88ce6f2f9843bd6fcbbfce1390a2071965d6 | co-change (same commit, seed excluded) | docs/patterns/streaming.rst | 0 | 3 | 0 | 0.0 | 0.0 | 0.0 | ok |  |
| gin | 052d1a79aafe3f04078a2716f8e77d4340308383 | graph-derived (circular — upper bound) |  | 12 | 5 | 5 | 0.417 | 1.0 | 0.588 | ok |  |
| gin | 052d1a79aafe3f04078a2716f8e77d4340308383 | co-change (same commit, seed excluded) | context.go | 0 | 4 | 0 | 0.0 | 0.0 | 0.0 | ok |  |
| gin | 472d086af2acd924cb4b9d7be0525f7d790f69bc | graph-derived (circular — upper bound) |  | 5 | 2 | 2 | 0.4 | 1.0 | 0.571 | ok |  |
| gin | 472d086af2acd924cb4b9d7be0525f7d790f69bc | co-change (same commit, seed excluded) | tree.go | 0 | 1 | 0 | 0.0 | 0.0 | 0.0 | ok |  |
| gin | 5c00df8afadd06cc5be530dde00fe6d9fa4a2e4a | graph-derived (circular — upper bound) |  | 4 | 2 | 2 | 0.5 | 1.0 | 0.667 | ok |  |
| gin | 5c00df8afadd06cc5be530dde00fe6d9fa4a2e4a | co-change (same commit, seed excluded) | render/data.go | 0 | 1 | 0 | 0.0 | 0.0 | 0.0 | ok |  |
| httpx | ae1b9f66238f75ced3ced5e4485408435de10768 | graph-derived (circular — upper bound) |  | 3 | 3 | 3 | 1.0 | 1.0 | 1.0 | ok |  |
| httpx | ae1b9f66238f75ced3ced5e4485408435de10768 | co-change (same commit, seed excluded) | CHANGELOG.md | 0 | 2 | 0 | 0.0 | 0.0 | 0.0 | ok |  |
| httpx | b55d4635701d9dc22928ee647880c76b078ba3f2 | graph-derived (circular — upper bound) |  | 7 | 4 | 4 | 0.571 | 1.0 | 0.727 | ok |  |
| httpx | b55d4635701d9dc22928ee647880c76b078ba3f2 | co-change (same commit, seed excluded) | requirements.txt | 0 | 3 | 0 | 0.0 | 0.0 | 0.0 | ok |  |

## Build Performance

| repo | file_count | node_count | edge_count | flow_detection_seconds | community_detection_seconds | search_avg_ms | nodes_per_second |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code-review-graph | 92 | 1418 | 8877 | 0.021 | 0.036 | 0.3 | 66243 |
| express | 141 | 1912 | 18877 | 0.023 | 0.07 | 0.1 | 82859 |
| fastapi | 1128 | 6292 | 32081 | 0.063 | 0.167 | 0.1 | 100143 |
| flask | 86 | 1415 | 8259 | 0.015 | 0.039 | 0.3 | 94015 |
| gin | 98 | 1589 | 17237 | 0.023 | 0.063 | 0.3 | 68479 |
| httpx | 68 | 1261 | 8228 | 0.016 | 0.037 | 0.1 | 78770 |
