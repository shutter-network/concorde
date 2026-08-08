// The theme, and the renderer installed through it.
//
// A render context is built per page by `getRenderContext`, and overriding that method is how a
// plugin gets to return a context of its own. Only one theme can be named on `typedoc.jsonc`'s
// `theme` line, so everything that overrides a partial has to arrive through this one file.
//
// # Every declaration and every signature in the reference is a linked, coloured block
//
// The block at the top of a page is the first thing a reader takes the shape from, and every type
// name in it used to be dead text: `useCodeBlocks` wraps the rendered declaration in a fence,
// markdown does not parse the inside of a fence, and the plugin's own working links are stripped
// out again by `unEscapeChars` on the way in. Turning the setting off gives the links back and
// takes the block with it.
//
// So a declaration block stops being a fenced code block and becomes HTML, written here.
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
// **Three partials are wrapped and nothing else is**: `declarationTitle`, `signatureTitle` and
// `typeAndParent`. Between them they are every fenced block the plugin emits for this API, so the
// only fence left in the reference is an `@example`. The type walk below is a hand-written stand-in
// for the plugin's `someType` family rather than an override of it, which is what keeps the
// parameter and property sections underneath a block exactly as they were: those sections call the
// plugin's own partials, and the plugin's own partials are never touched. That is a stronger
// guarantee than a depth counter, and it is why there is no counter here.
//
// # The buffer must be valid TypeScript, and that is why parameters carry their types
//
// Shiki colours with a TextMate grammar, and a grammar handed text outside the language classifies
// it however it happens to fall. `sign(typ, claims): Promise<string>;` is not TypeScript, and the
// grammar answers it by colouring the whole parameter list as plain text and `Promise` as a value.
// Annotated, in the right context, every part of it lands on the right scope.
//
// So parameters print their types. `expandParameters` stays off, because the plugin option widens
// the parameter tables below the block as well; here only the block widens. What it costs is
// width: the widest members go from about seventy characters to about a hundred and twenty and
// scroll sideways on the method-heavy pages. That is the price of the annotation, not of the
// colouring, and it buys a reader a clickable type where there was a bare parameter name.
//
// **A member is a fragment of a larger grammar, and Shiki is told which one.** `readonly fastify:
// FastifyInstance;` is valid inside a type literal and is not a program, so the block for a member
// is highlighted with `grammarContextCode` set to an opening type literal. The context is not part
// of the output; it only puts the tokenizer in the state the fragment belongs to. Which context a
// block gets follows the plugin's own `isGroupKind`: what it calls a group is a top-level
// declaration, and everything else is a member.
//
// Two renderings had to move for a buffer to parse at all, and both are recorded rather than
// hidden. The plugin writes an optional property as `readonly optional scrypt?: T`, with the
// modifier spelled twice and one of the spellings not a modifier; only the `?` survives here. And
// it writes a constructor as `new MalformedPublicKeyError(publicKey): MalformedPublicKeyError`,
// which is a construct signature carrying a name, and no context makes that legal; it is written
// as `new (publicKey: string): MalformedPublicKeyError` here, the class being named by the return
// type on the same line and by the heading above it.
//
// # What it reads out of another package
//
// `partials.declarationTitle`, `partials.signatureTitle` and `partials.typeAndParent` are wrapped.
// `ctx.router` (`getFullUrl`, `hasUrl`), `ctx.urlTo` and `ctx.page.model` answer where a reference
// points. `ctx.helpers.getKeyword` and `ctx.helpers.isGroupKind` answer what a block is. And the
// type walk is a copy of the plugin's `someType` family, so a change to how that family lays a
// declaration out is a change this file does not follow.
//
// The failure is quiet by construction: an override left uncalled means the plugin's wrapper runs,
// and the page renders as a correct-looking unlinked fence. `scripts/check-docs.ts` is what scans
// for it, one assertion per page, and a rename in this list is the checklist for a plugin upgrade.

import { createHighlighter } from "shiki";
import {
  ArrayType,
  ConditionalType,
  IndexedAccessType,
  InferredType,
  IntersectionType,
  IntrinsicType,
  LiteralType,
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
 * The grammar a block that is one member of an object type belongs to. Handed to Shiki as
 * `grammarContextCode`, so the tokenizer starts inside a type literal and never appears in the
 * output.
 */
const MEMBER_CONTEXT = "type __ = {\n";

/** The grammar a top-level declaration belongs to: none, it is already a program. */
const PROGRAM_CONTEXT = "";

/** How far one nesting level indents. */
const INDENT = "  ";

/**
 * The width past which a union stops being readable across one line. Measured against the
 * characters a reader sees, which is why a union near the threshold can wrap here and not in the
 * plugin: the plugin measures a string still carrying its backticks and its markdown links.
 */
const UNION_WIDTH = 70;

/**
 * The number of parameters past which a signature puts each of them on a line of its own. The
 * plugin's own threshold, kept: with types printed the alternative is a first line nobody can read
 * to the end of, and width is being spent on the types themselves.
 */
const WRAP_PARAMETERS_ABOVE = 2;

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
 * line's first character now sits. Every caller here only adds or removes whitespace at the ends of
 * a line, and a range never covers whitespace, so that one number is enough to keep every range
 * over the identifier it was recorded around.
 *
 * @param {Fragment} fragment
 * @param {(line: string, index: number, lines: string[]) => { text: string, offset: number }} mapLine
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

  const moved = [];
  const written = [];
  let length = 0;
  lines.forEach((line, index) => {
    const mapped = mapLine(line, index, lines);
    moved.push(length + mapped.offset);
    written.push(mapped.text);
    length += mapped.text.length + 1;
  });

  const links = [];
  for (const link of fragment.links) {
    const index = lines.findIndex(
      (line, i) => link.start >= starts[i] && link.end <= starts[i] + line.length,
    );
    if (index === -1) continue;
    const start = moved[index] + (link.start - starts[index]);
    links.push({ start, end: start + (link.end - link.start), href: link.href });
  }
  return { text: written.join("\n"), links };
}

/**
 * A fragment that continues onto further lines, moved one level in.
 *
 * The plugin's own indenter puts the first continuation line three spaces in and the last one two,
 * and it drops empty lines and then indexes the survivors against the count from before, so a
 * fragment that had one gets its last line indented as though it were a middle one. That quirk was
 * reproduced while some blocks on a page were still the plugin's and two blocks should not disagree
 * about how a nested object is laid out. Every block is this renderer's now, so the indentation is
 * one level per level and the quirk is gone.
 *
 * @param {Fragment} fragment
 * @param {string} prefix
 * @returns {Fragment}
 */
function indented(fragment, prefix = INDENT) {
  return mapLines(fragment, (line, index) =>
    index === 0 || line.length === 0
      ? { text: line, offset: 0 }
      : { text: prefix + line, offset: prefix.length },
  );
}

/**
 * The finished buffer: no line ends in whitespace.
 *
 * A wrapped union puts its first member on the next line and leaves the `=` or the `=>` before it
 * at the end of a line, and a reader copying the block out should not be copying that space.
 *
 * @param {Fragment} fragment
 * @returns {Fragment}
 */
function trimLineEnds(fragment) {
  return mapLines(fragment, (line) => ({ text: line.replace(/\s+$/, ""), offset: 0 }));
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
 * The modifier words in front of a declaration.
 *
 * The plugin's list, minus `optional`. TypeDoc reports optionality as a flag and the renderer also
 * writes the `?` the language spells it with, so the plugin's block says it twice and the first
 * spelling is not a modifier in any grammar.
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
  if (type instanceof LiteralType) {
    return text(typeof type.value === "bigint" ? `${type.value}n` : JSON.stringify(type.value));
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
    // The plugin drops the label and prints the element, and a label is not part of the type. The
    // buffer stays valid either way: `[start: number]` and `[number]` are both tuples.
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
 * The type parameters a declaration or a signature is written over, by name.
 *
 * Names and not constraints, which is what the plugin prints and what the Type Parameters section
 * below the block exists to expand on. A constraint in the block would widen every generic method
 * on the page to say something the reader is one heading away from.
 *
 * @param {import("typedoc").TypeParameterReflection[] | undefined} parameters
 * @returns {string}
 */
function typeParameters(parameters) {
  return parameters?.length ? `<${parameters.map((parameter) => parameter.name).join(", ")}>` : "";
}

/**
 * One parameter, always with its type. A rest parameter is never optional, so the `?` and the `...`
 * cannot both appear.
 *
 * @param {import("typedoc").ParameterReflection} parameter
 * @returns {Fragment}
 */
function parameterFragment(ctx, parameter) {
  const rest = parameter.flags?.isRest;
  const optional = !rest && (parameter.flags?.isOptional || parameter.defaultValue) ? "?" : "";
  return concat([
    rest ? "..." : "",
    parameter.name,
    optional,
    ": ",
    someTypeFragment(ctx, parameter.type),
  ]);
}

/**
 * A parameter list. `wrap` puts each parameter on a line of its own once there are more than two of
 * them, which is where a signature block stops fitting on one line; a function type written as the
 * type of a member never wraps, because it is already indented inside a block that scrolls.
 *
 * @param {import("typedoc").ParameterReflection[]} parameters
 * @returns {Fragment}
 */
function parametersFragment(ctx, parameters, options) {
  const rendered = parameters.map((parameter) => parameterFragment(ctx, parameter));
  if (!options?.wrap || rendered.length <= WRAP_PARAMETERS_ABOVE) {
    return concat(["(", join(rendered, ", "), ")"]);
  }
  return concat([`(\n${INDENT}`, join(rendered, `,\n${INDENT}`), "\n)"]);
}

/**
 * A union, wrapped onto its own lines once it is too wide to read across one.
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
  const wrap =
    ctx.options.getValue("useCodeBlocks") && (flat.length > UNION_WIDTH || flat.includes("\n"));
  if (!wrap) return join(members, " | ");
  // Every member on a line of its own, one level in, each behind its own bar. The bar leading the
  // first member is what makes the column line up, and TypeScript allows it. A member that is
  // itself several lines long carries on under its own bar rather than falling back to the
  // margin, which is the difference between a wrap and a ragged one.
  const bar = `\n${INDENT}| `;
  const aligned = members.map((member) => indented(member, " ".repeat(bar.length - 1)));
  return concat([bar, join(aligned, bar)]);
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
 * `<T>(a: A, b: B) => R`, or `<T>(a: A, b: B): R` where a member of an object is being printed.
 *
 * @param {import("typedoc").SignatureReflection[]} signatures
 * @returns {Fragment}
 */
function functionTypeFragment(ctx, signatures, options) {
  const shouldFormat = ctx.options.getValue("useCodeBlocks");
  const separator = options?.typeSeparator || " => ";

  const rendered = signatures.map((signature) =>
    concat([
      typeParameters(signature.typeParameters),
      shouldFormat && signatures.length > 1 ? INDENT : "",
      parametersFragment(ctx, signature.parameters ?? []),
      separator,
      someTypeFragment(ctx, signature.type),
    ]),
  );
  return join(rendered, shouldFormat ? ";\n" : "; ");
}

/**
 * The type of one member of an expanded object.
 *
 * **A member carrying signatures is a method here.** The plugin asks `getDeclarationType` for a
 * member's type, and that helper answers a member carrying signatures with the return type of its
 * first signature, so the parameters disappear and a method prints as a property holding its own
 * return value: `run: Promise<RunOutcome>`, and `tx: Promise<T>` with `T` bound to nothing. That
 * defect is not widened around here. It is not reached.
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
  // An object with nothing in it is one pair of braces. The plugin spends a line on each of them,
  // and `excludeExternals` makes this the shape of every drizzle table on every page.
  if (!model.indexSignatures?.length && !model.signatures?.length && !model.children?.length) {
    return text("{}");
  }
  const parts = [text("{")];

  if (model.indexSignatures?.length) {
    parts.push(
      join(
        model.indexSignatures.map((signature) =>
          concat([
            shouldFormat ? INDENT : "",
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
    parts.push(
      concat([
        shouldFormat ? INDENT : "",
        functionTypeFragment(ctx, model.signatures, { typeSeparator: ": " }),
        ";",
      ]),
    );
  }

  if (model.children) {
    const members = model.children.map((member) =>
      concat([
        shouldFormat ? INDENT : "",
        // `readonly` and nothing else: it is the one modifier a member of a type literal can
        // carry, and the plugin drops it here and leaves it to the Properties section below.
        member.flags?.isReadonly ? "readonly " : "",
        memberNameFragment(ctx, member),
        ": ",
        indented(memberTypeFragment(ctx, member, options)),
        ";",
      ]),
    );
    parts.push(shouldFormat ? join(members, "\n") : concat([" ", join(members, " ")]));
  }

  parts.push(text(shouldFormat ? "}" : " }"));
  return join(parts, shouldFormat ? "\n" : "");
}

/**
 * How a member of an object type is named: an accessor by the syntax that declares it, anything
 * else by its name and its `?`.
 *
 * @param {import("typedoc").DeclarationReflection} member
 * @returns {Fragment}
 */
function memberNameFragment(ctx, member) {
  if (member.getSignature) return text(`get ${member.name}()`);
  if (member.setSignature) {
    const parameters = parametersFragment(ctx, member.setSignature.parameters ?? []);
    return concat([`set ${member.name}`, parameters]);
  }
  return text(`${member.name}${member.flags?.isOptional ? "?" : ""}`);
}

/**
 * A whole declaration: `type Name<T> = …;`, `const name: …;`, `readonly name?: …;`, and where each
 * reference in it points. The plugin's `declarationTitle`, written into a buffer.
 *
 * @param {import("typedoc").DeclarationReflection} model
 * @returns {Fragment}
 */
function declarationFragment(ctx, model) {
  const keyword = ctx.options.getValue("useCodeBlocks") ? ctx.helpers.getKeyword(model.kind) : "";
  const prefix = [reflectionFlags(model.flags), model.flags?.isRest ? "..." : "", keyword]
    .filter((word) => word && word.length > 0)
    .join(" ");
  const parts = prefix.length ? [`${prefix} `] : [];

  const name = model.originalName ?? model.name;

  // A setter declares its parameter and never its return type, so it ends where its parameter list
  // ends. Every other declaration is a name, a colon and a type.
  if (model.setSignature && !model.getSignature) {
    const parameters = parametersFragment(ctx, model.setSignature.parameters ?? []);
    return concat([...parts, `set ${name}`, parameters, ";"]);
  }
  parts.push(model.getSignature ? `get ${name}()` : `${name}${model.flags?.isOptional ? "?" : ""}`);
  parts.push(typeParameters(model.typeParameters));
  parts.push(model.kind === ReflectionKind.TypeAlias ? " = " : ": ");

  const hasType = Boolean(
    model.signatures?.length || model.getSignature || model.setSignature || model.type,
  );
  if (hasType) {
    parts.push(memberTypeFragment(ctx, model));
  } else if (ctx.options.getValue("expandObjects")) {
    parts.push(declarationTypeFragment(ctx, model));
  } else {
    parts.push("object");
  }

  if (model.defaultValue && model.defaultValue !== "..." && model.defaultValue !== model.name) {
    parts.push(` = ${model.defaultValue}`);
  }
  parts.push(";");
  return concat(parts);
}

/**
 * A whole signature: a function, a method, a call signature or a constructor. The plugin's
 * `signatureTitle`, written into a buffer.
 *
 * A construct signature loses the name the plugin gives it. `new MalformedPublicKeyError(publicKey):
 * MalformedPublicKeyError` is a construct signature carrying a name, which is not TypeScript
 * anywhere, and the class it constructs is the return type on the same line.
 *
 * @param {import("typedoc").SignatureReflection} model
 * @returns {Fragment}
 */
function signatureFragment(ctx, model, options) {
  const parts = [];
  if (isTopLevelSignature(ctx, model)) {
    parts.push(`${ctx.helpers.getKeyword(model.parent.kind)} `);
  }
  if (options?.accessor) parts.push(`${options.accessor} `);

  const flags = reflectionFlags(model.parent?.flags);
  if (flags.length) parts.push(`${flags} `);

  if (model.kind === ReflectionKind.ConstructorSignature) {
    parts.push("new ");
  } else if (!["__call", "__type"].includes(model.name)) {
    parts.push(`${model.name}${model.parent?.flags?.isOptional ? "?" : ""}`);
  }

  parts.push(typeParameters(model.typeParameters));
  parts.push(parametersFragment(ctx, model.parameters ?? [], { wrap: true }));
  if (model.type) {
    parts.push(": ", someTypeFragment(ctx, model.type));
  }
  parts.push(";");
  return concat(parts);
}

/**
 * Whether a signature stands as a declaration of its own rather than as a member of something. The
 * plugin's own test, and it answers two questions at once: whether the block opens with `function`,
 * and which grammar Shiki is told the buffer belongs to.
 *
 * @param {import("typedoc").SignatureReflection} model
 */
function isTopLevelSignature(ctx, model) {
  return Boolean(
    ctx.options.getValue("useCodeBlocks") &&
      model.parent &&
      ctx.helpers.isGroupKind(model.parent) &&
      ctx.helpers.getKeyword(model.parent.kind),
  );
}

/**
 * The fragment as the markup VitePress puts around its own code blocks.
 *
 * Every class and every wrapper here is copied from what VitePress's `preWrapperPlugin` and its
 * two Shiki transformers produce for a fenced block, because the point is that a reader cannot
 * tell a signature block from the `@example` block below it. `v-pre` is part of that: the page is
 * compiled as a Vue template and a brace in a type is not an interpolation.
 *
 * `grammarContextCode` is the grammar the buffer is a fragment of. It is tokenized to put Shiki in
 * the right state and then thrown away, so nothing of it reaches the page.
 *
 * @param {Fragment} fragment
 * @param {string} context
 * @returns {string}
 */
function codeBlockHtml(highlighter, fragment, context) {
  const html = highlighter.codeToHtml(fragment.text, {
    lang: "typescript",
    themes: shikiThemes,
    defaultColor: false,
    grammarContextCode: context,
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
 * The context the renderer is installed on.
 *
 * @param {import("shiki").Highlighter} highlighter
 */
function contextClass(highlighter) {
  return class SignatureBlockContext extends MarkdownThemeContext {
    constructor(theme, page, options) {
      super(theme, page, options);

      /**
       * A block, coloured and linked. The base class initialises `partials` and `helpers` as its
       * own fields, which run during `super()` above, so both are in place to be wrapped here.
       *
       * @param {Fragment} fragment
       * @param {string} context
       */
      const block = (fragment, context) =>
        codeBlockHtml(highlighter, trimLineEnds(fragment), context);

      const useCodeBlocks = () => this.options.getValue("useCodeBlocks");

      // `useCodeBlocks` off is the plugin's blockquote rendering, which already links and has no
      // block to lose. Nothing here can improve on it, so it is left alone.
      const baseDeclarationTitle = this.partials.declarationTitle;
      this.partials.declarationTitle = (model) =>
        useCodeBlocks()
          ? block(
              declarationFragment(this, model),
              this.helpers.isGroupKind(model) ? PROGRAM_CONTEXT : MEMBER_CONTEXT,
            )
          : baseDeclarationTitle(model);

      const baseSignatureTitle = this.partials.signatureTitle;
      this.partials.signatureTitle = (model, partialOptions) =>
        useCodeBlocks()
          ? block(
              signatureFragment(this, model, partialOptions),
              isTopLevelSignature(this, model) ? PROGRAM_CONTEXT : MEMBER_CONTEXT,
            )
          : baseSignatureTitle(model, partialOptions);

      // What an `Inherited from`, an `Overrides` or an `Implementation of` line says. The plugin's
      // own partial, with its one fenced branch written as a block instead: a reference whose
      // reflection has a parent is a pair of markdown links and stays one, and everything else is
      // `Error.constructor`, which is a code block on the page and would otherwise be the last
      // fence in the reference that is not an example.
      this.partials.typeAndParent = (model) => {
        if (!model) return "`void`";
        if (model instanceof ArrayType) {
          return `${this.partials.typeAndParent(model.elementType)}[]`;
        }
        const reflection =
          model instanceof ReferenceType && model.reflection
            ? model.reflection.variant === "signature"
              ? model.reflection.parent
              : model.reflection
            : null;
        if (reflection?.parent) {
          return [reflection.parent, reflection]
            .map((target) =>
              this.router.hasUrl(target)
                ? `[\`${target.name}\`](${this.urlTo(target)})`
                : `\`${target.name}\``,
            )
            .join(".");
        }
        return useCodeBlocks()
          ? block(text(String(model)), PROGRAM_CONTEXT)
          : `\`${String(model).replace(/[\r\n]+/g, " ")}\``;
      };
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
