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

const directory = "routes";

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

const whatTheServerIs: Record<ServerName, string> = {
  agent: `**The Agent server has no authentication of any kind.** Everything below is reachable by the agent, and therefore by an injected prompt. Nothing on it names a credential.`,
  public: `**The Public server is what a User's client calls.** Which credential each route wants, and which wants none, is in that route's own description below.`,
};

function page(component: ComponentRoutes): string {
  return [
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

  while (lines.at(-1) === "") lines.pop();
  return lines;
}

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

function shape(schema: SchemaNode | undefined): readonly string[] {
  if (schema === undefined) return [];
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0 && schema.oneOf === undefined) {
    return [`The body is ${summary(schema)}.`, ""];
  }
  return oneBlankAfter(members(schema, ""));
}

function oneBlankAfter(lines: readonly string[]): readonly string[] {
  const trimmed = [...lines];
  while (trimmed.at(-1) === "") trimmed.pop();
  return [...trimmed, ""];
}

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

function prose(description: string, indent: string): readonly string[] {
  return ["", ...description.split("\n").map((line) => (line === "" ? "" : indent + line)), ""];
}

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
  if (schema.additionalProperties === false) said.push("no other properties");
  return said;
}

function range(low?: number, high?: number, noun?: string): readonly string[] {
  const counted = (of: number) => (noun === undefined ? "" : ` ${noun}${of === 1 ? "" : "s"}`);
  if (low !== undefined && high !== undefined) return [`${low} to ${high}${counted(high)}`];
  if (low !== undefined) return [`at least ${low}${counted(low)}`];
  if (high !== undefined) return [`at most ${high}${counted(high)}`];
  return [];
}

function literal(value: unknown): string {
  return code(JSON.stringify(value) ?? "undefined");
}

function code(value: string): string {
  return `\`${value}\``;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
