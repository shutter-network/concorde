import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Logger } from "../logging/logging.ts";
import type { UserRecord } from "../users/routes.ts";
import type { Component } from "./components.ts";

export type Auth = Component & {
  readonly scheme: string;

  authenticate(request: FastifyRequest): Promise<AuthOutcome>;
};

/**
 * Return `absent` when the request does not use this scheme, and `refused` when it does
 * but its credential is unacceptable. A refusal prevents fallback to another auth.
 * Refusal details are logged and are never included in the HTTP response.
 */
export type AuthOutcome =
  | {
      readonly kind: "absent";
    }
  | {
      readonly kind: "refused";
      readonly code: "invalid_request" | "invalid_token";
      readonly detail?: string;
    }
  | {
      readonly kind: "authenticated";
      readonly user: UserRecord;
    };

export class NoAuthRegisteredError extends Error {
  constructor(method: string, url: string) {
    super(
      `no Auth is registered with this server, so ${method} ${url} can authenticate nobody; construct an Auth with this server, or take requireUser off the route`,
    );
    this.name = "NoAuthRegisteredError";
  }
}

const refusalBody = {
  statusCode: 401,
  error: "Unauthorized",
  message: "authentication failed",
};

type RefusalCode = Extract<AuthOutcome, { kind: "refused" }>["code"];

type Refusal = { readonly auth: Auth; readonly code: RefusalCode } | undefined;

export function createAuthAggregate(logger: Logger) {
  const auths: Auth[] = [];

  const requireUser: preHandlerAsyncHookHandler = async (request, reply) => {
    if (auths.length === 0) throw new NoAuthRegisteredError(request.method, request.url);

    for (const auth of auths) {
      const outcome = await auth.authenticate(request);

      if (outcome.kind === "authenticated") {
        request.concordeUser = outcome.user;
        return undefined;
      }

      if (outcome.kind === "refused") {
        if (outcome.detail !== undefined) {
          logger.warn(
            { scheme: auth.scheme, code: outcome.code, detail: outcome.detail },
            "an Auth refused a request",
          );
        }
        return refuse(reply, auths, { auth, code: outcome.code });
      }
    }

    return refuse(reply, auths, undefined);
  };

  return {
    registerAuth(auth: Auth): void {
      auths.push(auth);
    },
    requireUser,
  };
}

function refuse(reply: FastifyReply, auths: readonly Auth[], refusedBy: Refusal): FastifyReply {
  return reply.code(401).header("WWW-Authenticate", challenge(auths, refusedBy)).send(refusalBody);
}

function challenge(auths: readonly Auth[], refusedBy: Refusal): string {
  return auths
    .map((auth) =>
      auth === refusedBy?.auth ? `${auth.scheme} error="${refusedBy.code}"` : auth.scheme,
    )
    .join(", ");
}
