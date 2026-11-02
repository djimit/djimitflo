# SEC-F1 result — security-checker discrimination (2026-10-21)

Protocol: `SEC-F1_PROTOCOL.md` incl. Amendment 1 (items from real upstream security-fix commits). Harness:
`SEC-F1_RUN.md`. Raw files: `sec-f1/result/` (`results.jsonl` redacted reviewer output metadata, `baseline.jsonl`,
`score.json`).

**Decision (frozen rule): KEEP** — fixed by the scored items, 0 unscored.

| | Prod security checker | Deterministic baseline |
|---|---|---|
| Vulnerable caught | **19/20** (0.95, Wilson 0.76–0.99) | 3/20 (0.15) |
| False rejects (20 benign + 6 decoys) | **0/26** (upper 0.13) | 3/26 |
| No verdict | 0/46 | — |
| AUC | **0.975** | — |
| Catches beyond baseline | **17** (McNemar b 17 / c 1, p 0.00014) | |

Thresholds: AUC ≥ 0.80, false rejects ≤ 2/26, ≥ 3 catches beyond baseline → all met.

Per class (checker / baseline caught of 4): auth bypass 4/0, command injection 4/2, path traversal 3/1, secret exposure
4/0, unsafe eval/deserialisation 4/0. Regex-visible split (reported only): visible 2 items (both caught by both),
not visible 18 (checker 17, baseline 1). Without the 4 wording-flagged items: AUC 0.972, caught 17/18.

Run: 2026-10-21 19:2x–21:4xZ, throwaway containers on the prod image `djimitflo:main-0c5b931` (no `/data`, no DB),
prompt hash `dd101494…` verified, model `ollama/glm-5.2:cloud` (prod default) on every item, **2.00 M tokens** (mean 43.5 k,
median 17.5 k per item), sequential.

## Limits (read before generalising)

- **Contamination risk:** all items are public, advisory-linked fixes; the model may have seen the fix or the advisory.
  The task text never names the CVE, but recall of a famous diff cannot be excluded. A clean replication needs fixes
  published after the model's training cutoff, or private planted defects (operator-supplied).
- Small n (20 / 26): the CIs above are wide; "0 false rejects" is compatible with up to ~13 %.
- Diffs are small (2–26 lines, ≤ 2 files) and the reviewer sees the vulnerable lines directly; real loop PRs are larger
  and the vulnerability may sit outside the diff.
- One model (glm-5.2). F2 (cross-family checker) is a separate experiment.
- The baseline is weak by construction (ESLint pack + 5 regexes + secret patterns, no gitleaks in the image); "beyond
  baseline" shows the checker is not redundant with today's deterministic tools, not that it beats a real SAST tool.

## What this changes

- The prod security checker stays as is (no change proposed). It discriminates on real fixes; the earlier concern that it
  rubber-stamps (it rejects 3 % of maker runs in prod) is explained by prod diffs rarely containing these defects, not by
  blindness.
- Reusable asset: the 46 items + harness are the security slice for any future reviewer comparison (OCR, F2 cross-family).
