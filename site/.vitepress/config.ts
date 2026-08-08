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

// The reference is the whole site. There is no landing page, no glossary and no guide: the
// only content is what TypeDoc writes from the doc comments, so `srcDir` is the generated
// directory and its index is the site root.
export default defineConfig({
  title: "shared-agent-framework",
  description: "The API reference, generated from the doc comments.",
  srcDir: "reference",

  // The pair VitePress would have picked anyway, said out loud because the signature blocks are
  // coloured by a second call to the same highlighter and have to be handed the same two themes;
  // `../shiki-themes.mjs` is where the argument for naming them once lives.
  markdown: { theme: shikiThemes },

  // Not published anywhere ([the site runs locally](../README.md)), so no base path and no
  // sitemap.
  themeConfig: {
    sidebar: [...typedocSidebar, ...generatedSidebar],
    outline: "deep",
    socialLinks: [{ icon: "github", link: "https://github.com/jannikluhn/shared-agent-framework" }],
  },
});
