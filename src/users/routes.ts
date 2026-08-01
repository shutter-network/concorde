/**
 * The User Directory's contribution to the Agent server: creating a User, and
 * reading Users back.
 *
 * A **Fastify plugin** with no prefix of its own, exactly as the Core's routes are:
 * the Operator registers it where they want it, switching it off is *not registering
 * it* (ADR-0010), and there is no plugin contract of ours for it to satisfy
 * (ADR-0021). A deployment where the agent must not create Users simply does not
 * offer it the capability.
 *
 * The paths below are relative to that prefix, which is why they name no resource:
 * under the conventional `/users` they are `POST /users`, `GET /users` and
 * `GET /users/:id`, and under any other prefix they are whatever the Operator chose.
 *
 * | Route | Answers |
 * | --- | --- |
 * | `POST /` | the created `UserRecord`, 201 |
 * | `GET /?limit=` | `{ users: UserRecord[] }`, newest first |
 * | `GET /:id` | `UserRecord`, or 404 |
 *
 * **Creating a User accepts no Attributes, and that is the security boundary of the
 * whole part.** Attributes are where grouping and therefore authorization live
 * (ADR-0008, ADR-0014), so an agent that could choose them could mint itself an
 * administrator — and ADR-0003 accepts that a hostile User may steer the agent,
 * while the Agent server has no authentication at all (ADR-0010). Note how it is
 * refused: the route has **no such parameter**, so there is no validator to bypass,
 * no allow-list to configure, and nothing to get wrong. It is an absent capability
 * and not a guard, which is why nothing below reads the request body.
 *
 * What is missing from the table is missing on purpose. There is **no delete and no
 * deactivation** — nothing removes a User (ADR-0029). Setting Attributes, replacing
 * a password and issuing a Token are **methods and not routes**, reachable from the
 * Operator's own trusted code and from nothing the agent can call.
 *
 * The capped limit, the envelope, the pattern-validated id, the refusal of an
 * unknown query parameter and the 404 body are the conventions in
 * `route-conventions.ts` that every part's routes share; only the sentence the
 * refusal ends with is this part's.
 */

import type { FastifyPluginAsync } from "fastify";
import { idParams, limitSchema, notFound, unknownQueryRefusal } from "../route-conventions.ts";

/**
 * A User as the agent reads it, and the JSON these routes answer with.
 *
 * `attributes` is `unknown` because it is arbitrary JSON the Gateway never
 * interprets and cannot meaningfully index (ADR-0014); what a Signal Handler makes
 * of it is the Handler's. `createdAt` is an ISO 8601 string because JSON has no
 * date. There is deliberately no field for the password: whether a User has one is
 * not something the agent's surface answers.
 */
export type UserRecord = {
  readonly id: string;
  readonly attributes: unknown;
  readonly createdAt: string;
};

/**
 * What these routes need of the User Directory, and no more: three operations over
 * the part's own handle, with no Store and no table objects.
 *
 * `create` takes nothing — not because a parameter was left for later, but because
 * there is nothing the agent may supply. Note that it is also transaction-less,
 * where the Directory's own `create` takes one (ADR-0023): a request that creates a
 * User has one statement in it and nothing to keep that statement with, while an
 * Operator creating a User has their own tables to keep it with.
 */
export type UserOperations = {
  create(): Promise<UserRecord>;
  get(id: string): Promise<UserRecord | undefined>;
  list(options: { readonly limit: number }): Promise<UserRecord[]>;
};

/**
 * The refusal these routes answer an unknown query parameter with.
 *
 * The convention and its reasoning are in `route-conventions.ts`; the sentence the
 * message ends with is this part's. It says outright that there is nothing to search
 * by, because the alternative — `?attributes[role]=admin` quietly returning every
 * User — reads as though a filter had been applied.
 */
const rejectUnknownQuery = unknownQueryRefusal(
  "Users cannot be searched or filtered: Attributes are arbitrary JSON the Gateway cannot meaningfully index, and a User has no natural key to match on (ADR-0014).",
);

/** The agent's User routes, over the operations above. */
export function agentUserRoutes(directory: UserOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post(
      "/",
      // No body schema, and the handler never looks at `request.body`. That is the
      // absent capability: whatever is posted, there is nothing here that could
      // carry an attribute into the row, so the column's default decides and the
      // created User has none.
      { preValidation: rejectUnknownQuery() },
      async (_request, reply) => reply.code(201).send(await directory.create()),
    );

    fastify.get<{ Querystring: { limit: number } }>(
      "/",
      {
        schema: {
          querystring: {
            type: "object",
            properties: { limit: limitSchema },
            additionalProperties: false,
          },
        },
        preValidation: rejectUnknownQuery("limit"),
      },
      async (request) => ({ users: await directory.list({ limit: request.query.limit }) }),
    );

    fastify.get<{ Params: { id: string } }>(
      "/:id",
      // No query parameters at all on a single record, and asking for one is refused
      // rather than ignored — the same reason the list route refuses.
      { schema: { params: idParams }, preValidation: rejectUnknownQuery() },
      async (request, reply) => {
        const user = await directory.get(request.params.id);
        if (user === undefined) return notFound(reply, "User", request.params.id);
        return user;
      },
    );
  };
}
