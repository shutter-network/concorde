/**
 * The HTTP Messenger's routes, both groups at `/messages`, one per server.
 *
 * Two plugins, because they go on two Fastify instances. Neither is exported and neither prefix is
 * configurable. These routes are half of a contract, and the Signal `kind` and the record shape are
 * the other half. The paths below are relative, because the constructor supplies the prefix.
 *
 * | Agent server | Answers |
 * | --- | --- |
 * | `POST /messages` | 201, the created outbound `MessageRecord`; 404 if no such User; 503 |
 * | `GET /messages?user=&after=&before=&limit=` | `{ messages: [...] }`, ascending by `seq`; 400 |
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `POST /messages` | 201, the created inbound `MessageRecord`, and a Signal; 401; 503 |
 * | `GET /messages?after=&before=&limit=` | `{ messages: [...] }`, ascending by `seq`; 400; 401 |
 *
 * Nothing here authenticates anybody. Both Public routes take the User Manager's `requireUser` as
 * one option on the route, and read the User off `request.safUser`. `user` is required on the
 * agent's read, because `seq` numbers one User's log and cannot cursor an interleaved result. The
 * Public routes have no parameter naming a User at all, so no User can read another's log.
 *
 * Each route's own `description` is what `/openapi.json` serves, so those sentences are the API
 * documentation rather than commentary. The cursor rules are the sharpest of them, because no
 * schema conveys any part of them. The two Public routes describe their 401 and their Token in the
 * User Manager's own words, imported rather than restated.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
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
import { authenticationFailed, bearerRequired } from "../users/routes.ts";
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
 * A User's own read and the agent's are one implementation. The User id comes from a Token or from
 * a query parameter. Two of them could disagree about what `before` means, and no test of one
 * surface would catch it.
 */
export type MessageHistory = {
  history(userId: string, window: MessageWindow): Promise<MessageRecord[]>;
};

/**
 * What the agent's routes need: the shared read and a send, with no Db and no table objects.
 *
 * `send` takes no `direction`, because the server the request arrived on decided it. It takes no
 * transaction either, because a request that sends a Message has one statement in it.
 */
export type MessageOperations = MessageHistory & {
  send(userId: string, text: string): Promise<MessageRecord>;
};

/**
 * What a User's own routes need: the shared read, and a submission.
 *
 * `submit` takes neither a `direction` nor a transaction, for the reasons `send` takes neither. The
 * transaction that carries the insert and its Signal is this component's own to open. What comes
 * back is the stored record, which is what the 201 answers with and what the Signal payload is.
 */
export type OwnMessageOperations = MessageHistory & {
  submit(userId: string, text: string): Promise<MessageRecord>;
};

/**
 * What these routes say about there being nothing to search by.
 *
 * Said in two places and written once. It ends the refusal below, and it is in both read routes'
 * descriptions. A caller who assumed a filter finds out at the first request.
 */
const notSearchable =
  "A Message log is read by cursor and cannot be searched or filtered. The parameters are a window over one User's `seq`, and there is no full-text or field matching.";

/** The refusal these routes answer an unknown query parameter with, ending in the sentence above. */
const rejectUnknownQuery = unknownQueryRefusal(notSearchable);

/**
 * How a client knows to ask again, which the envelope answers with no field of its own.
 *
 * A `hasMore` would be a second thing to keep true about a page whose length already says it.
 * There is no read state anywhere to compute one against. That absence is only safe written down.
 */
const fullPageMeansMore =
  "The envelope carries **no more-results flag**, because a full page is one. `messages.length === limit` means there may be more. The next request is this one with the cursor moved on. `after` takes the largest `seq` received, to walk forwards. `before` takes the smallest, to walk back. A short page is the end of that direction for now. There is no read state of any kind (no stored position, no unread count and no receipts). So the cursor a client needs is one it already holds, because it is holding the Messages.";

/** What both reads say about the `limit`: the shared sentences, and the two this one adds. */
const capped = `${cappedLimit} The Messages past the cap are reachable by paging rather than lost. This is the one list in the framework with a cursor.`;

/**
 * The 404, which describes the referenced User rather than the route.
 *
 * What is worth a client's attention is where it comes from. There is no lookup in front of the
 * write. This status is a constraint refusing rather than a check failing.
 */
const noSuchUser =
  "No User has that id, and nothing was stored. There is deliberately no lookup in front of the write: `userId` is a foreign key onto the User Manager's table, so a well-formed uuid naming nobody reaches the insert and the constraint is what refuses it (ADR-0036). A malformed one never gets that far: the pattern on `userId` refuses it as a 400 first, which is what keeps a typo from being a 500 out of PostgreSQL.";

/**
 * The 503, which is this component's other failure and the one a caller acts on.
 *
 * It is described rather than left as a generic server error. The right response to it is to send
 * the same thing again. That is not what a 5xx usually means.
 */
const lostTheRace =
  "The Message **was not recorded**, and sending it again is the right thing to do. Nothing is wrong with the request and the log is intact: `seq` is computed per User inside the insert and a unique constraint makes a lost race visible, so this is one User's own concurrent writers outrunning a bounded retry (ADR-0035). A 503 and not a 500 for that reason.";

/**
 * The 401, which is the User Manager's and is described in its words.
 *
 * The imported sentence is the whole of what the refusal says. What this component adds is where it
 * comes from. A client reading a Message route learns that `/auth` answers the same.
 */
const notAuthenticated = `${authenticationFailed} This part authenticates nobody: the refusal is the User Manager's \`requireUser\`, taken as one option on the route, so it is the same 401 the routes under \`/auth\` answer.`;

/**
 * The text of a Message: non-empty, and with no upper bound.
 *
 * `minLength: 1`, so a stray keypress is a 400 rather than a blank bubble. No `maxLength`, because
 * Fastify's `bodyLimit` is already the bound and it is the Operator's to raise.
 */
const textSchema = { type: "string", minLength: 1 } as const;

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

/**
 * The body of a User's own `POST /`: what they said, and nothing else.
 *
 * There is no `userId` here and nowhere for one to arrive. The submitting User is the one their
 * Token named, which is what makes the attribution in the Signal payload trustworthy.
 *
 * A client that posts a `userId` anyway has it dropped by `additionalProperties: false`. So nobody
 * can put words in another User's mouth.
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
  properties: { user: idSchema, after: afterCursor, before: beforeCursor, limit: limitSchema },
  required: ["user"],
  additionalProperties: false,
} as const;

/**
 * A User's own read: the window, and nothing naming a User.
 *
 * The agent's schema above is this one plus a required `user`. That is the whole difference between
 * the two surfaces. There is no such property to omit here. A request cannot ask about somebody
 * else, so nothing has to refuse one.
 */
const ownHistorySchema = {
  type: "object",
  properties: { after: afterCursor, before: beforeCursor, limit: limitSchema },
  additionalProperties: false,
} as const;

/**
 * `MessageRecord` on the wire, and the serializer both surfaces answer through.
 *
 * Fastify compiles a response schema with `fast-json-stringify`. It drops every field the schema
 * does not declare, and says nothing about it. So a field added to the type in `messages.ts` and
 * forgotten here is missing from every answer. The round trip in `gateway.test.ts` catches that.
 *
 * One shape for all four routes. The 201 of either submission and the items of either read are the
 * same object. The property descriptions are on the two fields whose name is not the whole story.
 * `seq` is the cursor and does not say so, and `direction` is a field a caller cannot set.
 */
const messageRecordSchema = {
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
const messageListSchema = {
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
const theWindow =
  "The window that matched, ascending by `seq`, with both directions interleaved as the one log they are.";
const theStoredMessage = "The Message as it was stored, including the `seq` it was given.";

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
 * The Public server's Message routes: a User's own log, and the one way into it from outside.
 *
 * `presentedUser` is the User Manager's `requireUser`, taken as one option on each route and not
 * wrapped. So an unauthenticated read or post is the Manager's single 401, and this component
 * authenticates nobody.
 *
 * The hook runs at `preHandler`, after validation. So a malformed window, an unknown query
 * parameter and an empty `text` are answered before a Token is read. That leaks nothing: a refusal
 * names a parameter or a field, and never a User.
 */
export function publicMessageRoutes(
  messageLog: OwnMessageOperations,
  presentedUser: preHandlerAsyncHookHandler,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { text: string } }>(
      "/",
      {
        schema: {
          tags: ["Messages"],
          summary: "Submit a Message",
          description: `An **inbound** Message from the User the presented Token names. There is **no field for the submitting User and nowhere for one to arrive**. The id comes from the Token and from nothing a client can write, which is what makes the attribution trustworthy. A \`userId\` written into the body is stripped before the handler and reaches nothing. The Message and the Signal that wakes the agent for it are one transaction. A Message that was stored always has one. What the agent makes of it is **not this response**. An answer arrives on the log as an outbound Message whenever it arrives, which is what \`after=<seq>\` is for. ${bearerRequired} ${unknownParameter}`,
          body: submitSchema,
          response: {
            201: {
              ...messageRecordSchema,
              description: `${theStoredMessage} That number is the cursor to poll from for the answer.`,
            },
            400: refused("`text` is missing or empty, or a query parameter was written."),
            401: refused(notAuthenticated),
            503: refused(lostTheRace),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectUnknownQuery(),
      },
      // Inbound, because this is the Public server's plugin, and by the User the Token named.
      // There is no field on this route for a client to put a User in. What `submit` does with it
      // is the constructor's, because a route holds no Db: one Message and one Signal, together.
      async (request, reply) => {
        try {
          return reply
            .code(201)
            .send(await messageLog.submit(request.safUser.id, request.body.text));
        } catch (error) {
          return refuseSend(reply, error, request.safUser.id);
        }
      },
    );

    fastify.get<{ Querystring: MessageWindow }>(
      "/",
      {
        schema: {
          tags: ["Messages"],
          summary: "Read your own Message log",
          description: `The presented User's own Messages, both directions, in the single numbered sequence that is their log. There is **no user parameter and nothing to omit**. The log read is the one the Token names. No User can read another's by any spelling of the request. \`?user=\` is refused as the unknown parameter it is. ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${bearerRequired} ${unknownParameter}`,
          querystring: ownHistorySchema,
          response: {
            200: { ...messageListSchema, description: theWindow },
            400: refused(
              "A cursor or `limit` is not an integer or is out of range, both cursors were passed, or a parameter this route does not take was written, `user` among them, since this route has none.",
            ),
            401: refused(notAuthenticated),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectUnknownQuery("after", "before", "limit"),
      },
      // The whole difference from the agent's read is the User id. Theirs comes from a query
      // parameter, and this one from the Token the hook above verified.
      async (request, reply) => answerHistory(reply, messageLog, request.safUser.id, request.query),
    );
  };
}

/**
 * The read both surfaces answer, and the one place this component applies the cursor rules.
 *
 * A User's own read is the same query asked about the User their Token names. The two must not
 * become a parallel pair that can disagree about what `before` means. What a cursor means is in
 * `route-conventions.ts`, so the other components that page cannot disagree either.
 */
async function answerHistory(
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
 * branch. The foreign key is the only enforcement, and there is no lookup in front of it.
 *
 * Both surfaces refuse through this one function, and only the agent can meet the 404. A User's own
 * post carries the id the Manager's hook just read a User by. So the Public route describes no 404,
 * and both submissions describe the 503.
 */
function refuseSend(reply: FastifyReply, error: unknown, userId: string): FastifyReply {
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
