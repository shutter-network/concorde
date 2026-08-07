/**
 * Four things a maintainer arriving from the Messenger will look for are absent on purpose. There
 * is no `user_id` anywhere, because a Decision is addressed to nobody. No route can 404 for a
 * missing User, because there is no foreign key. There is no race, no retry and no lock, because
 * the number comes from a PostgreSQL sequence. And this is not a Producer: publishing emits no
 * Signal, so nothing is notified and Users discover Decisions by polling.
 *
 * `publishDecision` below draws the number, stamps the time, signs, and only then inserts. That
 * order is load-bearing: the JWS binds `seq` and `createdAt`, so both must exist before the
 * signature does, and the signed values are the values that get stored. Inserting first and
 * updating with the artifact afterwards would make `jws` nullable in every record type forever.
 */

import { and, asc, desc, getTableName, gt, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db, Handle } from "../db/index.ts";
import type { Component } from "../gateway/components.ts";
import { type CursorWindow, limitSchema } from "../route-conventions.ts";
import type { Signatures } from "../signatures/index.ts";
import type { Users } from "../users/users.ts";
import { agentDecisionRoutes, publicDecisionRoutes } from "./routes.ts";
import { decisions, decisionsSchema, decisionsTables } from "./schema.ts";

type DecisionsHandle = Handle<typeof decisionsTables>;

// A constant and not an option: no prefix to configure and no plugin to register elsewhere, so a
// client written for one deployment's Decisions works against every other one.
const decisionsPrefix = "/decisions";

// Not reserved. The agent can ask `POST /sign` for this same label, which is an authority it
// already holds rather than a forgery. What the label buys a verifier is domain separation, the
// `typ` being in the protected header and therefore covered by the signature.
const decisionTyp = "saf-decision+jws";

/**
 * A Decision as every surface answers with it: the publish response, both reads, and `history`.
 *
 * The artifact is the Decision. Anybody holding the public key reads the other three fields back
 * out of `jws`, which is what makes handing one string to a third party worth doing.
 *
 * `createdAt` is ISO 8601, JSON having no date, and is the same string the artifact's payload
 * carries rather than a re-rendering of it.
 */
export type DecisionRecord = {
  readonly seq: number;
  readonly statement: string;
  readonly jws: string;
  readonly createdAt: string;
};

// An alias and not a second declaration, so the two components that page cannot come to disagree
// about what `before` means. It carries no User id, this log having no owner.
export type DecisionWindow = CursorWindow;

export type DecisionsOptions = {
  readonly db: Db;
  /**
   * Where every Decision is signed, which is why this component holds no key of its own.
   *
   * Build it first. Signing happens through this object in process and never as an HTTP request to
   * the Signatures routes, so a publish inside a transaction never leaves the process.
   */
  readonly signatures: Signatures;
  /**
   * Supplies the `requireUser` hook that the Public read runs, so this component holds no Token and
   * authenticates nobody.
   *
   * Not a schema-level dependency, unlike the Messenger's: nothing here references a User, so a
   * barrel may carry this component's tables without the tables of Users.
   */
  readonly users: Users;
  /**
   * Where the agent publishes and reads, at `/decisions`.
   *
   * Structural: anything carrying a Fastify instance satisfies it.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
  /**
   * Where any authenticated User reads the log, at `/decisions`.
   *
   * A log no User can read is not public, and a commitment that is not public is not a commitment,
   * so there is no assembly of this component that omits it.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
};

/**
 * The Decision log as a Component. Its programmatic API is two methods: a publish that joins the
 * caller's transaction, and a read of the whole log that needs neither a Token nor a route.
 *
 * Every other capability is a route this component registered itself, and no route plugin is
 * exported. A Signal Handler therefore commits to something and builds the next Prompt out of what
 * is already committed to, without going near HTTP.
 *
 * There is no parameter for the artifact anywhere, so no caller's bytes reach the `jws` column, and
 * neither method takes a User id, the log having no owner and nothing to scope by.
 *
 * Publishing notifies nothing. No Signal is emitted and no Handler wakes, so a Decision published
 * during a Run cannot queue work for the Run that published it.
 *
 * `start` and `stop` do nothing. A Decision is a committed row and an artifact somebody may already
 * hold, and both outlive this process.
 */
export type Decisions = Component & {
  /**
   * Publishes a Decision inside the transaction `tx` belongs to, and answers with the record.
   *
   * Takes the caller's transaction rather than opening one, so committing to something and
   * recording why cannot come apart: a rollback loses both. Ambient enlistment is not available,
   * because a second handle takes its own connection and its writes would survive that rollback.
   *
   * `statement` is the only other argument. The number, the timestamp and the artifact belong to
   * the write path, and the record comes back from here because a read cannot see the caller's own
   * uncommitted write.
   *
   * A publish that rolls back burns its number, the sequence not being transactional. Gaps in the
   * log are expected and mean nothing.
   */
  publish<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    statement: string,
  ): Promise<DecisionRecord>;

  /**
   * Reads the log, ascending by `seq`, so a Handler can see everything already committed to.
   *
   * Nothing scopes it: every reader sees the same sequence, and `options` is what bounds the
   * answer. Asking for everything means `{ after: 0, limit: <large> }` rather than omitting the
   * argument, which answers the newest page instead.
   *
   * A read, so it takes no transaction and cannot see the caller's own uncommitted write. `limit`
   * takes the routes' default when omitted and is not capped here, a cap being there to bound a
   * response body.
   */
  history(options?: {
    readonly after?: number;
    readonly before?: number;
    readonly limit?: number;
  }): Promise<DecisionRecord[]>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

/**
 * Builds Decisions and registers its two route groups at `/decisions` on both servers.
 *
 * Nothing here connects, listens or applies DDL.
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
    // The hook of Users, passed through and not wrapped. This Component authenticates nobody.
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

// The schema parameter is widened, so this works on a transaction carrying any component's schema.
// Two statements and no savepoint: nothing here expects to lose a race, so no constraint violation
// can abort the caller's transaction. For why the four steps run in this order, see the file header.
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
 * `nextval` is atomic, so there is no race to lose, nothing to retry and no lock to take. It sits
 * outside the transaction's rollback, so a rolled-back publish burns a number and leaves a gap, and
 * nothing checks, compacts or reports one.
 *
 * The sequence is asked for by `pg_get_serial_sequence`, with the table and column read off the
 * schema objects, so nothing here is a second spelling of a name the DDL owns. The `::int` is what
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
 * The one query every surface answers from. `before` and no cursor at all select descending and
 * reverse in memory, because PostgreSQL cannot answer "the last fifty ascending" without one or the
 * other, and the newest page is what a client opening the log wants. The reversal is invisible from
 * outside: every page arrives ascending.
 *
 * On the component's own handle rather than a widened one. A read takes no transaction, and this
 * component reads nothing but its own table.
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

function asDecisionRecord(row: typeof decisions.$inferSelect): DecisionRecord {
  return {
    seq: row.seq,
    statement: row.statement,
    jws: row.jws,
    createdAt: row.createdAt.toISOString(),
  };
}
