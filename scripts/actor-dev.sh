#!/bin/bash
# Runs the Terse local actor runtime inside WSL Ubuntu (no Windows build exists).
# Usage (from Windows PowerShell):  wsl -d Ubuntu -u root -- bash scripts/actor-dev.sh [srcdir]
# Copies actor/ (with its generated shared/ copy) into the WSL home (fast native FS + Linux node_modules),
# keeps them synced every 2 s, and runs `terse actor dev` on port 7100.
set -e
export PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$REPO}"
DEST=/root/second-sight
mkdir -p "$DEST"
command -v rsync >/dev/null || (apt-get install -y -qq rsync >/dev/null)
sync_once() {
  # The actor imports a generated copy of the shared/ modules it needs (terse deploy uploads only actor/).
  (cd "$SRC" && bun scripts/sync-actor-shared.ts --quiet)
  rsync -a --delete --exclude node_modules --exclude .durable-actors --exclude generated "$SRC/actor/" "$DEST/actor/"
}
sync_once
cd "$DEST/actor"
bun install --silent
( while true; do sleep 2; sync_once; done ) &
SYNC_PID=$!
trap 'kill $SYNC_PID 2>/dev/null' EXIT
terse actor dev
