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

const unsearchable =
  "Users cannot be searched or filtered. Attributes are arbitrary JSON that the Gateway cannot index, and a User has no natural key to match on.";

const rejectUnknownQuery = unknownQueryRefusal(unsearchable);

const credentialsAreNotInUrls =
  "This route takes no query parameters at all. A credential travels in the body or in the Authorization header, never in a URL.";

const rejectPublicQuery = unknownQueryRefusal(credentialsAreNotInUrls);

const capped = `${cappedLimit} There is no cursor and no offset, and nothing to narrow by. The Users past the cap are not reachable through this route.`;

const noPublicParameters = `${credentialsAreNotInUrls} ${unknownParameter}`;

const aQueryParameterWasWritten = "A query parameter was written, and this route takes none.";

const authenticationRequired =
  "**Requires authentication.** Present a credential of any scheme this deployment accepts, which is `Authorization: Bearer <token>` wherever the password login is registered. The User answered with is the one the Gateway authenticated, and no parameter anywhere names another.";

const userRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    attributes: {
      description:
        "Arbitrary JSON, defined by the deployment and interpreted by nothing in the Gateway. This is where grouping and therefore authorization live. Nothing on any HTTP surface writes them: a User is admitted from the Operator's own code, and `setAttributes` has no route anywhere.",
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
          summary: "Read Users, newest first",
          description: `Every User this Gateway has admitted, newest first. **These routes are reads.** There is no create here: an agent that could mint a User and give it a credential has minted itself an account, so admitting a User is the Operator's own code and has no route. ${unsearchable} ${capped} ${unknownParameter}`,
          querystring: {
            type: "object",
            properties: { limit: limitSchema },
            additionalProperties: false,
          },
          response: {
            200: { ...userListSchema, description: "The most recently created Users." },
            400: refused(
              "The `limit` is out of range or not an integer, or a parameter this route does not take was written.",
            ),
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
          summary: "Read one User by id",
          description: `One User, by the opaque id whoever admitted them was told. There is no email and no username to find one by. ${unsearchable} ${unknownParameter}`,
          params: idParams,
          response: {
            200: { ...userRecordSchema, description: "The User." },
            400: refused("The id in the path is not a uuid, or a query parameter was written."),
            404: refused("No User has that id."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        const user = await directory.get(request.params.id);
        if (user === undefined) return notFound(reply, "User", request.params.id);
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
          summary: "Read the authenticated User",
          description: `The User this request is acting as, in the same shape the agent's reads answer with. A client resuming after a restart recovers exactly what it was told. The Attributes governing this User's authorization are included. They are not hidden from the User they are about.\n\nIt echoes the authenticated User and reads nothing else, so it answers the same way whichever scheme this deployment authenticated the request with. ${authenticationRequired} ${noPublicParameters}`,
          response: {
            200: { ...userRecordSchema, description: "The User the Gateway authenticated." },
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
