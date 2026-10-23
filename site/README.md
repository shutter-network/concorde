# Documentation maintenance

The [published site](https://shutter-network.github.io/concorde/) combines three authored pages
with generated API, route, and table references.

Run these commands from the repository root. Each installs the site's dependencies first.

| Command | Purpose |
| --- | --- |
| `npm run docs:dev` | Generate the reference and start the local preview |
| `npm run docs:build` | Generate and build the static site |
| `npm run check:docs` | Generate, check signature links, and build |
| `npm run docs:deploy` | Run the checks and publish to `gh-pages` |

Deployment publishes the working tree, including uncommitted edits. It is manual; pushing a
commit does not publish the site. The deployment commit records `git describe --dirty`.

## Where to edit

| Content | Source |
| --- | --- |
| Introduction, guide, architecture | `index.md`, `guide.md`, `architecture.md` |
| TypeScript API explanations | JSDoc in `../src/` |
| HTTP descriptions | Route schemas in `../src/*/routes.ts` and `../src/route-conventions.ts` |
| Database tables | `../src/*/schema/index.ts` |
| Architecture illustration | `public/architecture.svg` |
| Generated reference layout | `../scripts/reference/`, `expanded-object-methods.mjs` |

Do not edit `reference/`. It is generated and gitignored, along with the generated sidebars.
This README is excluded from the published site.

## Generation and preview

The `generate` script runs TypeDoc first, then the route and table renderers. TypeDoc clears
`reference/`, so the other renderers must run afterward. VitePress imports both generated
sidebars; generate them before starting it.

The preview watches TypeDoc changes without clearing the output directory. Restart the preview
after route or schema changes to regenerate those pages. A full generation also removes stale
TypeDoc pages.

Signature blocks use HTML so type names can be links. `expanded-object-methods.mjs` renders the
blocks and Shiki highlights them. `check:docs` verifies that each generated API page contains a
linked signature block, then builds the site. Run it when changing TypeDoc, its plugins, or the
renderer.

## Paths and deployment

Keep these settings consistent:

- `.vitepress/config.ts`: `srcDir: "."`.
- `typedoc.jsonc`: `docsRoot: "."`, output in `./reference`.
- `../scripts/reference/pages.ts`: `referenceBase: "/reference"`.

Sidebar links can break without causing a build failure. Check them in the preview after
changing these paths.

The GitHub Pages base path is `/concorde/`. Update it if the repository URL changes; use `/` for
a site hosted at the root of a custom domain. The deployment script writes `.nojekyll` so GitHub
Pages serves paths beginning with underscores.

## Toolchain

The site has its own dependency tree because its TypeDoc installation uses TypeScript 6 while
the library uses TypeScript 7. Library dependencies are resolved from the root `node_modules`.
The root `npm run check` does not require the site package; CI runs `check:docs` separately.

When TypeDoc supports the library's compiler, consider merging the toolchains. Review the site
`tsconfig.json` at that point: VitePress currently uses it to avoid inheriting the library's
compiler settings.
