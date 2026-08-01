/**
 * The User Directory's contributions to the two servers: creating and reading Users
 * on the Agent server, and trading a password for a Token on the Public one.
 *
 * Two plugins and not one, because they are registered on different Fastify
 * instances listening on different addresses, and because either may be left out:
 * a deployment where the agent must not create Users does not register the Agent
 * plugin, and one replacing password authentication with its own scheme does not
 * register the Public plugin (ADR-0021, ADR-0030).
 *
 * Both carry **no prefix of their own**, exactly as the Core's routes do: the
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
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  idParams,
  idSchema,
  limitSchema,
  notFound,
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
 * What the agent's routes need of the User Directory, and no more: three operations
 * over the part's own handle, with no Store and no table objects.
 *
 * `create` takes one thing, an optional initial password, and there is no second
 * parameter waiting to be added: Attributes are what the agent may not supply, and
 * absence is how that is enforced. Note that it is also transaction-less, where the
 * Directory's own `create` takes one (ADR-0023): a request that creates a User has
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
  /** When it stops working, ISO 8601, from the Directory's construction-time lifetime. */
  readonly expiresAt: string;
  /** The User it belongs to, including the Attributes governing their authorization. */
  readonly user: UserRecord;
};

/**
 * What the Public routes need of the User Directory: one operation, answering
 * `undefined` for **every** kind of failure.
 *
 * That the failures are not distinguished here rather than at the route is the point.
 * There is no reason code to accidentally answer with, so a wrong password, an
 * unknown User and a User with no password reach the route as the same value and
 * leave it as the same response (ADR-0030).
 */
export type CredentialOperations = {
  logIn(credentials: Credentials): Promise<IssuedToken | undefined>;
};

/**
 * The refusal these routes answer an unknown query parameter with.
 *
 * The convention and its reasoning are in `route-conventions.ts`; the sentence the
 * message ends with is this part's. It says outright that there is nothing to search
 * by, because the alternative — `?attributes[role]=admin` quietly returning every
 * User — reads as though a filter had been applied.
 */
const rejectUnknownQuery = unknownQueryRefusal(
  "Users cannot be searched or filtered: Attributes are arbitrary JSON the Gateway cannot meaningfully index, and a User has no natural key to match on (ADR-0014).",
);

/**
 * The refusal the Public routes answer an unknown query parameter with.
 *
 * A different sentence from the agent's, because the useful thing to say on this
 * surface is where a credential goes: a password or a Token in a URL is a password or
 * a Token in every access log and every browser history between here and the client.
 */
const rejectPublicQuery = unknownQueryRefusal(
  "The Public routes take no query parameters at all: a credential travels in the body or in the Authorization header, never in a URL.",
);

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
      { schema: { body: newUserSchema }, preValidation: rejectUnknownQuery() },
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
          querystring: {
            type: "object",
            properties: { limit: limitSchema },
            additionalProperties: false,
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
      { schema: { params: idParams }, preValidation: rejectUnknownQuery() },
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
 * The Public server's routes: the login, and nothing that is not about a credential.
 *
 * Not registering this plugin is how a deployment replaces our authentication with
 * its own: an OIDC callback of the Operator's establishes identity however it likes
 * and mints an ordinary Token, after which every route in the Gateway is unchanged by
 * the substitution. That is why there is no Authenticator interface to implement
 * (ADR-0030).
 */
export function publicUserRoutes(directory: CredentialOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: Credentials }>(
      "/tokens",
      { schema: { body: credentialsSchema }, preValidation: rejectPublicQuery() },
      async (request, reply) => {
        const issued = await directory.logIn(request.body);
        // A Token is a resource this created, so 201, and the response is the only
        // time its plaintext exists anywhere (invariant 7 in `data-model.md`).
        return issued === undefined ? unauthorized(reply) : reply.code(201).send(issued);
      },
    );
  };
}
