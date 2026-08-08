// The two Shiki themes the site colours code with.
//
// They are named in one place because two things read them. VitePress colours every fenced block
// on the site, and `expanded-object-methods.mjs` colours the signature block at the top of a page
// with the same highlighter so that the two are indistinguishable. A signature block coloured for
// a theme the rest of the page is not using would be the one failure nobody notices, because both
// halves would look like code.
//
// These are VitePress's own defaults, restated rather than left implicit: `.vitepress/config.ts`
// sets `markdown.theme` from here, so the day somebody picks a different pair there is the day the
// signature blocks follow. No colour value is written down anywhere in this repository, and that
// is deliberate: a palette copied out of a theme is a list that drifts.

export const shikiThemes = { light: "github-light", dark: "github-dark" };
