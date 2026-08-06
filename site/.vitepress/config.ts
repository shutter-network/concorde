import { defineConfig } from "vitepress";
// Generated beside the pages by `typedoc-vitepress-theme`. This is a static import of a file
// that does not exist in a fresh clone, which is why `dev` and `build` both generate before
// they start VitePress: without that, loading this config is a hard resolve error.
import typedocSidebar from "../reference/typedoc-sidebar.json";

// The reference is the whole site. There is no landing page, no glossary and no guide: the
// only content is what TypeDoc writes from the doc comments, so `srcDir` is the generated
// directory and its index is the site root.
export default defineConfig({
  title: "shared-agent-framework",
  description: "The API reference, generated from the doc comments.",
  srcDir: "reference",

  // Decision records are contributor material and are not pages here. A doc comment that
  // still cites one makes TypeDoc copy the record into `reference/_media/`, so those copies
  // are excluded from the build and the links into them are not counted against it. Both
  // lines go when the citations do (tickets 05 to 07): with no citation left there is no
  // `_media/` to exclude, and every other dead link still fails the build.
  srcExclude: ["_media/**"],
  ignoreDeadLinks: [/\/_media\//],

  // Not published anywhere ([the site runs locally](../README.md)), so no base path and no
  // sitemap.
  themeConfig: {
    sidebar: typedocSidebar,
    outline: "deep",
    socialLinks: [{ icon: "github", link: "https://github.com/jannikluhn/shared-agent-framework" }],
  },
});
