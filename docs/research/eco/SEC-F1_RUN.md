# SEC-F1: how to run the harness (throwaway container)

Protocol: `SEC-F1_PROTOCOL.md` (incl. Amendment 1). Scripts on `exp/sec-f1`:

| script | does | network |
|---|---|---|
| `scripts/sec-f1-run.mjs` | checkout + patch, prod prompt, prod `OpenCodeExecutor`, results JSONL | GitHub (git fetch) + model endpoint |
| `scripts/sec-f1-baseline.mjs` | secrets (gitleaks or `SECRET_PATTERNS`), ESLint pack v1, R1–R5 | none when the git cache from the runner exists |
| `scripts/sec-f1-score.mjs` | AUC, false rejects, catches beyond baseline, McNemar, Wilson, decision rule | none |
| `scripts/sec-f1-lib.mjs` | order, blind item view, checkout, rules, output guards | — |

Guarantees built into the scripts:
- The runner aborts (exit 3) before the first item when `sha256(JSON.stringify(CHECKER_INSTRUCTIONS))` of the dist it is
  given is not `dd10149499c04656458c50fda4324d0181b5bcfe10da5a816273f50489aab4ac`.
- It only reads the manifest's blind fields (`id`, `repo`, `base_sha`, `files`, hashes, `finding`), never the labels.
- It opens one in-memory SQLite DB only; it deletes `DB_PATH`, `DJIMITFLO_CONTROL_URL` and `DJIMITFLO_SPAWN_TOKEN` from
  its own environment before loading the dist. Outputs inside the repo, the items dir, `/data` or with a DB extension are
  refused.
- It runs only `git` and `opencode`. No `npm install`, no script from a checkout (git hooks are off).
- Token cap 6 M (sum of opencode step totals, `--cap` may only lower it). No item starts once the cap is reached. The
  running item gets `OPENCODE_MAX_RUN_TOKENS = min(prod value, remaining)`. More than 2 no-verdicts in the first 10
  items stop the run with exit 4 (harness fault: fix it, record the restart in the protocol, then rerun).
- Resumable: an item with `<out>.d/<id>/result.json` is skipped. The JSONL is rebuilt from those files.

## 0. Source and output on the host (VPS)

```bash
SRC=/tmp/sec-f1-src            # a checkout of exp/sec-f1, mounted read-only
OUT=/tmp/sec-f1-out            # everything the run writes
git clone --branch exp/sec-f1 --depth 1 https://github.com/djimit/djimitflo.git "$SRC"
mkdir -p "$OUT" && chown 1001:1001 "$OUT"
IMG=$(docker inspect -f '{{.Config.Image}}' djimitflo-live)        # the prod image (same dist + opencode)
# the baseline imports the branch copy of finding-fix-gate.mjs; it must equal the one in the image
docker run --rm --network none -v "$SRC/scripts:/s:ro" "$IMG" cmp /s/finding-fix-gate.mjs /app/scripts/finding-fix-gate.mjs
```

Common flags for every step: `--rm`, the prod image, user 1001, **no `/data` mount, no DB, not on the compose network**.
The source is read-only under `/sec-f1`, so `REPO_ROOT` = `/sec-f1` and the items are found by default:

```bash
RUN="docker run --rm --user 1001:1001 -v $SRC/scripts:/sec-f1/scripts:ro -v $SRC/docs/research/eco:/sec-f1/docs/research/eco:ro -v $OUT:/out -w /tmp"
```

## 1. Prepare (GitHub only, no model)

Checks the prompt hash, fetches each base at depth 1 into `/out/work/git`, applies each patch, and writes every prompt to
`/out/work/prepared/<id>/prompt.md`. It calls no model and writes no result.

```bash
$RUN --network bridge "$IMG" node /sec-f1/scripts/sec-f1-run.mjs \
  --dist /app/packages/server/dist --work /out/work --prepare-only
ls "$OUT/work/prepared" | grep -c '^[0-9a-f]\{10\}$'      # expect 46
```

## 2. Baseline (offline)

```bash
$RUN --network none "$IMG" node /sec-f1/scripts/sec-f1-baseline.mjs \
  --dist /app/packages/server/dist --work /out/work --out /out/baseline.jsonl
```

gitleaks is not in the image. The secret component then falls back to `secret-patterns.ts`, and each row records which
one ran. `FINDING_FIX_ESLINT_FROM=/opt/finding-fix-eslint` comes from the image.

## 3. Reviewer run (this is the spend)

The reviewer needs the same opencode setup as prod: the provider env and, if prod uses one, the opencode config/auth
file. Do **not** copy `DB_PATH`, `DJIMITFLO_CONTROL_URL` or `DJIMITFLO_SPAWN_TOKEN`; the runner drops them anyway.

```bash
umask 077
docker exec djimitflo-live env | grep -E '^(OPENCODE_[A-Z_]*|OLLAMA_[A-Z_]*|DJIMITFLO_OPENCODE_MODEL|LOOP_REVIEWER_TIMEOUT_MS|RUNTIME_ENV_PASSTHROUGH)=' > /tmp/sec-f1.env
docker inspect djimitflo-live --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'   # look for an opencode config/auth mount
# add the matching mount read-only below, e.g. -v <src>/auth.json:/home/djimitflo/.local/share/opencode/auth.json:ro
$RUN --network bridge --env-file /tmp/sec-f1.env --tmpfs /home/djimitflo:uid=1001,gid=1001 -e HOME=/home/djimitflo \
  "$IMG" node /sec-f1/scripts/sec-f1-run.mjs --dist /app/packages/server/dist --work /out/work --out /out/results.jsonl
```

- If it stops, rerun the same command: finished items are skipped and the token total carries over.
- `SEC_F1_MODEL=<provider/model>` (via `-e`) forces `--model`. Leave it unset for the prod default. Each result records
  `effective_model` and where that value came from.
- Per item, `/out/results.jsonl.d/<id>/` holds `prompt.md`, `stdout.redacted.jsonl` and `result.json`.
  `run-meta.json` holds the order, the cap, the timeout, the hash and the opencode version.

## 4. Score (offline)

```bash
$RUN --network none "$IMG" node /sec-f1/scripts/sec-f1-score.mjs \
  --results /out/results.jsonl --baseline /out/baseline.jsonl --json /out/score.json
```

`decision` is the frozen rule: `KEEP`, `NARROW_REPLACE_CANDIDATE` or `INCONCLUSIVE`. If items are unscored, it is
`INCONCLUSIVE` unless the scored items already fix the outcome (`decision_fixed_by_scored_items`). The output also has:
- `all.regex_visible_split` (Amendment 1, reported only);
- `without_wording_flagged` (the 4 `security_wording` items left out, reported only).

## 5. Clean up

```bash
rm -rf "$OUT/work" /tmp/sec-f1.env      # keep results.jsonl(.d), baseline.jsonl, score.json for SEC-F1_RESULT.md
rm -rf "$SRC"
```

## Local check without a model

```bash
cd packages/server && npx vitest run src/__tests__/sec-f1-harness.test.ts src/__tests__/sec-f1-items.test.ts
```

The suite covers the decision-rule boundaries with fake results, the R1–R5 transcription against this protocol's table,
the prompt hash, the seeded order, the blind view and the output guards. It also builds the prompt with the prod
`LoopService` and runs a fake `opencode` binary through the prod `OpenCodeExecutor`.
