/**
 * Every route every component serves, as one JSON document, with no Gateway running.
 *
 * A route plugin declares its own `tags`, `summary`, `description`, parameters and response
 * schemas, and `@fastify/swagger` collects those declarations through an `onRoute` hook at
 * registration. So the document is obtainable by registering a plugin on a bare Fastify and asking
 * it: nothing calls a handler, so no Db, no Docker, no model and no network are involved.
 *
 * **One bare instance per plugin, not one per component.** Then no two plugins can collide on a
 * path, and the server a plugin belongs to is a property of the instance rather than something to
 * work out afterwards. A component with a plugin on each server is two entries below and one page.
 *
 * **No prefix is registered.** The paths come out relative to whatever a component's constructor
 * mounts the plugin under, which is what the page says they are. Registering the prefix here would
 * state the mount points in a second place, and the constructors are the first.
 *
 * **The plugins are listed rather than discovered, and the list is held against the source tree.**
 * They are not uniform: one argument or two or three, one plugin per component or two, each on the
 * Agent server or the Public server. A list is the only honest statement of that. `assertListIsWhole`
 * keeps it equal to the `src/<component>/routes.ts` files that exist, both ways, the same scan
 * `schema-extraction.ts` runs over the schema modules. It does not check that a listed plugin is the
 * whole of what that file exports, so a second plugin added to a module nobody adds here is the one
 * gap left.
 *
 * **The ports are stubs and the type checker is what makes them honest.** Every plugin takes a
 * structural operations port, which is what those types were for, so one Proxy satisfies all of
 * them. Nothing reads a port at registration time today; a plugin that started to would need a real
 * one here. The stubs are typed through `port`, so a plugin whose argument list changed fails
 * `npm run typecheck`. That is load-bearing rather than tidy: a plugin called with one argument too
 * few registers anyway, with every route present and its `preHandler` `undefined`, and the document
 * looks complete.
 */

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

/**
 * Which of the two servers a plugin goes on.
 *
 * The difference is the difference between what the agent can call and what a User's client can.
 * The Agent server has no authentication of any kind. The Public server has some on
 * almost every route, and which routes are the exception is in those routes' own descriptions.
 */
export type ServerName = "agent" | "public";

/**
 * One JSON Schema node, holding the fifteen keywords the framework's own routes use.
 *
 * Not the whole of JSON Schema, deliberately. Every keyword here is one
 * `scripts/reference/route-pages.ts` renders, and `assertNothingIsDropped` refuses a document
 * carrying any other, so the vocabulary of the pages and the vocabulary of the routes are held
 * equal. A route that starts declaring `format` fails the extraction with the name of the keyword
 * in the message, rather than rendering a page that is silent about the constraint.
 */
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

/** The keywords {@link SchemaNode} names, held against the document by `assertNothingIsDropped`. */
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

/** One query or path parameter of a route. */
export type ParameterDescription = {
  readonly name: string;
  /** `query` or `path`. Nothing in the framework declares a header or cookie parameter. */
  readonly in: string;
  readonly required: boolean;
  readonly description?: string | undefined;
  readonly schema?: SchemaNode | undefined;
};

/** One status a route can answer with, and the shape it answers with there. */
export type ResponseDescription = {
  /** `"200"`, `"401"` and so on, as the document keys them. */
  readonly status: string;
  readonly description: string;
  /** The media type, and absent on a status with no body at all, such as a 204. */
  readonly mediaType?: string | undefined;
  readonly schema?: SchemaNode | undefined;
};

/** What a route accepts in its body. */
export type RequestBodyDescription = {
  readonly required: boolean;
  readonly description?: string | undefined;
  readonly mediaType: string;
  readonly schema?: SchemaNode | undefined;
};

/** One route: the method, the relative path, and everything it declared about itself. */
export type RouteDescription = {
  /** Upper case, as a reader writes it: `GET`, `POST`, `PUT`, `DELETE`. */
  readonly method: string;
  /** Relative to the prefix the component's constructor registers the plugin under. */
  readonly path: string;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly tags: readonly string[];
  readonly parameters: readonly ParameterDescription[];
  readonly requestBody?: RequestBodyDescription | undefined;
  /** Ascending by status, so the success arrives before the refusals. */
  readonly responses: readonly ResponseDescription[];
};

/** One plugin's worth of routes, and the server it goes on. */
export type ServerRoutes = {
  readonly server: ServerName;
  readonly routes: readonly RouteDescription[];
};

/** One component's routes, keyed by the specifier a Developer imports the component from. */
export type ComponentRoutes = {
  /** The directory under `src`, which is also the subpath in the export map. */
  readonly subpath: string;
  /** The full import specifier, which is what the page is titled with. */
  readonly specifier: string;
  /** The Agent server first where a component serves both, because the agent's surface is older. */
  readonly servers: readonly ServerRoutes[];
};

/** What `npm run extract:routes` writes to stdout. */
export type RouteExtraction = {
  readonly components: readonly ComponentRoutes[];
};

/**
 * A stub for one operations port, typed by the plugin that takes it.
 *
 * Every method answers a resolved `undefined`, and none is ever called: registration reads the
 * route declarations and stops. The type argument is inferred from the parameter it is passed to,
 * which is the whole point. Written as a call rather than one shared constant so that each plugin's
 * port is checked against that plugin's own type.
 */
function port<T>(): T {
  return new Proxy({}, { get: () => async () => undefined }) as T;
}

/**
 * A stand-in for `publicServer.requireUser`, which is a hook rather than a port.
 *
 * The routes that take one declare their 401 in their own `response` block, so what this hook does
 * is invisible to the document. It has to be a real function because Fastify validates a route's
 * hooks at registration.
 */
const requireUser: preHandlerAsyncHookHandler = async () => {};

/** One entry per plugin: where its page goes, which server it is on, and the plugin itself. */
type ListedPlugin = {
  readonly subpath: string;
  readonly server: ServerName;
  readonly plugin: FastifyPluginAsync;
};

/**
 * Every route plugin the framework ships, constructed with its real arguments.
 *
 * Ordered by subpath, and the Agent server before the Public server within a subpath, because that
 * is the order the pages and the sidebar come out in.
 */
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

/**
 * The routes of every component that serves any, in the order the list above is written.
 *
 * @throws if the list has drifted from the source tree, if a plugin declared no route at all, or if
 * the document holds a `$ref` or a schema keyword the pages do not describe.
 */
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

/**
 * What one plugin declares, read off a bare Fastify it is the only thing registered on.
 *
 * The `info` block is required by `@fastify/swagger` and is thrown away: a page is titled with the
 * specifier, and the version a deployment's document declares belongs to the Gateway
 * (`describedVersion` in `src/gateway/gateway.ts`) rather than to this extraction.
 */
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
      `The ${listed.server} plugin of src/${listed.subpath}/routes.ts declared no route. A page ` +
        `for it would be complete-looking and empty, so this is a failure rather than a section ` +
        `left out.`,
    );
  }
  assertNothingIsHalfDescribed(listed, routes);
  // By path and then by method, so a page's bytes do not depend on the order the plugin happened
  // to declare its routes in.
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

/**
 * One entry per status, ascending, so the success is read before the refusals.
 *
 * Numeric rather than lexical, or a 400 would sort between a 200 and a 503.
 */
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

/**
 * The one media type a body or a response carries, or nothing where there is no body at all.
 *
 * Everything in the framework answers `application/json` and nothing negotiates, so a second entry
 * here would be a shape the pages describe with the wrong heading.
 */
function onlyMediaType(
  content: Record<string, MediaType>,
): [string | undefined, MediaType | undefined] {
  const entries = Object.entries(content);
  if (entries.length > 1) {
    throw new Error(
      `A route offers ${entries.length} media types (${entries.map(([name]) => name).join(", ")}). ` +
        `The pages name one per body, so add the section to scripts/reference/route-pages.ts.`,
    );
  }
  const first = entries[0];
  return first === undefined ? [undefined, undefined] : [first[0], first[1]];
}

/**
 * Refuses a route that would render as a heading with most of the page missing.
 *
 * A route arrives with `tags`, a `summary`, a `description` and a `response` schema per status it
 * can answer, or it arrives half-described, and until now nothing but review said so.
 * The generated page is where a half-described route becomes visible, and it becomes visible as an
 * absence, which is the shape of thing a reader does not notice.
 *
 * It is also what stands under the decision to add no per-page assertion to `check:docs` for these
 * pages. `describeResponses` reads `responses` off the document by name: a `@fastify/swagger` that
 * renamed that field would leave every route rendered with no status codes at all, and the page
 * would look finished. Read here, that is a failed generation naming the route.
 */
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
      `The ${listed.server} plugin of src/${listed.subpath}/routes.ts has a route the pages ` +
        `cannot describe, so its page would be a heading with the answer missing:`,
      ...half,
      `Either the route is half-described, or @fastify/swagger has renamed a field ` +
        `this extraction reads by name.`,
    ].join("\n"),
  );
}

/** Names in a sentence, where the reader takes them as a set and `and` is what English wants. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Refuses a document the pages cannot render honestly.
 *
 * Two things. A `$ref` anywhere: nothing resolves one, so it would print as a name pointing at a
 * definition no page carries. And a schema keyword {@link SchemaNode} does not name: a constraint
 * silently dropped leaves a page that is complete-looking and wrong about what the route accepts.
 * Both are read out of the raw document, because `app.swagger()` is typed as the OpenAPI shape
 * rather than as what the framework's own routes put in it.
 */
function assertNothingIsDropped(listed: ListedPlugin, document: OpenApiDocument): void {
  const dropped = new Set<string>();
  const refs: string[] = [];

  // Only the keywords holding further schemas are descended into, and each by name. A `default`
  // or an `example` is a value rather than a schema, and the keys under `properties` are property
  // names rather than keywords: walking either one generically reports the data as vocabulary.
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
      `The ${listed.server} plugin of src/${listed.subpath}/routes.ts declares things the route ` +
        `pages do not render, so its page would be complete-looking and wrong:`,
      ...refs.map((entry) => `  a reference nothing resolves: ${entry}`),
      ...(dropped.size === 0
        ? []
        : [`  schema keywords nothing describes: ${[...dropped].sort().join(", ")}`]),
      `Add them to SchemaNode and describedKeywords here, and to scripts/reference/route-pages.ts.`,
    ].join("\n"),
  );
}

/**
 * Holds the list above against `src`, both ways.
 *
 * The same scan `schema-extraction.ts` runs over the schema modules, for the same reason: a
 * component added later whose routes nobody lists is a component the reference does not describe.
 * It counts a `routes.ts` once however many plugins that file exports, so a **second** plugin added
 * to a listed module is not covered here and is the gap this leaves.
 */
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

/**
 * The part of an OpenAPI document these pages read, written out here.
 *
 * `app.swagger()` answers `OpenAPI.Document | OpenAPIV3.Document`, a union over two versions of the
 * specification whose every interesting field is optional or a `$ref` union. Reading it directly
 * would put a type guard on every access and describe nothing. This is what the framework's own
 * routes actually produce, and `assertNothingIsDropped` is what holds the document to it.
 */
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
