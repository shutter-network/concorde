import { defineConfig } from "vitepress";
import generatedSidebar from "../reference/generated-sidebar.json";
import typedocSidebar from "../reference/typedoc-sidebar.json";
import { shikiThemes } from "../shiki-themes.mjs";

export default defineConfig({
  title: "Concorde",
  description: "Build an AI agent that serves several parties at once and is controlled by none.",
  srcDir: ".",

  srcExclude: ["README.md"],

  base: "/concorde/",

  markdown: { theme: shikiThemes },

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide" },
      { text: "Architecture", link: "/architecture" },
      { text: "API reference", link: "/reference/" },
    ],

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
