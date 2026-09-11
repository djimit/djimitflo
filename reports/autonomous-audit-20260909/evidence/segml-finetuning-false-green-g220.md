# G220 SEGML fine-tuning false-green repair

The Level-2 fine-tuning bridge previously generated random baseline/fine-tuned scores with `Math.random()`, persisted them as A/B evidence and emitted deployment recommendations without running either model. `runABTest` now fails closed with typed `SEGML_AB_TEST_UNAVAILABLE` until a real paired provider evaluator and independent scorer are configured.

Service and authenticated HTTP tests prove no A/B row or deployment recommendation is created; the route returns **503**. This removes fabricated promotion evidence rather than claiming an unavailable provider capability.

Focused Level-2/Level-3 suites pass **19/19**; the post-change governed loop/runtime suite remains **24 files / 234 passed / 2 skipped / 0 failures**. Workspace type-check and lint also pass after removing the obsolete improvement-threshold constant.

The refreshed contract inventory now covers **300/581** source routes with no critical unclassified routes; MCP remains **56/56**.
