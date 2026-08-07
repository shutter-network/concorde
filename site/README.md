# The API reference site

TypeDoc reads the doc comments out of `../src`, its markdown plugin and VitePress theme write
one page per entry point into `reference/`, and VitePress serves them. The reference is the
whole site: no landing page, no glossary, no guides, and no decision record as a page of its
own. Run it from the repository root:

```sh
npm run docs:dev     # serve on localhost and regenerate as doc comments are edited
npm run docs:build   # generate and build the static site
npm run check:docs   # regenerate, fail if the committed pages differ, then build
```

All three install this package's dependencies from its lockfile first, so a fresh clone needs
no separate step. The site is not published: the repository is private, so a public URL would
be the wrong trade while the surface is still being judged.

`reference/` is generated in full on every run and **is committed**, so a change to the public
API arrives as a readable diff. Nothing under it is authored: TypeDoc wipes its output directory
before it writes, which is why `.vitepress/` sits beside it rather than inside it, and why a page
is never edited by hand. Change the doc comment in `../src` and regenerate. Regeneration
is byte-identical when no doc comment moved, which is what `disableSources: true` in
`typedoc.jsonc` buys, so a stray `docs:dev` during development leaves the tree clean and cannot
be mistaken for a real change. `node_modules`, `.vitepress/cache` and `.vitepress/dist` are
gitignored, and so is `reference/typedoc-sidebar.json`, for the reason `.gitignore` gives.

**So the committed pages are not a site on their own.** `.vitepress/config.ts` imports that
gitignored sidebar, and VitePress reads its config before anything else, so both `dev` and
`build` generate first. Neither is a script to skip because `reference/` looks present.

`check:docs` is the guard on all of that, and it lives at the root because it is a check rather
than a way to look at the site: it regenerates, names every page that differs from what is
committed, and builds. It is not part of `npm run check`, for the reason the next section
gives.

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
`typedoc.jsonc`, `.vitepress/config.ts`, `specifier-titles.mjs` and
`expanded-object-methods.mjs` to the root, fold the
devDependencies into the root ones minus `typescript`, and let `npm run docs:*` call the tools
directly. Nothing else here is load-bearing.

TypeScript 7 shipped without a stable programmatic API and one is expected in 7.1, so the far
bank of this bridge is dated rather than hypothetical. Compare `typedoc`'s
`peerDependencies.typescript` against the root `devDependencies.typescript` whenever either
moves.
