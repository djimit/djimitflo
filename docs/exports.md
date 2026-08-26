# Streaming exports

DjimFlo exposes two authenticated NDJSON streams for datasets that should not be assembled in memory:

- `GET /api/exports/training` — leakage-bounded training examples from completed or reviewed tasks; admin only.
- `GET /api/exports/stream/audit?dateFrom=<ISO>&dateTo=<ISO>` — append-only audit events; admin or platform admin.

Each response is `application/x-ndjson`: one complete JSON object per line. Consumers can process the response incrementally, for example:

```sh
curl -H "Authorization: Bearer $DJIMITFLO_API_TOKEN" \
  http://127.0.0.1:3001/api/exports/training \
  --output training-export.jsonl
```

The training stream includes `task_id`, title, machine and agent attribution, an output excerpt, the approval-derived outcome, and timestamps. It deliberately omits secrets, full prompts, and raw tool output.
