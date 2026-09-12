# Knowledge-vote route proof — G310

The authenticated knowledge fixture now publishes a claim, records three independent affirmative votes through literal `/knowledge/vote` requests, and verifies durable transition to `confirmed` in the stats projection. Focused swarm-intel coverage remains green at 6/6 tests; direct contract coverage is now 488/585 with zero critical unclassified routes.

This proves vote persistence and threshold transition locally; it does not establish epistemic truth of the voted claim.
