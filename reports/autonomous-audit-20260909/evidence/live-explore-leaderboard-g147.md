# G147 live Explore leaderboard proof

Date: 2026-09-10
Target: `https://djimitflo.agentical.nl/explore/leaderboard`

A read-only production request returned HTTP 200 with JSON and seven leaderboard rows. The response keys were exactly `agent_id`, `overall_score`, `total_cases`, `last_eval_at` and `trend`; no `prompt` or `case_content` fields were present. Every row had a string agent id, numeric score and integer case count. The first row was `opencode-glm-5.2-cloud-heldout` with score `4.2` and 15 cases.

Executed command:

```text
node --input-type=module ...fetch('https://djimitflo.agentical.nl/explore/leaderboard')...
→ {"status":200,"rows":7,"keys":["agent_id","overall_score","total_cases","last_eval_at","trend"]}
```

This proves the deployed public leaderboard route is enabled, reachable and payload-redacted. It does not certify the underlying historical evaluations, model quality, or production revision identity. No mutation was sent.
