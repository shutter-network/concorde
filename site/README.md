# The documentation site

TypeDoc reads the doc comments out of `../src`, its markdown plugin and VitePress theme write
one page per entry point into `reference/`, `../scripts/reference/render.ts` writes the table
and route pages after it, and VitePress serves them all. Run it from the repository root:

```sh
npm run docs:dev     # serve on localhost and regenerate as doc comments are edited
npm run docs:build   # generate and build the static site
npm run check:docs   # regenerate, check every page for a linked block, then build
npm run docs:deploy  # check:docs, then publish the build to the `gh-pages` branch
```

All four install this package's dependencies from its lockfile first, so a fresh clone needs
no separate step.

**The site is published at
[shutter-network.github.io/concorde](https://shutter-network.github.io/concorde/)**, which is where
it lands once the repository is moved to the `shutter-network` organisation and renamed. `base`
below already names the new one, so the first deploy after the move is what makes the two agree
([ADR-0056](../docs/adr/0056-the-framework-is-called-concorde.md)). Two things follow and neither is
guarded. **`base` in `.vitepress/config.ts` has to be the repository name**, because these are
project pages and every asset resolves below that segment: absent or wrong, the HTML loads and
every stylesheet, script and font 404s. A custom domain moves the site to the root of that
domain and sets `base` back to `/`, and the two always change together. And
**`../scripts/deploy-docs.sh` publishes the working tree**, not a commit: it stamps the
`gh-pages` commit message with `git describe --dirty` so a site built over uncommitted edits
says so, and it refuses nothing. Nothing deploys on a push, so a doc comment merged on `main`
is live when somebody remembers. `check:docs` in CI still proves it would build.

Because the publishing source is a branch rather than an Actions artifact, GitHub runs the
legacy Jekyll pipeline over it, which drops every path beginning with `_`. Nothing VitePress
writes today has one, so the `.nojekyll` the script writes changes nothing today: it is what
keeps a future one from 404ing in a way that reads as a wrong `base`.

**The site is two things now, and it used to be one.** `index.md`, `guide.md` and
`architecture.md` sit in this directory and are written by hand for an Operator adopting the
framework; `reference/` below them is generated and authored by nobody. The reference was the
whole site until those three arrived, and the change cost one thing worth knowing: **three values
now state where `reference/` sits and all three must agree.** `.vitepress/config.ts` sets
`srcDir` to this directory, `typedoc.jsonc` sets `docsRoot` to it, and
`../scripts/reference/pages.ts` exports `referenceBase` for the two renderers. Set any one of
them back to `reference/` and that generator's sidebar links lose the `/reference` segment and
reach nothing. **The build does not fail on it**: VitePress reports a dead link written in a
page and never one written in a sidebar, so the failure is found by a reader rather than by
`check:docs`. `README.md` is in `srcExclude` for a related reason — it is this note, about the
toolchain rather than about the framework, and `srcDir` would otherwise serve it as a page.

`public/` is the third thing in here and holds one file, `architecture.svg`, which `index.md` and
`architecture.md` both show. VitePress copies that directory to the site root untouched and
rewrites `/architecture.svg` against `base`, which is why the pages reference it with a leading
slash and not a relative path. It is an Excalidraw export and it is self-contained: the font it
uses is embedded, so the page makes no external request for it. Its labels are the glossary's, so
the picture says Signal Worker where the pages do. It has no background of its own, and every
stroke and every letter in it is `#1e1e1e` against a dark theme's `#1b1b1f`: the boxes stay
readable, because their text sits on a pastel fill, and the arrows, the dashed Gateway boundary
and the four labels on the arrows do not.

`reference/` is generated in full on every run and **is not committed**: `.gitignore` covers the
whole directory, sidebar included. It was committed, so that a change to the public API arrived
as a readable diff in review. A signature block is HTML now, and that does not diff readably.
What the reversal costs is argued in the repository's `CLAUDE.md`, and it is this: a reviewer
of a doc-comment change has to run the site to see the rendered result. Nothing under
`reference/` is authored: TypeDoc wipes its output directory before it writes, which is why
`.vitepress/` sits beside it rather than inside it, and why a page is never edited by hand.
Change the doc comment in `../src` and regenerate. `node_modules`, `.vitepress/cache` and
`.vitepress/dist` are gitignored for reasons of their own, which `.gitignore` gives.

**So a clone holds the three authored pages and no generated one.** `.vitepress/config.ts`
imports both generated sidebars, and VitePress reads its config before anything else, so both
`dev` and `build` generate first. Neither is a script to skip.

**`generate` is two generators and the order is load-bearing.** `typedoc && node
../scripts/reference/render.ts`: TypeDoc empties `reference/`, so the table pages are written
after it or not at all. This is also why `dev` passes `--cleanOutputDir false` to the watching
TypeDoc. Without it every rebuild in a dev session empties the directory again, the table pages
and the sidebar they are listed in go with it, and the running site serves eight links to
nothing. What that flag costs in a dev session is that a page TypeDoc stops writing lingers until
the next `generate`, and that a `schema.ts` edited during a session does not reach the table
pages, because TypeDoc's watch is what triggers a rebuild and it is not watching for that.

**Every declaration block and every signature block is HTML rather than a fence**, so that
the type references in it can be links: `expanded-object-methods.mjs` writes the declaration
itself, hands Shiki the characters and the ranges that are links, and wraps the result in the
markup VitePress puts around its own code blocks. Parameters carry their types, because the
buffer handed to Shiki has to be TypeScript for the grammar to colour it. Shiki is a declared
dependency here for that reason, rather than one reached through VitePress, and
`shiki-themes.mjs` is where the two theme names both callers use are written down.
`.vitepress/theme/` exists to load the one authored stylesheet in this site, which is what gives
such a link its dotted underline. The file's own header argues the design and lists the names it
reads off another package's render context.

`check:docs` is the guard on all of that, and it lives at the root because it is a check rather
than a way to look at the site: it regenerates, asserts that every page still holds a
preformatted block with a link inside it, names every page that does not, and builds. That
assertion is there for one failure. An upgrade that renames a partial this renderer overrides
leaves the override uncalled, the plugin writes its own fence instead, and the page is correctly
coloured, entirely unlinked, and looks right. `check:docs` is not part of `npm run check`, for
the reason the next section gives.

## Why this is a package of its own

**It carries a second TypeScript, and that is the only thing the separation buys.** TypeDoc
reads doc comments through the TypeScript compiler API and peers a compiler of `5.0.x` through
`6.0.x`. This repository pins TypeScript 7, whose programmatic API does not stabilise until
7.1. So the generator needs a compiler the build toolchain does not have, and a dependency tree
of its own is how it gets one: `npm ci` at the root installs none of this, and `npm run check`
neither knows nor cares that `site/` exists. A documentation generator does not get to choose
the compiler the framework ships with.

The framework's own dependencies are not duplicated here. Node and the compiler resolve
`drizzle-orm`, `fastify`, `pino` and the rest by walking up to the root `node_modules`, so this
tree holds only the documentation toolchain.

## The exit condition

**When TypeDoc supports the compiler this repository pins, delete this package.** Move
`typedoc.jsonc`, `.vitepress/`, `shiki-themes.mjs`, `specifier-titles.mjs` and
`expanded-object-methods.mjs` to the root, fold the
devDependencies into the root ones minus `typescript`, and let `npm run docs:*` call the tools
directly. `shiki` comes with them and stays declared rather than reached through VitePress,
because the renderer calls it itself. One file does not move, and it is the one question the
collapse has to answer rather than relocate: `tsconfig.json` here exists only so that VitePress's
esbuild reads it instead of the root's, and at the root there is nothing left for it to stand in
front of. Nothing else here is load-bearing.

TypeScript 7 shipped without a stable programmatic API and one is expected in 7.1, so the far
bank of this bridge is dated rather than hypothetical. Compare `typedoc`'s
`peerDependencies.typescript` against the root `devDependencies.typescript` whenever either
moves.
