import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import {
  afterCursor,
  bearerRequired,
  beforeCursor,
  bothCursors,
  cappedLimit,
  cursorCases,
  limitSchema,
  notAuthenticated,
  notFound,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";
import type { DecisionRecord, DecisionWindow } from "./decisions.ts";

export type DecisionReads = {
  history(window: DecisionWindow): Promise<DecisionRecord[]>;
  numbered(seq: number): Promise<DecisionRecord | undefined>;
};

export type DecisionOperations = DecisionReads & {
  publish(statement: string): Promise<DecisionRecord>;
};

const notSearchable = "Supports cursor paging, not search or field filters.";

const rejectUnknownQuery = unknownQueryRefusal(notSearchable);

const fullPageMeansMore =
  "A full page may have more results. Use its largest `seq` as `after` to continue forward, or its smallest as `before` to continue backward. A short page ends that direction for now. The server stores no read position.";

const capped = `${cappedLimit}`;

const oneSharedLog =
  "All authenticated users read the same decisions. The sequence is global; decisions have no recipient.";

const whatTheArtifactIs =
  "Verify the compact JWS against the public key from `GET /jwks.json`. Its payload contains `seq`, `createdAt`, and `statement`. A valid signature authenticates the statement under the signing identity; it does not prove correct agent behavior. Obtain the public key through a trusted source.";

const statementSchema = { type: "string", minLength: 1 } as const;

const publishSchema = {
  type: "object",
  properties: { statement: statementSchema },
  required: ["statement"],
  additionalProperties: false,
} as const;

const historySchema = {
  type: "object",
  properties: { after: afterCursor, before: beforeCursor, limit: limitSchema },
  additionalProperties: false,
} as const;

const seqParams = {
  type: "object",
  properties: {
    seq: {
      type: "integer",
      minimum: 1,
      maximum: 2147483647,
      description: "Global decision sequence number, starting at 1.",
    },
  },
  required: ["seq"],
  additionalProperties: false,
} as const;

const decisionRecordSchema = {
  type: "object",
  properties: {
    seq: {
      type: "integer",
      description:
        "Global sequence number used for paging. Rollbacks can leave gaps; a gap does not prove a decision was withheld.",
    },
    statement: { type: "string" },
    jws: {
      type: "string",
      description:
        'Compact JWS with payload `{ seq, createdAt, statement }` and protected header `typ: "concorde-decision+jws"`. Keep this artifact to verify the decision independently.',
    },
    createdAt: {
      type: "string",
      description: "Publication time in ISO 8601, matching the timestamp in the signed payload.",
    },
  },
  required: ["seq", "statement", "jws", "createdAt"],
} as const;

const decisionListSchema = {
  type: "object",
  properties: { decisions: { type: "array", items: decisionRecordSchema } },
  required: ["decisions"],
} as const;

const citingOne = "Fetch a decision by its sequence number, for example `GET /decisions/7`.";

const aNumberNobodyHas = "Missing sequence numbers return 404. Rollbacks can leave gaps.";

const noWindowHere = `${unknownParameter}`;

const malformedNumber =
  "The path must contain a positive sequence number within range. Query parameters are not accepted.";
const noSuchNumber = "No decision has this sequence number.";

const theWindow = "Matching decisions in ascending sequence order.";
const theCitedDecision = "The requested decision.";
const thePublishedDecision =
  "The stored decision, including its sequence number and signed artifact.";

export function agentDecisionRoutes(log: DecisionOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { statement: string } }>(
      "/",
      {
        schema: {
          tags: ["Decisions"],
          summary: "Publish a decision",
          description: `Signs and stores a statement in the shared decision log. The gateway assigns its sequence number and timestamp. Publishing emits no signal and sends no message; notify users separately if needed. ${whatTheArtifactIs} ${unknownParameter}`,
          body: publishSchema,
          response: {
            201: { ...decisionRecordSchema, description: thePublishedDecision },
            400: refused("A nonempty `statement` is required. Query parameters are not accepted."),
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
          summary: "Read decisions",
          description: `Read previously published decisions. ${oneSharedLog} ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${unknownParameter}`,
          querystring: historySchema,
          response: {
            200: { ...decisionListSchema, description: theWindow },
            400: refused(
              "Invalid cursor or limit, both cursors supplied, or an unknown query parameter.",
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
          summary: "Read a decision by number",
          description: `${citingOne} ${aNumberNobodyHas} ${noWindowHere}`,
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
          summary: "Read decisions",
          description: `${oneSharedLog} ${whatTheArtifactIs} ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${bearerRequired} ${unknownParameter}`,
          querystring: historySchema,
          response: {
            200: { ...decisionListSchema, description: theWindow },
            400: refused(
              "Invalid cursor or limit, both cursors supplied, or an unknown query parameter. There is no user filter.",
            ),
            401: refused(notAuthenticated),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectUnknownQuery("after", "before", "limit"),
      },
      async (request, reply) => answerHistory(reply, log, request.query),
    );

    fastify.get<{ Params: { seq: number } }>(
      "/:seq",
      {
        schema: {
          tags: ["Decisions"],
          summary: "Read a decision by number",
          description: `${citingOne} ${whatTheArtifactIs} ${aNumberNobodyHas} ${bearerRequired} ${noWindowHere}`,
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
      async (request, reply) => answerNumbered(reply, log, request.params.seq),
    );
  };
}

async function answerHistory(
  reply: FastifyReply,
  log: DecisionReads,
  asked: DecisionWindow,
): Promise<FastifyReply | { readonly decisions: DecisionRecord[] }> {
  if (asked.after !== undefined && asked.before !== undefined) {
    return bothCursors(reply, "the decision log");
  }
  return { decisions: await log.history(asked) };
}

async function answerNumbered(
  reply: FastifyReply,
  log: DecisionReads,
  seq: number,
): Promise<FastifyReply | DecisionRecord> {
  const cited = await log.numbered(seq);
  if (cited === undefined) return notFound(reply, "decision", String(seq));
  return cited;
}
