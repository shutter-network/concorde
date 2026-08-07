/**
 * Decisions: the Component that owns the one global log of Decisions.
 *
 * One call builds it, and it registers its two plugins on the two servers it is handed. Its `start`
 * and `stop` do nothing. It is in the Gateway's record for its membership, and for the position
 * that comes with it. That position is ahead of the Signal Worker, so it outlives the drain. A
 * Signal Handler's post phase may still publish then.
 *
 * Four things a reader arriving from the Messenger will look for are absent on purpose. There
 * is no `user_id` anywhere, because a Decision is addressed to nobody. No route can 404 for a
 * missing User, because there is no foreign key. There is no race, no retry and no lock, because
 * the number comes from a PostgreSQL sequence. And it is not a Producer: publishing emits no
 * Signal, so nothing is notified and Users discover Decisions by polling.
 */

import { and, asc, desc, getTableName, gt, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Component } from "../components.ts";
import type { Db, Handle } from "../db/index.ts";
import { type CursorWindow, limitSchema } from "../route-conventions.ts";
import type { Signatures } from "../signatures/index.ts";
import type { Users } from "../users/users.ts";
import { agentDecisionRoutes, publicDecisionRoutes } from "./routes.ts";
import { decisions, decisionsSchema, decisionsTables } from "./schema.ts";

/** A handle typed to this Component's own tables, and to no other's. */
type DecisionsHandle = Handle<typeof decisionsTables>;

/**
 * Where both route groups land, on their respective servers.
 *
 * A constant and not an option. There is no prefix to configure and no plugin to register
 * elsewhere. So a client written for one deployment's Decisions works against every other one.
 */
const decisionsPrefix = "/decisions";

/**
 * The `typ` this Component asks for on every artifact it publishes.
 *
 * Not reserved. The agent can ask `POST /sign` for this same label. That is an authority it already
 * holds rather than a forgery. What the label buys a verifier is domain separation. The `typ` is in
 * the protected header, so the signature covers it.
 *
 * So `typ` is the agent's signed claim about its artifact and not a framework guarantee. Only an
 * artifact fetched from this log is guaranteed to be shaped like one of these.
 */
const decisionTyp = "saf-decision+jws";

/**
 * A Decision as every surface answers with it: the POST response and both reads.
 *
 * One shape and not a projection per surface. It is the whole row, four columns. `createdAt` is an
 * ISO 8601 string, because JSON has no date, and it is the string the artifact's payload carries.
 *
 * The JWS is the Decision, and the other three fields are the log's convenience. Anybody holding
 * the public key can read all three back out of `jws`. That is what makes handing one artifact
 * onward the point of the whole Component.
 */
export type DecisionRecord = {
  readonly seq: number;
  readonly statement: string;
  readonly jws: string;
  readonly createdAt: string;
};

/**
 * Which stretch of the log a read asks for: the shared cursor window under this Component's name.
 *
 * An alias and not a second declaration. What a cursor means lives beside the schema and the
 * refusal that enforce it. So the two Components that page cannot disagree about `before`.
 *
 * The window carries no User id. This log has no owner, so a window over it is the whole of what a
 * read asks.
 */
export type DecisionWindow = CursorWindow;

/** Everything `createDecisions` needs: the Db, two Components, and both servers. */
export type DecisionsOptions = {
  readonly db: Db;
  /**
   * The Component that holds the signing identity, and the reason this one has no key.
   *
   * Required, and construct it before this one. A Decision that was not signed is not a Decision.
   * So there is no degraded mode in which rows arrive without artifacts. Signing happens through
   * this object in process, never as an HTTP request.
   */
  readonly signatures: Signatures;
  /**
   * The User Manager whose Users may read the log.
   *
   * Required, and it is where the Public read's authentication comes from. `requireUser` is taken
   * off this object and put on the route as one option. So this Component holds no Token, and it
   * answers the Manager's single 401.
   *
   * Unlike the Messenger's, this is not a schema-level dependency. Nothing here references a
   * User, so a barrel may carry this schema without the User Manager's.
   */
  readonly users: Users;
  /**
   * The Agent server, where the agent publishes and reads, at `/decisions`.
   *
   * Required: Decisions the agent cannot publish into holds nothing. Structural, and asks for
   * nothing but the Fastify instance, so what satisfies it is what `serverComponent` returns.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
  /**
   * The Public server, where any authenticated User reads the log, at `/decisions`.
   *
   * Required, and for a sharper reason. A log no User can read is not public, and a commitment that
   * is not public is not a commitment.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
};

/**
 * What the constructor answers with: the two things trusted code needs and no request can express.
 *
 * Every other capability is a route this Component registered itself, and no route plugin is
 * exported. So a Signal Handler and an Operator's entry point get two things. One is a publish that
 * joins a transaction of their own. The other is a read of the whole log, needing neither a Token
 * nor a route. A Handler can therefore commit to something and then build the next Prompt from what
 * is already committed to.
 *
 * No method writes a Decision without signing it, and neither takes a User id. There is no
 * parameter for the artifact anywhere, so no caller's bytes reach the `jws` column. And there is
 * nothing to scope either method by, because the log has no owner.
 */
export type Decisions = Component & {
  /**
   * Publishes a Decision from inside the caller's transaction, and answers with the record.
   *
   * Takes the caller's transaction rather than finding one, so committing to something and
   * recording why cannot come apart. A rollback loses both. Ambient enlistment is not available: a
   * second handle takes its own connection and its writes survive the rollback.
   *
   * The Statement is the only other argument. The number, the timestamp and the artifact are the
   * write path's. They are produced in that order, because the signature binds the first two. A
   * read cannot see the caller's own uncommitted write, so the record comes back here instead.
   *
   * A publish that rolls back burns its number, since the sequence is not transactional. That is
   * expected and means nothing.
   *
   * @param tx The caller's transaction, carrying whatever schema it was started on.
   * @param statement The string being committed to.
   * @returns The Decision, including the number it drew and the artifact signed over it.
   */
  publish<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    statement: string,
  ): Promise<DecisionRecord>;

  /**
   * The Decision log, ascending by `seq`, so a Handler can read everything already committed to.
   *
   * Nothing scopes it: the log is global, and every reader sees the same sequence. The window is
   * what bounds an answer. A Handler wanting everything asks with `after: 0` and a large `limit`,
   * rather than by omitting an argument.
   *
   * A read, so it takes no transaction and cannot see the caller's own uncommitted write. It
   * answers from the same query both routes answer from, with the same cursor options. `limit`
   * defaults to the routes' default and is not capped here, because a cap bounds a response body.
   *
   * @param options The shared window, every field optional.
   */
  history(options?: Partial<DecisionWindow>): Promise<DecisionRecord[]>;

  /**
   * Does nothing. There is nothing here to start.
   *
   * Nothing is notified when a Decision is published. There is no connection to open and no ticker
   * to set going. Users poll the log, and the largest `seq` they hold is the whole resume
   * mechanism.
   */
  start(): Promise<void>;

  /**
   * Does nothing, and there is nothing here a shutdown could lose.
   *
   * A Decision is a committed row and an artifact somebody may already hold. Both outlive this
   * process, and the artifact outlives the deployment.
   */
  stop(): Promise<void>;
};

/**
 * Builds Decisions and registers its two route groups at `/decisions` on both servers.
 *
 * Nothing here connects, listens or applies DDL. Put the result in the Gateway's record under a key
 * of your own, ahead of the Signal Worker.
 *
 * @example
 * Built in `extend`, and then used from the Operator's own trusted code.
 * ```ts
 * import { createPrivateKey } from "node:crypto";
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "shared-agent-framework";
 * import { createDecisions } from "shared-agent-framework/decisions";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createSignatures } from "shared-agent-framework/signatures";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const signingKey = createPrivateKey(readFileSync("./signing-key.pem"));
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   agentListen: { host: "127.0.0.1", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, publicServer }) => {
 *     const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
 *     const signatures = createSignatures({ signingKey, agentServer, publicServer, users });
 *     return {
 *       users,
 *       signatures,
 *       decisions: createDecisions({ db, signatures, users, agentServer, publicServer }),
 *     };
 *   },
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // One transaction holds the Decision and the Operator's own record of why.
 * const { db, decisions } = gateway.components;
 * const published = await db.tx((tx) => decisions.publish(tx, "shipping on Friday"));
 *
 * // And the whole log, for the next Prompt.
 * const log = await decisions.history({ after: 0, limit: 100 });
 * console.log(published.seq, log.length);
 * ```
 */
export function createDecisions(options: DecisionsOptions): Decisions {
  // The Component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(decisionsTables);

  // One read, named once and given to both plugins. The agent's read and a User's read are the
  // same query with nothing to scope it by, and sharing one function is what keeps them from
  // disagreeing about what `before` means.
  const readHistory = (window: DecisionWindow) => selectDecisions(handle, window);

  // Citing a number is that same read, asked with the cursor just below the number. Two readings
  // of one table are two chances to answer differently.
  //
  // What comes back is the first Decision at or after the number. So the row is the citation only
  // when it is numbered what was asked for, and a burned number is nothing rather than its
  // successor.
  //
  // Citing the first Decision asks with `after: 0`. That cursor means "from the beginning" and is
  // not an absence: a read that took it for one would answer the newest Decision.
  const readNumbered = async (seq: number) => {
    const [atOrAfter] = await readHistory({ after: seq - 1, limit: 1 });
    return atOrAfter?.seq === seq ? atOrAfter : undefined;
  };

  // And one write, likewise named once: this Component signs and stores here and nowhere else.
  // Widened over the handle it is given, so the agent's route reaches it inside a transaction this
  // Component opens, while a Handler reaches the same statements inside one of its own.
  const publishSigned = <TSchema extends Record<string, unknown>>(
    on: Handle<TSchema>,
    statement: string,
  ) => publishDecision(on, options.signatures, statement);

  const agentRoutes = agentDecisionRoutes({
    history: readHistory,
    numbered: readNumbered,
    // One transaction, with the whole write path inside it. On the Component's own Db, because a
    // request that publishes has nothing else to keep the insert company with.
    publish: (statement) => options.db.tx((tx) => publishSigned(tx, statement)),
  });
  const publicRoutes = publicDecisionRoutes(
    { history: readHistory, numbered: readNumbered },
    // The Manager's own hook, passed through and not wrapped. This Component authenticates nobody.
    options.users.requireUser,
  );

  // The two acts of wiring, both here so that an Operator's entry point does neither. Not awaited:
  // Fastify defers a plugin until the server is ready, so this is a registration made at
  // construction and loaded at `listen`.
  options.agentServer.fastify.register(agentRoutes, { prefix: decisionsPrefix });
  options.publicServer.fastify.register(publicRoutes, { prefix: decisionsPrefix });

  return {
    // The one write above, on the caller's handle rather than the Component's own.
    publish: publishSigned,
    // The one read above, reached with arguments instead of a query string: the routes' own
    // default `limit` and none of their cap.
    history: (asked) => readHistory({ ...asked, limit: asked?.limit ?? limitSchema.default }),

    // The two no-ops, whose reason is on the type above.
    start: async () => {},
    stop: async () => {},
  };
}

/**
 * The write path: one number, one timestamp, one signature and one row, in the caller's
 * transaction.
 *
 * The order is load-bearing. The JWS binds `seq` and `createdAt`, so both exist before the
 * signature does. The signed values are the values that get stored.
 *
 * The schema parameter is widened, so this works on a transaction carrying any Component's schema.
 * Two statements and no savepoint. Nothing here expects to lose a race, so no constraint violation
 * can abort the caller's transaction.
 */
async function publishDecision<TSchema extends Record<string, unknown>>(
  tx: Handle<TSchema>,
  signatures: Signatures,
  statement: string,
): Promise<DecisionRecord> {
  // The number comes before the signature, because the JWS binds it. That is what keeps `jws`
  // NOT NULL and keeps "no column is ever updated" literally true.
  const seq = await drawSeq(tx);

  // Generated here and not by the database. The signed timestamp and the stored timestamp must be
  // the same value, and one value reaching both is the only guarantee. Do not "fix" this to
  // `clock_timestamp()` to match `messages.created_at`: that column has no signature over it.
  const createdAt = new Date();

  // In process, never an HTTP request to the Signatures routes. The claims are built in the order
  // the payload carries them, because a compact JWS is signed as exactly the bytes emitted.
  const jws = await signatures.sign(decisionTyp, {
    seq,
    createdAt: createdAt.toISOString(),
    statement,
  });

  const [inserted] = await tx
    .insert(decisions)
    .values({ seq, statement, jws, createdAt })
    .returning();
  if (inserted === undefined) {
    throw new Error("publishing a Decision inserted no row");
  }
  return asDecisionRecord(inserted);
}

/**
 * The next number, drawn straight from the sequence behind the identity column.
 *
 * `nextval` is atomic, so there is no race to lose, nothing to retry and no lock to take. It is
 * also outside the transaction's rollback, so a rolled-back publish burns a number and leaves a
 * gap. Nothing checks, compacts or reports one.
 *
 * The sequence is asked for by `pg_get_serial_sequence`, and the table and column are read off the
 * schema objects. So nothing here is a second spelling of a name the DDL owns. The `::int` is what
 * makes PostgreSQL's `bigint` arrive as a JavaScript number.
 */
async function drawSeq<TSchema extends Record<string, unknown>>(
  tx: Handle<TSchema>,
): Promise<number> {
  const table = `${decisionsSchema.schemaName}.${getTableName(decisions)}`;
  const [drawn] = await tx
    .select({
      seq: sql<number>`nextval(pg_get_serial_sequence(${table}, ${decisions.seq.name}))::int`,
    })
    // A one-row source to select from, because Drizzle's builder requires a `from` where
    // PostgreSQL does not. Reading `nextval` off `decisions` itself would draw one number per row.
    .from(sql`(select 1) as drawing`);
  if (drawn === undefined) {
    throw new Error("the sequence behind decisions.seq answered no row");
  }
  return drawn.seq;
}

/**
 * The log, ascending by `seq`, and the one query every surface answers from.
 *
 * `before` and no cursor at all select descending and reverse in memory. The newest page is what a
 * client opening the log wants. PostgreSQL cannot answer "the last fifty ascending" without one or
 * the other. The reversal is invisible from outside: every page arrives ascending.
 *
 * On the Component's own handle rather than a widened one. A read takes no transaction, and this
 * Component reads nothing but its own table.
 */
async function selectDecisions(
  handle: DecisionsHandle,
  window: DecisionWindow,
): Promise<DecisionRecord[]> {
  const forwards = window.after !== undefined;
  const rows = await handle
    .select()
    .from(decisions)
    .where(
      and(
        window.after === undefined ? undefined : gt(decisions.seq, window.after),
        window.before === undefined ? undefined : lt(decisions.seq, window.before),
      ),
    )
    .orderBy(forwards ? asc(decisions.seq) : desc(decisions.seq))
    .limit(window.limit);
  const ascending = forwards ? rows : rows.reverse();
  return ascending.map(asDecisionRecord);
}

/** The row as every surface reads it. */
function asDecisionRecord(row: typeof decisions.$inferSelect): DecisionRecord {
  return {
    seq: row.seq,
    statement: row.statement,
    jws: row.jws,
    createdAt: row.createdAt.toISOString(),
  };
}
