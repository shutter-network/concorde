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
  "Send credentials in the request body or Authorization header, not in query parameters.";

const rejectQuery = unknownQueryRefusal(credentialsAreNotInUrls);

const unknownParameter = "Unknown query parameters return 400.";

const noParameters = `${credentialsAreNotInUrls} ${unknownParameter}`;

const bearerRequired =
  "Requires authentication through a scheme installed in this deployment. For bearer tokens, use `Authorization: Bearer <token>`. The authenticated user determines whose credentials are changed.";

const authenticationFailed =
  "Authentication failed. The response does not distinguish unknown users, incorrect passwords, or missing, invalid, or expired credentials.";

const aQueryParameterWasWritten = "Query parameters are not accepted.";

const userRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    attributes: {
      description:
        "Application-defined JSON. Updated only through the trusted programmatic API, not these routes.",
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
        "Token expiry in ISO 8601. The deployment sets the lifetime. Expired tokens are rejected but not automatically deleted. Log in again to obtain a new token.",
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
          summary: "Log in with a password",
          description: `Returns a bearer token for an existing user after checking their password. No credential is required to call this route. Only the token digest is stored, so a lost token cannot be recovered; log in again. ${noParameters}`,
          body: credentialsSchema,
          response: {
            201: {
              ...issuedTokenSchema,
              description:
                "The token, expiry time, and authenticated user. Save the token; it cannot be retrieved later.",
            },
            400: refused(
              `A UUID user id and a password of 1–${maxPasswordLength} characters are required. Unknown users return 401.`,
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
          summary: "Change your password",
          description: `Replaces the authenticated user's password after checking currentPassword. Extra body fields, including user, are stripped. Users without a password cannot set one here; recovery requires trusted application code. Existing tokens remain valid. Use DELETE /auth/tokens to revoke them. ${bearerRequired} ${noParameters}`,
          body: passwordChangeSchema,
          response: {
            204: noBody("Password replaced. Existing tokens remain valid."),
            400: refused(
              `Both passwords must contain 1–${maxPasswordLength} characters. Query parameters are not accepted. Extra body fields are stripped.`,
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
          summary: "Revoke the presented token",
          description: `Revokes only the bearer token in the Authorization header. Other tokens remain valid. If another auth scheme authenticates the request, returns 204 without revoking a token. ${bearerRequired} ${noParameters}`,
          response: {
            204: noBody("No response body. The presented bearer token, if any, was revoked."),
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
          summary: "Revoke all your tokens",
          description: `Revokes all password auth tokens for the authenticated user, including the presented token. Keeps the password and credentials belonging to other auth schemes. ${bearerRequired} ${noParameters}`,
          response: {
            204: noBody("All password auth tokens for this user were revoked."),
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
