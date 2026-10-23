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

const LINK_CLASS = "concorde-signature-link";

const MEMBER_CONTEXT = "type __ = {\n";

const PROGRAM_CONTEXT = "";

const INDENT = "  ";

const UNION_WIDTH = 70;

const WRAP_PARAMETERS_ABOVE = 2;

function text(value) {
  return { text: value, links: [] };
}

function anchor(value, href) {
  return href ? { text: value, links: [{ start: 0, end: value.length, href }] } : text(value);
}

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

function join(parts, separator) {
  const spaced = [];
  for (const part of parts) {
    if (spaced.length > 0) spaced.push(separator);
    spaced.push(part);
  }
  return concat(spaced);
}

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

function indented(fragment, prefix = INDENT) {
  return mapLines(fragment, (line, index) =>
    index === 0 || line.length === 0
      ? { text: line, offset: 0 }
      : { text: prefix + line, offset: prefix.length },
  );
}

function trimLineEnds(fragment) {
  return mapLines(fragment, (line) => ({ text: line.replace(/\s+$/, ""), offset: 0 }));
}

function pageHref(url) {
  if (!url || url.startsWith("#")) return url;
  const page = url.replace(/\.md(?=#|$)/, ".html");
  return /^[a-z][a-z0-9+.-]*:|^[./]/i.test(page) ? page : `./${page}`;
}

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

  return text(String(type));
}

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

function typeParameters(parameters) {
  return parameters?.length ? `<${parameters.map((parameter) => parameter.name).join(", ")}>` : "";
}

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

function parametersFragment(ctx, parameters, options) {
  const rendered = parameters.map((parameter) => parameterFragment(ctx, parameter));
  if (!options?.wrap || rendered.length <= WRAP_PARAMETERS_ABOVE) {
    return concat(["(", join(rendered, ", "), ")"]);
  }
  return concat([`(\n${INDENT}`, join(rendered, `,\n${INDENT}`), "\n)"]);
}

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
  const bar = `\n${INDENT}| `;
  const aligned = members.map((member) => indented(member, " ".repeat(bar.length - 1)));
  return concat([bar, join(aligned, bar)]);
}

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

function memberTypeFragment(ctx, member, options) {
  if (member.signatures?.length) {
    return reflectionTypeFragment(ctx, member, options);
  }
  const type = member.getSignature?.type ?? member.setSignature?.type ?? member.type;
  return someTypeFragment(ctx, type, options);
}

function declarationTypeFragment(ctx, model, options) {
  const shouldFormat = ctx.options.getValue("useCodeBlocks");
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

function memberNameFragment(ctx, member) {
  if (member.getSignature) return text(`get ${member.name}()`);
  if (member.setSignature) {
    const parameters = parametersFragment(ctx, member.setSignature.parameters ?? []);
    return concat([`set ${member.name}`, parameters]);
  }
  return text(`${member.name}${member.flags?.isOptional ? "?" : ""}`);
}

function declarationFragment(ctx, model) {
  const keyword = ctx.options.getValue("useCodeBlocks") ? ctx.helpers.getKeyword(model.kind) : "";
  const prefix = [reflectionFlags(model.flags), model.flags?.isRest ? "..." : "", keyword]
    .filter((word) => word && word.length > 0)
    .join(" ");
  const parts = prefix.length ? [`${prefix} `] : [];

  const name = model.originalName ?? model.name;

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

function isTopLevelSignature(ctx, model) {
  return Boolean(
    ctx.options.getValue("useCodeBlocks") &&
      model.parent &&
      ctx.helpers.isGroupKind(model.parent) &&
      ctx.helpers.getKeyword(model.parent.kind),
  );
}

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
      alwaysWrap: true,
      properties: { href: link.href, class: LINK_CLASS },
    })),
    transformers: [
      {
        name: "concorde:vitepress-code-block",
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

function contextClass(highlighter) {
  return class SignatureBlockContext extends MarkdownThemeContext {
    constructor(theme, page, options) {
      super(theme, page, options);

      const block = (fragment, context) =>
        codeBlockHtml(highlighter, trimLineEnds(fragment), context);

      const useCodeBlocks = () => this.options.getValue("useCodeBlocks");

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

export async function load(app) {
  const highlighter = await createHighlighter({
    themes: Object.values(shikiThemes),
    langs: ["typescript"],
  });
  const SignatureBlockContext = contextClass(highlighter);

  class SignatureBlockTheme extends MarkdownTheme {
    getRenderContext(page) {
      return new SignatureBlockContext(this, page, this.application.options);
    }
  }

  app.renderer.defineTheme("expanded-objects", SignatureBlockTheme);
}
