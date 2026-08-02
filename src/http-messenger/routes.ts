/**
 * The HTTP Messenger's contributions to the two servers, both of them at `/messages`.
 *
 * Two plugins and not one, because they are registered on different Fastify instances
 * listening on different addresses. Unlike the User Directory's, **neither is exported and
 * neither prefix is configurable**, which is this part's stated departure from ADR-0032's
 * door-out pattern: these routes are half of a contract whose other half is the Signal
 * `kind`, the record shape and a client written against both, so an Operator who wants
 * them somewhere else wants a different messaging part (ADR-0034, ADR-0021). The paths
 * below are still relative, because the constructor supplies the prefix.
 *
 * | Agent server | Answers |
 * | --- | --- |
 * | `POST /messages` | 201, the created outbound `MessageRecord`; 404 if no such User |
 * | `GET /messages?user=&after=&before=&limit=` | `{ messages: [...] }`, ascending by `seq` |
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `POST /messages` | 201, the created inbound `MessageRecord`, and a Signal; or 401 |
 * | `GET /messages?after=&before=&limit=` | `{ messages: [...] }`, ascending by `seq`, or 401 |
 *
 * Nothing here authenticates anybody. The Agent server has no authentication at all
 * (ADR-0010), and both Public routes take the User Directory's `requireUser` as **one option
 * on the route**, which is exactly what `src/users/users.ts` already promised: the User is
 * read off `request.safUser`, every refusal is the Directory's single 401, and this part
 * holds no Token, no header and no scheme of its own.
 *
 * `user` is **required** on the agent's read. Not for confidentiality — the agent may read
 * everything and an unscoped read leaks nothing new (ADR-0011) — but because `seq` is per
 * User and therefore cannot cursor an interleaved result: an unscoped read would need a
 * second paging mechanism inside the same route.
 *
 * The Public routes have **no parameter naming a User at all**, which is how one User cannot
 * read another's log or write into it by any spelling of the request: there is nothing to
 * guard, because the id comes from a Token and from nowhere a client can write. `?user=` on
 * the read is refused as the unknown parameter it is, and a `userId` in the body of a post
 * reaches nothing.
 *
 * The capped limit, the envelope, the pattern-validated id, the refusal of an unknown query
 * parameter and the 404 body are the conventions in `route-conventions.ts` that every
 * part's routes share; only the sentence a refusal ends with is this part's.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { idSchema, limitSchema, notFound, unknownQueryRefusal } from "../route-conventions.ts";
import {
  type MessageRecord,
  type MessageWindow,
  SeqContentionError,
  UnknownUserError,
} from "./messages.ts";

/**
 * The read **both** surfaces need of the part, and the reason it is a type of its own.
 *
 * A User's own read and the agent's are one implementation reached with the User id from a
 * different place — a Token or a query parameter — and this is the seam that says so. Two
 * of these would be two chances to disagree about what `before` means, which is a thing no
 * client could report and no test of one surface would catch (ADR-0035).
 */
export type MessageHistory = {
  history(userId: string, window: MessageWindow): Promise<MessageRecord[]>;
};

/**
 * What the agent's routes need of the part, and no more: the shared read and a send, with
 * no Db, no table objects and no direction.
 *
 * `send` takes no `direction`, because which one it is was decided by the server the
 * request arrived on — so there is nothing on this seam for a caller to set and nothing to
 * get wrong. It is also transaction-less, where the trusted-code method takes one
 * (ADR-0023): a request that sends a Message has one statement in it, and a Handler
 * answering somebody has its own tables to keep that statement with.
 */
export type MessageOperations = MessageHistory & {
  send(userId: string, text: string): Promise<MessageRecord>;
};

/**
 * What a User's own routes need of the part: the shared read, and a submission.
 *
 * `submit` is `send`'s counterpart and takes neither a `direction` nor a transaction, for
 * the reasons `send` takes neither: inbound was decided by the server the request arrived
 * on, and the transaction that carries the insert and the Signal it wakes the worker with is
 * the part's own to open — a route has nothing else to put in it (ADR-0023). What it returns
 * is the stored record, because that is what the 201 answers with and what the Signal
 * payload already is.
 */
export type OwnMessageOperations = MessageHistory & {
  submit(userId: string, text: string): Promise<MessageRecord>;
};

/**
 * The refusal these routes answer an unknown query parameter with.
 *
 * The convention and its reasoning are in `route-conventions.ts`; the sentence is this
 * part's. It says outright that there is nothing to search by, because the alternative —
 * `?text=hello` quietly returning the newest fifty Messages — reads as though a filter had
 * been applied.
 */
const rejectUnknownQuery = unknownQueryRefusal(
  "A Message log is read by cursor and cannot be searched or filtered: the parameters are a window over one User's `seq`, and there is no full-text or field matching of any kind.",
);

/**
 * A cursor: one `seq`, or the 0 no Message has.
 *
 * Validated as an integer so that `?after=abc` is the 400 it earned rather than a query
 * PostgreSQL refuses to run, the same reason an id is pattern-validated.
 *
 * `0` is deliberately allowed even though nothing is numbered it: `after=0` is how a client
 * asks for a log **from its beginning**, oldest first, which no other spelling expresses —
 * no cursor at all means the newest page, and `after=1` would skip the first Message.
 */
const cursorSchema = { type: "integer", minimum: 0 } as const;

/**
 * The text of a Message: non-empty, and with **no upper bound**.
 *
 * `minLength: 1` so that a stray keypress is a 400 rather than a blank bubble. No
 * `maxLength`, because Fastify's `bodyLimit` is already the bound and it is the Operator's
 * to raise on the server they constructed — a second number of ours would shadow one they
 * can already set (ADR-0034).
 */
const textSchema = { type: "string", minLength: 1 } as const;

/**
 * The body of the agent's `POST /`: which User, and what to say to them.
 *
 * `userId` is pattern-validated by the shared `idSchema` because PostgreSQL refuses to
 * cast a malformed uuid, and an agent that copied one wrong has earned a 400 rather than a
 * 500 (ADR-0036). A well-formed one naming nobody is the 404 the foreign key answers.
 */
const agentSendSchema = {
  type: "object",
  properties: { userId: idSchema, text: textSchema },
  required: ["userId", "text"],
  additionalProperties: false,
} as const;

/**
 * The body of a User's own `POST /`: what they said, and nothing else.
 *
 * There is **no `userId` here and nowhere for one to arrive**. The submitting User is the
 * one their Token named, which is what makes the attribution in the Signal payload
 * trustworthy — the Messenger writes it and the client never does. A client that posts one
 * anyway has it dropped by `additionalProperties: false` and reaches nothing, so nobody can
 * put words in another User's mouth.
 */
const submitSchema = {
  type: "object",
  properties: { text: textSchema },
  required: ["text"],
  additionalProperties: false,
} as const;

/** The agent's read: one User, required, and the window. */
const agentHistorySchema = {
  type: "object",
  properties: { user: idSchema, after: cursorSchema, before: cursorSchema, limit: limitSchema },
  required: ["user"],
  additionalProperties: false,
} as const;

/**
 * A User's own read: the window, and **nothing naming a User**.
 *
 * The agent's schema above is this one plus a required `user`, and the difference is the
 * whole difference between the two surfaces. It is not spelled as an omission from a shared
 * object, because what matters here is that there is no such property to omit: a request
 * cannot ask about somebody else, so nothing has to refuse one that does.
 */
const ownHistorySchema = {
  type: "object",
  properties: { after: cursorSchema, before: cursorSchema, limit: limitSchema },
  additionalProperties: false,
} as const;

/** The agent's Message routes, over the operations above. */
export function agentMessageRoutes(messageLog: MessageOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { userId: string; text: string } }>(
      "/",
      { schema: { body: agentSendSchema }, preValidation: rejectUnknownQuery() },
      async (request, reply) => {
        // Outbound because this is the Agent server. The agent cannot write an inbound
        // Message, and the refusal is the absence of a parameter rather than a check: a
        // prompt injection has nowhere to put one (ADR-0034).
        try {
          return reply
            .code(201)
            .send(await messageLog.send(request.body.userId, request.body.text));
        } catch (error) {
          return refused(reply, error, request.body.userId);
        }
      },
    );

    fastify.get<{ Querystring: MessageWindow & { user: string } }>(
      "/",
      {
        schema: { querystring: agentHistorySchema },
        preValidation: rejectUnknownQuery("user", "after", "before", "limit"),
      },
      // The whole difference between this read and a User's own is the line below: where
      // the User id comes from, a query parameter or a Token (ADR-0011).
      async (request, reply) => answerHistory(reply, messageLog, request.query.user, request.query),
    );
  };
}

/**
 * The Public server's Message routes: a User's own log, and the one way anything gets into
 * it from outside the Gateway.
 *
 * `presentedUser` is the User Directory's `requireUser`, taken as one option on each route
 * and not wrapped, extended or re-implemented. So an unauthenticated read or post is the
 * Directory's single 401 — a missing header, a header in another scheme, an unknown Token
 * and an expired one alike — and this part authenticates nobody (ADR-0030).
 *
 * The hook runs at `preHandler`, after validation, so a malformed window, an unknown query
 * parameter and an empty `text` are all answered before a Token is looked at. That is the
 * order `GET /auth/me` already answers in, and it leaks nothing: a refusal names a parameter
 * or a field of the route and never a User.
 */
export function publicMessageRoutes(
  messageLog: OwnMessageOperations,
  presentedUser: preHandlerAsyncHookHandler,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { text: string } }>(
      "/",
      {
        schema: { body: submitSchema },
        preHandler: presentedUser,
        preValidation: rejectUnknownQuery(),
      },
      // Inbound, because this is the Public server's plugin, and by the User the Token
      // named: there is no field on this route for a client to put a User in, so nothing
      // has to refuse one (ADR-0034). What `submit` does with it — one Message and one
      // Signal in one transaction — is the constructor's, since a route holds no Db.
      async (request, reply) => {
        try {
          return reply
            .code(201)
            .send(await messageLog.submit(request.safUser.id, request.body.text));
        } catch (error) {
          return refused(reply, error, request.safUser.id);
        }
      },
    );

    fastify.get<{ Querystring: MessageWindow }>(
      "/",
      {
        schema: { querystring: ownHistorySchema },
        preHandler: presentedUser,
        preValidation: rejectUnknownQuery("after", "before", "limit"),
      },
      // The whole difference from the agent's read is the User id: theirs comes from a
      // query parameter, this one from the Token the hook above verified. There is no
      // parameter here a client could put a User in, so nothing can read another's log.
      async (request, reply) => answerHistory(reply, messageLog, request.safUser.id, request.query),
    );
  };
}

/**
 * The read both surfaces answer, and the one place the cursor rules live.
 *
 * Written here rather than inside the agent's handler because a User's own read is the same
 * query asked about the User their Token names: the two must not become a parallel pair
 * that can disagree about what `before` means.
 */
async function answerHistory(
  reply: FastifyReply,
  messageLog: MessageHistory,
  userId: string,
  asked: MessageWindow,
): Promise<FastifyReply | { readonly messages: MessageRecord[] }> {
  if (asked.after !== undefined && asked.before !== undefined) {
    // Two windows in one request, which is a client bug worth naming rather than one of
    // the two silently winning.
    return reply.code(400).send({
      statusCode: 400,
      error: "Bad Request",
      message:
        "after and before describe two different windows: pass after to walk forwards, before to walk backwards, or neither for the newest page.",
    });
  }
  // The envelope, matching `{ users: [...] }`, and with no `hasMore` in it: a full page
  // says it, since `messages.length === limit`.
  return { messages: await messageLog.history(userId, asked) };
}

/**
 * What a refused send answers with: the two things the insert can fail for, and nothing
 * else rethrown as a 500.
 *
 * The 404 describes the **referenced User** rather than the route, and it arrives from a
 * caught error class rather than from a branch, because the only enforcement is the foreign
 * key and there is deliberately no lookup in front of it (ADR-0036).
 *
 * Both surfaces refuse through this one function, and only the agent can meet the 404: a
 * User's own post carries the id the Directory's hook just looked a User up by, and nothing
 * removes a User (ADR-0029). The contention a busy log can lose is reachable from either.
 */
function refused(reply: FastifyReply, error: unknown, userId: string): FastifyReply {
  if (error instanceof UnknownUserError) return notFound(reply, "User", userId);
  if (error instanceof SeqContentionError) {
    // A 503 and not a 500: nothing is wrong with the request, and retrying it is exactly
    // what a caller should do — the same send will get a number as soon as this User's own
    // concurrent writers stop outrunning a bounded retry.
    return reply
      .code(503)
      .send({ statusCode: 503, error: "Service Unavailable", message: error.message });
  }
  throw error;
}
