/**
 * The User Manager's contributions to the two servers: creating and reading Users
 * on the Agent server, and trading a password for a Token on the Public one.
 *
 * Two plugins and not one, because they are registered on different Fastify
 * instances listening on different addresses, and because either may be left out:
 * a deployment where the agent must not create Users does not register the Agent
 * plugin, and one replacing password authentication with its own scheme does not
 * register the Public plugin (ADR-0021, ADR-0030).
 *
 * Both carry **no prefix of their own**, exactly as the Signal Worker's routes do: the
 * Operator registers each where they want it, and there is no plugin contract of ours
 * for either to satisfy (ADR-0021). Every path below is therefore relative, which is
 * why the Agent plugin's paths name no resource at all: under the conventional
 * `/users` they are `POST /users`, `GET /users` and `GET /users/:id`, and the Public
 * plugin's one path under the conventional `/auth` is `POST /auth/tokens`.
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
 * The three that revoke and change are smaller than they look and matter more than
 * they look. Nothing removes a User (ADR-0029), so there is no delete to cascade from
 * and no flag to flip: **these are the only mechanism anywhere in the system by which
 * a credential stops working before it expires**, and `DELETE /tokens` is the whole of
 * the answer to "I think I have been compromised". It is also the only compaction a
 * User has over their own row count, since nothing reaps expired Tokens either
 * (ADR-0030).
 *
 * **Creating a User accepts a password and no Attributes, and that is the security
 * boundary of the whole part.** Attributes are where grouping and therefore
 * authorization live (ADR-0008, ADR-0014), so an agent that could choose them could
 * mint itself an administrator, and ADR-0003 accepts that a hostile User may steer
 * the agent, while the Agent server has no authentication at all (ADR-0010). Note how
 * it is refused: the route has **no such parameter**, so there is no validator to
 * bypass, no allow-list to configure, and nothing to get wrong. It is an absent
 * capability and not a guard.
 *
 * What is missing from the tables is missing on purpose. There is **no delete and no
 * deactivation**: nothing removes a User (ADR-0029). Setting Attributes, replacing a
 * password and issuing a Token to somebody who proved nothing are **methods and not
 * routes**, reachable from the Operator's own trusted code and from nothing the agent
 * can call.
 *
 * The capped limit, the envelope, the pattern-validated id, the refusal of an
 * unknown query parameter and the 404 body are the conventions in
 * `route-conventions.ts` that every part's routes share; only the sentence a refusal
 * ends with is this part's.
 *
 * Every route also **describes what it answers with**, which is how a person writing a
 * client learns the shape of an issued Token and which routes want it presented, and how
 * an Agent Implementation learns that creating a User has nowhere for Attributes to
 * arrive through, without either of them being told by hand
 * ([ADR-0040](../../docs/adr/0040-the-gateway-describes-its-own-http-api.md)). The
 * sentences below are load-bearing prose rather than commentary: they are what
 * `/openapi.json` serves. **The `UserRecord` schema is the sharpest of them**, because a
 * response schema is a serializer and this is the one record in the framework with a
 * field that must never reach a wire. So it is written as the list of fields that may be
 * answered rather than as an exclusion of the one that may not, and `asUserRecord`'s
 * hand-written projection gains a second, independent enforcement underneath it.
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
 * `attributes` is `unknown` because it is arbitrary JSON the Gateway never
 * interprets and cannot meaningfully index (ADR-0014); what a Signal Handler makes
 * of it is the Handler's. `createdAt` is an ISO 8601 string because JSON has no
 * date. There is deliberately no field for the password: whether a User has one is
 * not something the agent's surface answers.
 */
export type UserRecord = {
  readonly id: string;
  readonly attributes: unknown;
  readonly createdAt: string;
};

/**
 * What the agent's routes need of the User Manager, and no more: three operations
 * over the part's own handle, with no Db and no table objects.
 *
 * `create` takes one thing, an optional initial password, and there is no second
 * parameter waiting to be added: Attributes are what the agent may not supply, and
 * absence is how that is enforced. Note that it is also transaction-less, where the
 * Manager's own `create` takes one (ADR-0023): a request that creates a User has
 * one statement in it and nothing to keep that statement with, while an Operator
 * creating a User has their own tables to keep it with.
 */
export type UserOperations = {
  create(options: { readonly password?: string }): Promise<UserRecord>;
  get(id: string): Promise<UserRecord | undefined>;
  list(options: { readonly limit: number }): Promise<UserRecord[]>;
};

/**
 * What a client presents at the login route.
 *
 * `user` is the User's own opaque id, because that is the only handle a User has:
 * there is no email and no username anywhere in this framework (ADR-0014), and
 * whoever admitted them told them the id.
 */
export type Credentials = {
  readonly user: string;
  readonly password: string;
};

/**
 * What a login answers with: everything a client needs to make its next request and
 * to know who it is, so that it needs no second one.
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
 * What a User changing their own password states: who they are, what they know, and
 * what it becomes.
 *
 * `currentPassword` is required and there is no shape of this type without it. That is
 * the line between self-service and account recovery: recovery means proving identity
 * *without* the credential, which ADR-0014 declined to build and ADR-0030 reaffirms,
 * so the only replacement that does not prove possession is trusted code's
 * (ADR-0029). `user` is not read from the body — the route fills it from the presented
 * Token, so a caller cannot name somebody else.
 */
export type PasswordChange = {
  readonly user: string;
  readonly currentPassword: string;
  readonly newPassword: string;
};

/**
 * What the Public routes need of the User Manager: a login, the two revocations, and
 * a password change.
 *
 * `logIn` answers `undefined` for **every** kind of failure and `changePassword`
 * answers `false` for every kind of its own, and that they are not distinguished here
 * rather than at the route is the point. There is no reason code to accidentally
 * answer with, so a wrong password, an unknown User and a User with no password reach
 * the route as the same value and leave it as the same response (ADR-0030).
 *
 * Both revocations answer nothing at all, including how many Tokens there were. A
 * count is a number a client could learn about sessions it does not hold, and the
 * request succeeded either way: revoking is idempotent because the row is gone
 * afterwards, whether or not this call is what removed it.
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
 * It says it outright because the alternative, `?attributes[role]=admin` quietly
 * returning every User, reads as though a filter had been applied. Said in two places
 * and written once: it is how the refusal below ends, and it is in the description of
 * all three Agent server routes, so the sentence a caller is refused with and the
 * sentence the document carries cannot come apart.
 */
const unsearchable =
  "Users cannot be searched or filtered: Attributes are arbitrary JSON the Gateway cannot meaningfully index, and a User has no natural key to match on (ADR-0014).";

/**
 * The refusal these routes answer an unknown query parameter with.
 *
 * The convention and its reasoning are in `route-conventions.ts`; the sentence the
 * message ends with is this part's.
 */
const rejectUnknownQuery = unknownQueryRefusal(unsearchable);

/**
 * What the Public routes say about the same thing, which is a different sentence.
 *
 * The useful thing to say on this surface is where a credential goes: a password or a
 * Token in a URL is a password or a Token in every access log and every browser history
 * between here and the client.
 */
const credentialsAreNotInUrls =
  "The Public routes take no query parameters at all: a credential travels in the body or in the Authorization header, never in a URL.";

const rejectPublicQuery = unknownQueryRefusal(credentialsAreNotInUrls);

/**
 * What the one list route here says about its `limit`: the shared two sentences, and the
 * one this part adds.
 *
 * The sentence the Signal Worker adds is that the records past the cap are reachable by
 * narrowing; this route offers nothing to narrow *by*, which follows from the sentence
 * above it, so the honest thing to say is that they are not reachable at all.
 */
const capped = `${cappedLimit} There is no cursor, no offset and nothing to narrow by, so the Users past the cap are not reachable through this route.`;

/** What every Public route's description ends with, the two sentences above as one. */
const noPublicParameters = `${credentialsAreNotInUrls} ${unknownParameter}`;

/**
 * What the four Public routes that act as somebody say about the Token they want.
 *
 * The whole of the answer to "which routes require a bearer Token", and the reason it is
 * a sentence per route rather than one in `info.description`: `POST /auth/tokens` is the
 * one that does not, and a reader who has to work out which route is the exception has
 * been told nothing.
 */
const bearerRequired =
  "**Requires a bearer Token**, presented as `Authorization: Bearer <token>` and obtained from `POST /auth/tokens`. The User acted on is the one that Token names, and no parameter anywhere names another.";

/**
 * The one thing a 401 says, wherever it is answered.
 *
 * A wrong password, an id nobody holds, a User with no password at all, a missing
 * `Authorization` header, a header in another scheme, a Token that was never issued and
 * one that has expired are **one status and one message**. Enumeration is worth refusing
 * because Attributes govern authorization, so learning that an id names somebody is
 * learning where to point the guessing that nothing rate limits (ADR-0030).
 */
const authenticationFailed =
  "Authentication failed, which is the whole of what is said: a wrong password, an id nobody holds, a User with no password, and a Token that is missing, malformed, unknown or expired are one status and one message, so nothing here answers who exists (ADR-0030).";

/**
 * What a Public route that reads no body is refused for.
 *
 * The whole of the 400 on the three of them, since a route with nothing to validate has
 * nothing else to be refused for. It does not repeat *why* they take none: the route's
 * own description carries that sentence already.
 */
const aQueryParameterWasWritten = "A query parameter was written, and these routes take none.";

/**
 * `UserRecord` on the wire, written as **the fields that may be answered**.
 *
 * A response schema is a serializer: Fastify compiles it with `fast-json-stringify`,
 * which answers with the properties it declares and drops everything else without a word
 * ([ADR-0040](../../docs/adr/0040-the-gateway-describes-its-own-http-api.md)). That makes
 * this the second, independent enforcement of the rule `asUserRecord` holds by hand with
 * the comment *"the password hash is not on this wire, ever"*. The reason it is a
 * positive list rather than a `passwordHash: false` of some kind is that a positive list
 * cannot be defeated by a field nobody thought of. A column added to `saf_users.users`
 * reaches no response until somebody writes it here.
 *
 * The direction that costs something is the other one, and it is why
 * `default-gateway.test.ts` reads a User the Manager actually created and compares the
 * whole body: a field added to `UserRecord` and forgotten here is silently missing from
 * every answer, and a comparison of one HTTP response against another would not see it.
 *
 * The property description is on `attributes` alone. `id` and `createdAt` are their own
 * whole story; what an Attribute *is* is not.
 */
const userRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    // No `type` at all, which is an empty schema: it passes any JSON value through byte
    // intact and renders in the document as "any". A shape here would be the Gateway
    // having an opinion about Attributes it has spent five ADRs declining to have.
    attributes: {
      description:
        "Arbitrary JSON, defined by the deployment and interpreted by nothing in the Gateway. This is where grouping and therefore authorization live, since there is no Party entity (ADR-0008, ADR-0014). A User created through this API always has `{}`: the route has no parameter through which anything else could arrive, so the column's default is the only thing that can decide.",
    },
    createdAt: { type: "string" },
  },
  required: ["id", "attributes", "createdAt"],
} as const;

/** A list answers in an envelope rather than as a bare array, the convention every part's does. */
const userListSchema = {
  type: "object",
  properties: { users: { type: "array", items: userRecordSchema } },
  required: ["users"],
} as const;

/**
 * `IssuedToken` on the wire, with the same force and the same hazard as the shape above.
 *
 * The User is embedded rather than referenced, which is the login answering everything a
 * client needs to make its next request and to know who it is. `expiresAt` carries a
 * description because a client has to decide what to do at that moment and the field name
 * does not say; `token` does not, because what it is worth knowing about the Token is
 * *when* it exists, and that belongs to the route rather than to the field.
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
 * The spelling matters twice over. It is what Fastify's serializer answers an empty
 * payload against without a 500, and it is what makes `@fastify/swagger` emit a described
 * response with **no `content` at all**, where an empty object schema would document a
 * JSON body a client then waits to parse. Measured against `@fastify/swagger` 9.8.1, as
 * everything else in ADR-0040 was.
 */
function noBody(why: string) {
  return { type: "null", description: why };
}

/**
 * The most a password may be, in characters.
 *
 * A bound and not a policy: nothing here has an opinion about what a good password
 * is. scrypt reads its whole input, so an unbounded one is an unbounded amount of
 * memory-hard work per request, on a route nothing rate limits (ADR-0030). The number
 * is far above any passphrase a person types.
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
 * `null` is in the type list because a `POST` with no body at all is how a User with
 * no password is created, and Fastify answers a missing body against an
 * object-only schema with a 400. What `additionalProperties: false` does here is
 * **strip** rather than refuse, because Fastify's ajv is configured with
 * `removeAdditional`, which is exactly what is wanted for this one route: an
 * `attributes` field posted by an agent that was talked into it is not an error to
 * report back, it is a field that reaches nothing.
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
      // The body schema has one property, and it is the whole of what the agent may
      // supply. That is the absent capability: there is nothing here an attribute
      // could arrive through, so the column's default decides and the created User
      // has none, with no validator to bypass and no allow-list to configure.
      {
        schema: {
          tags: ["Users"],
          summary: "Create a User",
          description: `A User with an opaque Gateway-issued id and, optionally, a password they can log in with. Post no body at all to create one with no password, who can then be given a Token only by the Operator's own trusted code.\n\n**It accepts no Attributes, and there is no parameter for them.** Attributes are where grouping and therefore authorization live (ADR-0008, ADR-0014), so this is an absent capability and not a guard: nothing here to bypass, nothing to configure, and the created User's \`attributes\` is \`{}\` because the column's default is the only thing that can decide. An \`attributes\` field written into the body is not refused either: it is stripped before the handler and reaches nothing. ${unknownParameter}`,
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
      // No query parameters at all on a single record, and asking for one is refused
      // rather than ignored — the same reason the list route refuses.
      {
        schema: {
          tags: ["Users"],
          summary: "Read one User by id",
          description: `One User, by the opaque id whoever admitted them was told: there is no email and no username to find one by. ${unsearchable} ${unknownParameter}`,
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
 * The id is pattern-validated like an id in a path, and for the same reason:
 * PostgreSQL refuses to cast a malformed uuid, so an unvalidated one would be a 500
 * out of a typo. It tells a caller nothing about who exists: a well-formed id nobody
 * holds gets the same 401 as a wrong password.
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
 * There is **no `user` field**, and its absence is the same kind of decision the
 * missing `attributes` on `POST /users` is: the User is the presented one, read from
 * the Token, so there is no parameter through which one User could change another's
 * password and therefore no check that could be got wrong. Both passwords carry the
 * same bound, because both are read by scrypt.
 */
const passwordChangeSchema = {
  type: "object",
  properties: { currentPassword: passwordSchema, newPassword: passwordSchema },
  required: ["currentPassword", "newPassword"],
  additionalProperties: false,
} as const;

/**
 * The one answer every authentication failure gets, whatever it was.
 *
 * One status and one message: a wrong password, a User that does not exist, a User
 * whose password hash is null, and, once a Token can be presented, a missing header,
 * a malformed one, an unknown Token and an expired one. Enumeration is worth refusing
 * here because Attributes govern authorization, so learning that an id names somebody
 * is learning where to point the guessing that nothing rate limits (ADR-0030).
 *
 * The body is Fastify's own error shape, so this surface answers one shape rather
 * than two.
 */
export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .send({ statusCode: 401, error: "Unauthorized", message: "authentication failed" });
}

/**
 * What the preHandler needs of the User Manager: a Token in, a User or nothing out.
 *
 * `undefined` for every way it can fail, for the reason `CredentialOperations` answers
 * `undefined` for every way a login can: an unknown Token and an expired one arrive
 * here as the same value, so there is no reason code for a route to leak by accident.
 */
export type TokenOperations = {
  authenticate(token: string): Promise<UserRecord | undefined>;
};

/**
 * The authenticated User, on the request, typed for every deployment.
 *
 * This augmentation is **global**: it is shipped in the package, so a
 * `FastifyRequest` anywhere in a program that imports this subpath has the field,
 * whether or not that program constructs the Manager. That is the cost of typing a
 * request property at all, and it is accepted in ADR-0030; the name is namespaced
 * because an unqualified `user` is what `@fastify/jwt` claims, and a collision between
 * two Fastify decorators is a boot failure rather than a runtime one.
 *
 * It is **not optional**, though at runtime it is absent until `requireUser` has run.
 * The type cannot express "set only after this hook ran", and the alternative —
 * `safUser?: UserRecord` — would make every authenticated handler narrow a value the
 * hook guarantees, to guard against a mistake the type could not catch either way. So
 * a route that forgets the preHandler still type-checks and reads `undefined` at
 * runtime; what that does is pinned by a test rather than assumed.
 */
declare module "fastify" {
  interface FastifyRequest {
    /**
     * The User the presented Token belongs to, assigned by `users.requireUser`.
     *
     * Present only on a route that took that preHandler. Reading it anywhere else is
     * reading `undefined` with a type that says otherwise.
     */
    safUser: UserRecord;
  }
}

/**
 * `Authorization: Bearer <token>`, or nothing.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is
 * case-insensitive, and a client that sends `bearer` is not a client to refuse over
 * spelling. Everything else is exact: one scheme, one space or more, and a credential
 * with no whitespace in it, which every Token this framework mints satisfies.
 */
function presentedToken(authorization: string | undefined): string | undefined {
  return /^Bearer +(\S+)$/i.exec(authorization ?? "")?.[1];
}

/**
 * Builds the preHandler: the whole integration surface, and one option on a route.
 *
 * It is an ordinary Fastify hook and not a plugin, so an Operator adds it to a route
 * of their own — on either server, inside any plugin, at any depth — without
 * registering anything of ours, and the HTTP Messenger does exactly the same.
 *
 * The User is **assigned by a plain property write** rather than declared with
 * `decorateRequest`, and that is the design and not a shortcut (ADR-0030). A
 * decoration is scoped to the plugin instance that made it, so making it visible to a
 * *sibling* plugin — which is what an Operator's routes and the HTTP Messenger's both are —
 * would mean marking our plugins `skip-override` through `fastify-plugin`, and a
 * `skip-override` plugin has the `prefix` passed to `register` **silently ignored**.
 * That was measured during design, not recalled. The price of assigning instead is one
 * hidden-class transition per authenticated request, and what it buys is that both
 * route plugins stay ordinary and prefixable.
 *
 * Every refusal is `unauthorized` and nothing else: a missing header, a header in
 * another scheme, a Token that was never issued and one that has expired are one
 * status and one message, the same one a wrong password gets.
 */
export function requireUser(directory: TokenOperations): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const presented = presentedToken(request.headers.authorization);
    const user = presented === undefined ? undefined : await directory.authenticate(presented);
    // Returning the reply is how an async hook says the lifecycle is over; without it
    // Fastify would carry on to the handler after the 401 had been sent.
    if (user === undefined) return unauthorized(reply);
    request.safUser = user;
    return undefined;
  };
}

/**
 * The Public server's routes: the login, and nothing that is not about a credential.
 *
 * Not registering this plugin is how a deployment replaces our authentication with
 * its own: an OIDC callback of the Operator's establishes identity however it likes
 * and mints an ordinary Token, after which every route in the Gateway is unchanged by
 * the substitution. That is why there is no Authenticator interface to implement
 * (ADR-0030).
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
          description: `A User's own opaque id and their password, for a bearer Token to present on everything else. **This response is the only place the Token's plaintext ever exists**: it is stored as a digest and cannot be read back, so a client that loses it logs in again rather than recovering it.\n\nThis is the one Public route that requires no Token, and the one a client calls first. ${noPublicParameters}`,
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
        // A Token is a resource this created, so 201, and the response is the only
        // time its plaintext exists anywhere (invariant 7 in `data-model.md`).
        return issued === undefined ? unauthorized(reply) : reply.code(201).send(issued);
      },
    );

    // The smallest possible consumer of the preHandler, and the same one an Operator
    // takes: the hook answers everything, and the handler is a property read. It
    // answers the `UserRecord` the login answered with, so a client resuming after a
    // restart recovers exactly what it was told when it logged in — including the
    // Attributes governing its authorization, which are not hidden from the User they
    // are about.
    fastify.get(
      "/me",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Read the presented User",
          description: `The User the presented Token belongs to, in the same shape the login answered with, so a client resuming after a restart recovers exactly what it was told. The Attributes governing this User's authorization are included: they are not hidden from the User they are about. ${bearerRequired} ${noPublicParameters}`,
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

    // Logging out: the presented Token stops working and no other one does, which is
    // what makes a Token on a device the User no longer trusts droppable without
    // ending the session they are sitting in (User story 19).
    fastify.delete(
      "/tokens/current",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Revoke the presented Token",
          description: `Logging out. The presented Token stops working and no other one of this User's does, which is what makes a Token on a device they no longer trust droppable from a device they still use. Idempotent: the row is gone afterwards whether or not this call is what removed it. ${bearerRequired} ${noPublicParameters}`,
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
        // The Token is re-read from the header rather than carried on the request.
        // `requireUser` has already run, so this is the same parse of the same string
        // and it cannot answer differently; the alternative is a second public
        // property beside `safUser`, which would put a plaintext credential on every
        // request in every deployment for the sake of this one line.
        const presented = presentedToken(request.headers.authorization);
        // Unreachable behind the preHandler, and the refusal is the same one it would
        // have given: there is no second thing this route can say.
        if (presented === undefined) return unauthorized(reply);
        await directory.revokeToken(presented);
        // 204: there is nothing to answer with. The Token's plaintext existed once, in
        // the response that issued it, and this response is about its absence.
        return reply.code(204).send();
      },
    );

    // The answer to "I think I have been compromised", and the only one there is:
    // nothing removes a User (ADR-0029), so every credential that will stop working
    // before it expires stops working here (User story 20).
    fastify.delete(
      "/tokens",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Revoke every Token of the presented User",
          description: `The answer to "I think I have been compromised", and the only one there is: nothing removes a User (ADR-0029), so every credential that stops working before it expires stops working here. Every Token of the presented User goes, **including the one presented**, so the caller is logged out too. It is also the only compaction a User has over their own row count, since nothing reaps an expired Token either. ${bearerRequired} ${noPublicParameters}`,
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
        // The presented User's, from the presented Token, and not an id from anywhere
        // a caller could write one: the route has no parameter naming a User.
        await directory.revokeTokens(request.safUser.id);
        return reply.code(204).send();
      },
    );

    // Rotating a credential without an Operator (User story 22). Note what it
    // deliberately does **not** do: a changed password revokes nothing, because a User
    // who changed theirs out of fear is served by `DELETE /tokens`, which exists and is
    // one request away. Bundling the two would take that choice away from them.
    fastify.put<{ Body: { currentPassword: string; newPassword: string } }>(
      "/password",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Replace the presented User's password",
          description: `A User rotating their own credential by proving they hold the current one. There is **no \`user\` field**: the User is the one the Token names, so there is no parameter through which one could change another's password and therefore no check that could be got wrong. There is no recovery path either: proving identity *without* the credential is what this framework declined to build (ADR-0014, ADR-0030), so a forgotten password is replaced by the Operator's own trusted code or not at all.\n\nA changed password **revokes nothing**. A User who changed theirs out of fear is served by \`DELETE /auth/tokens\`, which is one request away, and bundling the two would take that choice away from them. ${bearerRequired} ${noPublicParameters}`,
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
        // The same 401 a wrong password at the login route gets, because it is the
        // same failure: a credential was presented and it was not right.
        return changed ? reply.code(204).send() : unauthorized(reply);
      },
    );
  };
}
