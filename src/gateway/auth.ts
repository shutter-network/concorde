/**
 * The list is read per request and never closed over, which is the whole of what late binding
 * means here: an Auth constructed after a route was registered still authenticates that route, so
 * the only thing construction order inside `extend` decides is the order the schemes are asked in.
 * A `requireUser` that captured the array's contents at registration time would authenticate
 * nobody in the deployment that reads best, where the servers are built before every component
 * that registers with them.
 *
 * **The 401 is written here and it is written again in Password Auth**, whose `unauthorized`
 * answers the same three fields with the same message on the login route, where no hook has run
 * and there is nothing for this file to refuse. Two producers of one body is the cost of the
 * aggregate depending on no component, and it is paid rather than hidden: `auths.test.ts` and
 * `password-auth/authentication.test.ts` compare them over real HTTP, byte for byte, instead of
 * trusting that somebody kept them in step. Nothing here may import that function, because the
 * layer runs the other way.
 *
 * `detail` is read once, into a log line, and is never given to the reply. Adding it to the body,
 * or to RFC 6750's `error_description`, would hand a client the sentence that was written for
 * whoever runs the deployment. The `code` beside it is the whole of what a client is owed, and it
 * is closed so that an Auth cannot widen that answer.
 *
 * Two Auths may carry one scheme, and the header then names it twice, once with `error=` if that
 * Auth was the one that refused. The refusing Auth is found by identity and not by its scheme, so
 * the mark lands on the challenge that earned it. Nothing refuses the duplicate, there being
 * nothing wrong with two ways to present one scheme.
 */

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Logger } from "../logging/logging.ts";
import type { UserRecord } from "../users/routes.ts";
import type { Component } from "./components.ts";

/**
 * One authentication scheme: what owns that scheme's secret and turns a request carrying it into a
 * User.
 *
 * An Auth registers itself with a server at the end of its own constructor, and the server asks
 * every registered Auth in turn on every protected route. Which schemes a deployment accepts is
 * therefore which Auths it constructs, and in which order.
 *
 * It is an ordinary Component with one more member, so it is keyed in the Gateway's record beside
 * everything else and is switched off by not constructing it.
 */
export type Auth = Component & {
  /**
   * The HTTP authentication scheme this answers for, such as `Bearer`.
   *
   * One token, with no space and no parameters in it: the server writes the challenge around it.
   * Every 401 the server composes names this scheme, whether or not this Auth was the one that
   * refused the request.
   */
  readonly scheme: string;

  /**
   * Reads the request, and answers that it carries nothing of this scheme, or that it carries one
   * that failed, or that it names this User.
   *
   * The whole request is given, so a credential in a header, in a body field or anywhere else is
   * expressible. It is read and not written: assigning to it decides nothing, because the server
   * assigns `request.safUser` itself from the User this answers with.
   *
   * A thrown error keeps its ordinary meaning. It is not a refusal, and the request is a 500.
   */
  authenticate(request: FastifyRequest): Promise<AuthOutcome>;
};

/**
 * What an Auth answers about one request.
 *
 * `absent` and `refused` are separate so that a request carrying nothing of this scheme falls
 * through to the next Auth without this one inventing a failure. The server stops at the first
 * `refused`, so an Auth that answers `refused` where it means `absent` shuts every scheme behind
 * it out of the request.
 */
export type AuthOutcome =
  | {
      /** This request carries no credential of this scheme. */
      readonly kind: "absent";
    }
  | {
      /** This request carries a credential of this scheme, and it did not work. */
      readonly kind: "refused";
      /**
       * Why, in the two words RFC 6750 defines and in no others: `invalid_request` for a
       * credential that arrived malformed, and `invalid_token` for one that was well formed and
       * did not verify.
       *
       * It reaches the client, in this scheme's challenge in the `WWW-Authenticate` header of the
       * 401. It is closed because a word an Auth invented would be a word the framework cannot
       * promise says nothing about who exists in this deployment.
       */
      readonly code: "invalid_request" | "invalid_token";
      /**
       * One sentence about the mechanics, for whoever runs the deployment.
       *
       * **It never reaches the wire.** It goes to the Logger the server was built with and nowhere
       * else, so a URL that a proxy rewrote is something an Operator can diagnose and a client
       * learns nothing from. Write the mechanical fact here, never the identity: which check
       * failed, and not whether the User exists.
       */
      readonly detail?: string;
    }
  | {
      /** This request carries a credential of this scheme, and it names this User. */
      readonly kind: "authenticated";
      readonly user: UserRecord;
    };

/**
 * A protected route was reached on a server that no Auth had registered with.
 *
 * Thrown rather than refused, so the request is a 500 an Operator finds in their log. The
 * alternative is a 401, which is the answer every User would read as their own credential having
 * failed, for a mistake none of them made.
 */
export class NoAuthRegisteredError extends Error {
  constructor(method: string, url: string) {
    super(
      `no Auth is registered with this server, so ${method} ${url} can authenticate nobody; construct an Auth with this server, or take requireUser off the route`,
    );
    this.name = "NoAuthRegisteredError";
  }
}

/** What every 401 this framework answers carries, whichever scheme was presented. */
const refusalBody = {
  statusCode: 401,
  error: "Unauthorized",
  message: "authentication failed",
};

/** The closed code, taken off the union so that the two functions below cannot widen it. */
type RefusalCode = Extract<AuthOutcome, { kind: "refused" }>["code"];

/** Which Auth refused and with which code, or nothing when every Auth answered `absent`. */
type Refusal = { readonly auth: Auth; readonly code: RefusalCode } | undefined;

/**
 * The registered Auths and the hook that walks them, for one server.
 *
 * `logger` takes the refusal details. Nothing else is written to it, so a server with no Auth
 * registered logs nothing at all.
 */
export function createAuthAggregate(logger: Logger) {
  // Order-bearing, and appended to by `registerAuth` for as long as the server exists. The hook
  // below reads it per request rather than copying it; see the file header.
  const auths: Auth[] = [];

  const requireUser: preHandlerAsyncHookHandler = async (request, reply) => {
    if (auths.length === 0) throw new NoAuthRegisteredError(request.method, request.url);

    for (const auth of auths) {
      const outcome = await auth.authenticate(request);

      if (outcome.kind === "authenticated") {
        // The one place a User is assigned on this server, whichever scheme named them. Returning
        // nothing is how an async hook says the request carries on to the handler.
        request.safUser = outcome.user;
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

    // Every Auth answered `absent`: the request presented nothing anybody here accepts.
    return refuse(reply, auths, undefined);
  };

  return {
    registerAuth(auth: Auth): void {
      auths.push(auth);
    },
    requireUser,
  };
}

/**
 * The one 401, with the challenge RFC 7235 says a 401 must carry.
 *
 * Returning the reply is how an async hook says the lifecycle is over. Without it Fastify carries
 * on to the handler after the refusal has been sent.
 */
function refuse(reply: FastifyReply, auths: readonly Auth[], refusedBy: Refusal): FastifyReply {
  return reply.code(401).header("WWW-Authenticate", challenge(auths, refusedBy)).send(refusalBody);
}

// One challenge per registered scheme, comma separated, which is RFC 7235's `1#challenge`. The
// refusing scheme carries RFC 6750's `error=` and no other parameter: `error_description` would
// be the detail, and `realm` names a protection space this framework does not have. The value
// needs no escaping, the code being one of two words this file spells out.
function challenge(auths: readonly Auth[], refusedBy: Refusal): string {
  return auths
    .map((auth) =>
      auth === refusedBy?.auth ? `${auth.scheme} error="${refusedBy.code}"` : auth.scheme,
    )
    .join(", ");
}
