export const referenceBase = "/reference";

export function pageLink(directory: string, subpath: string): string {
  return `${referenceBase}/${directory}/${subpath}.md`;
}

export type ReferencePage = {
  readonly file: string;
  readonly markdown: string;
};

export type SidebarSection = {
  readonly text: string;
  readonly collapsed: boolean;
  readonly items: readonly { readonly text: string; readonly link: string }[];
};

export type PageSet = {
  readonly directory: string;
  readonly pages: readonly ReferencePage[];
  readonly section: SidebarSection;
};
