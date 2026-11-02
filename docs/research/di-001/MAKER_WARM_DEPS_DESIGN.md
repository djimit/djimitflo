# MAKER_WARM_DEPS: warm worktree bootstrap (design)

**Status:** built behind `MAKER_WARM_DEPS` (`off` | `on`, default `off`). It does nothing while `MAKER_DEPS_001_MODE=on`.
**This is the candidate default after MAKER-DEPS-001 reads out**: if arm B (dependencies prepared before the maker starts) wins the pre-registered analysis, MAKER_WARM_DEPS is how arm B becomes the default without a fresh `npm ci` per worktree.

**Origin:** L3 report v2 (21-10) §5 bottleneck 4. About 44 % of attributed non-verified outcomes are not maker quality (environment 48.6 % over 7 d). `MAKER_FAILURES.md` (DI-001) traced the dominant token cause to makers bootstrapping a worktree without `node_modules` inside their tool loop.

## 1. Relation to MAKER-DEPS-001 (must not alter either arm)

- MAKER-DEPS-001 v1 (`MAKER_DEPS_001_PREREG.md`, sha256-locked) randomises dependency preparation per goal:
  - arm A: today's behaviour;
  - arm B: the checks' own `npm ci --legacy-peer-deps --no-audit --no-fund`, then the `@djimitflo/shared` build.
- Turning MAKER_WARM_DEPS on during the experiment would change both arms:
  - arm A makers would start with dependencies;
  - arm B's preparation would change source and duration.
- So, while `MAKER_DEPS_001_MODE=on`, MAKER_WARM_DEPS refuses to act:
  - the state is `blocked_by_experiment`, logged once per process;
  - evidence: `maker_deps_001.warm_deps.state` in `/api/health/evolution-evidence`;
  - arm assignment, the arm-B command, its event (`maker_worktree_prepared`) and the lease records are byte-for-byte what they are without the flag. A test checks this.
- The pre-registration is not amended. This flag is not a third arm.

## 2. What it does when on

**Population:** the same eligible makers as MAKER-DEPS-001:

- local `opencode` makers of goal runs;
- never TG-001, the gym, or remote, mock or manual makers.

**Steps** (`LoopService.prepareMakerWorktree(..., { warmDepsRoot })`, the arm-B code path):

1. It acts only if the worktree has a `package-lock.json` and no `node_modules`.
2. Key: `sha256(package-lock.json)`. Entry: `<MAKER_WARM_DEPS_CACHE_DIR or /data/maker-deps-cache>/<key>/`, holding `tree/<path>` and `READY.json`. `READY.json` records the paths and the Node ABI.
3. **Hit:** `cp -a` copies the root `node_modules` and each workspace's own `node_modules` into the worktree. npm's relative workspace links stay relative, so they resolve into the new worktree. The entry's `READY.json` mtime is touched.
4. **Miss:** the existing `npm ci` runs, the same command and logs as arm B. On exit 0, the resulting node_modules are copied to a temp directory, which is renamed atomically to the entry. A concurrent maker that renames first wins, and the loser's copy is dropped.
5. Then the `@djimitflo/shared` build runs, exactly as in arm B.
6. **Cap:** after a store, the newest 3 entries by `READY.json` mtime are kept. Temp directories older than 1 h are removed.

**Recorded:**

- on the lease:
  - `deps_source`: `cache` | `fresh` | `failed`;
  - `warm_deps`: `{ lockfile_sha256, cache_hit, cache_stored, cache_error, paths, ms }`;
- a `maker_warm_deps` loop event with the full preparation record.

## 3. Fallbacks

Every fallback ends on the normal path:

| Case | Behaviour | `deps_source` |
|---|---|---|
| entry missing | `npm ci`, store | `fresh` (or `failed`) |
| entry from another Node ABI | treated as a miss and replaced | `fresh` |
| copy from the cache fails (broken or partial entry, disk full) | partial copy removed, `npm ci` | `fresh`, `cache_error` set |
| store fails after a good install | the worktree keeps its install | `fresh`, `cache_error` set |
| `npm ci` fails | nothing stored; the maker runs as today | `failed` |
| bookkeeping throws | `npm ci` if it has not run yet | `fresh` or `failed`, `cache_error: provision_error: …` |

## 4. Choices

**Copy, not hardlink.**

- Hardlinked files share inodes. A maker or check that writes inside `node_modules` in place (patching a dependency, a tool writing next to its package) would silently change the cache and every later worktree.
- `cp -a` uses copy-on-write where the filesystem supports it (GNU coreutils ≥ 9 reflinks by default), and a full copy otherwise.
- `ms` on the lease measures the cost.

**Key = lockfile only.**

- `npm ci` installs exactly the lockfile, so the lockfile is the identity of the tree.
- The Node ABI is checked from `READY.json` rather than put in the key. A deploy that changes Node rebuilds the entry once.

**Supply chain unchanged.**

- The cache only replays what `npm ci` produced from the lockfile's integrity hashes.
- No registry, mirror or script approval is added.

## 5. Read-out and switch-on

- MAKER-DEPS-001 reads out at `target_per_arm` or at the amended stop date (experiment registry):
  - **if arm B is not worse**, the operator may set `MAKER_DEPS_001_MODE` off and `MAKER_WARM_DEPS=on`;
  - **otherwise** this flag stays off.
- After the switch, compare:
  - `warm_deps.by_source` (cache share);
  - lease `warm_deps.ms` against arm B's `install_ms`;
  - maker failures with `failure.stage = deps` or `failure.stderr_class` in `missing_module`, `npm_ci` (`/api/health/attribution` → `failure_capture`).

## 6. Limits

- Disk: up to 3 full `node_modules` trees, plus each worktree's own copy where the filesystem has no copy-on-write.
- The cache is per host. A remote compute host never uses it, because remote makers are not eligible.
- If prod `/data` is not on a copy-on-write filesystem, a hit is a full copy. That is faster than a registry install, but it is not free.
