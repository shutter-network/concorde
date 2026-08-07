/**
 * The HTTP Channel's routes: one group at `/messages` on the Public server.
 *
 * This is what HTTP as a Channel actually is — a User submitting, and a User polling their own
 * log by cursor ([ADR-0035](../../docs/adr/0035-a-users-messages-are-one-log-read-by-cursor.md),
 * [ADR-0048](../../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). The
 * agent's own two routes are acts on the log rather than acts of a medium, so they are the
 * Messenger's and live in `../messenger/routes.ts`. Neither plugin is exported and neither
 * prefix is configurable. The paths below are relative, because the constructor supplies the
 * prefix.
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `POST /messages` | 201, the created inbound `MessageRecord`, and a Signal; 401; 503 |
 * | `GET /messages?after=&before=&limit=` | `{ messages: [...] }`, ascending by `seq`; 400; 401 |
 *
 * **The serializer, the cursor sentences and both refusal helpers are imported from the
 * Messenger's own route module rather than restated.** A `MessageRecord` has one shape on every
 * surface, and a response schema is a serializer whose drift is silent, so the copy that would
 * have made this file self-contained is exactly the copy that could lose a field on one surface
 * and nowhere else.
 *
 * Nothing here authenticates anybody. Both routes take the User Manager's `requireUser` as one
 * option on the route, and read the User off `request.safUser`. The routes have no parameter
 * naming a User at all, so no User can read another's log.
 *
 * Each route's own `description` is what `/openapi.json` serves, so those sentences are the API
 * documentation rather than commentary. The two routes describe their 401 and their Token in the
 * User Manager's own words, imported rather than restated.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import type { MessageRecord, MessageWindow } from "../messenger/messages.ts";
import {
  answerHistory,
  capped,
  fullPageMeansMore,
  lostTheRace,
  type MessageHistory,
  messageListSchema,
  messageRecordSchema,
  notSearchable,
  refuseSend,
  rejectUnknownQuery,
  textSchema,
  theStoredMessage,
  theWindow,
} from "../messenger/routes.ts";
import {
  afterCursor,
  beforeCursor,
  cursorCases,
  limitSchema,
  refused,
  unknownParameter,
} from "../route-conventions.ts";
import { authenticationFailed, bearerRequired } from "../users/routes.ts";

/**
 * What a User's own routes need: the shared read, and a submission.
 *
 * `submit` takes neither a `direction` nor a transaction, for the reasons the agent's `send`
 * takes neither. The transaction that carries the insert and its Signal is opened by this
 * Channel's constructor, around the Messenger's `receive`. What comes back is the stored record,
 * which is what the 201 answers with and what the Signal payload is.
 */
export type OwnMessageOperations = MessageHistory & {
  submit(userId: string, text: string): Promise<MessageRecord>;
};

/**
 * The 401, which is the User Manager's and is described in its words.
 *
 * The imported sentence is the whole of what the refusal says. What this component adds is where it
 * comes from. A client reading a Message route learns that `/auth` answers the same.
 */
const notAuthenticated = `${authenticationFailed} This part authenticates nobody: the refusal is the User Manager's \`requireUser\`, taken as one option on the route, so it is the same 401 the routes under \`/auth\` answer.`;

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

/**
 * A User's own read: the window, and nothing naming a User.
 *
 * The agent's schema is this one plus a required `user`. That is the whole difference between the
 * two surfaces. There is no such property to omit here. A request cannot ask about somebody else,
 * so nothing has to refuse one.
 */
const ownHistorySchema = {
  type: "object",
  properties: { after: afterCursor, before: beforeCursor, limit: limitSchema },
  additionalProperties: false,
} as const;

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
      // is the constructor's, because a route holds no Db: one Message and one Signal, together,
      // written through the handle the Messenger handed this Channel at registration.
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
