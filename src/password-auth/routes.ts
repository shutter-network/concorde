/**
 * One plugin, on the Public server, carrying no prefix of its own. The constructor's prefix is
 * `/auth`, so the paths below are relative to it.
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `POST /tokens` | 201, an `IssuedToken`. **No Token required**; 400; 401 |
 * | `PUT /password` | 204; 400; 401 |
 * | `DELETE /tokens/current` | 204, the presented Token revoked; 400; 401 |
 * | `DELETE /tokens` | 204, every Token of the presented User revoked; 400; 401 |
 *
 * **There is no `GET /me` here.** It only echoes `request.safUser`, so it is scheme-independent
 * and cannot live under one scheme's prefix
 * ([ADR-0052](../../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)).
 * It is the Users component's, and it stays there.
 *
 * The three routes below `POST /tokens` take the **server's** composed hook and not one of this
 * component's own. That is the whole of ADR-0052's aggregate: `request.safUser` is assigned in one
 * place, and a route reading it does not care which scheme named the User. The consequence is
 * visible on `DELETE /tokens/current`, which is documented where it is answered.
 *
 * `unauthorized` is written here and it is written again in the Users component and a third time
 * in `gateway/auth.ts`. Three producers of one body is the cost of this component depending on no
 * other and of the aggregate depending on none at all, and it is paid rather than hidden:
 * `authentication.test.ts` compares them over real HTTP, byte for byte.
 *
 * Each route's own `description` is what `/openapi.json` serves, so those strings are the API
 * documentation rather than commentary, and `docs/api-docs.md` governs them. A response schema is
 * a serializer as well: `fast-json-stringify` drops every field the schema does not declare, with
 * no warning anywhere, so `userRecordSchema` is a positive list and the password digest cannot
 * reach the wire through a field nobody thought of.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { idSchema, refused, unknownQueryRefusal } from "../route-conventions.ts";
import type { UserRecord } from "../users/routes.ts";

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
  /** When it stops working, ISO 8601, from the lifetime this component was built with. */
  readonly expiresAt: string;
  /** The User it belongs to, Attributes and all. */
  readonly user: UserRecord;
};

/**
 * `currentPassword` has no absent shape, and that is the line between self-service and account
 * recovery. The only replacement that proves nothing is trusted code's `setPassword`.
 *
 * `user` is not read from the body. The route fills it from the authenticated User, so a caller
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

// A credential in a URL is one in every access log between here and the client, which is the one
// thing worth saying about the parameters these routes do not take.
const credentialsAreNotInUrls =
  "These routes take no query parameters at all. A credential travels in the body or in the Authorization header, never in a URL.";

const rejectQuery = unknownQueryRefusal(credentialsAreNotInUrls);

const unknownParameter =
  "An unknown query parameter is a **400**, not a filter that did nothing and a request answered with everything.";

const noParameters = `${credentialsAreNotInUrls} ${unknownParameter}`;

/** What every route that acts as somebody says about the credential it wants. */
const bearerRequired =
  "**Requires a bearer Token**, presented as `Authorization: Bearer <token>` and obtained from `POST /auth/tokens`. The User acted on is the one the Gateway authenticated, and no parameter anywhere names another.";

/**
 * The one thing a 401 says, wherever it is answered.
 *
 * Every authentication failure is one status and one message. Enumeration is refused because
 * Attributes govern authorization and nothing rate limits the guessing.
 */
const authenticationFailed =
  "Authentication failed, which is the whole of what is said: a wrong password, an id nobody holds, a User with no password, and a Token that is missing, malformed, unknown or expired are one status and one message, so nothing here answers who exists.";

// The whole of the 400 on the three routes that read no body beyond a credential.
const aQueryParameterWasWritten = "A query parameter was written, and these routes take none.";

// A positive list of the fields that can be answered, so a column added to a table reaches no
// response until somebody writes it here.
const userRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    // No `type` at all, which is an empty schema. It passes any JSON value through byte intact
    // and renders in the document as "any".
    attributes: {
      description:
        "Arbitrary JSON, defined by the deployment and interpreted by nothing in the Gateway. This is where grouping and therefore authorization live. Nothing on this surface can write them: a password names a User who already exists.",
    },
    createdAt: { type: "string" },
  },
  required: ["id", "attributes", "createdAt"],
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

// The id is pattern-validated like an id in a path. PostgreSQL refuses to cast a malformed uuid,
// so an unvalidated one would be a 500 out of a typo. A well-formed id nobody holds gets the same
// 401 as a wrong password.
const credentialsSchema = {
  type: "object",
  properties: { user: idSchema, password: passwordSchema },
  required: ["user", "password"],
  additionalProperties: false,
} as const;

// No `user` field: the User is the authenticated one, so no request can change another User's
// password and no check can be got wrong. Both passwords carry the same bound, because scrypt
// reads both.
const passwordChangeSchema = {
  type: "object",
  properties: { currentPassword: passwordSchema, newPassword: passwordSchema },
  required: ["currentPassword", "newPassword"],
  additionalProperties: false,
} as const;

/**
 * Answers the one 401 every authentication failure gets, whatever it was.
 *
 * A wrong password, a User that does not exist and a User with no password are one message. The
 * body is Fastify's own error shape, so this surface answers one shape rather than two.
 */
export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .send({ statusCode: 401, error: "Unauthorized", message: "authentication failed" });
}

/**
 * The Token in an `Authorization` header, or `undefined` when the header names another scheme,
 * carries nothing after the scheme, or is absent.
 *
 * The scheme is matched case-insensitively, because RFC 7235 says it is. Everything else is exact:
 * one scheme, one space or more, and a credential with no whitespace in it.
 */
export function presentedToken(authorization: string | undefined): string | undefined {
  return /^Bearer +(\S+)$/i.exec(authorization ?? "")?.[1];
}

/** Whether an `Authorization` header names this scheme at all, however broken the rest of it is. */
export function namesBearer(authorization: string | undefined): boolean {
  return /^Bearer\b/i.test(authorization ?? "");
}

/**
 * The Public server's routes: the login, and nothing that is not about a credential.
 *
 * `authenticated` is the server's own composed hook, taken as one route option and neither
 * wrapped nor extended, so a refusal on these routes is the one the server writes for every
 * protected route.
 */
export function passwordRoutes(
  directory: CredentialOperations,
  authenticated: preHandlerAsyncHookHandler,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: Credentials }>(
      "/tokens",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Trade a password for a Token",
          description: `A User's own opaque id and their password, for a bearer Token to present on everything else. **This response is the only place the Token's plaintext ever exists.** It is stored as a digest and cannot be read back. A client that loses it logs in again rather than recovering it.\n\nThis is the one route here that requires no Token, and the one a client calls first. ${noParameters}`,
          body: credentialsSchema,
          response: {
            201: {
              ...issuedTokenSchema,
              description:
                "The Token, when it stops working, and the User it belongs to, so that a client needs no second request to know who it is.",
            },
            400: refused(
              `The \`user\` is not a uuid, or the password is missing, empty or longer than ${maxPasswordLength} characters. A well-formed id nobody holds is a 401 and not a 400, since a 400 would answer who exists.`,
            ),
            401: refused(authenticationFailed),
          },
        },
        preValidation: rejectQuery(),
      },
      async (request, reply) => {
        const issued = await directory.logIn(request.body);
        // A Token is a resource this created, so 201. This response is the only time its
        // plaintext exists anywhere.
        return issued === undefined ? unauthorized(reply) : reply.code(201).send(issued);
      },
    );

    // Rotating a credential without an Operator. A changed password revokes nothing. A User who
    // changed theirs out of fear is served by `DELETE /tokens`, one request away.
    fastify.put<{ Body: { currentPassword: string; newPassword: string } }>(
      "/password",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Replace the authenticated User's password",
          description: `A User rotating their own credential by proving they hold the current one. There is **no \`user\` field**: the User is the one the Gateway authenticated. So no request can change another User's password, and there is no check to get wrong. There is no recovery path either. Proving identity *without* the credential is what this framework declined to build. A forgotten password is replaced by the Operator's own trusted code, or not at all.\n\nA User who holds no password cannot get one here, having nothing to prove, and is refused with the same 401 a wrong one gets. A changed password **revokes nothing**: a User who changed theirs out of fear is served by \`DELETE /auth/tokens\`, which is one request away. ${bearerRequired} ${noParameters}`,
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
        preHandler: authenticated,
        preValidation: rejectQuery(),
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

    // Logging out. The presented Token stops working and no other one does. So a User can drop a
    // Token without ending the session they are in.
    fastify.delete(
      "/tokens/current",
      {
        schema: {
          tags: ["Authentication"],
          summary: "Revoke the presented Token",
          description: `Logging out. The presented Token stops working, and no other Token of this User's does. So a Token on a device they no longer trust is droppable from a device they still use. Idempotent: the row is gone afterwards, whether or not this call removed it.\n\nIt acts on the Token in the \`Authorization\` header and on nothing else, so a request the Gateway authenticated by some other scheme answers 204 and drops nothing. ${bearerRequired} ${noParameters}`,
          response: {
            204: noBody(
              "The Token no longer works. Nothing is answered, including how many Tokens there were: a count is a number about Tokens the caller does not hold.",
            ),
            400: refused(aQueryParameterWasWritten),
            401: refused(authenticationFailed),
          },
        },
        preHandler: authenticated,
        preValidation: rejectQuery(),
      },
      async (request, reply) => {
        // The Token is re-read from the header rather than carried on the request. A property
        // beside `safUser` would put a plaintext credential on every request in every deployment.
        const presented = presentedToken(request.headers.authorization);
        if (presented !== undefined) await directory.revokeToken(presented);
        // 204: there is nothing to answer with. This response is about the Token's absence, and
        // a request that carried none of this scheme's credentials has that absence already.
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
          summary: "Revoke every Token of the authenticated User",
          description: `The answer to "I think I have been compromised", and the only one there is. Nothing removes a User, so every credential of this scheme that stops working before it expires stops working here. Every Token of the authenticated User goes, **including the one presented**, so the caller is logged out too. It is the only compaction a User has over their own row count, because nothing reaps an expired Token.\n\nIt drops no password and no credential of any other scheme, so a User who is also reached another way keeps that way. ${bearerRequired} ${noParameters}`,
          response: {
            204: noBody(
              "Every Token that User held, including the presented one, has stopped working.",
            ),
            400: refused(aQueryParameterWasWritten),
            401: refused(authenticationFailed),
          },
        },
        preHandler: authenticated,
        preValidation: rejectQuery(),
      },
      async (request, reply) => {
        // The authenticated User's id. The route has no parameter naming a User, so a caller
        // cannot write one.
        await directory.revokeTokens(request.safUser.id);
        return reply.code(204).send();
      },
    );
  };
}
