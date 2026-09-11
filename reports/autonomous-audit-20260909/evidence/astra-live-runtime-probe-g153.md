# G153 — live GPT-6 Astra runtime probe

Command executed from the audit checkout:

```text
codex exec --model gpt-6-astra --config model_reasoning_effort=max --sandbox read-only --cd /Users/dlandman/djimitflo-audit-20260909 "Do not use tools and do not modify files. Respond with exactly ASTRA_RUNTIME_PROBE."
```

Observed runtime header:

- Codex `v0.153.4`
- provider: `openai`
- model: `gpt-6-astra`
- reasoning effort: `max`
- sandbox: `read-only`
- approval: `never`
- session: `01a08a05-1113-75d1-b0ac-d90b00d4070a`
- response: `ASTRA_RUNTIME_PROBE`
- tokens used: `13.980`

Two Context7 `AuthRequired` MCP startup warnings were emitted, but the actual
provider call completed successfully and produced the requested exact response.
No files were modified and no external repository, deployment or production
state was changed.

This proves a live read-only Astra provider call and the configured reasoning
and sandbox boundary. It does not certify computer-use, browser automation,
long-running task recovery, quality, autonomous promotion or deployment.
