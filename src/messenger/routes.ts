/**
 * One plugin, on the Agent server, at the prefix the constructor supplies. The agent's acts are
 * acts on the log rather than acts of any one medium, so they belong to the component that owns the
 * log; a User's own submission and cursored poll are what HTTP as a Channel *is*, and they live in
 * `../http-channel/routes.ts`
 * ([ADR-0048](../../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)).
 * Neither plugin is exported and neither prefix is configurable.
 *
 * | Agent server | Answers |
 * | --- | --- |
 * | `POST /messages` | 201, the created outbound `MessageRecord`; 404 if no such User; 503 |
 * | `GET /messages?user=&after=&before=&limit=` | `{ messages: [...] }`, ascending by `seq`; 400 |
 *
 * Half of this module is exported for the HTTP Channel to import, and that is deliberate: the
 * serializer both surfaces answer a `MessageRecord` through, the cursor sentences both reads carry,
 * and the two helpers both groups refuse with. The record is the Messenger's, so its wire shape is
 * declared here once and the Channel renders the same object. A second copy would drift in silence,
 * a response schema being a serializer that drops what it does not declare and warns about none of
 * it. None of it reaches a specifier.
 *
 * Nothing here authenticates anybody, and there is nothing on this server to authenticate with.
 *
 * Each route's own `description` is what `/openapi.json` serves, so those sentences are the API
 * documentation rather than commentary. The cursor rules are the sharpest of them, because no
 * schema conveys any part of them.
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  afterCursor,
  beforeCursor,
  bothCursors,
  cappedLimit,
  cursorCases,
  idSchema,
  limitSchema,
  notFound,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";
import {
  type MessageRecord,
  type MessageWindow,
  SeqContentionError,
  UnknownUserError,
} from "./messages.ts";
import { messageDirections } from "./schema.ts";

/**
 * The read both surfaces need, and the reason it is a type of its own.
 *
 * A User's own read and the agent's are one implementation, with the User id arriving from a Token
 * or from a query parameter. Two of them could disagree about what `before` means, and no test of
 * one surface would catch it.
 */
export type MessageHistory = {
  history(userId: string, window: MessageWindow): Promise<MessageRecord[]>;
};

/**
 * What the agent's routes need: the shared read and a send, with no Db and no table objects.
 *
 * `send` takes no `direction`, because the method that writes it decided it, and no transaction,
 * because a request that sends a Message has one statement in it. The constructor opens the
 * transaction carrying that statement and the Channel's own work.
 */
export type MessageOperations = MessageHistory & {
  send(userId: string, text: string): Promise<MessageRecord>;
};

/**
 * What these routes say about there being nothing to search by.
 *
 * Said in two places and written once. It ends the refusal below, and it is in both read routes'
 * descriptions. A caller who assumed a filter finds out at the first request.
 */
export const notSearchable =
  "A Message log is read by cursor and cannot be searched or filtered. The parameters are a window over one User's `seq`, and there is no full-text or field matching.";

/** The refusal these routes answer an unknown query parameter with, ending in the sentence above. */
export const rejectUnknownQuery = unknownQueryRefusal(notSearchable);

/**
 * How a client knows to ask again, which the envelope answers with no field of its own.
 *
 * A `hasMore` would be a second thing to keep true about a page whose length already says it, and
 * there is no read state anywhere to compute one against. That absence is only safe written down.
 */
export const fullPageMeansMore =
  "The envelope carries **no more-results flag**, because a full page is one. `messages.length === limit` means there may be more. The next request is this one with the cursor moved on. `after` takes the largest `seq` received, to walk forwards. `before` takes the smallest, to walk back. A short page is the end of that direction for now. There is no read state of any kind (no stored position, no unread count and no receipts). So the cursor a client needs is one it already holds, because it is holding the Messages.";

/** What both reads say about the `limit`: the shared sentences, and the two this one adds. */
export const capped = `${cappedLimit} The Messages past the cap are reachable by paging rather than lost. This is the one list in the framework with a cursor.`;

/**
 * The 404, which describes the referenced User rather than the route.
 *
 * What is worth a client's attention is where it comes from. There is no lookup in front of the
 * write, so this status is a constraint refusing rather than a check failing.
 */
const noSuchUser =
  "No User has that id, and nothing was stored. There is deliberately no lookup in front of the write: `userId` is a foreign key onto the User Manager's table, so a well-formed uuid naming nobody reaches the insert and the constraint is what refuses it. A malformed one never gets that far: the pattern on `userId` refuses it as a 400 first, which is what keeps a typo from being a 500 out of PostgreSQL.";

/**
 * The 503, which is this component's other failure and the one a caller acts on.
 *
 * It is described rather than left as a generic server error, because the right response to it is
 * to send the same thing again, and that is not what a 5xx usually means.
 */
export const lostTheRace =
  "The Message **was not recorded**, and sending it again is the right thing to do. Nothing is wrong with the request and the log is intact: `seq` is computed per User inside the insert and a unique constraint makes a lost race visible, so this is one User's own concurrent writers outrunning a bounded retry. A 503 and not a 500 for that reason.";

/**
 * The text of a Message: non-empty, and with no upper bound.
 *
 * `minLength: 1`, so a stray keypress is a 400 rather than a blank bubble. No `maxLength`, because
 * Fastify's `bodyLimit` is already the bound and it is the Operator's to raise.
 */
export const textSchema = { type: "string", minLength: 1 } as const;

/**
 * The body of the agent's `POST /`: which User, and what to say to them.
 *
 * `userId` is pattern-validated by the shared `idSchema`, because PostgreSQL refuses to cast a
 * malformed uuid. An agent that copied one wrong has earned a 400 rather than a 500. A well-formed
 * one naming nobody is the 404 the foreign key answers.
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
  properties: { user: idSchema, after: afterCursor, before: beforeCursor, limit: limitSchema },
  required: ["user"],
  additionalProperties: false,
} as const;

/**
 * `MessageRecord` on the wire, and the serializer both surfaces answer through.
 *
 * Fastify compiles a response schema with `fast-json-stringify`. It drops every field the schema
 * does not declare, and says nothing about it, so a field added to the type in `messages.ts` and
 * forgotten here is missing from every answer. The round trip in `gateway.test.ts` catches that.
 *
 * One shape for all four routes, and the reason it is exported: two of those routes are the HTTP
 * Channel's, and a Message has one shape whichever component serves it. The property descriptions
 * are on the two fields whose name is not the whole story. `seq` is the cursor and does not say so,
 * and `direction` is a field a caller cannot set.
 */
export const messageRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    userId: { type: "string" },
    direction: {
      type: "string",
      // From the same array the type and the database's CHECK constraint are. A direction added to
      // one is added to all three.
      enum: messageDirections,
      description:
        "Which way it travelled. **`inbound`** is the User to the agent and **`outbound`** is the agent to the User, and only a User can cause an inbound one. Decided by the server the request arrived on rather than by any field, so there is nothing anywhere for a caller to set.",
    },
    seq: {
      type: "integer",
      description:
        "This Message's number in **one User's** log, from 1, counting both directions. It is the cursor: the largest one held is what `after` takes to read whatever has arrived since. It is not global and no other User's activity moves it, so two Users' Messages are not orderable against each other by it.",
    },
    text: { type: "string" },
    createdAt: { type: "string" },
  },
  required: ["id", "userId", "direction", "seq", "text", "createdAt"],
} as const;

/**
 * A list answers in an envelope rather than as a bare array, which is the shared convention.
 *
 * This is where a cursor would go, and none is wanted: the largest `seq` in the page is already it.
 */
export const messageListSchema = {
  type: "object",
  properties: { messages: { type: "array", items: messageRecordSchema } },
  required: ["messages"],
} as const;

/**
 * What both reads answer with, and what both submissions do, each written once.
 *
 * The two surfaces differ in where the User comes from and in nothing about what comes back. A
 * sentence per surface would be two copies of one fact.
 */
export const theWindow =
  "The window that matched, ascending by `seq`, with both directions interleaved as the one log they are.";
export const theStoredMessage = "The Message as it was stored, including the `seq` it was given.";

/** The agent's Message routes, over the operations above. */
export function agentMessageRoutes(messageLog: MessageOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { userId: string; text: string } }>(
      "/",
      {
        schema: {
          tags: ["Messages"],
          summary: "Send a Message to one User",
          description: `An **outbound** Message: the agent to the User \`userId\` names. There is no \`direction\` field, and no way to write an inbound Message from this server. The server the request arrived on decides which way a Message travelled. An agent talked into speaking as somebody has nowhere to say so. A \`direction\` written into the body is stripped before the handler and reaches nothing. The Message is numbered as it is written, with the next \`seq\` in that User's log across both directions. The record answered is the stored one, so there is no read-back to do. ${unknownParameter}`,
          body: agentSendSchema,
          response: {
            201: { ...messageRecordSchema, description: theStoredMessage },
            400: refused(
              "`userId` is not a uuid, `text` is missing or empty, or a query parameter was written. A well-formed id naming nobody is a 404 rather than a 400, since only the write can tell.",
            ),
            404: refused(noSuchUser),
            503: refused(lostTheRace),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        // Outbound because this is the Agent server. The agent cannot write an inbound Message,
        // and the refusal is an absent parameter rather than a check.
        try {
          return reply
            .code(201)
            .send(await messageLog.send(request.body.userId, request.body.text));
        } catch (error) {
          return refuseSend(reply, error, request.body.userId);
        }
      },
    );

    fastify.get<{ Querystring: MessageWindow & { user: string } }>(
      "/",
      {
        schema: {
          tags: ["Messages"],
          summary: "Read one User's Message log",
          description: `One User's Messages, both directions, in the single numbered sequence that is their log. **\`user\` is required.** Not for confidentiality: reads are not scoped, and the agent may read every log there is. It is required because \`seq\` numbers one person's log and nothing else. An interleaved read would have no cursor to page by. ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${unknownParameter}`,
          querystring: agentHistorySchema,
          response: {
            200: { ...messageListSchema, description: theWindow },
            400: refused(
              "`user` is missing or not a uuid, a cursor or `limit` is not an integer or is out of range, both cursors were passed, or a parameter this route does not take was written.",
            ),
          },
        },
        preValidation: rejectUnknownQuery("user", "after", "before", "limit"),
      },
      // The whole difference between this read and a User's own is the line below. The User id
      // comes from a query parameter here, and from a Token there.
      async (request, reply) => answerHistory(reply, messageLog, request.query.user, request.query),
    );
  };
}

/**
 * The read both surfaces answer, and the one place the cursor rules are applied.
 *
 * A User's own read is the same query asked about the User their Token names. The two must not
 * become a parallel pair that can disagree about what `before` means, which is why the HTTP
 * Channel's plugin answers its own read through this function rather than through a copy. What a
 * cursor means is in `route-conventions.ts`, so the other components that page cannot disagree
 * either.
 */
export async function answerHistory(
  reply: FastifyReply,
  messageLog: MessageHistory,
  userId: string,
  asked: MessageWindow,
): Promise<FastifyReply | { readonly messages: MessageRecord[] }> {
  // Two windows in one request, refused with the shared 400. The noun that makes the refusal this
  // component's is "a User's Messages".
  if (asked.after !== undefined && asked.before !== undefined) {
    return bothCursors(reply, "a User's Messages");
  }
  // The envelope, matching `{ users: [...] }`, and with no `hasMore` in it. A full page says it,
  // because `messages.length === limit`.
  return { messages: await messageLog.history(userId, asked) };
}

/**
 * What a refused send answers with: the two things the insert can fail for.
 *
 * Anything else is rethrown as a 500. The 404 arrives from a caught error class rather than from a
 * branch, the foreign key being the only enforcement and there being no lookup in front of it.
 *
 * Both surfaces refuse through this one function, and only the agent can meet the 404: a User's own
 * post carries the id the Manager's hook just read a User by. So the Public route describes no 404,
 * and both submissions describe the 503.
 */
export function refuseSend(reply: FastifyReply, error: unknown, userId: string): FastifyReply {
  if (error instanceof UnknownUserError) return notFound(reply, "User", userId);
  if (error instanceof SeqContentionError) {
    // A 503 and not a 500. Nothing is wrong with the request, and a caller can send it again. The
    // same send gets a number when this User's writers stop outrunning it.
    return reply
      .code(503)
      .send({ statusCode: 503, error: "Service Unavailable", message: error.message });
  }
  throw error;
}
