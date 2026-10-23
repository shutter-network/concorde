import { readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import fastifySwagger from "@fastify/swagger";
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import Fastify from "fastify";
import { agentDecisionRoutes, publicDecisionRoutes } from "../../src/decisions/routes.ts";
import { publicMessageRoutes } from "../../src/http-channel/routes.ts";
import { agentMessageRoutes } from "../../src/messenger/routes.ts";
import { passwordRoutes } from "../../src/password-auth/routes.ts";
import { scheduleRoutes } from "../../src/scheduler/routes.ts";
import { agentReadRoutes } from "../../src/signals/routes.ts";
import { agentSignatureRoutes, publicSignatureRoutes } from "../../src/signatures/routes.ts";
import { agentUserRoutes, publicUserRoutes } from "../../src/users/routes.ts";

export type ServerName = "agent" | "public";

export type SchemaNode = {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly required?: readonly string[];
  readonly items?: SchemaNode;
  readonly additionalProperties?: boolean | SchemaNode;
  readonly oneOf?: readonly SchemaNode[];
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly nullable?: boolean;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
};

const describedKeywords: readonly string[] = [
  "type",
  "description",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "oneOf",
  "enum",
  "default",
  "nullable",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
];

export type ParameterDescription = {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly description?: string | undefined;
  readonly schema?: SchemaNode | undefined;
};

export type ResponseDescription = {
  readonly status: string;
  readonly description: string;
  readonly mediaType?: string | undefined;
  readonly schema?: SchemaNode | undefined;
};

export type RequestBodyDescription = {
  readonly required: boolean;
  readonly description?: string | undefined;
  readonly mediaType: string;
  readonly schema?: SchemaNode | undefined;
};

export type RouteDescription = {
  readonly method: string;
  readonly path: string;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly tags: readonly string[];
  readonly parameters: readonly ParameterDescription[];
  readonly requestBody?: RequestBodyDescription | undefined;
  readonly responses: readonly ResponseDescription[];
};

export type ServerRoutes = {
  readonly server: ServerName;
  readonly routes: readonly RouteDescription[];
};

export type ComponentRoutes = {
  readonly subpath: string;
  readonly specifier: string;
  readonly servers: readonly ServerRoutes[];
};

export type RouteExtraction = {
  readonly components: readonly ComponentRoutes[];
};

function port<T>(): T {
  return new Proxy({}, { get: () => async () => undefined }) as T;
}

const requireUser: preHandlerAsyncHookHandler = async () => {};

type ListedPlugin = {
  readonly subpath: string;
  readonly server: ServerName;
  readonly plugin: FastifyPluginAsync;
};

const routePlugins: readonly ListedPlugin[] = [
  { subpath: "decisions", server: "agent", plugin: agentDecisionRoutes(port()) },
  { subpath: "decisions", server: "public", plugin: publicDecisionRoutes(port(), requireUser) },
  { subpath: "http-channel", server: "public", plugin: publicMessageRoutes(port(), requireUser) },
  { subpath: "messenger", server: "agent", plugin: agentMessageRoutes(port()) },
  { subpath: "password-auth", server: "public", plugin: passwordRoutes(port(), requireUser) },
  { subpath: "scheduler", server: "agent", plugin: scheduleRoutes(port()) },
  { subpath: "signals", server: "agent", plugin: agentReadRoutes(port()) },
  { subpath: "signatures", server: "agent", plugin: agentSignatureRoutes(port()) },
  {
    subpath: "signatures",
    server: "public",
    plugin: publicSignatureRoutes({ keys: [] }, port(), requireUser),
  },
  { subpath: "users", server: "agent", plugin: agentUserRoutes(port()) },
  { subpath: "users", server: "public", plugin: publicUserRoutes(requireUser) },
];

const packageName = "@shutter-network/concorde";

export async function extractRoutes(): Promise<RouteExtraction> {
  assertListIsWhole();

  const byComponent = new Map<string, ServerRoutes[]>();
  for (const listed of routePlugins) {
    const routes = await declaredRoutes(listed);
    const servers = byComponent.get(listed.subpath) ?? [];
    servers.push({ server: listed.server, routes });
    byComponent.set(listed.subpath, servers);
  }

  return {
    components: [...byComponent].map(([subpath, servers]) => ({
      subpath,
      specifier: `${packageName}/${subpath}`,
      servers,
    })),
  };
}

async function declaredRoutes(listed: ListedPlugin): Promise<readonly RouteDescription[]> {
  const app = Fastify();
  await app.register(fastifySwagger, {
    openapi: { openapi: "3.0.3", info: { title: listed.subpath, version: "0" } },
  });
  await app.register(listed.plugin);
  await app.ready();

  const document = app.swagger() as OpenApiDocument;
  assertNothingIsDropped(listed, document);

  const routes: RouteDescription[] = [];
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      routes.push(describeRoute(method, path, operation));
    }
  }
  if (routes.length === 0) {
    throw new Error(
      `No routes found in the ${listed.server} plugin of src/${listed.subpath}/routes.ts.`,
    );
  }
  assertNothingIsHalfDescribed(listed, routes);
  return routes.sort(
    (left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
  );
}

function describeRoute(method: string, path: string, operation: Operation): RouteDescription {
  return {
    method: method.toUpperCase(),
    path,
    summary: operation.summary,
    description: operation.description,
    tags: operation.tags ?? [],
    parameters: (operation.parameters ?? []).map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required ?? false,
      description: parameter.description,
      schema: parameter.schema,
    })),
    requestBody: describeBody(operation.requestBody),
    responses: describeResponses(operation.responses ?? {}),
  };
}

function describeBody(body: RequestBody | undefined): RequestBodyDescription | undefined {
  if (body === undefined) return undefined;
  const [mediaType, content] = onlyMediaType(body.content ?? {});
  return {
    required: body.required ?? false,
    description: body.description,
    mediaType: mediaType ?? "application/json",
    schema: content?.schema,
  };
}

function describeResponses(responses: Record<string, Response>): readonly ResponseDescription[] {
  return Object.entries(responses)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([status, response]) => {
      const [mediaType, content] = onlyMediaType(response.content ?? {});
      return {
        status,
        description: response.description ?? "",
        mediaType,
        schema: content?.schema,
      };
    });
}

function onlyMediaType(
  content: Record<string, MediaType>,
): [string | undefined, MediaType | undefined] {
  const entries = Object.entries(content);
  if (entries.length > 1) {
    throw new Error(
      `A route offers ${entries.length} media types (${entries.map(([name]) => name).join(", ")}). ` +
        `Add support for multiple media types in scripts/reference/route-pages.ts.`,
    );
  }
  const first = entries[0];
  return first === undefined ? [undefined, undefined] : [first[0], first[1]];
}

function assertNothingIsHalfDescribed(
  listed: ListedPlugin,
  routes: readonly RouteDescription[],
): void {
  const half = routes.flatMap((route) => {
    const missing = [
      ...(route.summary === undefined ? ["a summary"] : []),
      ...(route.description === undefined ? ["a description"] : []),
      ...(route.tags.length === 0 ? ["a tag"] : []),
      ...(route.responses.length === 0 ? ["any response at all"] : []),
    ];
    return missing.length === 0
      ? []
      : [`  ${route.method} ${route.path} declares no ${list(missing)}.`];
  });
  if (half.length === 0) return;

  throw new Error(
    [
      `Incomplete route documentation in the ${listed.server} plugin of src/${listed.subpath}/routes.ts:`,
      ...half,
      `Check the route schemas and the @fastify/swagger output fields.`,
    ].join("\n"),
  );
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function assertNothingIsDropped(listed: ListedPlugin, document: OpenApiDocument): void {
  const dropped = new Set<string>();
  const refs: string[] = [];

  const walk = (node: SchemaNode | undefined, where: string): void => {
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") refs.push(`${where} -> ${String(value)}`);
      else if (!describedKeywords.includes(key)) dropped.add(key);
    }
    for (const [name, child] of Object.entries(node.properties ?? {}))
      walk(child, `${where}.${name}`);
    walk(node.items, `${where}[]`);
    if (typeof node.additionalProperties === "object") {
      walk(node.additionalProperties, `${where}.*`);
    }
    for (const [index, branch] of (node.oneOf ?? []).entries()) walk(branch, `${where}|${index}`);
  };

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      const at = `${method.toUpperCase()} ${path}`;
      for (const parameter of operation.parameters ?? []) {
        walk(parameter.schema, `${at} parameter ${parameter.name}`);
      }
      for (const media of Object.values(operation.requestBody?.content ?? {})) {
        walk(media.schema, `${at} body`);
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const media of Object.values(response.content ?? {})) {
          walk(media.schema, `${at} ${status}`);
        }
      }
    }
  }

  const named = Object.keys(document.components?.schemas ?? {});
  if (named.length > 0) refs.push(`components.schemas: ${named.join(", ")}`);

  if (refs.length === 0 && dropped.size === 0) return;
  throw new Error(
    [
      `Unsupported route documentation in the ${listed.server} plugin of src/${listed.subpath}/routes.ts:`,
      ...refs.map((entry) => `  unresolved reference: ${entry}`),
      ...(dropped.size === 0
        ? []
        : [`  unsupported schema keywords: ${[...dropped].sort().join(", ")}`]),
      `Add them to SchemaNode and describedKeywords here, and to scripts/reference/route-pages.ts.`,
    ].join("\n"),
  );
}

function assertListIsWhole(): void {
  const source = fileURLToPath(new URL("../../src/", import.meta.url));
  const inSource = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.name === "routes.ts")
    .map((entry) => relative(source, entry.parentPath));

  const listed = [...new Set(routePlugins.map((entry) => entry.subpath))];
  const unlisted = inSource.filter((subpath) => !listed.includes(subpath)).sort();
  const gone = listed.filter((subpath) => !inSource.includes(subpath)).sort();
  if (unlisted.length === 0 && gone.length === 0) return;

  throw new Error(
    [
      `The route plugins listed in scripts/reference/route-extraction.ts disagree with src.`,
      ...unlisted.map((s) => `  src/${s}/routes.ts is not listed, so ${s} has no page.`),
      ...gone.map((s) => `  ${s} is listed but src/${s}/routes.ts is gone.`),
    ].join("\n"),
  );
}

type OpenApiDocument = {
  readonly paths?: Record<string, Record<string, Operation>>;
  readonly components?: { readonly schemas?: Record<string, unknown> };
};

type Operation = {
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: string;
    readonly required?: boolean;
    readonly description?: string;
    readonly schema?: SchemaNode;
  }[];
  readonly requestBody?: RequestBody;
  readonly responses?: Record<string, Response>;
};

type RequestBody = {
  readonly required?: boolean;
  readonly description?: string;
  readonly content?: Record<string, MediaType>;
};

type Response = {
  readonly description?: string;
  readonly content?: Record<string, MediaType>;
};

type MediaType = { readonly schema?: SchemaNode };
