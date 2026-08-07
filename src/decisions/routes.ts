/**
 * Two plugins, because they go on two Fastify instances. Neither is exported and neither prefix is
 * configurable. The paths below are relative to the prefix the constructor supplies, `/decisions`.
 *
 * | Agent server | Answers |
 * | --- | --- |
 * | `POST /` | 201, the published `DecisionRecord`; 400 |
 * | `GET /?after=&before=&limit=` | `{ decisions: [...] }`, ascending by `seq`; 400 |
 * | `GET /:seq` | one `DecisionRecord`; 400; 404 |
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `GET /?after=&before=&limit=` | the same read; 400; 401 |
 * | `GET /:seq` | the same one record; 400; 401; 404 |
 *
 * The four reads are one query. The log is global, so there is no `?user=` and no Token-derived
 * subject. The two surfaces differ in nothing but the hook. The by-number pair is that same read,
 * with the cursor worked out for the caller. So a citation and a page cannot disagree.
 *
 * Publishing is the Agent server's alone. A Decision is the Shared Agent's commitment, and a User
 * with a Token is not the Shared Agent. Nothing here authenticates anybody: the Public read takes
 * the User Manager's `requireUser` as one option, so every refusal is the Manager's single 401.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import {
  afterCursor,
  beforeCursor,
  bothCursors,
  cappedLimit,
  cursorCases,
  limitSchema,
  notFound,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";
import { authenticationFailed, bearerRequired } from "../users/routes.ts";
import type { DecisionRecord, DecisionWindow } from "./decisions.ts";

/**
 * The reads both surfaces need of the Component: the log, and one record by number.
 *
 * One type for the two of them. The agent's reads and a User's are one implementation with nothing
 * to distinguish them. A second type would be a second chance to disagree about what `before`
 * means.
 */
export type DecisionReads = {
  history(window: DecisionWindow): Promise<DecisionRecord[]>;
  /**
   * One Decision by its number, or nothing, which is what the 404 is made of.
   *
   * A method rather than a window the routes assemble, so the arithmetic turning a number into a
   * cursor lives once. `undefined` and not a thrown error, because a number nobody has is an
   * ordinary answer here. Gaps are expected and mean nothing.
   */
  numbered(seq: number): Promise<DecisionRecord | undefined>;
};

/**
 * What the agent's routes need: the shared reads, and a publish.
 *
 * `publish` takes the Statement and nothing else. There is no parameter for the artifact, so no
 * path anywhere puts a caller's own bytes into the `jws` column. It takes no transaction either,
 * because a request that publishes has one thing to record.
 */
export type DecisionOperations = DecisionReads & {
  publish(statement: string): Promise<DecisionRecord>;
};

/**
 * What these routes say about there being nothing to search by.
 *
 * Said in two places and written once. It ends the refusal below, and it is in the description of
 * both reads. The alternative is `?statement=ship` quietly answering the newest fifty Decisions,
 * which reads as though a filter had been applied.
 */
const notSearchable =
  "The Decision log is read by cursor and cannot be searched or filtered. The parameters are a window over `seq`. There is no full-text or field matching of any kind.";

/** The refusal these routes answer an unknown query parameter with. */
const rejectUnknownQuery = unknownQueryRefusal(notSearchable);

/**
 * How a client knows to ask again, which is the question the envelope answers with no field.
 *
 * A `hasMore` would be a second thing to keep true about a page whose length already says it. There
 * is no read state anywhere to compute one against.
 */
const fullPageMeansMore =
  "The envelope carries **no more-results flag**, because a full page is one. `decisions.length === limit` means there can be more. The next request is this one with the cursor moved on. Walking forwards, set `after` to the largest `seq` received. Walking back, set `before` to the smallest. A short page is the end of that direction for now. There is no read state of any kind, so the cursor a client needs is one it already holds.";

/** What both reads say about the `limit`: the shared sentences, and one more. */
const capped = `${cappedLimit} The Decisions past the cap are reachable by paging rather than lost.`;

/**
 * The sentence on every read of this log and on nothing else in the framework.
 *
 * Every other read a client meets here is scoped to one User. A reader who assumes this one is too
 * will build a per-User cache of a sequence that other people move.
 */
const oneSharedLog =
  "**One global log, the same for every reader.** A Decision is addressed to nobody. There is no recipient, no group and no parameter naming a User anywhere on this route. `seq` numbers the one log rather than anybody's slice of it. So two Users reading the same window get the same records in the same order. A `seq` that moved is somebody else's activity. This surface is published to everyone on purpose, so that is the function rather than a leak.";

/**
 * What the artifact is and what to do with it, which is the sentence the Component exists for.
 *
 * It names the offline path first and deliberately. A reader who meets a Gateway-supplied verdict
 * before the key set will take the convenient answer. That answer is worth nothing to the third
 * party this identity exists for.
 */
const whatTheArtifactIs =
  "Each record carries `jws`, a **compact JWS** (RFC 7515) over `{ seq, createdAt, statement }`. It is one URL-safe string, and any off-the-shelf JOSE library in any language verifies it. Take it away and check it against the public key at `GET /jwks.json` on the Public server. That check is offline and asks this Gateway nothing. It is the only verification worth something to somebody who does not trust the Operator. What it proves is narrow. **The Operator committed to this Statement on the Shared Agent's behalf.** It says nothing whatever about how the agent behaved.";

/**
 * The 401, which is the User Manager's and is described in its words.
 *
 * The imported sentence is the whole of what the refusal says. What this Component adds is where it
 * comes from. A client reading a Decision route need not discover that the hook belongs elsewhere.
 */
const notAuthenticated = `${authenticationFailed} This part authenticates nobody: the refusal is the User Manager's \`requireUser\`, taken as one option on the route, so it is the same 401 the routes under \`/auth\` answer.`;

/**
 * The Statement of a Decision: non-empty, and with no upper bound.
 *
 * `minLength: 1` so that an empty commitment is a 400 rather than a signed nothing. No `maxLength`,
 * because Fastify's `bodyLimit` is already the bound and it is the Operator's to raise.
 */
const statementSchema = { type: "string", minLength: 1 } as const;

/**
 * The body of `POST /`: what is being committed to, and nothing else.
 *
 * There is no field for the artifact, the number or the timestamp, and nowhere for one to arrive.
 * The write path produces all three. A caller that writes one anyway has it dropped by
 * `additionalProperties: false`.
 */
const publishSchema = {
  type: "object",
  properties: { statement: statementSchema },
  required: ["statement"],
  additionalProperties: false,
} as const;

/**
 * A read of the log: the window, and nothing naming a User.
 *
 * One schema for both surfaces, which is the difference from the Messenger's pair. There the
 * agent's read is a User's plus a required `user`. Here the log has no owner to scope it to.
 */
const historySchema = {
  type: "object",
  properties: { after: afterCursor, before: beforeCursor, limit: limitSchema },
  additionalProperties: false,
} as const;

/**
 * The number in the path of a citation: a positive integer, validated before it is one.
 *
 * Not `idParams`, which is a uuid pattern. What identifies a Decision is its position in the one
 * log. Validated here, so `GET /decisions/seven` is the 400 it earned. Without that, it is a 500
 * out of a query that could not run. Fastify's ajv coerces the digits, so the handler gets a
 * number.
 *
 * `minimum: 1` because nothing is numbered 0. The log starts at 1, and 0 is a cursor meaning "from
 * the beginning". `maximum` is PostgreSQL's `integer`, which is what `seq` is. Without it, a number
 * too large for the column reaches the database. It comes back as a 500 carrying the query text.
 */
const seqParams = {
  type: "object",
  properties: {
    seq: {
      type: "integer",
      minimum: 1,
      maximum: 2147483647,
      description: "The Decision's number in the one global log, from 1.",
    },
  },
  required: ["seq"],
  additionalProperties: false,
} as const;

/**
 * `DecisionRecord` on the wire, written as the fields that can be answered.
 *
 * Fastify compiles a response schema with `fast-json-stringify`, which drops every field the schema
 * does not declare with no warning. So a field added to the type in `decisions.ts` and forgotten
 * here is missing from every answer. The round trip in `gateway.test.ts` catches that.
 *
 * One shape for all five routes. That covers the 201 of a publish, the items of either read, and
 * the record a citation answers with. The property descriptions are on the three fields whose name
 * is not the whole story.
 */
const decisionRecordSchema = {
  type: "object",
  properties: {
    seq: {
      type: "integer",
      description:
        "This Decision's number in the one global log, from 1. It is the cursor: the largest one held is what `after` takes to read whatever has been published since. **Gaps are expected and mean nothing**, a rolled-back publish burning a number, so a missing number is not a withheld Decision and nothing anywhere could tell you if it were.",
    },
    statement: { type: "string" },
    jws: {
      type: "string",
      description:
        'The **Decision itself**: a compact JWS, `header.payload.signature`, base64url. Its payload carries this record\'s `seq`, `createdAt` and `statement`, so everything above can be read back out of it by anybody holding the public key, which is what makes handing this one string to a third party the whole point. Its protected header carries `typ: "saf-decision+jws"`, covered by the signature, so an artifact of another kind cannot be presented as a Decision.',
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
 * A list answers in an envelope rather than as a bare array, as every Component's does.
 *
 * It is also where a cursor would have gone had one been wanted. None is: the largest `seq` in the
 * page is already it.
 */
const decisionListSchema = {
  type: "object",
  properties: { decisions: { type: "array", items: decisionRecordSchema } },
  required: ["decisions"],
} as const;

/**
 * What a citation is for, which is why this route exists beside the read.
 *
 * `?after=<n-1>&limit=1` answers the same record and reads badly. A client that has to write it
 * will get the off-by-one wrong once. Said on both surfaces, because both cite.
 */
const citingOne =
  "Citing a Decision is a route rather than a cursor query. `GET /decisions/7` is the Decision numbered 7, which is what `?after=6&limit=1` says the long way round. It is the **same read** the log is paged with. The cursor is the one just below the number, so a citation and a page can never answer with different records.";

/**
 * What a number nobody has means, which is less than a reader will assume.
 *
 * The 404 is the honest answer, and the sentence after it keeps the answer from being over-read. A
 * hole in the sequence is a rolled-back publish.
 */
const aNumberNobodyHas =
  "A number nobody has is a **404**, and it is not evidence of a Decision withheld. A rolled-back publish burns a number, so gaps in `seq` are expected and mean nothing. Detecting a withheld Decision is not something this log can do or claims to.";

/**
 * What these two routes say about a query parameter, there being no window to ask for.
 *
 * The Signal Worker's single-record routes say the same thing. A `?limit=1` answered with a 200
 * reads as though it had been honoured.
 */
const noWindowHere = `This route takes no query parameters at all. The number is the whole request, and the window belongs to the read beside it. ${unknownParameter}`;

/** What a citation is refused for, and what it is answered with when nothing has that number. */
const malformedNumber =
  "The number in the path is not a positive integer this log could have reached, or a query parameter was written.";
const noSuchNumber = "No Decision has that number.";

/** What both reads answer with, and what a publish does, each written once. */
const theWindow = "The window that matched, ascending by `seq`.";
const theCitedDecision = "The Decision with that number, exactly as the log read answers with it.";
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
          description: `Commit to something, on the record, to everybody. The Statement is signed with the Shared Agent's key and kept in the one global log. The record answered carries the artifact, so there is no read-back to do, and the agent can quote it to a User in the same Run.\n\nThere is **no field for the number, the timestamp or the signature**. The number is drawn first, the timestamp second and the artifact last. All three happen inside one transaction, because the signature binds the first two. Nothing is notified: publishing wakes no Signal and no Handler. So a Decision published during a Run cannot queue work for the Run that published it. ${whatTheArtifactIs} ${unknownParameter}`,
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
          description: `Every Decision this Shared Agent has published. It is the same log a User reads and the same one this agent published into. A Session is a lossy cache, so an agent with no memory of what it decided reads it here. ${oneSharedLog} ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${unknownParameter}`,
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

    fastify.get<{ Params: { seq: number } }>(
      "/:seq",
      {
        schema: {
          tags: ["Decisions"],
          summary: "Read one Decision by number",
          description: `One Decision, so a number the agent holds can be quoted without working out a cursor. The number is its own from an earlier Run, or one a User cited at it. ${citingOne} ${aNumberNobodyHas} ${noWindowHere}`,
          params: seqParams,
          response: {
            200: { ...decisionRecordSchema, description: theCitedDecision },
            400: refused(malformedNumber),
            404: refused(noSuchNumber),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => answerNumbered(reply, log, request.params.seq),
    );
  };
}

/**
 * The Public server's Decision routes: the same two reads, behind the Manager's single 401.
 *
 * `presentedUser` is `requireUser`, taken as one option and not wrapped, extended or
 * re-implemented. So an unauthenticated read is the Manager's single 401, and this Component
 * authenticates nobody.
 *
 * The Token is required and the User it names is then unused. It gates the surface rather than
 * scoping the answer. The Gateway is not a public bulletin board for whoever finds the port. `GET
 * /jwks.json` is the one exception on this server, a public key being public. The hook runs at
 * `preHandler`, so a malformed window is answered before a Token is looked at.
 */
export function publicDecisionRoutes(
  log: DecisionReads,
  presentedUser: preHandlerAsyncHookHandler,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: DecisionWindow }>(
      "/",
      {
        schema: {
          tags: ["Decisions"],
          summary: "Read the Decision log",
          description: `Everything this Shared Agent has committed to. This is what it said on everybody's behalf rather than what it said to you. Reading it is the first half of the only thing this log is for. The second half is taking a \`jws\` away and showing it to somebody who does not trust this Gateway. ${oneSharedLog} ${whatTheArtifactIs} ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${bearerRequired} ${unknownParameter}`,
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
      // The User the hook just verified is deliberately not read: there is nothing here to scope,
      // so the whole difference between this read and the agent's is the line above.
      async (request, reply) => answerHistory(reply, log, request.query),
    );

    fastify.get<{ Params: { seq: number } }>(
      "/:seq",
      {
        schema: {
          tags: ["Decisions"],
          summary: "Read one Decision by number",
          description: `The Decision somebody cited at you, fetched by the number they cited. This is where an artifact worth handing onward comes from: one record, one \`jws\`, and nothing else to hold. ${citingOne} ${whatTheArtifactIs} ${aNumberNobodyHas} ${bearerRequired} ${noWindowHere}`,
          params: seqParams,
          response: {
            200: { ...decisionRecordSchema, description: theCitedDecision },
            400: refused(malformedNumber),
            401: refused(notAuthenticated),
            404: refused(noSuchNumber),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectUnknownQuery(),
      },
      // The User is unread here too: a Decision is addressed to nobody, so every Token that works
      // answers with the same record.
      async (request, reply) => answerNumbered(reply, log, request.params.seq),
    );
  };
}

/**
 * The read both surfaces answer, and the one place this Component applies the cursor rules.
 *
 * Written here rather than inside either handler, because the two are the same query asked by two
 * callers. They must not become a parallel pair that can disagree about what `before` means.
 */
async function answerHistory(
  reply: FastifyReply,
  log: DecisionReads,
  asked: DecisionWindow,
): Promise<FastifyReply | { readonly decisions: DecisionRecord[] }> {
  // Two windows in one request, refused with the shared 400 and the noun that makes it this
  // Component's.
  if (asked.after !== undefined && asked.before !== undefined) {
    return bothCursors(reply, "the Decision log");
  }
  // The envelope, matching `{ messages: [...] }` and `{ users: [...] }`. It carries no `hasMore`:
  // a full page says it, since `decisions.length === limit`.
  return { decisions: await log.history(asked) };
}

/**
 * The citation both surfaces answer, and the only place either of them can 404.
 *
 * One function, for the reason `answerHistory` is one. What is not here is a query. `numbered` is
 * the log read, asked for one record from the cursor below the number.
 *
 * The 404 is the shared body, naming what was not found and the number it was not found by. That is
 * worth saying rather than answering an empty envelope. A citation that resolves to nothing is a
 * fact about the citation.
 */
async function answerNumbered(
  reply: FastifyReply,
  log: DecisionReads,
  seq: number,
): Promise<FastifyReply | DecisionRecord> {
  const cited = await log.numbered(seq);
  if (cited === undefined) return notFound(reply, "Decision", String(seq));
  return cited;
}
