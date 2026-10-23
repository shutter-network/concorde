import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import {
  authenticationFailed,
  cappedLimit,
  idParams,
  limitSchema,
  notFound,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";

export type UserRecord = {
  readonly id: string;
  readonly attributes: unknown;
  readonly createdAt: string;
};

export type UserOperations = {
  get(id: string): Promise<UserRecord | undefined>;
  list(options: { readonly limit: number }): Promise<UserRecord[]>;
};

const unsearchable = "User search and attribute filters are not supported.";

const rejectUnknownQuery = unknownQueryRefusal(unsearchable);

const credentialsAreNotInUrls =
  "Query parameters are not accepted. Send credentials in the request body or Authorization header.";

const rejectPublicQuery = unknownQueryRefusal(credentialsAreNotInUrls);

const capped = `${cappedLimit} There is no paging or filtering. Users beyond the list limit require a lookup by id.`;

const noPublicParameters = `${credentialsAreNotInUrls} ${unknownParameter}`;

const aQueryParameterWasWritten = "Query parameters are not accepted.";

const authenticationRequired =
  "Requires a credential from an auth scheme installed in this deployment. Returns the authenticated user; there is no user selector.";

const userRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    attributes: {
      description:
        "Application-defined JSON. Built-in routes do not interpret attributes or enforce an attribute-based policy. Trusted application code updates them through setAttributes.",
    },
    createdAt: { type: "string" },
  },
  required: ["id", "attributes", "createdAt"],
} as const;

const userListSchema = {
  type: "object",
  properties: { users: { type: "array", items: userRecordSchema } },
  required: ["users"],
} as const;

export function agentUserRoutes(directory: UserOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: { limit: number } }>(
      "/",
      {
        schema: {
          tags: ["Users"],
          summary: "List users, newest first",
          description: `Lists existing users. User creation and credential management are available only through trusted application code. ${unsearchable} ${capped} ${unknownParameter}`,
          querystring: {
            type: "object",
            properties: { limit: limitSchema },
            additionalProperties: false,
          },
          response: {
            200: { ...userListSchema, description: "The most recently created users." },
            400: refused("Invalid limit or an unknown query parameter."),
          },
        },
        preValidation: rejectUnknownQuery("limit"),
      },
      async (request) => ({ users: await directory.list({ limit: request.query.limit }) }),
    );

    fastify.get<{ Params: { id: string } }>(
      "/:id",
      {
        schema: {
          tags: ["Users"],
          summary: "Read a user by id",
          description: `Looks up a user by UUID. ${unsearchable} ${unknownParameter}`,
          params: idParams,
          response: {
            200: { ...userRecordSchema, description: "The User." },
            400: refused("The id must be a UUID. Query parameters are not accepted."),
            404: refused("No user has this id."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        const user = await directory.get(request.params.id);
        if (user === undefined) return notFound(reply, "user", request.params.id);
        return user;
      },
    );
  };
}

declare module "fastify" {
  interface FastifyRequest {
    concordeUser: UserRecord;
  }
}

export function publicUserRoutes(authenticated: preHandlerAsyncHookHandler): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get(
      "/me",
      {
        schema: {
          tags: ["Users"],
          summary: "Read the authenticated user",
          description: `Returns the authenticated user, including their attributes, regardless of which auth scheme accepted the request. ${authenticationRequired} ${noPublicParameters}`,
          response: {
            200: { ...userRecordSchema, description: "The authenticated user." },
            400: refused(aQueryParameterWasWritten),
            401: refused(authenticationFailed),
          },
        },
        preHandler: authenticated,
        preValidation: rejectPublicQuery(),
      },
      async (request) => request.concordeUser,
    );
  };
}
