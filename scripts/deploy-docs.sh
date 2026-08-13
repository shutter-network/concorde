#!/bin/sh
# Build the documentation site and publish it to `gh-pages`, which is the branch GitHub Pages is
# configured to serve from the root of. There is no workflow: this script is the whole deployment
# and it runs by hand, which is the same shape publishing the package has.
#
# The one thing that decides whether the published site works at all is `base` in
# `site/.vitepress/config.ts`, which has to be the repository name because these are project
# pages rather than a user site.
#
# This is the one file in `scripts/` that is not TypeScript. What it does is git plumbing over a
# built directory, and the `scripts/*.ts` convention exists for programs that read `src` or the
# manifest through the toolchain, which this does not.
set -eu
cd "$(git rev-parse --show-toplevel)"

BRANCH=gh-pages
DIST=site/.vitepress/dist
TREE=$(mktemp -d)/gh-pages

# What the published commit is traceable to. `--dirty` is the honest part: this deploys the
# working tree, so a site built over uncommitted edits says so in the commit message rather than
# claiming to be the commit it was built beside. Nothing here refuses a dirty tree.
STAMP=$(git describe --always --dirty --broken)

# `check:docs` rather than `docs:build`, which it contains: it regenerates, asserts that every
# reference page still holds a signature block with a link inside it, and then builds. That
# assertion is the only thing that catches a TypeDoc upgrade renaming a partial
# `site/expanded-object-methods.mjs` overrides, which leaves every page correctly coloured,
# entirely unlinked and looking finished. The cost is that the reference is generated twice, once
# to be read and once by the build, and publishing is not the inner loop.
npm run check:docs

# The publishing source is a branch, not an Actions artifact, so GitHub runs the legacy Jekyll
# pipeline over it, and Jekyll drops every path beginning with `_`. Nothing VitePress writes today
# has one, so this changes nothing today: it is what keeps a future one from 404ing in a way that
# reads as a wrong `base`.
touch "$DIST/.nojekyll"

git fetch origin "$BRANCH" 2>/dev/null || true
if git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
  git worktree add -B "$BRANCH" "$TREE" "origin/$BRANCH"
else
  git worktree add --orphan -b "$BRANCH" "$TREE"
fi

# The branch contents are replaced rather than copied over. A page the generators stopped writing
# has to stop being served, and copying onto the previous deployment would serve it for good.
find "$TREE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$DIST/." "$TREE/"

git -C "$TREE" add --all
git -C "$TREE" commit -m "docs: $STAMP" || echo "no change to publish"
git -C "$TREE" push origin "$BRANCH"
git worktree remove --force "$TREE"
rm -rf "$(dirname "$TREE")"
