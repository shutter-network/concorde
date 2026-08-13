/**
 * Two plugins, because they go on two Fastify instances and either can be left out. Neither
 * carries a prefix of its own, so every path they declare is relative to the prefix they are
 * registered under. The constructor's prefix is `/users` on both servers.
 *
 * The routes themselves are not listed here. `scripts/reference/route-pages.ts` renders them into
 * the reference out of the declarations below, so a table beside them would be a second list to
 * keep true and nothing would compare the two.
 *
 * **The agent's routes are reads and there is no create among them**
 * ([ADR-0052](../../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)).
 * `POST /users` was removed rather than stripped of its password parameter. Attributes are where
 * grouping and therefore authorization live
 * ([ADR-0008](../../docs/adr/0008-party-is-not-in-the-data-model.md)), the Agent server has no
 * authentication of any kind, and an injected prompt reaches everything on it
 * ([ADR-0003](../../docs/adr/0003-prompt-injection-is-an-accepted-risk.md)). An agent that could
 * mint a User **and** give it a credential has minted itself an account it can log in as. A User
 * is admitted from trusted code, which is `users.create` inside the Operator's own transaction. Do
 * not add the route back, and do not add a validator in front of one: there is nothing here to
 * bypass and nothing to configure.
 *
 * `GET /me` is the one Public route here, and it is here rather than under a scheme's prefix
 * because it only echoes `request.concordeUser`: whichever Auth named the User, the answer is the
 * same (ADR-0052). It takes the Public server's own composed hook, so this component authenticates
 * nobody.
 *
 * Each route's own `description` is what `/openapi.json` serves, so those strings are the API
 * documentation rather than commentary, and `docs/api-docs.md` governs them. A response schema is
 * a serializer as well: `fast-json-stringify` drops every field the schema does not declare, with
 * no warning anywhere, so `userRecordSchema` is a positive list and a column added to the table
 * cannot reach the wire through a field nobody thought of.
 */

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

/**
 * A User as every surface answers with one: both agent reads, and the authenticated User.
 *
 * `attributes` is arbitrary JSON that nothing in the Gateway interprets, and `createdAt` is ISO
 * 8601, JSON having no date. How a User authenticates is answered nowhere, on this shape or on any
 * other: that is an Auth's business and not this component's.
 */
export type UserRecord = {
  readonly id: string;
  readonly attributes: unknown;
  readonly createdAt: string;
};

/**
 * What the agent's routes need of the component: two reads and no table objects.
 *
 * There is no `create` here, because there is no route that creates one. Admitting a User is
 * trusted code's, on the caller's own transaction.
 */
export type UserOperations = {
  get(id: string): Promise<UserRecord | undefined>;
  list(options: { readonly limit: number }): Promise<UserRecord[]>;
};

// Said in the route descriptions below, and written once. The alternative is `?attributes=admin`
// quietly answering the newest fifty Users, which reads as though a filter had been applied.
const unsearchable =
  "Users cannot be searched or filtered. Attributes are arbitrary JSON that the Gateway cannot index, and a User has no natural key to match on.";

const rejectUnknownQuery = unknownQueryRefusal(unsearchable);

// A different sentence for the Public surface, because what is useful there is where a credential
// goes. A password or a Token in a URL is one in every access log between here and the client.
const credentialsAreNotInUrls =
  "This route takes no query parameters at all. A credential travels in the body or in the Authorization header, never in a URL.";

const rejectPublicQuery = unknownQueryRefusal(credentialsAreNotInUrls);

const capped = `${cappedLimit} There is no cursor and no offset, and nothing to narrow by. The Users past the cap are not reachable through this route.`;

const noPublicParameters = `${credentialsAreNotInUrls} ${unknownParameter}`;

// The whole of the 400 on the one Public route, which reads no body. A route with nothing to
// validate has nothing else to be refused for.
const aQueryParameterWasWritten = "A query parameter was written, and this route takes none.";

/**
 * What `GET /me` says about the credential it wants, and it names no scheme as the scheme.
 *
 * The other components' routes reach for `bearerRequired` in `route-conventions.ts`, which names
 * the Token and where one comes from. This route cannot: it is the one route in the framework that
 * is deliberately scheme-independent, so a sentence promising a Token would be wrong in a
 * deployment whose Users hold no password (ADR-0052).
 */
const authenticationRequired =
  "**Requires authentication.** Present a credential of any scheme this deployment accepts, which is `Authorization: Bearer <token>` wherever the password login is registered. The User answered with is the one the Gateway authenticated, and no parameter anywhere names another.";

// A positive list of the fields that can be answered. A column added to `concorde_users.users`
// reaches no response until somebody writes it here, and a field added to `UserRecord` and
// forgotten here is missing from every answer. The round trip in `gateway.test.ts` catches the
// second case.
const userRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    // No `type` at all, which is an empty schema. It passes any JSON value through byte intact
    // and renders in the document as "any".
    attributes: {
      description:
        "Arbitrary JSON, defined by the deployment and interpreted by nothing in the Gateway. This is where grouping and therefore authorization live. Nothing on any HTTP surface writes them: a User is admitted from the Operator's own code, and `setAttributes` has no route anywhere.",
    },
    createdAt: { type: "string" },
  },
  required: ["id", "attributes", "createdAt"],
} as const;

// A list answers in an envelope rather than as a bare array, as every component's does.
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
      // No query parameters at all on a single record, and one is refused rather than ignored.
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

/**
 * The augmentation is global: any `FastifyRequest` in a program importing this subpath has the
 * field, whether or not the program builds the component. The name is namespaced because
 * `@fastify/jwt` claims an unqualified `user`.
 *
 * It is not optional, though at runtime it is absent until a `requireUser` has run. The type cannot
 * express "set only after this hook ran", so a route that forgets the preHandler still type-checks
 * and reads `undefined`. Accepted, as everywhere else that Operator code is guidance rather than
 * construction ([ADR-0030](../../docs/adr/0030-passwords-are-traded-for-bearer-tokens.md)).
 */
declare module "fastify" {
  interface FastifyRequest {
    /**
     * The User this request acts as, assigned by the server's own `requireUser` and by nothing
     * else.
     *
     * Which scheme named them is not recorded here and is not a route's business: the Public
     * server walks every Auth registered with it and writes this property in one place, so a
     * handler reading it behaves the same under a password, a Nostr key or a scheme of the
     * Operator's own (ADR-0052).
     */
    concordeUser: UserRecord;
  }
}

/**
 * The Public server's one route: which User this request is acting as.
 *
 * `authenticated` is the server's own composed hook, taken as one route option and neither wrapped
 * nor extended, so the refusal here is the one every protected route on that server answers.
 */
export function publicUserRoutes(authenticated: preHandlerAsyncHookHandler): FastifyPluginAsync {
  return async (fastify) => {
    // The smallest possible consumer of the preHandler, and the same one an Operator takes. The
    // hook answers everything, and the handler is a property read.
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
