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
 * The Public server's plugin registers **no routes yet**: an honest empty plugin rather
 * than a placeholder route, so nothing answers on that surface until the tickets that give
 * a User something to post and something to read.
 *
 * Nothing here authenticates anybody. The Agent server has no authentication at all
 * (ADR-0010), and the Public routes will take the User Directory's `requireUser` as one
 * option on the route, which is exactly what `src/users/users.ts` already promised.
 *
 * `user` is **required** on the agent's read. Not for confidentiality — the agent may read
 * everything and an unscoped read leaks nothing new (ADR-0011) — but because `seq` is per
 * User and therefore cannot cursor an interleaved result: an unscoped read would need a
 * second paging mechanism inside the same route.
 *
 * The capped limit, the envelope, the pattern-validated id, the refusal of an unknown query
 * parameter and the 404 body are the conventions in `route-conventions.ts` that every
 * part's routes share; only the sentence a refusal ends with is this part's.
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { idSchema, limitSchema, notFound, unknownQueryRefusal } from "../route-conventions.ts";
import {
  type MessageRecord,
  type MessageWindow,
  SeqContentionError,
  UnknownUserError,
} from "./messages.ts";

/**
 * What the routes need of the part, and no more: a send and a read, with no Db, no table
 * objects and no direction.
 *
 * `send` takes no `direction`, because which one it is was decided by the server the
 * request arrived on — so there is nothing on this seam for a caller to set and nothing to
 * get wrong. It is also transaction-less, where the trusted-code method takes one
 * (ADR-0023): a request that sends a Message has one statement in it, and a Handler
 * answering somebody has its own tables to keep that statement with.
 */
export type MessageOperations = {
  send(userId: string, text: string): Promise<MessageRecord>;
  history(userId: string, window: MessageWindow): Promise<MessageRecord[]>;
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

/** The agent's read: one User, required, and the window. */
const agentHistorySchema = {
  type: "object",
  properties: { user: idSchema, after: cursorSchema, before: cursorSchema, limit: limitSchema },
  required: ["user"],
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
 * The Public server's Message routes: none yet.
 *
 * An empty plugin and not a placeholder route, so the surface says what is true — nothing
 * a User can reach exists — and the wiring the constructor does is the wiring that will
 * carry the routes when they arrive, rather than something to add along with them.
 */
export function publicMessageRoutes(): FastifyPluginAsync {
  return async () => {
    return;
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
  messageLog: MessageOperations,
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
