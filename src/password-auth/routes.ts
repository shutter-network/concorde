import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { idSchema, refused, unknownQueryRefusal } from "../route-conventions.ts";
import type { UserRecord } from "../users/routes.ts";

export type Credentials = {
  readonly user: string;
  readonly password: string;
};

export type IssuedToken = {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: UserRecord;
};

export type PasswordChange = {
  readonly user: string;
  readonly currentPassword: string;
  readonly newPassword: string;
};

export type CredentialOperations = {
  logIn(credentials: Credentials): Promise<IssuedToken | undefined>;
  revokeToken(token: string): Promise<void>;
  revokeTokens(user: string): Promise<void>;
  changePassword(change: PasswordChange): Promise<boolean>;
};

const credentialsAreNotInUrls =
  "These routes take no query parameters at all. A credential travels in the body or in the Authorization header, never in a URL.";

const rejectQuery = unknownQueryRefusal(credentialsAreNotInUrls);

const unknownParameter =
  "An unknown query parameter is a **400**, not a filter that did nothing and a request answered with everything.";

const noParameters = `${credentialsAreNotInUrls} ${unknownParameter}`;

const bearerRequired =
  "**Requires a bearer Token**, presented as `Authorization: Bearer <token>` and obtained from `POST /auth/tokens`. The User acted on is the one the Gateway authenticated, and no parameter anywhere names another.";

const authenticationFailed =
  "Authentication failed, which is the whole of what is said: a wrong password, an id nobody holds, a User with no password, and a Token that is missing, malformed, unknown or expired are one status and one message, so nothing here answers who exists.";

const aQueryParameterWasWritten = "A query parameter was written, and these routes take none.";

const userRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    attributes: {
      description:
        "Arbitrary JSON, defined by the deployment and interpreted by nothing in the Gateway. This is where grouping and therefore authorization live. Nothing on this surface can write them: a password names a User who already exists.",
    },
    createdAt: { type: "string" },
  },
  required: ["id", "attributes", "createdAt"],
} as const;

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

function noBody(why: string) {
  return { type: "null", description: why };
}

const maxPasswordLength = 1024;

const passwordSchema = {
  type: "string",
  minLength: 1,
  maxLength: maxPasswordLength,
} as const;

const credentialsSchema = {
  type: "object",
  properties: { user: idSchema, password: passwordSchema },
  required: ["user", "password"],
  additionalProperties: false,
} as const;

const passwordChangeSchema = {
  type: "object",
  properties: { currentPassword: passwordSchema, newPassword: passwordSchema },
  required: ["currentPassword", "newPassword"],
  additionalProperties: false,
} as const;

export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .send({ statusCode: 401, error: "Unauthorized", message: "authentication failed" });
}

export function presentedToken(authorization: string | undefined): string | undefined {
  return /^Bearer +(\S+)$/i.exec(authorization ?? "")?.[1];
}

export function namesBearer(authorization: string | undefined): boolean {
  return /^Bearer\b/i.test(authorization ?? "");
}

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
        return issued === undefined ? unauthorized(reply) : reply.code(201).send(issued);
      },
    );

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
          user: request.concordeUser.id,
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
        });
        return changed ? reply.code(204).send() : unauthorized(reply);
      },
    );

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
        const presented = presentedToken(request.headers.authorization);
        if (presented !== undefined) await directory.revokeToken(presented);
        return reply.code(204).send();
      },
    );

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
        await directory.revokeTokens(request.concordeUser.id);
        return reply.code(204).send();
      },
    );
  };
}
