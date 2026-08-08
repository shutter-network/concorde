// VitePress's own theme, and one stylesheet.
//
// A custom theme entry is the only way to add a stylesheet to a VitePress site, so this file
// exists to hold the import on the line below and nothing else. What it loads is described in the
// file it loads.
import DefaultTheme from "vitepress/theme";
import "./signature-links.css";

export default DefaultTheme;
