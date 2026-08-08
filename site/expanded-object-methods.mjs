// The theme, and the two things installed through it.
//
// A render context is built per page by `getRenderContext`, and overriding that method is how a
// plugin gets to return a context of its own. Only one theme can be named on `typedoc.jsonc`'s
// `theme` line, so everything that overrides a partial has to arrive through the same one. Hence
// one file with two halves.
//
// # 1. A type reference in a signature block is a link
//
// The block at the top of a page is the first thing a reader takes the shape from, and every type
// name in it is dead text: `useCodeBlocks` wraps the rendered declaration in a fence, markdown does
// not parse the inside of a fence, and the plugin's own working links are stripped out again by
// `unEscapeChars` on the way in. Turning the setting off gives the links back and takes the block
// with it.
//
// So a signature block stops being a fenced code block and becomes HTML, written here.
//
// **The mechanism follows from one observation: a signature block is not source text.** It is a
// rendering of a type tree in which every reference is already resolved, so nothing has to
// rediscover that `Component` is a reference to a type alias with a page of its own. The renderer
// below writes the declaration into a text buffer and records, per reference, the character range
// it just wrote and the URL the plugin's own router answers with. Colour is then a function of the
// characters and is left to Shiki. **A link is never a function of the characters.** That is why
// this is not a Shiki transformer: a transformer sees a token's string and nothing else, so
// attaching a link would mean resolving a name back to a declaration, and names in these pages are
// not unique. Decorations take character ranges and never need to know what is inside them.
//
// Ranges cover the identifier only and are closed before any type argument is written, so
// `Promise<MessageRecord>` yields one range over `MessageRecord` and nothing over `Promise`. They
// are therefore disjoint spans and never nested, which matters because Shiki verifies that
// decorations do not intersect and throws when they do: a mistake here is a failed generation
// rather than a wrong page.
//
// **This converts one declaration kind: a type alias whose declaration contains a resolvable
// reference.** Everything else still goes to the plugin's own `declarationTitle` and renders
// exactly as it did. A type alias with nothing to link to goes there too, because an HTML block
// carrying no anchor would be a change of markup that bought a reader nothing.
//
// **What it reads out of another package.** `partials.declarationTitle` is wrapped; `ctx.router`
// (`getFullUrl`, `hasUrl`), `ctx.urlTo` and `ctx.page.model` answer where a reference points; and
// the type walk below is a hand-written copy of the plugin's `someType` family, so a change to how
// that family lays a declaration out is a change this file does not follow. Nothing guards against
// any of it yet. The failure is quiet by construction: an override left uncalled means the
// plugin's wrapper runs, and the page renders as a correct-looking unlinked fence. Issue 03 adds
// the per-page assertion that closes it.
//
// # 2. A method inside an expanded object prints as a method
//
// `expandObjects` in `typedoc.jsonc` is what makes the block above an object type print its
// members rather than the word `object`. It cannot be set on its own. The plugin renders each
// member as `name: <type>` and takes that type from `helpers.getDeclarationType`, which for a
// member carrying signatures answers the *return type of the first one*. So the parameters
// disappear and a method prints as a property holding its own return value: `run(prompt:
// RunPrompt): Promise<RunOutcome>` becomes `run: Promise<RunOutcome>`, and `tx<T>(body: ...):
// Promise<T>` becomes `tx: Promise<T>` with `T` bound to nothing at all. `object` said nothing and
// misled nobody; that block would mislead, which is why the setting and this file arrive together.
//
// The fix is one widening: inside an expanded object, hand the renderer the member's own function
// type instead of its return type. It applies only inside an expanded object, because the
// Properties and Methods sections below the block call the same helper and print the name and the
// parameters themselves. And an expanded object can contain another one, so "inside" is a count
// and not a flag.
//
// **It is dead code for every block the renderer above converts**, which renders a member with
// signatures as a method natively rather than by widening a helper. It stays because the blocks
// that renderer does not convert still reach it. It goes when nothing does.
//
// **On what it reads out of the render context.** Two names, `partials.declarationType` and
// `helpers.getDeclarationType`. A future `typedoc-plugin-markdown` that renames either one, or that
// stops asking the helper for a member's type, leaves the widening wired to nothing and the methods
// go quietly back to printing their return type.

import { createHighlighter } from "shiki";
import {
  ArrayType,
  ConditionalType,
  IndexedAccessType,
  InferredType,
  IntersectionType,
  IntrinsicType,
  NamedTupleMember,
  OptionalType,
  QueryType,
  ReferenceType,
  ReflectionKind,
  ReflectionType,
  TupleType,
  TypeOperatorType,
  UnionType,
  UnknownType,
} from "typedoc";
import { MarkdownTheme, MarkdownThemeContext } from "typedoc-plugin-markdown";
import { shikiThemes } from "./shiki-themes.mjs";

/**
 * The class every anchor inside a signature block carries.
 * `.vitepress/theme/signature-links.css` is what gives it its dotted underline.
 */
const LINK_CLASS = "saf-signature-link";

/**
 * A piece of a signature block: the characters, and the ranges within them that are links.
 *
 * @typedef {{ text: string, links: { start: number, end: number, href: string }[] }} Fragment
 */

/**
 * A fragment that is characters and nothing else.
 *
 * @param {string} value
 * @returns {Fragment}
 */
function text(value) {
  return { text: value, links: [] };
}

/**
 * A fragment that is one link over the whole of it. An empty URL answers with plain text, so an
 * anchor in a block always has somewhere to go.
 *
 * @param {string} value
 * @param {string} href
 * @returns {Fragment}
 */
function anchor(value, href) {
  return href ? { text: value, links: [{ start: 0, end: value.length, href }] } : text(value);
}

/**
 * Fragments one after another, with every range moved to where its characters ended up. A plain
 * string is taken as a fragment carrying no links.
 *
 * @param {(Fragment | string)[]} parts
 * @returns {Fragment}
 */
function concat(parts) {
  let value = "";
  const links = [];
  for (const part of parts) {
    const fragment = typeof part === "string" ? text(part) : part;
    for (const link of fragment.links) {
      links.push({
        start: link.start + value.length,
        end: link.end + value.length,
        href: link.href,
      });
    }
    value += fragment.text;
  }
  return { text: value, links };
}

/**
 * Fragments with a separator between them.
 *
 * @param {(Fragment | string)[]} parts
 * @param {string} separator
 * @returns {Fragment}
 */
function join(parts, separator) {
  const spaced = [];
  for (const part of parts) {
    if (spaced.length > 0) spaced.push(separator);
    spaced.push(part);
  }
  return concat(spaced);
}

/**
 * Rewrites a fragment one line at a time and carries its ranges along.
 *
 * `mapLine` answers with the new line and `offset`, the index within it at which the original
 * line's first character now sits, or with `null` to drop the line. Every caller here only adds or
 * removes whitespace at the ends of a line, and a range never covers whitespace, so that one
 * number is enough to keep every range over the identifier it was recorded around.
 *
 * @param {Fragment} fragment
 * @param {(line: string, index: number, lines: string[]) => { text: string, offset: number } | null} mapLine
 * @returns {Fragment}
 */
function mapLines(fragment, mapLine) {
  const lines = fragment.text.split("\n");
  const starts = [];
  let cursor = 0;
  for (const line of lines) {
    starts.push(cursor);
    cursor += line.length + 1;
  }

  const moved = new Array(lines.length).fill(null);
  const written = [];
  let length = 0;
  lines.forEach((line, index) => {
    const mapped = mapLine(line, index, lines);
    if (mapped === null) return;
    moved[index] = length + mapped.offset;
    written.push(mapped.text);
    length += mapped.text.length + 1;
  });

  const links = [];
  for (const link of fragment.links) {
    const index = lines.findIndex(
      (line, i) => link.start >= starts[i] && link.end <= starts[i] + line.length,
    );
    if (index === -1 || moved[index] === null) continue;
    const start = moved[index] + (link.start - starts[index]);
    links.push({ start, end: start + (link.end - link.start), href: link.href });
  }
  return { text: written.join("\n"), links };
}

/**
 * The plugin's own indentation of a member's type: the first line where the name left it, the last
 * line two spaces in, and every line between them three. Reproduced quirk and all, because the
 * blocks this renderer does not convert are still laid out that way and two blocks on one page
 * should not disagree about how a nested object is indented.
 *
 * Two quirks, both load-bearing. It drops the empty lines and then indexes the survivors while
 * still comparing against the count from before, so a fragment that had one gets its last line
 * indented as though it were a middle one. And its last-line rule reads *"unless the line already
 * closes a brace"*, which never fires: the string it tests still carries the plugin's escaping, so
 * the closing brace it is looking for is spelled `\}` by the time it looks.
 *
 * @param {Fragment} fragment
 * @returns {Fragment}
 */
function indentMemberType(fragment) {
  const originalCount = fragment.text.split("\n").length;
  let position = -1;
  return mapLines(fragment, (line) => {
    if (line.length === 0) return null;
    position += 1;
    if (position === 0) return { text: line, offset: 0 };
    if (position === originalCount - 1) return { text: `  ${line}`, offset: 2 };
    return { text: `   ${line}`, offset: 3 };
  });
}

/**
 * What `codeBlock` does to a rendered declaration before fencing it: the last line loses its
 * surrounding whitespace when the declaration closes a brace or an angle bracket.
 *
 * @param {Fragment} fragment
 * @returns {Fragment}
 */
function trimLastLine(fragment) {
  const ends = ["}", "};", ">", ">;"].some((suffix) => fragment.text.endsWith(suffix));
  if (!ends) return fragment;
  const count = fragment.text.split("\n").length;
  return mapLines(fragment, (line, index) => {
    if (index !== count - 1) return { text: line, offset: 0 };
    return { text: line.trim(), offset: -(line.length - line.trimStart().length) };
  });
}

/**
 * The href a page's markdown link would have had, as a browser needs it. VitePress rewrites `.md`
 * to `.html` in the links it parses out of markdown, and it never looks inside raw HTML, so the
 * rewrite happens here instead. A pure fragment is already a link to this page.
 *
 * @param {string} url
 * @returns {string}
 */
function pageHref(url) {
  if (!url || url.startsWith("#")) return url;
  const page = url.replace(/\.md(?=#|$)/, ".html");
  return /^[a-z][a-z0-9+.-]*:|^[./]/i.test(page) ? page : `./${page}`;
}

/**
 * The flag words the plugin puts in front of a declaration, without its backticks.
 *
 * @param {import("typedoc").ReflectionFlags} flags
 * @returns {string}
 */
function reflectionFlags(flags) {
  return [
    flags?.isAbstract && "abstract",
    flags?.isConst && "const",
    flags?.isPrivate && "private",
    flags?.isProtected && "protected",
    flags?.isReadonly && "readonly",
    flags?.isStatic && "static",
    flags?.isOptional && "optional",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * One type, as characters and ranges. The dispatch is the plugin's `someType`, in its order, so
 * that a kind neither of us handles falls to the same `toString` in both.
 *
 * @param {import("typedoc").SomeType | undefined} type
 * @returns {Fragment}
 */
function someTypeFragment(ctx, type, options) {
  if (!type) return text("");

  if (type instanceof ArrayType) {
    const element = someTypeFragment(ctx, type.elementType);
    return type.elementType.type === "union"
      ? concat(["(", element, ")[]"])
      : concat([element, "[]"]);
  }
  if (type instanceof ConditionalType) {
    return join(
      [
        someTypeFragment(ctx, type.checkType),
        text("extends"),
        someTypeFragment(ctx, type.extendsType),
        text("?"),
        someTypeFragment(ctx, type.trueType),
        text(":"),
        someTypeFragment(ctx, type.falseType),
      ],
      " ",
    );
  }
  if (type instanceof IndexedAccessType) {
    return concat([
      someTypeFragment(ctx, type.objectType),
      "[",
      someTypeFragment(ctx, type.indexType),
      "]",
    ]);
  }
  if (type instanceof InferredType) {
    return text(`infer ${type.name}`);
  }
  if (type instanceof IntersectionType && type.types) {
    return join(
      type.types.map((member) => someTypeFragment(ctx, member)),
      " & ",
    );
  }
  if (type instanceof IntrinsicType && type.name) {
    return text(type.name);
  }
  if (type instanceof QueryType) {
    return concat(["typeof ", someTypeFragment(ctx, type.queryType)]);
  }
  if (type instanceof ReferenceType) {
    return referenceTypeFragment(ctx, type);
  }
  if (type instanceof ReflectionType) {
    return reflectionTypeFragment(ctx, type.declaration, options);
  }
  if (type instanceof TypeOperatorType) {
    return concat([`${type.operator} `, someTypeFragment(ctx, type.target)]);
  }
  if (type instanceof TupleType && type.elements) {
    return concat([
      "[",
      join(
        type.elements.map((element) => someTypeFragment(ctx, element, { forceCollapse: true })),
        ", ",
      ),
      "]",
    ]);
  }
  if (type instanceof UnionType && type.types) {
    return unionTypeFragment(ctx, type);
  }
  if (type instanceof UnknownType) {
    return text(type.name);
  }
  if (type instanceof NamedTupleMember) {
    return someTypeFragment(ctx, type.element);
  }
  if (type instanceof OptionalType) {
    const element = someTypeFragment(ctx, type.elementType, {
      forceCollapse: options?.forceCollapse,
    });
    return type.elementType.type === "union"
      ? concat(["(", element, ")?"])
      : concat([element, "?"]);
  }

  // A mapped type, a template literal, a type predicate: the plugin prints these through
  // `toString()` as well, and a reference inside one is unlinked in both. Recorded rather than
  // solved: the block is honest, it is only less clickable than it could be.
  return text(String(type));
}

/**
 * A reference, with a range around the identifier when it has a page to reach.
 *
 * The range closes before the type arguments, which is what keeps every range in a block a
 * disjoint identifier span. A type parameter is deliberately not a link: `T` resolves to a
 * reflection with a URL, and the URL is the page the reader is already on.
 *
 * @param {import("typedoc").ReferenceType} type
 * @returns {Fragment}
 */
function referenceTypeFragment(ctx, type) {
  const named = () => {
    const pageUrl = ctx.router.getFullUrl(ctx.page.model);
    const targetUrl =
      type.reflection && ctx.router.hasUrl(type.reflection)
        ? ctx.router.getFullUrl(type.reflection)
        : null;
    if (type.reflection && targetUrl && pageUrl !== targetUrl) {
      return type.reflection.kind === ReflectionKind.TypeParameter
        ? text(type.name)
        : anchor(type.reflection.name, pageHref(ctx.urlTo(type.reflection)));
    }
    return type.externalUrl ? anchor(type.name, type.externalUrl) : text(type.name);
  };

  if (type.reflection || (type.name && type.typeArguments)) {
    const parts = [named()];
    if (type.typeArguments?.length) {
      parts.push(typeArgumentsFragment(ctx, type.typeArguments));
    }
    return concat(parts);
  }
  return type.externalUrl ? anchor(type.name, type.externalUrl) : text(type.name);
}

/**
 * @param {import("typedoc").SomeType[]} args
 * @returns {Fragment}
 */
function typeArgumentsFragment(ctx, args) {
  return concat([
    "<",
    join(
      args.map((arg) =>
        arg instanceof ReflectionType
          ? reflectionTypeFragment(ctx, arg.declaration, { forceCollapse: true })
          : someTypeFragment(ctx, arg),
      ),
      ", ",
    ),
    ">",
  ]);
}

/**
 * A union, wrapped onto its own lines once it is too wide to read across one.
 *
 * The plugin measures the same seventy characters against a string still carrying its backticks
 * and its markdown links, and this measures the characters a reader sees, so a union near the
 * threshold can wrap here and not there.
 *
 * @param {import("typedoc").UnionType} type
 * @returns {Fragment}
 */
function unionTypeFragment(ctx, type) {
  const members = type.types.map((member) => {
    const fragment = someTypeFragment(ctx, member, { forceCollapse: true });
    return member instanceof ReflectionType && member.declaration?.signatures?.length
      ? concat(["(", fragment, ")"])
      : fragment;
  });
  const flat = members.map((member) => member.text).join("");
  const wrap = ctx.options.getValue("useCodeBlocks") && (flat.length > 70 || flat.includes("\n"));
  const body = join(members, wrap ? "\n  | " : " | ");
  return wrap ? concat(["\n  | ", body]) : body;
}

/**
 * The declaration behind a `ReflectionType`: a lone call signature prints as a function type, and
 * anything else prints as an object.
 *
 * @param {import("typedoc").DeclarationReflection} declaration
 * @returns {Fragment}
 */
function reflectionTypeFragment(ctx, declaration, options) {
  const expand = options?.forceCollapse || ctx.options.getValue("expandObjects");
  if (declaration?.signatures?.length === 1 && !declaration.children) {
    return functionTypeFragment(ctx, declaration.signatures);
  }
  if (expand || declaration.signatures?.length) {
    return declarationTypeFragment(ctx, declaration, options);
  }
  return text("object");
}

/**
 * `<T>(a, b) => R`, or `<T>(a, b): R` where a member of an object is being printed.
 *
 * Parameter types are not printed, because `expandParameters` is off and this renderer reproduces
 * what the block says today. Issue 02 is what turns them on for these blocks alone.
 *
 * @param {import("typedoc").SignatureReflection[]} signatures
 * @returns {Fragment}
 */
function functionTypeFragment(ctx, signatures, options) {
  const shouldFormat = ctx.options.getValue("useCodeBlocks");
  const separator = options?.typeSeparator || " => ";
  const showParameterType = options?.forceParameterType || ctx.options.getValue("expandParameters");

  const rendered = signatures.map((signature) => {
    const typeParameters = signature.typeParameters
      ? `<${signature.typeParameters.map((parameter) => parameter.name).join(", ")}>`
      : "";
    const parameters = (signature.parameters ?? []).map((parameter) => {
      const name = `${parameter.flags?.isRest ? "..." : ""}${parameter.name}${
        parameter.flags?.isOptional ? "?" : ""
      }`;
      return showParameterType
        ? concat([name, ": ", someTypeFragment(ctx, parameter.type)])
        : text(name);
    });
    return concat([
      typeParameters,
      shouldFormat && signatures.length > 1 ? "  " : "",
      "(",
      join(parameters, ", "),
      ")",
      separator,
      someTypeFragment(ctx, signature.type),
    ]);
  });
  return join(rendered, shouldFormat ? ";\n" : "; ");
}

/**
 * The type of one member of an expanded object.
 *
 * **A member carrying signatures is a method here, not a widened helper.** That is the whole of
 * what the second half of this file exists to repair, done once at the point the member is
 * rendered.
 *
 * @param {import("typedoc").DeclarationReflection} member
 * @returns {Fragment}
 */
function memberTypeFragment(ctx, member, options) {
  if (member.signatures?.length) {
    return reflectionTypeFragment(ctx, member, options);
  }
  const type = member.getSignature?.type ?? member.setSignature?.type ?? member.type;
  return someTypeFragment(ctx, type, options);
}

/**
 * An object type with its members printed out, which is what `expandObjects` buys.
 *
 * @param {import("typedoc").DeclarationReflection} model
 * @returns {Fragment}
 */
function declarationTypeFragment(ctx, model, options) {
  const shouldFormat = ctx.options.getValue("useCodeBlocks");
  const parts = [text("{")];

  if (model.indexSignatures?.length) {
    parts.push(
      join(
        model.indexSignatures.map((signature) =>
          concat([
            concat(
              (signature.parameters ?? []).map((parameter) =>
                concat(["[", parameter.name, ": ", someTypeFragment(ctx, parameter.type), "]"]),
              ),
            ),
            ": ",
            someTypeFragment(ctx, signature.type),
            ";",
          ]),
        ),
        "\n",
      ),
    );
  }

  if (model.signatures) {
    parts.push(concat([functionTypeFragment(ctx, model.signatures, { typeSeparator: ": " }), ";"]));
  }

  if (model.children) {
    const members = model.children.map((member) => {
      const name = [];
      if (member.getSignature) {
        name.push("get", `${member.name}()`);
      } else if (member.setSignature) {
        const parameters = member.setSignature.parameters ?? [];
        const rendered = concat([
          "(",
          join(
            parameters.map((parameter) =>
              concat([
                parameter.flags?.isRest ? "..." : "",
                `${parameter.name}${parameter.flags?.isOptional || parameter.defaultValue ? "?" : ""}`,
                ": ",
                someTypeFragment(ctx, parameter.type),
              ]),
            ),
            ", ",
          ),
          ")",
        ]);
        name.push("set", concat([member.name, rendered]));
      } else {
        name.push(`${member.name}${member.flags?.isOptional ? "?" : ""}`);
      }
      return concat([
        shouldFormat ? "  " : "",
        join(name, " "),
        ": ",
        indentMemberType(memberTypeFragment(ctx, member, options)),
        ";",
      ]);
    });
    parts.push(shouldFormat ? join(members, "\n") : concat([" ", join(members, " ")]));
  }

  parts.push(text(shouldFormat ? "}" : " }"));
  return join(parts, shouldFormat ? "\n" : "");
}

/**
 * A whole type alias declaration: `type Name<T> = …;`, and where each reference in it points.
 *
 * @param {import("typedoc").DeclarationReflection} model
 * @returns {Fragment}
 */
function typeAliasFragment(ctx, model) {
  const parts = [];

  const prefix = [reflectionFlags(model.flags), model.flags?.isRest ? "..." : "", "type"]
    .filter((word) => word.length > 0)
    .join(" ");
  parts.push(`${prefix} `);

  const name = model.originalName ?? model.name;
  parts.push(model.flags.isOptional ? `${name}?` : name);
  if (model.typeParameters?.length) {
    parts.push(`<${model.typeParameters.map((parameter) => parameter.name).join(", ")}>`);
  }
  parts.push(" = ");

  const declarationType = model.signatures
    ? model.signatures[0].type
    : (model.getSignature?.type ?? model.setSignature?.type ?? model.type);
  if (declarationType) {
    parts.push(someTypeFragment(ctx, declarationType));
  } else if (ctx.options.getValue("expandObjects")) {
    parts.push(declarationTypeFragment(ctx, model));
  } else {
    parts.push("object");
  }

  if (model.defaultValue && model.defaultValue !== "..." && model.defaultValue !== model.name) {
    parts.push(` = ${model.defaultValue}`);
  }
  parts.push(";");

  return trimLastLine(concat(parts));
}

/**
 * The fragment as the markup VitePress puts around its own code blocks.
 *
 * Every class and every wrapper here is copied from what VitePress's `preWrapperPlugin` and its
 * two Shiki transformers produce for a fenced block, because the point is that a reader cannot
 * tell a signature block from the `@example` block below it. `v-pre` is part of that: the page is
 * compiled as a Vue template and a brace in a type is not an interpolation.
 *
 * @param {Fragment} fragment
 * @returns {string}
 */
function codeBlockHtml(highlighter, fragment) {
  const html = highlighter.codeToHtml(fragment.text, {
    lang: "typescript",
    themes: shikiThemes,
    defaultColor: false,
    decorations: fragment.links.map((link) => ({
      start: link.start,
      end: link.end,
      tagName: "a",
      // Always a wrapper, never the token itself: a decoration that happens to cover every token
      // on a line is otherwise applied to the line element, and the line would become the anchor.
      alwaysWrap: true,
      properties: { href: link.href, class: LINK_CLASS },
    })),
    transformers: [
      {
        name: "saf:vitepress-code-block",
        pre(node) {
          this.addClassToHast(node, "vp-code");
          delete node.properties.style;
          node.properties["v-pre"] = "";
        },
      },
    ],
  });
  return `<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span>${html}</div>`;
}

/**
 * The context both halves are installed on.
 *
 * @param {import("shiki").Highlighter} highlighter
 */
function contextClass(highlighter) {
  return class SignatureBlockContext extends MarkdownThemeContext {
    constructor(theme, page, options) {
      super(theme, page, options);

      // A type alias with something to link to is written here; everything else, including a type
      // alias with nothing to link to, goes to the plugin and renders as it always has.
      const baseDeclarationTitle = this.partials.declarationTitle;
      this.partials.declarationTitle = (model) => {
        const converts =
          model.kind === ReflectionKind.TypeAlias && this.options.getValue("useCodeBlocks");
        if (!converts) return baseDeclarationTitle(model);
        const fragment = typeAliasFragment(this, model);
        if (fragment.links.length === 0) return baseDeclarationTitle(model);
        return codeBlockHtml(highlighter, fragment);
      };

      // How many expanded objects the plugin's own renderer is currently inside. The base class
      // initialises `partials` and `helpers` as its own fields, which run during `super()` above,
      // so both are in place to be wrapped here.
      let depth = 0;

      const baseDeclarationType = this.partials.declarationType;
      this.partials.declarationType = (model, partialOptions) => {
        depth += 1;
        try {
          return baseDeclarationType(model, partialOptions);
        } finally {
          depth -= 1;
        }
      };

      const baseGetDeclarationType = this.helpers.getDeclarationType;
      this.helpers.getDeclarationType = (model) =>
        depth > 0 && model.signatures?.length
          ? new ReflectionType(model)
          : baseGetDeclarationType(model);
    }
  };
}

/** @param {import("typedoc").Application} app */
export async function load(app) {
  // Built once, before any page is rendered. `load` is awaited by TypeDoc, which is the only
  // asynchronous moment this plugin gets: a partial has to answer with a string.
  const highlighter = await createHighlighter({
    themes: Object.values(shikiThemes),
    langs: ["typescript"],
  });
  const SignatureBlockContext = contextClass(highlighter);

  /**
   * Defining a theme is the mechanism: a render context is built per page by `getRenderContext`,
   * and overriding that method is how a plugin gets to return a context of its own.
   */
  class SignatureBlockTheme extends MarkdownTheme {
    getRenderContext(page) {
      return new SignatureBlockContext(this, page, this.application.options);
    }
  }

  app.renderer.defineTheme("expanded-objects", SignatureBlockTheme);
}
