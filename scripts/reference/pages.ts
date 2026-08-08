/**
 * What a renderer in this directory hands back, and what `render.ts` does with it.
 *
 * One renderer produces one `PageSet`: a directory under `site/reference`, the pages that go in
 * it, and the sidebar section that reaches them. Keeping the section beside the pages is what
 * makes a listed page and a written page the same loop, so the two cannot disagree.
 *
 * The types are here rather than in either renderer because the second one, for the HTTP routes,
 * produces the same shape.
 */

/** One markdown file, named relative to its `PageSet`'s directory. */
export type ReferencePage = {
  /** File name, with its `.md` extension. */
  readonly file: string;
  readonly markdown: string;
};

/** One collapsible group in the site's sidebar, in VitePress's own shape. */
export type SidebarSection = {
  readonly text: string;
  readonly collapsed: boolean;
  readonly items: readonly { readonly text: string; readonly link: string }[];
};

/** Everything one renderer produces. */
export type PageSet = {
  /** Directory under `site/reference`, emptied before the pages are written into it. */
  readonly directory: string;
  readonly pages: readonly ReferencePage[];
  readonly section: SidebarSection;
};
