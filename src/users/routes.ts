/**
 * The User Manager's routes: Users on the Agent server, credentials on the Public one.
 *
 * Two plugins, because they go on two Fastify instances and either can be left out. Neither
 * carries a prefix of its own, so the paths below are relative to the prefix they are registered
 * under. The conventional prefixes are `/users` and `/auth`.
 *
 * | Agent server | Answers |
 * | --- | --- |
 * | `POST /` | the created `UserRecord`, 201 |
 * | `GET /?limit=` | `{ users: UserRecord[] }`, newest first |
 * | `GET /:id` | `UserRecord`, or 404 |
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `POST /tokens` | an `IssuedToken` (the Token, its expiry, the User), or 401 |
 * | `GET /me` | the presented User, or 401 |
 * | `DELETE /tokens/current` | 204, having revoked the Token that was presented |
 * | `DELETE /tokens` | 204, having revoked every Token of the presented User |
 * | `PUT /password` | 204, or the same 401 if the current password is wrong |
 *
 * Creating a User accepts a password and no Attributes. Attributes are where authorization lives,
 * so the route has no such parameter. There is no validator to bypass and no allow-list to
 * configure. The three routes that revoke and change are the only way a credential stops working
 * before it expires.
 *
 * Each route's own `description` is what `/openapi.json` serves, so those sentences are the API
 * documentation rather than commentary. The `UserRecord` schema is the sharpest of them. It lists
 * the fields that can be answered, so a field nobody thought of cannot reach the wire.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import {
  cappedLimit,
  idParams,
  idSchema,
  limitSchema,
  notFound,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";

/**
 * A User as the agent reads it, and the JSON these routes answer with.
 *
 * `attributes` is `unknown`, because it is arbitrary JSON the Gateway never interprets. What a
 * Signal Handler makes of it is the Handler's business. `createdAt` is an ISO 8601 string, because
 * JSON has no date.
 *
 * There is no field for the password. Whether a User has one is not something this surface answers.
 */
export type UserRecord = {
  readonly id: string;
  readonly attributes: unknown;
  readonly createdAt: string;
};

/**
 * What the agent's routes need of the User Manager: three operations, and no table objects.
 *
 * `create` takes one thing, an optional initial password. Attributes are what the agent may not
 * supply, and there is no parameter for them. It takes no transaction either, because a request
 * that creates a User has one statement in it.
 */
export type UserOperations = {
  create(options: { readonly password?: string }): Promise<UserRecord>;
  get(id: string): Promise<UserRecord | undefined>;
  list(options: { readonly limit: number }): Promise<UserRecord[]>;
};

/**
 * What a client presents at the login route.
 *
 * `user` is the User's own opaque id, which is the only handle a User has. There is no email and
 * no username anywhere in this framework. Whoever admitted them told them the id.
 */
export type Credentials = {
  readonly user: string;
  readonly password: string;
};

/**
 * What a login answers with: the Token, when it expires, and the User it belongs to.
 *
 * A client needs no second request to know who it is.
 */
export type IssuedToken = {
  /** The Token, in the only response that will ever carry it. */
  readonly token: string;
  /** When it stops working, ISO 8601, from the Manager's construction-time lifetime. */
  readonly expiresAt: string;
  /** The User it belongs to, including the Attributes governing their authorization. */
  readonly user: UserRecord;
};

/**
 * What a User changing their own password states: what they know, and what it becomes.
 *
 * `currentPassword` is required, and there is no shape of this type without it. That is the line
 * between self-service and account recovery. The only replacement that proves nothing is trusted
 * code's `setPassword`.
 *
 * `user` is not read from the body. The route fills it from the presented Token, so a caller
 * cannot name somebody else.
 */
export type PasswordChange = {
  readonly user: string;
  readonly currentPassword: string;
  readonly newPassword: string;
};

/**
 * What the Public routes need: a login, the two revocations, and a password change.
 *
 * `logIn` answers `undefined` for every kind of failure, and `changePassword` answers `false` for
 * every kind of its own. A wrong password, an unknown User and a User with no password reach the
 * route as one value. There is no reason code to leak.
 *
 * Both revocations answer nothing, not even a count. Revoking is idempotent: the row is gone
 * afterwards, whether or not this call removed it.
 */
export type CredentialOperations = {
  logIn(credentials: Credentials): Promise<IssuedToken | undefined>;
  revokeToken(token: string): Promise<void>;
  revokeTokens(user: string): Promise<void>;
  changePassword(change: PasswordChange): Promise<boolean>;
};

/**
 * What the agent's routes say about there being nothing to search by.
 *
 * Said in two places and written once. It ends the refusal below, and it is in all three Agent
 * route descriptions. A caller who assumed a filter finds out at the first request.
 */
const unsearchable =
  "Users cannot be searched or filtered. Attributes are arbitrary JSON that the Gateway cannot index, and a User has no natural key to match on.";

/** The refusal these routes answer an unknown query parameter with. */
const rejectUnknownQuery = unknownQueryRefusal(unsearchable);

/**
 * What the Public routes say about the same thing, which is a different sentence.
 *
 * What is useful on this surface is where a credential goes. A password or a Token in a URL is one
 * in every access log between here and the client.
 */
const credentialsAreNotInUrls =
  "The Public routes take no query parameters at all. A credential travels in the body or in the Authorization header, never in a URL.";

const rejectPublicQuery = unknownQueryRefusal(credentialsAreNotInUrls);

/** What the one list route here says about its `limit`: the shared sentences, and one more. */
const capped = `${cappedLimit} There is no cursor and no offset, and nothing to narrow by. The Users past the cap are not reachable through this route.`;

/** What every Public route's description ends with, the two sentences above as one. */
const noPublicParameters = `${credentialsAreNotInUrls} ${unknownParameter}`;

/**
 * What the four Public routes that act as somebody say about the Token they want.
 *
 * A sentence per route rather than one in `info.description`. `POST /auth/tokens` is the exception,
 * and a reader must be told which route that is.
 *
 * Exported for the HTTP Channel's Public routes, which take `requireUser` as one option of their
 * own. A second sentence about one hook is a second thing to keep true.
 */
export const bearerRequired =
  "**Requires a bearer Token**, presented as `Authorization: Bearer <token>` and obtained from `POST /auth/tokens`. The User acted on is the one that Token names, and no parameter anywhere names another.";

/**
 * The one thing a 401 says, wherever it is answered.
 *
 * Every authentication failure is one status and one message. Enumeration is refused because
 * Attributes govern authorization, and nothing rate limits the guessing.
 *
 * Exported for the reason `bearerRequired` above is. The HTTP Channel's Public routes are refused
 * by `unauthorized` too, because they take this component's hook.
 */
export const authenticationFailed =
  "Authentication failed, which is the whole of what is said: a wrong password, an id nobody holds, a User with no password, and a Token that is missing, malformed, unknown or expired are one status and one message, so nothing here answers who exists (ADR-0030).";

/**
 * What a Public route that reads no body is refused for.
 *
 * The whole of the 400 on the three of them. A route with nothing to validate has nothing else to
 * be refused for. Its own description says why it takes no parameters.
 */
const aQueryParameterWasWritten = "A query parameter was written, and these routes take none.";

/**
 * `UserRecord` on the wire, written as the fields that can be answered.
 *
 * Fastify compiles a response schema with `fast-json-stringify`. It answers with the properties it
 * declares and drops everything else without a word. So this is the second enforcement of the rule
 * `asUserRecord` holds by hand. The password hash is not on this wire, ever. A positive list cannot
 * be defeated by a field nobody thought of.
 *
 * A column added to `saf_users.users` reaches no response until somebody writes it here. A field
 * added to `UserRecord` and forgotten here is missing from every answer. The round trip in
 * `gateway.test.ts` catches that. The property description is on `attributes` alone.
 */
const userRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    // No `type` at all, which is an empty schema. It passes any JSON value through byte intact
    // and renders in the document as "any".
    attributes: {
      description:
        "Arbitrary JSON, defined by the deployment and interpreted by nothing in the Gateway. This is where grouping and therefore authorization live, since there is no Party entity (ADR-0008, ADR-0014). A User created through this API always has `{}`: the route has no parameter through which anything else could arrive, so the column's default is the only thing that can decide.",
    },
    createdAt: { type: "string" },
  },
  required: ["id", "attributes", "createdAt"],
} as const;

/** A list answers in an envelope rather than as a bare array, as every component's does. */
const userListSchema = {
  type: "object",
  properties: { users: { type: "array", items: userRecordSchema } },
  required: ["users"],
} as const;

/**
 * `IssuedToken` on the wire, with the same force and the same hazard as the shape above.
 *
 * The User is embedded rather than referenced, so a login answers everything a client needs.
 * `expiresAt` carries a description, because a client has to decide what to do at that moment.
 * `token` carries none: when its plaintext exists is the route's story rather than the field's.
 */
const issuedTokenSchema = {
  type: "object",
  properties: {
    token: { type: "string" },
    expiresAt: {
      type: "string",
      description:
        "When the Token stops working, ISO 8601. Always present: a Token that never expires is unrepresentable, and the lifetime is the Gateway's rather than the client's to choose. Nothing renews a Token and nothing reaps an expired one: it simply stops being accepted, and a client past this time logs in again (ADR-0030).",
    },
    user: userRecordSchema,
  },
  required: ["token", "expiresAt", "user"],
} as const;

/**
 * A response that carries no body, which is `type: "null"` and not an empty object.
 *
 * Fastify's serializer answers an empty payload against this without a 500. `@fastify/swagger`
 * emits a described response with no `content`, so no client waits for a body to parse.
 *
 * @param why What this status means, for the document.
 */
function noBody(why: string) {
  return { type: "null", description: why };
}

/**
 * The most a password can be, in characters. A bound rather than a policy.
 *
 * scrypt reads its whole input. So an unbounded password is unbounded memory-hard work, on a route
 * nothing rate limits. The number is far above any passphrase a person types.
 */
const maxPasswordLength = 1024;

const passwordSchema = {
  type: "string",
  minLength: 1,
  maxLength: maxPasswordLength,
} as const;

/**
 * The body of `POST /`: an optional initial password, and nothing else.
 *
 * `null` is in the type list because a `POST` with no body creates a User with no password.
 * Fastify answers a missing body against an object-only schema with a 400.
 *
 * `additionalProperties: false` strips rather than refuses, because Fastify's ajv is configured
 * with `removeAdditional`. So an `attributes` field an agent was talked into posting reaches
 * nothing.
 */
const newUserSchema = {
  type: ["object", "null"],
  properties: { password: passwordSchema },
  additionalProperties: false,
} as const;

/** The agent's User routes, over the operations above. */
export function agentUserRoutes(directory: UserOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { password?: string } | null }>(
      "/",
      // The body schema has one property, and it is the whole of what the agent may supply.
      // There is nothing here an attribute could arrive through, so the column's default decides.
      {
        schema: {
          tags: ["Users"],
          summary: "Create a User",
          description: `A User with an opaque Gateway-issued id and, optionally, a password they can log in with. Post no body at all to create a User with no password. Only the Operator's own trusted code can then give them a Token.\n\n**It accepts no Attributes, and there is no parameter for them.** Attributes are where grouping and therefore authorization live. This is an absent capability rather than a guard: there is nothing to bypass and nothing to configure. The created User's \`attributes\` is \`{}\`, because the column's default is the only thing that can decide. An \`attributes\` field written into the body is not refused either. It is stripped before the handler and reaches nothing. ${unknownParameter}`,
          body: newUserSchema,
          response: {
            201: {
              ...userRecordSchema,
              description:
                "The created User, and the only place their id is answered before somebody asks for it by that id.",
            },
            400: refused(
              `The \`password\` is empty or longer than ${maxPasswordLength} characters, or a query parameter was written.`,
            ),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        const password = request.body?.password;
        return reply
          .code(201)
          .send(await directory.create(password === undefined ? {} : { password }));
      },
    );

    fastify.get<{ Querystring: { limit: number } }>(
      "/",
      {
        schema: {
          tags: ["Users"],
          summary: "Read Users, newest first",
          description: `Every User this Gateway has admitted, newest first. ${unsearchable} ${capped} ${unknownParameter}`,
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
 * The body of `POST /tokens`: who is logging in, and what they know.
 *
 * The id is pattern-validated like an id in a path. PostgreSQL refuses to cast a malformed uuid,
 * so an unvalidated one would be a 500 out of a typo. A well-formed id nobody holds gets the same
 * 401 as a wrong password.
 */
const credentialsSchema = {
  type: "object",
  properties: { user: idSchema, password: passwordSchema },
  required: ["user", "password"],
  additionalProperties: false,
} as const;

/**
 * The body of `PUT /password`: what the caller knows, and what they want instead.
 *
 * There is no `user` field. The User is the presented one, read from the Token. No request can
 * change another User's password, and no check can be got wrong. Both passwords carry the same
 * bound, because scrypt reads both.
 */
const passwordChangeSchema = {
  type: "object",
  properties: { currentPassword: passwordSchema, newPassword: passwordSchema },
  required: ["currentPassword", "newPassword"],
  additionalProperties: false,
} as const;

/**
 * Answers the one 401 every authentication failure gets, whatever it was.
 *
 * A wrong password, a User that does not exist and a User with no password are one message. So are
 * a missing header, a malformed one, an unknown Token and an expired one. Nothing here answers who
 * exists.
 *
 * The body is Fastify's own error shape, so this surface answers one shape rather than two.
 */
export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .send({ statusCode: 401, error: "Unauthorized", message: "authentication failed" });
}

/**
 * What the preHandler needs of the User Manager: a Token in, a User or nothing out.
 *
 * `undefined` for every way it can fail. An unknown Token and an expired one arrive here as one
 * value, so no route can leak a reason code.
 */
export type TokenOperations = {
  authenticate(token: string): Promise<UserRecord | undefined>;
};

/**
 * The authenticated User, on the request, typed for every deployment.
 *
 * This augmentation is global. Any `FastifyRequest` in a program that imports this subpath has the
 * field, whether or not the program builds the Manager. The name is namespaced, because
 * `@fastify/jwt` claims an unqualified `user`.
 *
 * It is not optional, though at runtime it is absent until `requireUser` has run. The type cannot
 * express "set only after this hook ran". So a route that forgets the preHandler still type-checks
 * and reads `undefined`.
 */
declare module "fastify" {
  interface FastifyRequest {
    /**
     * The User the presented Token belongs to, assigned by `users.requireUser`.
     *
     * Present only on a route that took that preHandler. Reading it anywhere else reads
     * `undefined` with a type that says otherwise.
     */
    safUser: UserRecord;
  }
}

/**
 * `Authorization: Bearer <token>`, or nothing.
 *
 * The scheme is matched case-insensitively, because RFC 7235 says it is. Everything else is exact:
 * one scheme, one space or more, and a credential with no whitespace in it.
 */
function presentedToken(authorization: string | undefined): string | undefined {
  return /^Bearer +(\S+)$/i.exec(authorization ?? "")?.[1];
}

/**
 * Builds the preHandler that requires a Token: the whole integration surface.
 *
 * An ordinary Fastify hook rather than a plugin. An Operator adds it to a route of their own, on
 * either server and at any depth. The HTTP Channel does the same.
 *
 * The User is assigned by a plain property write rather than with `decorateRequest`. A decoration
 * is scoped to the plugin instance that made it, and a sibling plugin cannot see it. Every refusal
 * is `unauthorized` and nothing else.
 */
export function requireUser(directory: TokenOperations): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const presented = presentedToken(request.headers.authorization);
    const user = presented === undefined ? undefined : await directory.authenticate(presented);
    // Returning the reply is how an async hook says the lifecycle is over. Without it, Fastify
    // carries on to the handler after the 401 has been sent.
    if (user === undefined) return unauthorized(reply);
    request.safUser = user;
    return undefined;
  };
}

/**
 * The Public server's routes: the login, and nothing that is not about a credential.
 *
 * Registering neither this plugin nor a Public server is how a deployment replaces this
 * authentication with its own. An OIDC callback of the Operator's establishes identity and mints
 * an ordinary Token. Every other route in the Gateway is unchanged.
 */
export function publicUserRoutes(
  directory: CredentialOperations,
  presentedUser: preHandlerAsyncHookHandler,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: Credentials }>(
      "/tokens",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Trade a password for a Token",
          description: `A User's own opaque id and their password, for a bearer Token to present on everything else. **This response is the only place the Token's plaintext ever exists.** It is stored as a digest and cannot be read back. A client that loses it logs in again rather than recovering it.\n\nThis is the one Public route that requires no Token, and the one a client calls first. ${noPublicParameters}`,
          body: credentialsSchema,
          response: {
            201: {
              ...issuedTokenSchema,
              description:
                "The Token, when it stops working, and the User it belongs to, so that a client needs no second request to know who it is.",
            },
            400: refused(
              `The \`user\` is not a uuid, or a password is missing, empty or longer than ${maxPasswordLength} characters. A well-formed id nobody holds is a 401 and not a 400, since a 400 would answer who exists.`,
            ),
            401: refused(authenticationFailed),
          },
        },
        preValidation: rejectPublicQuery(),
      },
      async (request, reply) => {
        const issued = await directory.logIn(request.body);
        // A Token is a resource this created, so 201. This response is the only time its
        // plaintext exists anywhere.
        return issued === undefined ? unauthorized(reply) : reply.code(201).send(issued);
      },
    );

    // The smallest possible consumer of the preHandler, and the same one an Operator takes. The
    // hook answers everything, and the handler is a property read.
    fastify.get(
      "/me",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Read the presented User",
          description: `The User the presented Token belongs to, in the same shape the login answered with. A client resuming after a restart recovers exactly what it was told. The Attributes governing this User's authorization are included. They are not hidden from the User they are about. ${bearerRequired} ${noPublicParameters}`,
          response: {
            200: { ...userRecordSchema, description: "The User the presented Token names." },
            400: refused(aQueryParameterWasWritten),
            401: refused(authenticationFailed),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectPublicQuery(),
      },
      async (request) => request.safUser,
    );

    // Logging out. The presented Token stops working and no other one does. So a User can drop a
    // Token without ending the session they are in.
    fastify.delete(
      "/tokens/current",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Revoke the presented Token",
          description: `Logging out. The presented Token stops working, and no other Token of this User's does. So a Token on a device they no longer trust is droppable from a device they still use. Idempotent: the row is gone afterwards, whether or not this call removed it. ${bearerRequired} ${noPublicParameters}`,
          response: {
            204: noBody(
              "The Token no longer works. Nothing is answered, including how many Tokens there were: a count is a number about Tokens the caller does not hold.",
            ),
            400: refused(aQueryParameterWasWritten),
            401: refused(authenticationFailed),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectPublicQuery(),
      },
      async (request, reply) => {
        // The Token is re-read from the header rather than carried on the request. `requireUser`
        // has already run, so this is the same parse of the same string. A property beside
        // `safUser` would put a plaintext credential on every request in every deployment.
        const presented = presentedToken(request.headers.authorization);
        // Unreachable behind the preHandler, and the refusal is the one it would have given.
        if (presented === undefined) return unauthorized(reply);
        await directory.revokeToken(presented);
        // 204: there is nothing to answer with. This response is about the Token's absence.
        return reply.code(204).send();
      },
    );

    // The answer to "I think I have been compromised", and the only one there is. Nothing removes
    // a User, so every credential that stops working before it expires stops working here.
    fastify.delete(
      "/tokens",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Revoke every Token of the presented User",
          description: `The answer to "I think I have been compromised", and the only one there is. Nothing removes a User, so every credential that stops working before it expires stops working here. Every Token of the presented User goes, **including the one presented**, so the caller is logged out too. It is the only compaction a User has over their own row count, because nothing reaps an expired Token. ${bearerRequired} ${noPublicParameters}`,
          response: {
            204: noBody(
              "Every Token that User held, including the presented one, has stopped working.",
            ),
            400: refused(aQueryParameterWasWritten),
            401: refused(authenticationFailed),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectPublicQuery(),
      },
      async (request, reply) => {
        // The presented User's id, from the presented Token. The route has no parameter naming
        // a User, so a caller cannot write one.
        await directory.revokeTokens(request.safUser.id);
        return reply.code(204).send();
      },
    );

    // Rotating a credential without an Operator. A changed password revokes nothing. A User who
    // changed theirs out of fear is served by `DELETE /tokens`, one request away.
    fastify.put<{ Body: { currentPassword: string; newPassword: string } }>(
      "/password",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Replace the presented User's password",
          description: `A User rotating their own credential by proving they hold the current one. There is **no \`user\` field**: the User is the one the Token names. So no request can change another User's password, and there is no check to get wrong. There is no recovery path either. Proving identity *without* the credential is what this framework declined to build. A forgotten password is replaced by the Operator's own trusted code, or not at all.\n\nA changed password **revokes nothing**. A User who changed theirs out of fear is served by \`DELETE /auth/tokens\`, which is one request away. ${bearerRequired} ${noPublicParameters}`,
          body: passwordChangeSchema,
          response: {
            204: noBody(
              "The password is replaced. Every Token issued before it, the presented one included, still works.",
            ),
            400: refused(
              `A password is missing, empty or longer than ${maxPasswordLength} characters, or a query parameter was written. A \`user\` field in the body is not refused: it is stripped before the handler and reaches nothing.`,
            ),
            401: refused(authenticationFailed),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectPublicQuery(),
      },
      async (request, reply) => {
        const changed = await directory.changePassword({
          user: request.safUser.id,
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
        });
        // The same 401 a wrong password at the login route gets. It is the same failure: a
        // credential was presented and it was not right.
        return changed ? reply.code(204).send() : unauthorized(reply);
      },
    );
  };
}
