#!/bin/bash
# Deploys the Terse actors to the hosted Terse platform (run inside WSL Ubuntu: the Windows CLI can't create
# the symlinks the deploy build needs without Developer Mode).
#   wsl -d Ubuntu -u root -- bash scripts/deploy-actors.sh
# Needs: `terse auth login` done in WSL (or the Windows credentials copied to ~/.config/terse-nodejs/config.json),
# and actor/terse.config.json (links the hosted project).
set -e
export PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/root/second-sight-deploy
(cd "$REPO" && bun scripts/sync-actor-shared.ts)
mkdir -p "$DEST"
rsync -a --delete --exclude node_modules --exclude .durable-actors --exclude generated "$REPO/actor/" "$DEST/actor/"
cd "$DEST/actor"
bun install --silent
terse deploy
