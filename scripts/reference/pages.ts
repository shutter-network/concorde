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

/**
 * Where the generated pages sit under the VitePress root, and therefore what every sidebar link
 * to one begins with.
 *
 * `site/` is the root and `site/reference/` is one directory below it, because the site carries
 * authored pages as well now. Written once here because both renderers need the identical value
 * and a wrong one is quiet: VitePress reports a dead link written in a page and never one written
 * in a sidebar, so a link that reaches nothing survives the build and is found by a reader.
 * `typedoc.jsonc`'s `docsRoot` states the same fact to TypeDoc, which computes its own fifteen
 * links from it.
 */
export const referenceBase = "/reference";

/** One sidebar link to a generated page, in the shape VitePress reads. */
export function pageLink(directory: string, subpath: string): string {
  return `${referenceBase}/${directory}/${subpath}.md`;
}

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
