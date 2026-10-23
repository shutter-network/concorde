#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"

BRANCH=gh-pages
DIST=site/.vitepress/dist
TREE=$(mktemp -d)/gh-pages

STAMP=$(git describe --always --dirty --broken)

npm run check:docs

touch "$DIST/.nojekyll"

git fetch origin "$BRANCH" 2>/dev/null || true
if git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
  git worktree add -B "$BRANCH" "$TREE" "origin/$BRANCH"
else
  git worktree add --orphan -b "$BRANCH" "$TREE"
fi

find "$TREE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$DIST/." "$TREE/"

git -C "$TREE" add --all
git -C "$TREE" commit -m "docs: $STAMP" || echo "no change to publish"
git -C "$TREE" push origin "$BRANCH"
git worktree remove --force "$TREE"
rm -rf "$(dirname "$TREE")"
