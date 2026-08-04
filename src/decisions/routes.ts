/**
 * Decisions' contributions to the two servers, both of them at `/decisions`.
 *
 * Two plugins and not one, because they are registered on different Fastify instances
 * listening on different addresses. Neither is exported and neither prefix is configurable, on
 * the HTTP Messenger's reasoning: these routes are half of a contract whose other half is the
 * artifact shape and a verifier written against it (ADR-0034, ADR-0042). The paths below are
 * still relative, because the constructor supplies the prefix.
 *
 * | Agent server | Answers |
 * | --- | --- |
 * | `POST /decisions` | 201, the published `DecisionRecord`; 400 |
 * | `GET /decisions?after=&before=&limit=` | `{ decisions: [...] }`, ascending by `seq`; 400 |
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `GET /decisions?after=&before=&limit=` | the same read; 400; 401 |
 *
 * **The two reads are one query and differ in nothing but the hook.** The log is global, so
 * there is no `?user=` on the agent's read and no Token-derived subject on the User's: what a
 * cursored read of this log asks is the window and nothing else. That is the whole difference
 * from the HTTP Messenger's pair, where the two surfaces differ in where the User comes from
 * ([ADR-0043](../../docs/adr/0043-decisions-are-one-global-log.md)).
 *
 * **Publishing is the Agent server's alone.** There is no public route that writes a Decision
 * and no plan for one: a Decision is the Shared Agent's commitment, and a User with a Token is
 * not the Shared Agent. That is also what makes every writer serial, since the agent can only
 * publish during a Run.
 *
 * Nothing here authenticates anybody. The Agent server has no authentication at all (ADR-0010),
 * and the Public read takes the User Manager's `requireUser` as **one option on the route**, so
 * the User is read off `request.safUser` — where it is, in fact, ignored, there being nothing
 * on this surface scoped to one — and every refusal is the Manager's single 401.
 *
 * The cursor pair and the window it describes, the capped limit, the envelope, the refusal of
 * an unknown query parameter, the refusal of both cursors at once and the shared error body are
 * the conventions in `route-conventions.ts` that every part's routes share; what is this part's
 * is the noun each refusal names and the sentence it ends with.
 *
 * Every route also **describes what it answers with**, which is how a person writing a verifier
 * learns the shape of an artifact and how an Agent Implementation learns how to publish one
 * ([ADR-0040](../../docs/adr/0040-the-gateway-describes-its-own-http-api.md)). The sentences
 * below are load-bearing prose rather than commentary: they are what `/openapi.json` serves.
 * Two of them carry more weight than the rest — what the `jws` is and how to check it without
 * us, and what a signature does **not** prove — because a reader who gets either wrong has been
 * misled by the document rather than by themselves.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import {
  afterCursor,
  beforeCursor,
  bothCursors,
  cappedLimit,
  cursorCases,
  limitSchema,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";
import { authenticationFailed, bearerRequired } from "../users/routes.ts";
import type { DecisionRecord, DecisionWindow } from "./decisions.ts";

/**
 * The read **both** surfaces need of the part, and the reason it is a type of its own.
 *
 * The agent's read and a User's are one implementation with nothing at all to distinguish them,
 * so two of these would be two chances to disagree about what `before` means — a thing no
 * client could report and no test of one surface would catch (ADR-0035).
 */
export type DecisionHistory = {
  history(window: DecisionWindow): Promise<DecisionRecord[]>;
};

/**
 * What the agent's routes need of the part, and no more: the shared read and a publish, with no
 * Db, no table objects and no signature.
 *
 * `publish` takes the statement and nothing else. There is deliberately **no parameter for the
 * artifact**: the signature is not something a caller supplies, so no path anywhere puts a
 * caller's own bytes into the `jws` column. It takes no transaction either, and does not need
 * one: a request that publishes has exactly one thing to record, so the part opens the
 * transaction the write path needs and a route holds nothing (ADR-0023).
 */
export type DecisionOperations = DecisionHistory & {
  publish(statement: string): Promise<DecisionRecord>;
};

/**
 * What these routes say about there being nothing to search by.
 *
 * The convention and its reasoning are in `route-conventions.ts`; the sentence is this part's.
 * It says outright that there is nothing to search by, because the alternative —
 * `?statement=ship` quietly returning the newest fifty Decisions — reads as though a filter had
 * been applied. Said in two places and written once: it is how the refusal below ends, and it
 * is in the description of both reads, so the sentence a caller is refused with and the
 * sentence the document carries cannot come apart.
 */
const notSearchable =
  "The Decision log is read by cursor and cannot be searched or filtered: the parameters are a window over `seq`, and there is no full-text or field matching of any kind.";

/**
 * The refusal these routes answer an unknown query parameter with.
 *
 * The convention and its reasoning are in `route-conventions.ts`; the sentence the message ends
 * with is this part's, and it is the one above.
 */
const rejectUnknownQuery = unknownQueryRefusal(notSearchable);

/**
 * How a client knows to ask again, which is the question the envelope deliberately does not
 * answer with a field.
 *
 * A `hasMore` would be a second thing to keep true about a page whose length already says it,
 * and there is no read state anywhere for it to be computed against (ADR-0035).
 */
const fullPageMeansMore =
  "The envelope carries **no more-results flag**, because a full page is one: `decisions.length === limit` means there may be more, and the next request is this one with the cursor moved on, `after` set to the largest `seq` received when walking forwards and `before` set to the smallest when walking back. A short page is the end of that direction for now. There is no read state of any kind, so the cursor a client needs is one it already holds, because it is holding the Decisions.";

/**
 * What both reads say about the `limit`: the shared two sentences, and the one this part adds.
 *
 * Like the Message log and unlike the two lists the Signal Worker and the User Manager answer,
 * this one has a cursor, so the honest sentence here is the cheerful one.
 */
const capped = `${cappedLimit} The Decisions past the cap are reachable by paging rather than lost.`;

/**
 * What is on every read of this log and on nothing else in the framework: the sentence saying
 * it is one log, shared, and the same for everybody.
 *
 * Worth stating to a client author because every other read they will meet here is scoped to
 * one User, and a reader who assumes this one is too will build a per-User cache of a sequence
 * that other people move.
 */
const oneSharedLog =
  "**One global log, the same for every reader.** A Decision is addressed to nobody: there is no recipient, no group and no parameter naming a User anywhere on this route, and `seq` numbers the one log rather than anybody's slice of it. So two Users reading the same window get the same records in the same order, and a number moving is somebody else's activity, which on a surface published to everyone on purpose is the function rather than a leak (ADR-0043).";

/**
 * What the artifact is and what to do with it, which is the sentence the whole part exists for.
 *
 * It names the offline path first and deliberately: a reader who meets a Gateway-supplied
 * verdict before the key set will take the convenient answer, and the convenient answer is
 * worth nothing to the third party this identity exists for (ADR-0042).
 */
const whatTheArtifactIs =
  "Each record carries `jws`, a **compact JWS** (RFC 7515) over `{ seq, createdAt, statement }` — one URL-safe string, verifiable by any off-the-shelf JOSE library in any language. Take it away and check it against the public key at `GET /jwks.json` on the Public server, offline and without asking this Gateway anything, which is the only verification worth something to somebody who does not trust the Operator. What it proves is narrow: **that the Operator committed to this Statement on the Shared Agent's behalf, and nothing whatever about how the agent behaved** (ADR-0041).";

/**
 * The 401, which is the User Manager's and is described in its words.
 *
 * The imported sentence is the whole of what the refusal says; what this part adds is where it
 * comes from, since a client reading a Decision route should not have to discover that the hook
 * belongs to another part to know the answer is identical there (ADR-0030).
 */
const notAuthenticated = `${authenticationFailed} This part authenticates nobody: the refusal is the User Manager's \`requireUser\`, taken as one option on the route, so it is the same 401 the routes under \`/auth\` answer.`;

/**
 * The statement of a Decision: non-empty, and with **no upper bound**.
 *
 * `minLength: 1` so that an empty commitment is a 400 rather than a signed nothing. No
 * `maxLength`, because Fastify's `bodyLimit` is already the bound and it is the Operator's to
 * raise on the server they constructed — a second number of ours would shadow one they can
 * already set (ADR-0043).
 */
const statementSchema = { type: "string", minLength: 1 } as const;

/**
 * The body of `POST /`: what is being committed to, and nothing else.
 *
 * There is **no field for the artifact, the number or the timestamp**, and nowhere for one to
 * arrive: all three are produced by the write path, in that order, because the signature binds
 * the first two. A caller that writes one anyway has it dropped by `additionalProperties: false`
 * and reaches nothing.
 */
const publishSchema = {
  type: "object",
  properties: { statement: statementSchema },
  required: ["statement"],
  additionalProperties: false,
} as const;

/**
 * A read of the log: the window, and **nothing naming a User**.
 *
 * One schema for both surfaces, which is the difference from the HTTP Messenger's pair: there
 * the agent's read is a User's plus a required `user`, and here there is no such property to
 * add, because the log has no owner to scope it to.
 */
const historySchema = {
  type: "object",
  properties: { after: afterCursor, before: beforeCursor, limit: limitSchema },
  additionalProperties: false,
} as const;

/**
 * `DecisionRecord` on the wire, and **the serializer every surface answers through** rather
 * than a description of one.
 *
 * Fastify compiles a response schema with `fast-json-stringify`, which drops every field the
 * schema does not declare and says nothing about it, so a field added to the type in
 * `decisions.ts` and forgotten here is silently missing from every answer of this part
 * (ADR-0040). That is why `default-gateway.test.ts` reads a log this part actually recorded and
 * compares the whole thing.
 *
 * One shape for all three routes, as there is one shape for every surface of this part: the 201
 * of a publish and the items of either read are the same object.
 *
 * The property descriptions are on the three fields whose name is not the whole story. `seq` is
 * the cursor and does not say so; `jws` is the reason the part exists and would otherwise read
 * as a checksum; `createdAt` is normally left undescribed here and is not, because it is inside
 * the signature and a reader needs to know that it is the publisher's clock rather than the
 * database's. `statement` needs none: it is the string that was committed to.
 */
const decisionRecordSchema = {
  type: "object",
  properties: {
    seq: {
      type: "integer",
      description:
        "This Decision's number in the one global log, from 1. It is the cursor: the largest one held is what `after` takes to read whatever has been published since. **Gaps are expected and mean nothing** — a rolled-back publish burns a number — so a missing number is not a withheld Decision and nothing anywhere could tell you if it were.",
    },
    statement: { type: "string" },
    jws: {
      type: "string",
      description:
        'The **Decision itself**: a compact JWS, `header.payload.signature`, base64url. Its payload carries this record\'s `seq`, `createdAt` and `statement`, so everything above can be read back out of it by anybody holding the public key — which is what makes handing this one string to a third party the whole point. Its protected header carries `typ: "saf-decision+jws"`, covered by the signature, so an artifact of another kind cannot be presented as a Decision.',
    },
    createdAt: {
      type: "string",
      description:
        "When it was published, ISO 8601. Generated by the Gateway when the artifact was signed rather than by the database, because the signed timestamp and the stored one are the same value: this is the timestamp inside `jws`.",
    },
  },
  required: ["seq", "statement", "jws", "createdAt"],
} as const;

/**
 * A list answers in an envelope rather than as a bare array, which is the convention in
 * `route-conventions.ts`. Here it is also where a cursor would have gone had one been wanted.
 * None is: the largest `seq` in the page is already it (ADR-0035).
 */
const decisionListSchema = {
  type: "object",
  properties: { decisions: { type: "array", items: decisionRecordSchema } },
  required: ["decisions"],
} as const;

/** What both reads answer with, and what a publish does, each written once. */
const theWindow = "The window that matched, ascending by `seq`.";
const thePublishedDecision =
  "The Decision as it was published, including the number it was given and the artifact signed over it.";

/** The agent's Decision routes, over the operations above. */
export function agentDecisionRoutes(log: DecisionOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { statement: string } }>(
      "/",
      {
        schema: {
          tags: ["Decisions"],
          summary: "Publish a Decision",
          description: `Commit to something, on the record, to everybody. The Statement is signed with the Shared Agent's key and kept in the one global log, and the record answered carries the artifact, so there is no read-back to do and the agent can quote it to a User in the same Run.\n\nThere is **no field for the number, the timestamp or the signature**: the number is drawn first, the timestamp second and the artifact last, in that order and inside one transaction, because the signature binds the other two. Nothing is notified — publishing wakes no Signal and no Handler, so a Decision published during a Run cannot queue work for the Run that published it (ADR-0043). ${whatTheArtifactIs} ${unknownParameter}`,
          body: publishSchema,
          response: {
            201: { ...decisionRecordSchema, description: thePublishedDecision },
            400: refused("`statement` is missing or empty, or a query parameter was written."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => reply.code(201).send(await log.publish(request.body.statement)),
    );

    fastify.get<{ Querystring: DecisionWindow }>(
      "/",
      {
        schema: {
          tags: ["Decisions"],
          summary: "Read the Decision log",
          description: `Every Decision this Shared Agent has published, which is the same log a User reads and the same one this agent published into. A Session is a lossy cache, so an agent with no memory of what it decided reads it here (ADR-0011). ${oneSharedLog} ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${unknownParameter}`,
          querystring: historySchema,
          response: {
            200: { ...decisionListSchema, description: theWindow },
            400: refused(
              "A cursor or `limit` is not an integer or is out of range, both cursors were passed, or a parameter this route does not take was written.",
            ),
          },
        },
        preValidation: rejectUnknownQuery("after", "before", "limit"),
      },
      async (request, reply) => answerHistory(reply, log, request.query),
    );
  };
}

/**
 * The Public server's Decision route: the same read, behind the User Manager's single 401.
 *
 * `presentedUser` is `requireUser`, taken as one option on the route and not wrapped, extended
 * or re-implemented. So an unauthenticated read is the Manager's single 401 — a missing header,
 * a header in another scheme, an unknown Token and an expired one alike — and this part
 * authenticates nobody (ADR-0030).
 *
 * **The Token is required and the User it names is then unused**, which is worth meeting head
 * on rather than reading as a bug. It gates the surface rather than scoping the answer: the
 * Gateway is not a public bulletin board for whoever finds the port, and a User is who publishes
 * a Decision onward out of band rather than the Gateway itself. `GET /jwks.json` is the one
 * exception on this server, a public key being public (ADR-0043).
 *
 * The hook runs at `preHandler`, after validation, so a malformed window and an unknown query
 * parameter are both answered before a Token is looked at. That is the order every other Public
 * route already answers in, and it leaks nothing: a refusal names a parameter of the route and
 * never a User.
 */
export function publicDecisionRoutes(
  log: DecisionHistory,
  presentedUser: preHandlerAsyncHookHandler,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: DecisionWindow }>(
      "/",
      {
        schema: {
          tags: ["Decisions"],
          summary: "Read the Decision log",
          description: `Everything this Shared Agent has committed to, which is what it said on everybody's behalf rather than what it said to you. Reading it is the first half of the only thing this log is for; the second is taking a \`jws\` away and showing it to somebody who does not trust this Gateway. ${oneSharedLog} ${whatTheArtifactIs} ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${bearerRequired} ${unknownParameter}`,
          querystring: historySchema,
          response: {
            200: { ...decisionListSchema, description: theWindow },
            400: refused(
              "A cursor or `limit` is not an integer or is out of range, both cursors were passed, or a parameter this route does not take was written, `user` among them, since this log has no owner.",
            ),
            401: refused(notAuthenticated),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectUnknownQuery("after", "before", "limit"),
      },
      // The User the hook just verified is deliberately not read: there is nothing here to
      // scope, so the whole difference between this read and the agent's is the line above.
      async (request, reply) => answerHistory(reply, log, request.query),
    );
  };
}

/**
 * The read both surfaces answer, and the one place this part applies the cursor rules.
 *
 * Written here rather than inside either handler because the two are the same query asked by
 * two callers: they must not become a parallel pair that can disagree about what `before`
 * means. What a cursor *means* is not this part's and is in `route-conventions.ts`, for the
 * same reason one file up: the other part that pages must not disagree with this one either.
 */
async function answerHistory(
  reply: FastifyReply,
  log: DecisionHistory,
  asked: DecisionWindow,
): Promise<FastifyReply | { readonly decisions: DecisionRecord[] }> {
  // Two windows in one request, refused with the shared 400 and the noun that makes it this
  // part's: what a caller reading this log asked about is the Decisions.
  if (asked.after !== undefined && asked.before !== undefined) {
    return bothCursors(reply, "the Decision log");
  }
  // The envelope, matching `{ messages: [...] }` and `{ users: [...] }`, and with no `hasMore`
  // in it: a full page says it, since `decisions.length === limit`.
  return { decisions: await log.history(asked) };
}
