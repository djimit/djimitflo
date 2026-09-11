# G209 agent-catalog compilation closure

The catalog compiler no longer emits `F5 stub, not implemented` placeholders for `claude-code`, `cursor` or `gemini-cli`. Each declared target now produces a deterministic instruction artifact with mission, persona, rules, workflows, deliverables, metrics and tool metadata. A real authenticated catalog HTTP regression covers all six declared targets (`openclaw`, `codex`, `claude-code`, `cursor`, `gemini-cli`, `djimit-native`) and verifies `runtime_registered:false` and `execution_started:false`; catalog tests pass 26/26 and the server catalog route passes 10/10.

This closes artifact compilation only. Runtime activation remains intentionally limited to `openclaw` and `codex`, and no provider execution is inferred.
