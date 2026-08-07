/**
 * Two plugins, because they go on two Fastify instances and either can be left out. Neither
 * carries a prefix of its own, so the paths below are relative to the prefix they are registered
 * under. The constructor's prefixes are `/users` and `/auth`.
 *
 * | Agent server | Answers |
 * | --- | --- |
 * | `POST /` | 201, the created `UserRecord`; 400 |
 * | `GET /?limit=` | `{ users: UserRecord[] }`, newest first; 400 |
 * | `GET /:id` | one `UserRecord`; 400; 404 |
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `POST /tokens` | 201, an `IssuedToken`. **No Token required**; 400; 401 |
 * | `GET /me` | the presented User; 400; 401 |
 * | `DELETE /tokens/current` | 204, the presented Token revoked; 400; 401 |
 * | `DELETE /tokens` | 204, every Token of the presented User revoked; 400; 401 |
 * | `PUT /password` | 204; 400; 401 |
 *
 * **Creating a User takes a password and takes no Attributes, and that is an absent capability
 * rather than a guard** ([ADR-0029](../../docs/adr/0029-users-are-a-part-of-their-own.md)).
 * Attributes are where grouping and therefore authorization live
 * ([ADR-0008](../../docs/adr/0008-party-is-not-in-the-data-model.md)), the Agent server has no
 * authentication of any kind, and an injected prompt reaches everything on it
 * ([ADR-0003](../../docs/adr/0003-prompt-injection-is-an-accepted-risk.md)). An agent able to
 * choose Attributes could create a User with an administrator's, give it a password and log in.
 * Do not add the parameter and do not add a validator in front of one: there is nothing here to
 * bypass and nothing to configure.
 *
 * `authenticationFailed` and `bearerRequired` are exported because Signatures, Decisions and the
 * HTTP Channel put this component's hook on routes of their own and describe it with these
 * sentences. A second sentence about one hook is a second thing to keep true.
 *
 * Each route's own `description` is what `/openapi.json` serves, so those strings are the API
 * documentation rather than commentary, and `docs/api-docs.md` governs them. A response schema is
 * a serializer as well: `fast-json-stringify` drops every field the schema does not declare, with
 * no warning anywhere, so `userRecordSchema` is a positive list and the password digest cannot
 * reach the wire through a field nobody thought of.
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
 * A User as every surface answers with one: both reads, the created record, and a login.
 *
 * `attributes` is arbitrary JSON that nothing in the Gateway interprets, and `createdAt` is ISO
 * 8601, JSON having no date. Whether a User has a password is answered nowhere, on this shape or
 * on any other.
 */
export type UserRecord = {
  readonly id: string;
  readonly attributes: unknown;
  readonly createdAt: string;
};

/**
 * What the agent's routes need of the component: three operations and no table objects.
 *
 * `create` takes one thing, an initial password, and there is no parameter for Attributes. It
 * takes no transaction either, a request that creates a User having one statement in it.
 */
export type UserOperations = {
  create(options: { readonly password?: string }): Promise<UserRecord>;
  get(id: string): Promise<UserRecord | undefined>;
  list(options: { readonly limit: number }): Promise<UserRecord[]>;
};

// `user` is the User's own opaque id, which is the only handle a User has. There is no email and
// no username anywhere in this framework: whoever admitted them told them the id.
export type Credentials = {
  readonly user: string;
  readonly password: string;
};

/**
 * What a login answers with: the Token, when it expires, and the User it belongs to.
 *
 * The User is embedded rather than referenced, so a client needs no second request to know who it
 * is.
 */
export type IssuedToken = {
  /** The Token, in the only response that will ever carry it. */
  readonly token: string;
  /** When it stops working, ISO 8601, from the lifetime this Gateway was built with. */
  readonly expiresAt: string;
  /** The User it belongs to, Attributes and all. */
  readonly user: UserRecord;
};

/**
 * `currentPassword` has no absent shape, and that is the line between self-service and account
 * recovery. The only replacement that proves nothing is trusted code's `setPassword`.
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
 * `logIn` answers `undefined` for every kind of failure and `changePassword` answers `false` for
 * every kind of its own, so a wrong password, an unknown User and a User with no password reach
 * the route as one value and there is no reason code for a route to leak.
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

// Said in three route descriptions and in the refusal below, and written once. The alternative is
// `?attributes=admin` quietly answering the newest fifty Users, which reads as though a filter had
// been applied.
const unsearchable =
  "Users cannot be searched or filtered. Attributes are arbitrary JSON that the Gateway cannot index, and a User has no natural key to match on.";

const rejectUnknownQuery = unknownQueryRefusal(unsearchable);

// A different sentence for the Public surface, because what is useful there is where a credential
// goes. A password or a Token in a URL is one in every access log between here and the client.
const credentialsAreNotInUrls =
  "The Public routes take no query parameters at all. A credential travels in the body or in the Authorization header, never in a URL.";

const rejectPublicQuery = unknownQueryRefusal(credentialsAreNotInUrls);

const capped = `${cappedLimit} There is no cursor and no offset, and nothing to narrow by. The Users past the cap are not reachable through this route.`;

const noPublicParameters = `${credentialsAreNotInUrls} ${unknownParameter}`;

/**
 * What every route that acts as somebody says about the Token it wants.
 *
 * A sentence per route rather than one in `info.description`. `POST /auth/tokens` is the
 * exception, and a reader must be told which route that is. Exported for the other components
 * whose routes take `requireUser`; see the file header.
 */
export const bearerRequired =
  "**Requires a bearer Token**, presented as `Authorization: Bearer <token>` and obtained from `POST /auth/tokens`. The User acted on is the one that Token names, and no parameter anywhere names another.";

/**
 * The one thing a 401 says, wherever it is answered.
 *
 * Every authentication failure is one status and one message. Enumeration is refused because
 * Attributes govern authorization and nothing rate limits the guessing. Exported for the reason
 * `bearerRequired` is.
 */
export const authenticationFailed =
  "Authentication failed, which is the whole of what is said: a wrong password, an id nobody holds, a User with no password, and a Token that is missing, malformed, unknown or expired are one status and one message, so nothing here answers who exists.";

// The whole of the 400 on the three Public routes that read no body. A route with nothing to
// validate has nothing else to be refused for.
const aQueryParameterWasWritten = "A query parameter was written, and these routes take none.";

// A positive list of the fields that can be answered. A column added to `saf_users.users` reaches
// no response until somebody writes it here, and a field added to `UserRecord` and forgotten here
// is missing from every answer. The round trip in `gateway.test.ts` catches the second case.
const userRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    // No `type` at all, which is an empty schema. It passes any JSON value through byte intact
    // and renders in the document as "any".
    attributes: {
      description:
        "Arbitrary JSON, defined by the deployment and interpreted by nothing in the Gateway. This is where grouping and therefore authorization live. A User created through this API always has `{}`: the route has no parameter through which anything else could arrive, so the column's default is the only thing that can decide.",
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

// The same force and the same hazard as the shape above. `expiresAt` carries a description because
// a client has to decide what to do at that moment; `token` carries none, when its plaintext
// exists being the route's story rather than the field's.
const issuedTokenSchema = {
  type: "object",
  properties: {
    token: { type: "string" },
    expiresAt: {
      type: "string",
      description:
        "When the Token stops working, ISO 8601. Always present: a Token that never expires is unrepresentable, and the lifetime is the Gateway's rather than the client's to choose. Nothing renews a Token and nothing reaps an expired one: it simply stops being accepted, and a client past this time logs in again.",
    },
    user: userRecordSchema,
  },
  required: ["token", "expiresAt", "user"],
} as const;

/**
 * A response that carries no body, which is `type: "null"` and not an empty object.
 *
 * Fastify's serializer answers an empty payload against this without a 500, and
 * `@fastify/swagger` emits a described response with no `content`, so no client waits for a body
 * to parse.
 */
function noBody(why: string) {
  return { type: "null", description: why };
}

// A bound rather than a policy. scrypt reads its whole input, so an unbounded password is
// unbounded memory-hard work on a route nothing rate limits. The number is far above any
// passphrase a person types.
const maxPasswordLength = 1024;

const passwordSchema = {
  type: "string",
  minLength: 1,
  maxLength: maxPasswordLength,
} as const;

// `null` is in the type list because a `POST` with no body creates a User with no password, and
// Fastify answers a missing body against an object-only schema with a 400.
//
// `additionalProperties: false` strips rather than refuses, Fastify's ajv being configured with
// `removeAdditional`. So an `attributes` field an agent was talked into posting reaches nothing.
const newUserSchema = {
  type: ["object", "null"],
  properties: { password: passwordSchema },
  additionalProperties: false,
} as const;

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

// The id is pattern-validated like an id in a path. PostgreSQL refuses to cast a malformed uuid,
// so an unvalidated one would be a 500 out of a typo. A well-formed id nobody holds gets the same
// 401 as a wrong password.
const credentialsSchema = {
  type: "object",
  properties: { user: idSchema, password: passwordSchema },
  required: ["user", "password"],
  additionalProperties: false,
} as const;

// No `user` field: the User is the presented one, read from the Token, so no request can change
// another User's password and no check can be got wrong. Both passwords carry the same bound,
// because scrypt reads both.
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
 * a missing header, a malformed one, an unknown Token and an expired one. The body is Fastify's
 * own error shape, so this surface answers one shape rather than two.
 */
export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .send({ statusCode: 401, error: "Unauthorized", message: "authentication failed" });
}

// `undefined` for every way it can fail. An unknown Token and an expired one arrive here as one
// value, so no route can leak a reason code.
export type TokenOperations = {
  authenticate(token: string): Promise<UserRecord | undefined>;
};

/**
 * The augmentation is global: any `FastifyRequest` in a program importing this subpath has the
 * field, whether or not the program builds the component. The name is namespaced because
 * `@fastify/jwt` claims an unqualified `user`.
 *
 * It is not optional, though at runtime it is absent until `requireUser` has run. The type cannot
 * express "set only after this hook ran", so a route that forgets the preHandler still type-checks
 * and reads `undefined`. Accepted, as everywhere else that Operator code is guidance rather than
 * construction ([ADR-0030](../../docs/adr/0030-passwords-are-traded-for-bearer-tokens.md)).
 */
declare module "fastify" {
  interface FastifyRequest {
    /** The User the presented Token belongs to, assigned by `users.requireUser`. */
    safUser: UserRecord;
  }
}

// The scheme is matched case-insensitively, because RFC 7235 says it is. Everything else is exact:
// one scheme, one space or more, and a credential with no whitespace in it.
function presentedToken(authorization: string | undefined): string | undefined {
  return /^Bearer +(\S+)$/i.exec(authorization ?? "")?.[1];
}

/**
 * The whole integration surface: an ordinary Fastify hook and not a plugin, so an Operator adds it
 * to a route of their own on either server and at any depth.
 *
 * The User is assigned by a plain property write rather than with `decorateRequest`. A decoration
 * is scoped to the plugin instance that made it, so escaping that scope means depending on
 * `fastify-plugin` and either surrendering route prefixes or re-implementing them. Do not convert
 * this to one. Every refusal is `unauthorized` and nothing else.
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
 * an ordinary Token through `issueToken`, and every other route in the Gateway is unchanged. That
 * is why there is no `Authenticator` interface here: an implementation of `verify(request)` still
 * has to answer where the credential lives, so the useful extension point is issuance
 * ([ADR-0030](../../docs/adr/0030-passwords-are-traded-for-bearer-tokens.md)).
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
