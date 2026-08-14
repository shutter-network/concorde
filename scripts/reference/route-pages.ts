/**
 * One page per component that serves routes, written from the extracted declarations.
 *
 * The reader is the Developer who has deployed nothing. Every route arrives with the summary and
 * the description its plugin declares, word for word, because those sentences **are** the API
 * documentation and a paraphrase here would be a second wording to keep true. What a running
 * Gateway serves at `GET /openapi.json` and what this page says come out of the same declaration.
 *
 * **The two servers are separate sections.** The difference between them is the difference between
 * what the agent can call and what a User's client can, and the Agent server has no authentication
 * of any kind. A component with a plugin on each gets both sections on one page, because a page is
 * about a component.
 *
 * **Paths are relative and no page names a prefix.** The extraction registers none, so what is
 * printed is what the plugin declares, under whatever the constructor mounts it at. Naming the
 * prefix here would state the mount points in a second place.
 *
 * **A shape is a nested list rather than a flattened one.** A response is an envelope holding an
 * array of records, and a record holds an object with two spellings, so the reader needs the tree.
 * A markdown table cannot nest, which is why the table pages beside these use one and these do not.
 *
 * **Nothing here is authored and no page is ever edited.** `site/reference` is emptied on every
 * generation. A change to a page is a change to a route's `schema` block in its `routes.ts`.
 */

import { type PageSet, pageLink, type ReferencePage } from "./pages.ts";
import type {
  ComponentRoutes,
  ParameterDescription,
  RequestBodyDescription,
  ResponseDescription,
  RouteDescription,
  RouteExtraction,
  SchemaNode,
  ServerName,
  ServerRoutes,
} from "./route-extraction.ts";

/** The directory these pages live in under `site/reference`, and the first part of their URLs. */
const directory = "routes";

/** Every page, and the sidebar section that reaches them. */
export function routePages(extraction: RouteExtraction): PageSet {
  const pages: ReferencePage[] = extraction.components.map((component) => ({
    file: `${component.subpath}.md`,
    markdown: page(component),
  }));
  return {
    directory,
    pages,
    section: {
      text: "Routes",
      collapsed: true,
      items: extraction.components.map((component) => ({
        text: component.subpath,
        link: pageLink(directory, component.subpath),
      })),
    },
  };
}

/** What each server is, said once per page rather than once per route. */
const whatTheServerIs: Record<ServerName, string> = {
  agent: `**The Agent server has no authentication of any kind.** Everything below is reachable by the agent, and therefore by an injected prompt. Nothing on it names a credential.`,
  public: `**The Public server is what a User's client calls.** Which credential each route wants, and which wants none, is in that route's own description below.`,
};

function page(component: ComponentRoutes): string {
  return [
    // A title of its own, because the heading below is the specifier and both the component's
    // TypeScript API page and its table page carry the same one.
    //
    // Quoted, and `JSON.stringify` rather than a pair of `"` characters: the package is scoped, so
    // every specifier begins with `@`, which YAML reserves. Bare, the frontmatter does not parse
    // and the site build fails on the file rather than on the line.
    "---",
    `title: ${JSON.stringify(`${component.specifier} routes`)}`,
    "---",
    "",
    `# ${component.specifier}`,
    "",
    `The HTTP routes this component serves: ${howMany(component.servers)}.`,
    "",
    `**Every path is relative.** Each one is printed as the plugin declares it, under whatever ` +
      `prefix the component's constructor registers that plugin at. This page states no mount ` +
      `point, because the constructor is where the mount point is decided.`,
    "",
    `Generated from what the route plugins in \`src/${component.subpath}/routes.ts\` declare, ` +
      `which is what a running Gateway serves at \`GET /openapi.json\`. Never edited by hand.`,
    ...component.servers.flatMap((server) => serverSection(server)),
    "",
  ].join("\n");
}

/** How many routes on which server, as the sentence under the heading. */
function howMany(servers: readonly ServerRoutes[]): string {
  return list(
    servers.map(
      (server) =>
        `${server.routes.length} on the ${server.server === "agent" ? "Agent" : "Public"} server`,
    ),
  );
}

function serverSection(server: ServerRoutes): readonly string[] {
  return [
    "",
    `## ${server.server === "agent" ? "Agent" : "Public"} server`,
    "",
    whatTheServerIs[server.server],
    ...server.routes.flatMap((route) => ["", ...routeSection(route)]),
  ];
}

function routeSection(route: RouteDescription): readonly string[] {
  const lines = [`### \`${route.method} ${route.path}\``, ""];
  if (route.summary !== undefined) lines.push(`**${route.summary}**`, "");
  if (route.description !== undefined) lines.push(route.description, "");
  if (route.tags.length > 0) lines.push(`Tagged ${route.tags.map(code).join(", ")}.`, "");

  lines.push(...parameterSection("path", route.parameters));
  lines.push(...parameterSection("query", route.parameters));
  lines.push(...bodySection(route.requestBody));
  lines.push(...responseSection(route.responses));

  // The blank line every section above ends with, taken back off, so that one blank line
  // separates two routes wherever the last section happened to be.
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The path parameters or the query parameters, and nothing at all where a route takes none. */
function parameterSection(
  where: string,
  parameters: readonly ParameterDescription[],
): readonly string[] {
  const mine = parameters.filter((parameter) => parameter.in === where);
  if (mine.length === 0) return [];
  return [
    `**${where === "path" ? "Path" : "Query"} parameters**`,
    "",
    ...oneBlankAfter(
      mine.flatMap((parameter) =>
        field(
          parameter.name,
          parameter.schema ?? {},
          parameter.required,
          "",
          parameter.description,
        ),
      ),
    ),
  ];
}

function bodySection(body: RequestBodyDescription | undefined): readonly string[] {
  if (body === undefined) return [];
  return [
    "**Request body**",
    "",
    `${code(body.mediaType)}, ${body.required ? "required" : "optional"}.`,
    "",
    ...(body.description === undefined ? [] : [body.description, ""]),
    ...shape(body.schema),
  ];
}

/**
 * One block per status, ascending, each with the sentence saying what reaches it and the shape it
 * answers with.
 *
 * A status with no schema at all is a body-less answer, which is every 204 here, and it says so
 * rather than showing an empty list.
 */
function responseSection(responses: readonly ResponseDescription[]): readonly string[] {
  if (responses.length === 0) return [];
  return [
    "**Responses**",
    "",
    ...responses.flatMap((response) => [
      response.mediaType === undefined
        ? `**\`${response.status}\`** with no body`
        : `**\`${response.status}\`** ${code(response.mediaType)}`,
      "",
      ...(response.description === "" ? [] : [response.description, ""]),
      ...shape(response.schema),
    ]),
  ];
}

/**
 * One schema as an indented list, or the one line that says there is nothing to list.
 *
 * An object prints its properties. Anything else prints as a single unnamed line, which is what a
 * body that is a bare array or a bare string would be. Nothing in the framework declares one today.
 */
function shape(schema: SchemaNode | undefined): readonly string[] {
  if (schema === undefined) return [];
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0 && schema.oneOf === undefined) {
    return [`The body is ${summary(schema)}.`, ""];
  }
  return oneBlankAfter(members(schema, ""));
}

/**
 * A list of fields, closed with exactly one blank line however the last of them ended.
 *
 * A field carrying prose ends with a blank of its own, and two in a row would end the list on the
 * way to HTML and leave whatever followed outside it.
 */
function oneBlankAfter(lines: readonly string[]): readonly string[] {
  const trimmed = [...lines];
  while (trimmed.at(-1) === "") trimmed.pop();
  return [...trimmed, ""];
}

/**
 * The children of one schema, indented under whatever holds them.
 *
 * Three cases, and they compose: a `oneOf` prints one branch per option, an object prints its
 * properties, and an array prints the members of its items directly rather than through a line
 * saying "each item is an object". The array's own line already said `array of object`, so that
 * line would be the same sentence twice.
 */
function members(schema: SchemaNode, indent: string): readonly string[] {
  if (schema.oneOf !== undefined) {
    return schema.oneOf.flatMap((branch, index) => [
      `${indent}- **Option ${index + 1}:** ${summary(branch)}`,
      ...members(branch, `${indent}  `),
    ]);
  }
  if (schema.type === "array" && schema.items !== undefined) {
    return members(schema.items, indent);
  }
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).flatMap(([name, child]) =>
    field(name, child, required.has(name), indent),
  );
}

/**
 * One named field: its type, whether it is required, its constraints, its prose, and its children.
 *
 * The prose is indented two spaces past the bullet so that a description carrying a blank line
 * stays inside the list item rather than ending it. One of them does, on `typ` at `POST /sign`.
 */
function field(
  name: string,
  schema: SchemaNode,
  required: boolean,
  indent: string,
  override?: string,
): readonly string[] {
  const parts = [summary(schema), required ? "required" : "optional", ...constraints(schema)];
  const description = override ?? schema.description;
  return [
    `${indent}- **${code(name)}** ${parts.join(", ")}`,
    ...(description === undefined ? [] : prose(description, `${indent}  `)),
    ...members(schema, `${indent}  `),
  ];
}

/** A description under a bullet, indented so a blank line inside it does not end the item. */
function prose(description: string, indent: string): readonly string[] {
  return ["", ...description.split("\n").map((line) => (line === "" ? "" : indent + line)), ""];
}

/**
 * What a value is, in as few words as read as one.
 *
 * A schema with no `type` at all is an empty schema: it passes any JSON value through byte intact,
 * which is what `attributes` on a User and `data` on a Schedule are, and calling it `any JSON` is
 * the whole of what there is to say.
 */
function summary(schema: SchemaNode): string {
  const nullable = schema.nullable === true ? " or null" : "";
  if (schema.oneOf !== undefined) return `one of ${schema.oneOf.length} shapes${nullable}`;
  if (schema.type === "array") {
    return `array of ${schema.items === undefined ? "any JSON" : summary(schema.items)}${nullable}`;
  }
  if (schema.type === undefined) return `any JSON${nullable}`;
  const type = typeof schema.type === "string" ? schema.type : schema.type.join(" or ");
  return `${code(type)}${nullable}`;
}

/** Everything a schema says about a value beyond its type, each as one short phrase. */
function constraints(schema: SchemaNode): readonly string[] {
  const said: string[] = [];

  if (schema.enum !== undefined) {
    said.push(
      schema.enum.length === 1
        ? `always ${literal(schema.enum[0])}`
        : `one of ${schema.enum.map(literal).join(", ")}`,
    );
  }
  said.push(...range(schema.minimum, schema.maximum));
  said.push(...range(schema.minLength, schema.maxLength, "character"));
  if (schema.pattern !== undefined) said.push(`matching ${code(schema.pattern)}`);
  if (schema.default !== undefined) said.push(`default ${literal(schema.default)}`);
  // Said only where it is `false`, which is the case that refuses something. `true` is the
  // default of the specification and states nothing.
  if (schema.additionalProperties === false) said.push("no other properties");
  return said;
}

/**
 * A bound, both bounds or neither, as the phrase English wants for each.
 *
 * `noun` is what is being counted, where a bound counts something rather than being the value: a
 * length is `1 to 128 characters` and a number is `1 to 200`. It agrees with the number it follows,
 * so a `minLength` of one reads `at least 1 character`.
 */
function range(low?: number, high?: number, noun?: string): readonly string[] {
  const counted = (of: number) => (noun === undefined ? "" : ` ${noun}${of === 1 ? "" : "s"}`);
  if (low !== undefined && high !== undefined) return [`${low} to ${high}${counted(high)}`];
  if (low !== undefined) return [`at least ${low}${counted(low)}`];
  if (high !== undefined) return [`at most ${high}${counted(high)}`];
  return [];
}

/** A JSON value as it would be written in a request or read out of a response. */
function literal(value: unknown): string {
  return code(JSON.stringify(value) ?? "undefined");
}

function code(value: string): string {
  return `\`${value}\``;
}

/** Phrases in a sentence, where `and` is what English wants before the last of them. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
