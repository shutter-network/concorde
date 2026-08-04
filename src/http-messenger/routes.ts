/**
 * The HTTP Messenger's contributions to the two servers, both of them at `/messages`.
 *
 * Two plugins and not one, because they are registered on different Fastify instances
 * listening on different addresses. Unlike the User Manager's, **neither is exported and
 * neither prefix is configurable**, which is this part's stated departure from ADR-0032's
 * door-out pattern: these routes are half of a contract whose other half is the Signal
 * `kind`, the record shape and a client written against both, so an Operator who wants
 * them somewhere else wants a different messaging part (ADR-0034, ADR-0021). The paths
 * below are still relative, because the constructor supplies the prefix.
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
 * Nothing here authenticates anybody. The Agent server has no authentication at all
 * (ADR-0010), and both Public routes take the User Manager's `requireUser` as **one option
 * on the route**, which is exactly what `src/users/users.ts` already promised: the User is
 * read off `request.safUser`, every refusal is the Manager's single 401, and this part
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
 * The cursor pair and the window it describes, the capped limit, the envelope, the
 * pattern-validated id, the refusal of an unknown query parameter, the refusal of both
 * cursors at once and the 404 body are the conventions in `route-conventions.ts` that every
 * part's routes share; what is this part's is the noun each refusal names and the sentence
 * it ends with.
 *
 * Every route also **describes what it answers with**, which is how a person writing a
 * client learns how to submit a Message and how to page a log without reading the
 * quickstart, and how an Agent Implementation learns the same for its own two
 * ([ADR-0040](../../docs/adr/0040-the-gateway-describes-its-own-http-api.md)). The
 * sentences below are load-bearing prose rather than commentary: they are what
 * `/openapi.json` serves. **The cursor rules are the sharpest of them**, because no schema
 * conveys any of them, and they are imported rather than written here for the reason the
 * schema they describe is. What this part says on top of them is what its own log is, that
 * a full page is the only more-results flag there is, and that nothing here can be
 * searched.
 *
 * The two Public routes describe their 401 and their Token in the **User Manager's own
 * words**, imported rather than restated, because it is the Manager's hook that refuses
 * them and this part still authenticates nobody (ADR-0030). Note the asymmetry that
 * creates: the hook arrives as an argument and its description as an import. A third
 * parameter carrying two strings would make that tidy and the constructor's call site
 * worse, and the sentences are the Manager's under either spelling.
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
 * What these routes say about there being nothing to search by.
 *
 * The convention and its reasoning are in `route-conventions.ts`; the sentence is this
 * part's. It says outright that there is nothing to search by, because the alternative —
 * `?text=hello` quietly returning the newest fifty Messages — reads as though a filter had
 * been applied. Said in two places and written once: it is how the refusal below ends, and
 * it is in the description of both read routes, so the sentence a caller is refused with
 * and the sentence the document carries cannot come apart.
 */
const notSearchable =
  "A Message log is read by cursor and cannot be searched or filtered: the parameters are a window over one User's `seq`, and there is no full-text or field matching of any kind.";

/**
 * The refusal these routes answer an unknown query parameter with.
 *
 * The convention and its reasoning are in `route-conventions.ts`; the sentence the message
 * ends with is this part's, and it is the one above.
 */
const rejectUnknownQuery = unknownQueryRefusal(notSearchable);

/**
 * How a client knows to ask again, which is the question the envelope deliberately does not
 * answer with a field.
 *
 * A `hasMore` would be a second thing to keep true about a page whose length already says
 * it, and there is no read state anywhere for it to be computed against (ADR-0035). That
 * absence is only safe if it is written down, which is what this is for.
 */
const fullPageMeansMore =
  "The envelope carries **no more-results flag**, because a full page is one: `messages.length === limit` means there may be more, and the next request is this one with the cursor moved on, `after` set to the largest `seq` received when walking forwards and `before` set to the smallest when walking back. A short page is the end of that direction for now. There is no read state of any kind (no stored position, no unread count and no receipts), so the cursor a client needs is one it already holds, because it is holding the Messages.";

/**
 * What both reads say about the `limit`: the shared two sentences, and the one this part
 * adds.
 *
 * The Signal Worker's records past the cap are reachable only by narrowing and the User
 * Manager's are not reachable at all. This is the one list in the framework with a cursor,
 * so the honest sentence here is the cheerful one.
 */
const capped = `${cappedLimit} The Messages past the cap are reachable by paging rather than lost: this is the one list in the framework with a cursor.`;

/**
 * The 404, which describes the **referenced User** rather than the route.
 *
 * What is worth a client's attention is where it comes from: there is no lookup in front of
 * the write, so this status is a constraint refusing rather than a check failing, and it is
 * the only thing anywhere that says whether a `userId` names somebody (ADR-0036).
 */
const noSuchUser =
  "No User has that id, and nothing was stored. There is deliberately no lookup in front of the write: `userId` is a foreign key onto the User Manager's table, so a well-formed uuid naming nobody reaches the insert and the constraint is what refuses it (ADR-0036). A malformed one never gets that far: the pattern on `userId` refuses it as a 400 first, which is what keeps a typo from being a 500 out of PostgreSQL.";

/**
 * The 503, which is this part's other failure and the one a caller should act on.
 *
 * It is worth describing rather than leaving as a generic server error precisely because
 * the right response to it is to send the same thing again, which is not what a 5xx usually
 * means (ADR-0035).
 */
const lostTheRace =
  "The Message **was not recorded**, and sending it again is the right thing to do. Nothing is wrong with the request and the log is intact: `seq` is computed per User inside the insert and a unique constraint makes a lost race visible, so this is one User's own concurrent writers outrunning a bounded retry (ADR-0035). A 503 and not a 500 for that reason.";

/**
 * The 401, which is the User Manager's and is described in its words.
 *
 * The imported sentence is the whole of what the refusal says; what this part adds is where
 * it comes from, since a client reading a Message route should not have to discover that
 * the hook belongs to another part to know that the answer is identical there (ADR-0030).
 */
const notAuthenticated = `${authenticationFailed} This part authenticates nobody: the refusal is the User Manager's \`requireUser\`, taken as one option on the route, so it is the same 401 the routes under \`/auth\` answer.`;

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
  properties: { user: idSchema, after: afterCursor, before: beforeCursor, limit: limitSchema },
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
  properties: { after: afterCursor, before: beforeCursor, limit: limitSchema },
  additionalProperties: false,
} as const;

/**
 * `MessageRecord` on the wire, and **the serializer both surfaces answer through** rather
 * than a description of one.
 *
 * Fastify compiles a response schema with `fast-json-stringify`, which drops every field the
 * schema does not declare and says nothing about it, so a field added to the type in
 * `messages.ts` and forgotten here is silently missing from every answer of this part,
 * including the Signal payload's twin, which is the same record and reaches a Handler
 * unserialized ([ADR-0040](../../docs/adr/0040-the-gateway-describes-its-own-http-api.md)).
 * That is why `default-gateway.test.ts` reads a log the Messenger actually recorded and
 * compares the whole thing.
 *
 * One shape for all four routes, as there is one shape for all six surfaces of this part:
 * the 201 of either submission and the items of either read are the same object, and a
 * projection per surface would be the parallel pair ADR-0034 keeps refusing.
 *
 * The property descriptions are on the two fields whose name is not the whole story.
 * `id`, `userId` and `createdAt` get none; `seq` is the cursor and does not say so, and
 * `direction` is the one field a caller cannot set and would otherwise expect to.
 */
const messageRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    userId: { type: "string" },
    direction: {
      type: "string",
      // From the same array the type and the database's CHECK constraint are, so a
      // direction added to one is added to all three.
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
 * A list answers in an envelope rather than as a bare array, which is the convention in
 * `route-conventions.ts`. Here it is also where a cursor would have gone had one been
 * wanted. None is: the largest `seq` in the page is already it (ADR-0035).
 */
const messageListSchema = {
  type: "object",
  properties: { messages: { type: "array", items: messageRecordSchema } },
  required: ["messages"],
} as const;

/**
 * What both reads answer with, and what both submissions do, each written once.
 *
 * The two surfaces differ in where the User comes from and in nothing about what comes
 * back, so a sentence per surface would be two copies of one fact under the same policy
 * `notSearchable` above is written once for.
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
          description: `An **outbound** Message: the agent to the User \`userId\` names. There is no \`direction\` field and no way to write an inbound Message from this server: which way a Message travelled is decided by the server the request arrived on, so an agent talked into speaking as somebody has nowhere to say so, and a \`direction\` written into the body is stripped before the handler and reaches nothing (ADR-0034). The Message is numbered as it is written, with the next \`seq\` in that User's log across both directions, and the record answered is the stored one, so there is no read-back to do. ${unknownParameter}`,
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
        // Outbound because this is the Agent server. The agent cannot write an inbound
        // Message, and the refusal is the absence of a parameter rather than a check: a
        // prompt injection has nowhere to put one (ADR-0034).
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
          description: `One User's Messages, both directions, in the single numbered sequence that is their log. **\`user\` is required.** Not for confidentiality, since reads are not scoped and the agent may read every log there is (ADR-0011), but because \`seq\` numbers one person's log and nothing else: a log belongs to one person, and an interleaved read would have no cursor to page by. ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${unknownParameter}`,
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
 * `presentedUser` is the User Manager's `requireUser`, taken as one option on each route
 * and not wrapped, extended or re-implemented. So an unauthenticated read or post is the
 * Manager's single 401 — a missing header, a header in another scheme, an unknown Token
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
        schema: {
          tags: ["Messages"],
          summary: "Submit a Message",
          description: `An **inbound** Message from the User the presented Token names. There is **no field for the submitting User and nowhere for one to arrive**: the id comes from the Token and from nothing a client can write, which is what makes the attribution trustworthy, and a \`userId\` written into the body is stripped before the handler and reaches nothing. The Message and the Signal that wakes the agent for it are one transaction, so a Message that was stored always has one. What the agent makes of it is **not this response**: an answer arrives on the log as an outbound Message whenever it arrives, which is what \`after=<seq>\` is for. ${bearerRequired} ${unknownParameter}`,
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
          description: `The presented User's own Messages, both directions, in the single numbered sequence that is their log. There is **no user parameter and nothing to omit**: the log read is the one the Token names, so no User can read another's by any spelling of the request, and \`?user=\` is refused as the unknown parameter it is. ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${bearerRequired} ${unknownParameter}`,
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
      // The whole difference from the agent's read is the User id: theirs comes from a
      // query parameter, this one from the Token the hook above verified. There is no
      // parameter here a client could put a User in, so nothing can read another's log.
      async (request, reply) => answerHistory(reply, messageLog, request.safUser.id, request.query),
    );
  };
}

/**
 * The read both surfaces answer, and the one place this part applies the cursor rules.
 *
 * Written here rather than inside the agent's handler because a User's own read is the same
 * query asked about the User their Token names: the two must not become a parallel pair
 * that can disagree about what `before` means. What a cursor *means* is not this part's and
 * is in `route-conventions.ts`, for the same reason one file up: the other parts that page
 * must not disagree with this one either.
 */
async function answerHistory(
  reply: FastifyReply,
  messageLog: MessageHistory,
  userId: string,
  asked: MessageWindow,
): Promise<FastifyReply | { readonly messages: MessageRecord[] }> {
  // Two windows in one request, refused with the shared 400 and the noun that makes it this
  // part's: what a caller reading Messages asked about is a User's Messages.
  if (asked.after !== undefined && asked.before !== undefined) {
    return bothCursors(reply, "a User's Messages");
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
 * User's own post carries the id the Manager's hook just looked a User up by, and nothing
 * removes a User (ADR-0029). So the Public route **does not describe a 404**, which is the
 * document following the code rather than this function: describing one would be a branch a
 * client writes and never takes. The contention a busy log can lose is reachable from
 * either, and both describe the 503.
 *
 * Named for the act rather than for the status, since `refused` is the conventions module's
 * word for describing one in the document and this is the one answering it.
 */
function refuseSend(reply: FastifyReply, error: unknown, userId: string): FastifyReply {
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
