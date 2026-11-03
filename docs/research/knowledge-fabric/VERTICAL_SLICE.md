# DKF-EVOLUTION-001: first vertical slice (Phase H, PROPOSAL, not built)

Nothing in this file has been built, ingested, deployed or merged. Implementation, any ingestion run, flag changes and
deploys each need separate operator authorization (§6).

## 1. Goal

Prove the fabric end to end on a corpus that is small, technical and operator-owned, without changing any prod decision:

1. NAS read, read-only and path-allow-listed;
2. ingestion through the state machine, idempotently;
3. OKF v0.2 normalisation that round-trips unknown keys;
4. bitemporal rows;
5. retrieval arm C (FTS5 + RRF + metadata filters) compared offline against today's arm B on real labelled queries;
6. three real decisions as decision-plane rows.

Not in the slice: makers as consumers (S0), private corpora, Qdrant consolidation, embedding-model changes, any acting
mode.

## 2. Candidate corpus (by path only)

**Primary: `/mnt/nas/workstation-backup/wiki/wiki/concepts/` + `/mnt/nas/workstation-backup/wiki/wiki/entities/`**

- 296 `.md` files, 1.3 MB: 249 concepts and 47 entities.
- These are DjimitKBWiki's compiled pages from the 2026-07-01 snapshot. They are the operator's technical KB, not a
  personal area.

Why this corpus:

- It is the **smallest real NAS corpus with a known twin**. Metadata comparison with the live vault (names and sizes only,
  no content read) finds 296 / 299 names in common, 0 NAS-only, 3 vault-only, and 0 same-name files with different
  sizes. The twin pages are already in `kb_pages` from kb-sync.
- **Zero new data leaves the house.** When a page is byte-identical, its content sha already exists in `kb_pages`. The
  slice reuses that row's verdict and vector instead of calling NVIDIA again (§3, step 3). Any page that differs needs an
  explicit operator OK before its text goes to NVIDIA (safety and embedding), exactly as the live vault's pages already
  do.
- Its pages already carry `type`, so they are OKF v0.2 conformant at the concept level (§11). That makes them a clean
  normaliser test.
- It exercises the NAS path, the corpus namespace and the cross-corpus dedupe, which is the general problem of "the same
  knowledge in two places" (K5 replica divergence). Dedupe across corpora is what any later NAS corpus needs.

**Explicitly excluded inside that tree**, as deny-globs in the registry and re-checked by the server:

- `raw/`, `10 Raw/` (third-party intake), `sources/` (full source text), `summaries/`;
- `qdrant-storage/`, `*.env`, `logs/`, `.openkb/`, `tools/`, `config/`, `docs/`;
- every non-`.md` file.

**Alternative B (operator choice, not the default): `/mnt/nas/agent-shared/`**

- 11 files, **excluding `infrastructure/credentials-refs.md` by name**.
- It is real, superseded ops knowledge from April, before the VPS migration (Phase L5 parked it).
- Its value is S3 superseded-knowledge traps, ingested as `status: deprecated` and served only as history.
- Its risk is that it feeds wrong ops facts if a filter fails. Take it only after the primary passes.

**Not candidates:**

- `restic*`, `vps-backups/*` (backups);
- `qdrant-snapshots/`;
- the excluded personal areas;
- the MacBook ChatGPT export (private, local only).

## 3. Build steps (each behind a flag, default off; shadow before act)

| # | Change | Where | Reuses |
|---|---|---|---|
| 0 | **Operator fixes, independent of the slice:** recreate `~/djimit/DjimitKBWiki/logs/` (or retarget the crons) so the NAS rsync runs again; decide whether to restore or remove the cron entries for the missing `daily-validate.sh` and `rebuild_indexes.py` | workstation crontab | — |
| 1 | Corpus registry `~/.djimit/kb-corpora.json`: `{id: "nas-wiki-20260701", root, allow: ["concepts/*.md", "entities/*.md"], deny: [...§2], classification: "internal", owner: "human:<operator>", read_only: true}` | workstation | — |
| 2 | `kb-sync.mjs --corpus <id>`: read the registry; enforce allow and deny; open files with `O_RDONLY`; prefix `path` with the corpus id; send the raw frontmatter; dry-run by default; treat a server `pending` answer as not accepted, so the page is retried until it has a verdict; log every opened path | `scripts/kb-sync.mjs` (origin/main, installed per memory rule "install host scripts from origin/main") | existing push model, host token |
| 3 | Server ingest, flag `KB_FABRIC_INGEST=off\|shadow`: re-check the corpus prefix and deny-globs; **cross-corpus dedupe** (same body sha already in `kb_pages` ⇒ copy vector and verdict, zero NVIDIA calls); otherwise the existing safety and embed path; new nullable columns (`corpus`, `concept_id`, `okf_json`, `safety_state`, `classification`, `recorded_from`, `recorded_to`, `normaliser_version`, plus a backfilled `embedding_model` / `embedding_dim`); answer `pending` on a safety error | `S/services/kb-corpus.ts` `ingestKbPages`, `S/routes/remote-gym.ts:67` | content_safety, P1 seal, `addDimColumn` pattern |
| 4 | Serving guard: `kbContext` ignores rows with `corpus IS NOT NULL` unless `KB_FABRIC_SERVE=true` (separate flag, not part of this slice). **In shadow, panel prompts are byte-identical to today's** | `kb-corpus.ts:59` | — |
| 5 | OKF v0.2 normaliser and conformance report: map KBWiki frontmatter (ARCHITECTURE.md §3.2), JSON-flow-style values, round-trip fixture (Google `acme_retail/metrics/gross-margin.md` with its unknown `not:` key) | small module + `knowledge-maintenance` `okf_lint` (report only) | knowledge-maintenance job |
| 6 | Arm C offline: an FTS5 table built **in the offline scorer** from an export of `kb_pages` (ids, titles, bodies of the technical KB; never committed to git); RRF via `retrieval-eval.ts`; metadata filters | `scripts/` scorer (pattern `e1-rrf-score.mjs`) | `retrieval-eval.ts`, E1 export |
| 7 | Decision plane: D-0001 to D-0003 (TEMPORAL_DECISIONS.md §4) as OKF v0.2 docs (`type: Decision`, `djimit:` extension) in `docs/research/knowledge-fabric/decisions/`, so there is **no prod write**. A `swarm_claims` import comes later and needs its own authorization | repo | `swarm_claims` / `swarm_evidence_edges` design |
| 8 | Tests: allow and deny path tests (including `credentials-refs.md`, `.env`, `qdrant-storage/`); idempotency; pending retry; round-trip zero diff; a no-new-outbound-host test; and a "shadow does not change the prompt" test that fails on today's code once the corpus rows exist | `packages/server/src/__tests__/` | builder preamble rule "a test that fails on old code" |

The slice touches no new service, no new outbound host, no Qdrant and no maker path.

## 4. Acceptance criteria

| # | Criterion | How it is verified |
|---|---|---|
| AC1 | 0 files opened outside the allow-list; 0 paths under excluded areas | pusher path log ⊆ allow-list; tests |
| AC2 | Idempotent: run 2 sends 0 pages; touching 1 file (in a test fixture, never on the NAS) sends 1 | test + dry-run counts |
| AC3 | Every corpus row has a yes/no safety verdict, or is `PENDING_VERDICT` and not servable | SQL on a **copy** of the DB |
| AC4 | 296 pages accepted, or each failure listed with a reason; 0 NVIDIA calls for byte-identical pages | `llm_model_calls` delta (consumer embeddings / content_safety) = number of non-identical pages |
| AC5 | `embedding_model` / `embedding_dim` non-NULL on every corpus row | SQL |
| AC6 | OKF v0.2 conformance report: `type` present on ≥ 99 %; round-trip fixture zero diff outside `djimit:` | report + test |
| AC7 | Shadow neutrality: 0 `kb_retrieval` hits on corpus rows while `KB_FABRIC_SERVE` is off; panel prompt unchanged | judgments query + test |
| AC8 | No new outbound host | test enumerating fetch targets |
| AC9 | As-of: for a concept present in both corpora, "as recorded on 2026-09-01" and "as of now" each return a version with `recorded_from` / `recorded_to` set correctly | test on fixture rows |
| AC10 | Baseline comparison delivered: arm C vs arm B on S1 (E1 labels, n ≥ 30) with ΔMRR and a paired-bootstrap CI, plus S4 guards (60 synthetic items each) | offline scorer output |

AC10 is a **measurement**, not a success bar. The slice is complete when AC1–AC10 are delivered, whatever the C-vs-B
verdict. Any adoption of C follows the frozen rule in EVALUATION_PROTOCOL.md §6.

## 5. Baseline comparison and rollback

**Baseline:** arm B as it runs today: `kbContext` cosine k = 3 plus the jev gate, over the same 1 313 pages.

- Arm A (no KB) is computed from the same frozen queries for context.
- E-KB (#961) runs separately on the gate itself. The slice does not duplicate it.

**Rollback**, in order:

1. Set `KB_FABRIC_INGEST=off`. Corpus rows are no longer written. `KB_FABRIC_SERVE` was never on, so nothing reached a
   prompt.
2. Delete the corpus rows, after a unique backup of `/data`: `DELETE FROM kb_pages WHERE corpus = 'nas-wiki-20260701'`.
   This is one statement, and the existing rows (corpus NULL) are untouched.
3. Workstation: remove the registry entry and reinstall the previous `kb-sync.mjs` from origin/main.

The NAS and the vault are never written. The pusher opens files read-only, and a read-only bind mount is recommended
(§6).

## 6. What the operator must authorize (separately)

1. **Corpus.** `/mnt/nas/workstation-backup/wiki/wiki/{concepts,entities}` (296 files, 1.3 MB) as corpus
   `nas-wiki-20260701`, classification `internal`. Also decide whether pages that are **not** byte-identical to `kb_pages`
   may go to NVIDIA for safety and embedding, as the live vault's pages already do. The alternative is "skip
   non-identical pages", which keeps zero new egress.
2. **Read-only mount.** A read-only bind mount of that subtree on the workstation, e.g. `/mnt/nas-ro/…`. This needs sudo,
   so the operator runs it. The CIFS mount is `rw` today.
3. **Implementation PR(s).** Steps 2–8, flags default off. Review and merge are the operator's.
4. **Deploy** through `scripts/deploy-vps.sh <sha> --apply`, then set `KB_FABRIC_INGEST=shadow` in runtime.env (with a
   dated backup).
5. **Workstation install** of the updated `kb-sync.mjs` and the registry from origin/main, followed by one dry run and
   then one real run.
6. **Labelling time.** About 110 min for S1 (E1 cards), which also closes E1. E-KB's ≈ 125 min is optional for the slice
   but recommended in the same week.
7. **Independent of the slice:** fix the KBWiki crons (step 0) and the kb-sync pending-verdict defect. The second also
   re-verdicts the 456 unverdicted live pages, which is a separate small PR.

Not requested and not needed: `KB_FABRIC_SERVE=true` (acting), Qdrant changes, alternative corpus B, any personal NAS
area, and the ChatGPT export.
