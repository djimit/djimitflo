#!/usr/bin/env bash
# install-deploy-script.sh — operator step, as root on the VPS: install scripts/deploy-vps.sh of a reviewed commit as the
# copy scripts/auto-deploy.sh verifies and executes (/usr/local/lib/djimitflo/deploy-vps.installed.sh, root:root 0755), and
# record its source commit and sha256 in deploy-vps.installed.sh.source. auto-deploy never runs a deploy script from the
# commit it deploys (S2 / DEP-01); when a merged commit changes scripts/deploy-vps.sh it pauses until this step has been run
# for that commit.
#
# Dry run by default (shows the diff against the installed copy). Usage:
#   scripts/install-deploy-script.sh <40-char-sha>           # show what would be installed
#   scripts/install-deploy-script.sh <40-char-sha> --apply   # install it
set -euo pipefail
ROOT="${DEPLOY_ROOT:-/srv/djimitflo}"
REPO_SLUG="${AUTO_DEPLOY_REPO:-djimit/djimitflo}"
# a root-owned dir that only root can write, every parent up to / included (auto-deploy.sh checks the same before it runs it)
INSTALL_DIR="${AUTO_DEPLOY_INSTALL_DIR:-/usr/local/lib/djimitflo}"
INSTALLED="$INSTALL_DIR/deploy-vps.installed.sh"
trusted_dir() { python3 - "$1" <<'PY'
import os, stat, sys
T = int(os.environ.get("AUTO_DEPLOY_TRUSTED_UID") or "0"); p = os.path.realpath(sys.argv[1])
while True:
    st = os.lstat(p)
    if st.st_uid not in (0, T): sys.exit(f"{p} is owned by uid {st.st_uid}, not root")
    if st.st_mode & 0o022 and not (st.st_mode & stat.S_ISVTX and st.st_uid == 0): sys.exit(f"{p} is writable by group or others")
    if p == "/": break
    p = os.path.dirname(p)
PY
}
sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <40-char-sha> [--apply]" >&2; exit 2; }
sha256_file() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
curl -fsS "https://raw.githubusercontent.com/$REPO_SLUG/$sha/scripts/deploy-vps.sh" -o "$tmp"
bash -n "$tmp" || { echo "scripts/deploy-vps.sh at $sha does not parse — not installing" >&2; exit 1; }
hash="$(sha256_file "$tmp")"
if [ -f "$INSTALLED" ]; then
  echo "# installed now: $(sed -n 's/^commit=//p' "$INSTALLED.source" 2>/dev/null || echo unknown)"
  diff -u "$INSTALLED" "$tmp" || true
else
  echo "# no installed copy yet at $INSTALLED"
fi
if [ "${2:-}" != "--apply" ]; then echo "# dry run — review the diff above, then rerun with --apply to install scripts/deploy-vps.sh of $sha (sha256 $hash)"; exit 0; fi
install -d -m 0755 "$INSTALL_DIR"
trusted_dir "$INSTALL_DIR" || { echo "$INSTALL_DIR is not trusted — make it and every dir above it root:root and not group/other-writable (chown root:root, chmod 0755)" >&2; exit 1; }
# the script first, then its record: an interrupted install leaves a mismatch, which auto-deploy refuses
install -m 0755 "$tmp" "$INSTALLED.tmp.$$" && mv -f "$INSTALLED.tmp.$$" "$INSTALLED"
printf 'commit=%s\nsha256=%s\ninstalled_at=%s\n' "$sha" "$hash" "$(date -u +%FT%TZ)" > "$INSTALLED.source.tmp.$$" \
  && chmod 0644 "$INSTALLED.source.tmp.$$" && mv -f "$INSTALLED.source.tmp.$$" "$INSTALLED.source"
echo "installed scripts/deploy-vps.sh of $sha as $INSTALLED (sha256 $hash)"
[ ! -e "$ROOT/AUTO_DEPLOY_DISABLED" ] || echo "auto-deploy is paused: $(head -c 300 "$ROOT/AUTO_DEPLOY_DISABLED") — remove $ROOT/AUTO_DEPLOY_DISABLED to resume"
