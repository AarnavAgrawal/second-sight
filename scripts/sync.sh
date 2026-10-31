#!/usr/bin/env bash
# Keep the current branch in step with origin: fetch, rebase (stashing uncommitted work), test, push.
# Never force-pushes. Exits non-zero and leaves the tree untouched on a rebase conflict or failing tests.
#   bash scripts/sync.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export PATH="$HOME/.bun/bin:$PATH"

branch=$(git branch --show-current)
[ -n "$branch" ] || { echo "sync: detached HEAD, skipping"; exit 1; }
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  echo "sync: a rebase is already in progress, resolve it first"; exit 1
fi

git fetch --quiet origin
behind=$(git rev-list --count "HEAD..origin/$branch")
if ! git rebase --autostash "origin/$branch"; then
  git rebase --abort || true
  echo "sync: CONFLICT rebasing onto origin/$branch. Nothing pushed; resolve by hand."
  exit 2
fi

ahead=$(git rev-list --count "origin/$branch..HEAD")
if [ "$ahead" -eq 0 ]; then
  echo "sync: rebased onto origin/$branch (pulled $behind), nothing to push"; exit 0
fi

if ! bun test shared >/tmp/second-sight-sync-test.log 2>&1; then
  tail -20 /tmp/second-sight-sync-test.log
  echo "sync: tests failed. $ahead local commit(s) NOT pushed."
  exit 3
fi

git push --quiet origin "HEAD:$branch"
echo "sync: pushed $ahead commit(s) to origin/$branch (was $behind behind before rebase)"
