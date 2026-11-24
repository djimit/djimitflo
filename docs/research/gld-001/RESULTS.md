# GLD-001: results

**Verdict: INCONCLUSIVE** (PREREG §5). Run on 2026-11-24, once, by an agent on operator instruction; protocol
[`PREREG.md`](PREREG.md), sha256 unchanged (`PREREG.sha256`).

GLiDE-0.4B did not forecast "this proposal ends verified" better than the stored jev-1.13.0 answers. Its AUC was lower
(0.583 against 0.653), but the 95 % interval of the difference, [−0.168, +0.028], includes zero and is wider than the
equivalence margin, so the run neither rejects nor supports H1. **Neither model beats the per-source base rate**: both
Brier scores are worse than the baseline (skill −0.30 and −0.34). Per PREREG §6 that is the main finding: on these
proposals no System One model adds forecast value.

## Numbers

| | jev-1.13.0 (stored) | GLiDE-0.4B |
| --- | --- | --- |
| AUC | 0.6528 | 0.5829 |
| Brier | 0.2927 | 0.3004 |
| Brier of the per-source base rate | 0.2250 | 0.2250 |
| Skill against the base rate | −0.3005 | −0.3350 |
| `names_file` accuracy against `PATH_RE` | 0.9798 | 0.9966 |

- Cases: 297 scored by both models, 168 verified or applied, 0 dropped on the state hash, 0 GLiDE errors.
- **Primary:** ΔAUC (GLiDE − jev) = −0.0699, paired bootstrap 95 % interval [−0.1680, +0.0282] (2 000 resamples, seed 1).
- Secondary: ΔAUC within `gap_analysis` (n = 279) −0.0812; agreement of `decide()` verdicts 0.9461; median latency 341 ms
  per four-question request through an SSH tunnel (hardware- and path-specific, not comparable to the vendor's 6.9 ms).

## Provenance

- Database copy: SQLite online backup of the production file opened read-only, 812 142 592 bytes, sha256
  `42020070586832b85a0a57b5612e6a25f6b9d8dfb315636c02a2e93e5361a8da`; deleted after the run.
- Script: `packages/server/src/scripts/system-one-replay.ts` at `93b0c011`.
- Model: `fastino/GLiDE-0.4B` @ `16fb9d63cc34d1b4b5a1fb7cbf2d9d4a3dd5ad71`, both weight hashes equal to PREREG §0, started by
  the operator on the workstation (NVIDIA GeForce RTX 2060 SUPER 8 GB, driver 580.178.04, Python 3.12.3), bound to
  `127.0.0.1:8001`. It loaded and served on a GPU the vendor did not validate. The server's request counter went from 0 to
  297 over the run.

## Deviations

1. **A first invocation sent nothing.** The SSH tunnel failed to open (control-socket path too long) and the script ran
   anyway: 297 connection errors, 0 answers, script verdict INSUFFICIENT_EVIDENCE. The server's counter stood at 0
   requests afterwards, so no GLiDE output existed before the run reported here. That invocation is not counted as the run.
2. **Cases 297 / 168, not the 295 / 166 of PREREG §0.** Two more proposals resolved between the count and the copy.
3. **The case count in §0 was read with the same selection rule before freezing** (already stated there).
4. **Result JSON key collision.** `score()` returns `n_cases` and `positives`, which overwrite the header's keys of the same
   name; the values are equal when every case is scored, as here. Not changed for this run.
5. **Context limit.** The server reported `max_len` 40 000, not the 7 999 tokens of the model card; no request was refused.

## What follows

- No backend, flag or decision changes. jev stays the only System One backend; NE-001 scope is untouched.
- INCONCLUSIVE is not negative evidence about GLiDE. The finding that holds for both models (no skill against the base
  rate, as in NE-005 and the AR1 backfill) is proposed to the operator as a note on NE-005, not written by an agent.
- A larger study would need roughly four times the cases to bring the interval inside ±0.05, and its best outcome would
  be "equivalent to a model that does not beat the base rate". Not proposed.
