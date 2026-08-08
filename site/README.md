# The API reference site

TypeDoc reads the doc comments out of `../src`, its markdown plugin and VitePress theme write
one page per entry point into `reference/`, and VitePress serves them. The reference is the
whole site: no landing page, no glossary, no guides, and no decision record as a page of its
own. Run it from the repository root:

```sh
npm run docs:dev     # serve on localhost and regenerate as doc comments are edited
npm run docs:build   # generate and build the static site
npm run check:docs   # regenerate, check every page for a linked block, then build
```

All three install this package's dependencies from its lockfile first, so a fresh clone needs
no separate step. The site is not published: the repository is private, so a public URL would
be the wrong trade while the surface is still being judged.

`reference/` is generated in full on every run and **is not committed**: `.gitignore` covers the
whole directory, sidebar included. It was committed, so that a change to the public API arrived
as a readable diff in review. A signature block is HTML now, and that does not diff readably.
What the reversal costs is argued in the repository's `CLAUDE.md`, and it is this: a reviewer
of a doc-comment change has to run the site to see the rendered result. Nothing under
`reference/` is authored: TypeDoc wipes its output directory before it writes, which is why
`.vitepress/` sits beside it rather than inside it, and why a page is never edited by hand.
Change the doc comment in `../src` and regenerate. `node_modules`, `.vitepress/cache` and
`.vitepress/dist` are gitignored for reasons of their own, which `.gitignore` gives.

**So a clone holds no pages at all.** `.vitepress/config.ts` imports the generated sidebar, and
VitePress reads its config before anything else, so both `dev` and `build` generate first.
Neither is a script to skip.

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
