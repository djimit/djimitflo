#!/usr/bin/env bash
# install-deploy-script.sh — operator step, as root on the VPS: install scripts/deploy-vps.sh of a reviewed commit as the
# copy scripts/auto-deploy.sh executes ($DEPLOY_ROOT/deploy-vps.installed.sh), and record its source commit and sha256 in
# deploy-vps.installed.sh.source. auto-deploy never runs a deploy script from the commit it deploys (S2 / DEP-01); when a
# merged commit changes scripts/deploy-vps.sh it pauses until this step has been run for that commit.
#
# Dry run by default (shows the diff against the installed copy). Usage:
#   scripts/install-deploy-script.sh <40-char-sha>           # show what would be installed
#   scripts/install-deploy-script.sh <40-char-sha> --apply   # install it
set -euo pipefail
ROOT="${DEPLOY_ROOT:-/srv/djimitflo}"
REPO_SLUG="${AUTO_DEPLOY_REPO:-djimit/djimitflo}"
INSTALLED="$ROOT/deploy-vps.installed.sh"
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
# the script first, then its record: an interrupted install leaves a mismatch, which auto-deploy refuses
install -m 0755 "$tmp" "$INSTALLED.tmp.$$" && mv -f "$INSTALLED.tmp.$$" "$INSTALLED"
printf 'commit=%s\nsha256=%s\ninstalled_at=%s\n' "$sha" "$hash" "$(date -u +%FT%TZ)" > "$INSTALLED.source.tmp.$$" && mv -f "$INSTALLED.source.tmp.$$" "$INSTALLED.source"
echo "installed scripts/deploy-vps.sh of $sha as $INSTALLED (sha256 $hash)"
[ ! -e "$ROOT/AUTO_DEPLOY_DISABLED" ] || echo "auto-deploy is paused: $(head -c 300 "$ROOT/AUTO_DEPLOY_DISABLED") — remove $ROOT/AUTO_DEPLOY_DISABLED to resume"
