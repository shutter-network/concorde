import { defineConfig } from "vitepress";
// Written beside the pages by `../scripts/reference/render.ts`, which runs after TypeDoc in
// `npm run generate`. Static for the same reason as the line above, and load-bearing for a second
// one: TypeDoc empties `reference/` on every run, so this file exists only if the renderer ran,
// and a pipeline that dropped that step fails here rather than serving a sidebar with a section
// missing from it.
import generatedSidebar from "../reference/generated-sidebar.json";
// Generated beside the pages by `typedoc-vitepress-theme`. This is a static import of a file
// that does not exist in a fresh clone, which is why `dev` and `build` both generate before
// they start VitePress: without that, loading this config is a hard resolve error.
import typedocSidebar from "../reference/typedoc-sidebar.json";
import { shikiThemes } from "../shiki-themes.mjs";

// The site is two things: the pages in this directory, which are written by hand for an Operator
// adopting the framework, and `reference/`, which is generated from the doc comments and from the
// schema and route declarations. `srcDir` is therefore `site/` itself and not `reference/`, which
// it was while the reference was the whole site. Three things move together with that value and
// are wrong in silence if one of them is left behind: `typedoc.jsonc`'s `docsRoot`, which decides
// what TypeDoc's own sidebar links start with, and `referenceBase` in
// `../../scripts/reference/pages.ts`, which decides the same for the table and route pages.
export default defineConfig({
  title: "Concorde",
  description: "Build an AI agent that serves several parties at once and is controlled by none.",
  srcDir: ".",

  // `README.md` is this directory's own maintainer note, about the toolchain rather than about
  // the framework, and `srcDir` above would otherwise serve it as a page. `node_modules` is
  // excluded by VitePress itself.
  srcExclude: ["README.md"],

  // The site is served as GitHub Pages for this repository, so it sits under the repository name
  // rather than at the root of the host, and every asset and every internal link resolves below
  // this segment. It is a fourth value stating where the site's pages sit, alongside the three
  // named above, and the only one of the four that fails loudly: absent or wrong, the HTML loads
  // and every stylesheet, script and font 404s, so the first page opened says so. A custom domain
  // sets this back to "/". `../scripts/deploy-docs.sh` is what publishes, by hand.
  base: "/concorde/",

  // The pair VitePress would have picked anyway, said out loud because the signature blocks are
  // coloured by a second call to the same highlighter and have to be handed the same two themes;
  // `../shiki-themes.mjs` is where the argument for naming them once lives.
  markdown: { theme: shikiThemes },

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide" },
      { text: "Architecture", link: "/architecture" },
      { text: "API reference", link: "/reference/" },
    ],

    // The authored pages first and the generated sections after them, which is the order somebody
    // adopting the framework meets them in. Every entry below `API reference` is generated: the
    // fifteen entry-point pages TypeDoc writes, then the table and route sections the renderer
    // writes.
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Build a shared agent", link: "/guide" },
          { text: "Architecture", link: "/architecture" },
        ],
      },
      { text: "API reference", link: "/reference/" },
      ...typedocSidebar,
      ...generatedSidebar,
    ],
    outline: "deep",
    socialLinks: [{ icon: "github", link: "https://github.com/shutter-network/concorde" }],
  },
});
