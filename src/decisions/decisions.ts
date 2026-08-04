/**
 * Decisions: the part of the Gateway that owns the one global log of Decisions.
 *
 * Constructed like every other part — one call, an ordinary object back, and nothing to
 * register it with. It wires itself the way every part does, registering its own migration
 * descriptor with the Db and its two plugins on the two servers it is handed (ADR-0032).
 *
 * It is a **Component whose `start` and `stop` do nothing**, for the reason the User Manager's
 * and the HTTP Messenger's are: no timers and no connection of its own, and membership in the
 * Gateway's record is what puts this part in a **position** before it needs one (ADR-0037).
 * The position it has is ahead of the Signal Worker, so that it outlives the drain: a Signal
 * Handler's post phase runs after the Runs arising from a Signal have finished, which during
 * shutdown is inside the drain, and a Decision reached by a failing Run should still be
 * recorded ([ADR-0038](../../docs/adr/0038-the-default-assembly-is-a-constructor.md)).
 *
 * Four things about it are decisions rather than omissions, and each is a place a reader
 * arriving from the HTTP Messenger will look for machinery that is deliberately absent
 * ([ADR-0043](../../docs/adr/0043-decisions-are-one-global-log.md)):
 *
 *  - **The log is global and there is no `user_id` anywhere.** Not on the table, not on a
 *    route, not on a method. A Decision addressed to one User would be a Message with extra
 *    steps, and worse: a verifier holding one could never tell whether the same Shared Agent
 *    had signed a contradictory one for somebody else. A commitment that is not public is not
 *    a commitment. So the agent's read and a User's read are the same query with **no scoping
 *    at all**, and the two route groups differ only in whether an auth hook runs.
 *  - **No route can 404 for a missing User**, because there is no foreign key: ADR-0036's "the
 *    agent's 404 is PostgreSQL's `23503` caught" has no analogue here, and this part imposes no
 *    construction-order dependency on the User Manager. It takes one all the same, for the
 *    hook that refuses an unauthenticated read.
 *  - **There is no race, no retry and no lock.** `messages.seq` is computed per User as
 *    `max()+1` and needs a bounded retry behind a unique constraint; this number comes from a
 *    PostgreSQL sequence, which is atomic. Reinforced by every writer already being serial: the
 *    publish route is on the Agent server only, so the agent can only publish during a Run, and
 *    trusted code publishes from inside the same serial worker.
 *  - **It is not a Producer.** Publishing writes a row and emits no Signal, and this module
 *    holds no reference to the Signal Worker. A Decision is published *by the agent, during a
 *    Run*, so emitting one would have the agent's own action queue work for the agent on a
 *    serial worker — the Signal queues behind the Run still in flight, and the Handler it wakes
 *    can publish again. That is a loop with nothing guarding it. Consequence: nothing is
 *    notified when a Decision is published, and Users discover Decisions by polling.
 */

import { and, asc, desc, getTableName, gt, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Component } from "../components.ts";
import type { Db, Handle, Transaction } from "../db/index.ts";
import type { CursorWindow } from "../route-conventions.ts";
import type { Signatures } from "../signatures/index.ts";
import type { Users } from "../users/users.ts";
import { decisionsMigrations } from "./migrations.ts";
import { agentDecisionRoutes, publicDecisionRoutes } from "./routes.ts";
import { decisions, decisionsSchema, decisionsTables } from "./schema.ts";

/** A handle typed to this part's own tables, and to no other part's (ADR-0022). */
type DecisionsHandle = Handle<typeof decisionsTables>;

/**
 * Where both route groups land, on their respective servers.
 *
 * A constant and not an option: there is no prefix to configure and no plugin to register
 * elsewhere, so a client written for one deployment's Decisions works against every other
 * deployment's (ADR-0034, ADR-0042).
 */
const decisionsPrefix = "/decisions";

/**
 * The `typ` this part asks for on every artifact it publishes.
 *
 * **Not reserved**, and that is deliberate: the agent may ask `POST /sign` for this same label,
 * and that is the authority it already holds exercised without a log row rather than a forgery
 * (ADR-0042). What the label buys a verifier is domain separation — an artifact typed as a
 * Decision cannot be replayed as anything else this identity signs, because the `typ` is in the
 * protected header and is therefore covered by the signature.
 *
 * The consequence, stated where it will be met: `typ` is the agent's signed claim about its
 * artifact and not a framework guarantee. Only an artifact **fetched from this log** is
 * guaranteed to be shaped like one of these.
 */
const decisionTyp = "saf-decision+jws";

/**
 * A Decision as every surface answers with it: the POST response and both reads.
 *
 * One shape and not a projection per surface, and it is the whole row: four columns, all four
 * answered. `createdAt` is an ISO 8601 string, because JSON has no date, and it is the same
 * string the payload of the artifact carries, since one value reached both.
 *
 * **The JWS is the Decision**, and the other three fields are the log's convenience: a verifier
 * holding a valid artifact cannot conclude that a row exists and does not need to, because the
 * signature is the authority (ADR-0042). Everything in this record but `jws` can be read back
 * out of `jws` by anybody holding the public key, which is what makes handing one onward
 * out of band the point of the whole part.
 */
export type DecisionRecord = {
  readonly seq: number;
  readonly statement: string;
  readonly jws: string;
  readonly createdAt: string;
};

/**
 * Which stretch of the log a read asks for: the shared cursor window under this part's own
 * name.
 *
 * An alias and not a second declaration. What a cursor means lives beside the schema and the
 * refusal that enforce it, in `route-conventions.ts`, so that the two parts that page cannot
 * come to disagree about what `before` means (ADR-0035).
 *
 * The window carries no User id, and here that is not a matter of where the id comes from: this
 * log has no owner, so a window over it is the whole of what a read asks.
 */
export type DecisionWindow = CursorWindow;

export type DecisionsOptions = {
  readonly db: Db;
  /**
   * The part that holds the signing identity, and the reason this one has no key.
   *
   * Required, and construct it **before** this: a Decision that was not signed is not a
   * Decision, so there is no degraded mode in which this part writes rows without artifacts.
   * Signing happens through this object in process and never as an HTTP request to the
   * Signatures routes.
   */
  readonly signatures: Signatures;
  /**
   * The User Manager whose Users may read the log.
   *
   * Required, and it is where the Public read's authentication comes from: `requireUser` is
   * taken off this object and put on the route as one option, so this part holds no Token and
   * no header of its own and its one refusal is the Manager's single 401 (ADR-0030).
   *
   * **Unlike the HTTP Messenger's, this is not a schema-level dependency.** There is no foreign
   * key onto `saf_users.users` and nothing here references a User at all, so construction order
   * is free: this part's migration folder applies wherever it lands (ADR-0043).
   */
  readonly users: Users;
  /**
   * The Agent server, where the agent publishes and reads, at **`/decisions`**.
   *
   * Required: Decisions the agent cannot publish into holds nothing, which is broken rather
   * than smaller. Structural, and asks for nothing but the Fastify instance, for the purely
   * technical reason every other part's server option is — `FastifyInstance` has five generic
   * parameters — so what satisfies it is what `serverComponent` returns.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
  /**
   * The Public server, where any authenticated User reads the log, at **`/decisions`**.
   *
   * Required for the reason the Agent server is, and a sharper one: a log no User can read is
   * not public, and a commitment that is not public is not a commitment.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
};

/**
 * What the constructor answers with today: the two methods every Component has, and nothing
 * else.
 *
 * Everything this part can do is a route it registered itself, and no route plugin is exported
 * (ADR-0034). The reads and the write below are reached over HTTP.
 */
export type Decisions = Component & {
  /**
   * **Does nothing.** Written out here so that it is read rather than discovered.
   *
   * Nothing is notified when a Decision is published, so there is no connection to open and no
   * ticker to set going: Users poll the log, and the largest `seq` they hold is the whole of
   * the resume mechanism (ADR-0043). Everything this part needed was done at construction
   * (ADR-0032).
   */
  start(): Promise<void>;

  /**
   * **Does nothing**, and there is nothing here that a shutdown could lose.
   *
   * A Decision is a committed row and an artifact somebody may already be holding; both outlive
   * this process, and the artifact outlives the deployment.
   */
  stop(): Promise<void>;
};

export function createDecisions(options: DecisionsOptions): Decisions {
  // The part's own handle, typed to its own tables. `pg` never leaves the Db (ADR-0022).
  const handle = options.db.handle(decisionsTables);

  // One read, named once and given to both plugins. The agent's read and a User's read are the
  // same query with nothing to scope it by, and the two sharing this one function is what keeps
  // them from becoming a parallel set that can disagree about what `before` means (ADR-0035).
  const readHistory = (window: DecisionWindow) => selectDecisions(handle, window);

  const agentRoutes = agentDecisionRoutes({
    history: readHistory,
    // One transaction, with the whole of the write path inside it. On the part's own Db rather
    // than a handle, because a request that publishes has nothing else to keep the insert
    // company with — trusted code with something to keep it company is what takes a
    // transaction first (ADR-0023).
    publish: (statement) =>
      options.db.tx((tx) => publishDecision(tx, options.signatures, statement)),
  });
  const publicRoutes = publicDecisionRoutes(
    { history: readHistory },
    // The Manager's own hook, passed through and not wrapped: this part authenticates nobody,
    // which is what `src/users/users.ts` promised it would do (ADR-0030).
    options.users.requireUser,
  );

  // The three acts of wiring, all of them here so that an Operator's entry point does none of
  // them (ADR-0032). Registering the descriptor is bookkeeping the Db does nothing with until
  // `migrate` or `start`, and unlike the HTTP Messenger's the order it lands in does not matter.
  options.db.registerMigrations(decisionsMigrations);
  // Not awaited: Fastify defers a plugin until the server is ready, so this is a registration
  // made at construction and loaded at `listen` — which is also why a server that is already
  // listening refuses one.
  options.agentServer.fastify.register(agentRoutes, { prefix: decisionsPrefix });
  options.publicServer.fastify.register(publicRoutes, { prefix: decisionsPrefix });

  return {
    // The two no-ops, whose reason is on the type above: membership in the Gateway's record,
    // and the position that comes with it (ADR-0037).
    start: async () => {},
    stop: async () => {},
  };
}

/**
 * The write path: one number, one timestamp, one signature and one row, in the caller's
 * transaction.
 *
 * **Three parts of this order are load-bearing**, and each has its comment below. The short
 * version is that the JWS binds `seq` and `createdAt`, so both have to exist before the
 * signature does, and the signed values have to be the values that get stored.
 *
 * One transaction and nothing else in it, opened by the part rather than taken from a caller: a
 * request that publishes has one thing to record. The parameter is the Db's own `Transaction`
 * and is **not** widened over a schema, because there is nothing to widen it for — every caller
 * of this is a route (ADR-0023).
 */
async function publishDecision(
  tx: Transaction,
  signatures: Signatures,
  statement: string,
): Promise<DecisionRecord> {
  // **The number comes before the signature**, because the JWS binds it. That is what keeps
  // `jws` NOT NULL and keeps "no column is ever updated" literally true; insert-then-sign-then-
  // update is correct inside one transaction and was rejected for making the column nullable
  // forever to model a state no reader can observe (ADR-0043).
  const seq = await drawSeq(tx);

  // **Generated here and not by the database.** The signed timestamp and the stored timestamp
  // must be the same value, and one value reaching both is the only way to guarantee it. Do not
  // "fix" this to `clock_timestamp()` to match `messages.created_at`: that column has no
  // signature over it.
  const createdAt = new Date();

  // **In process, never an HTTP request to the Signatures routes.** The claims are built in the
  // order the payload carries them, because a compact JWS is signed as exactly the bytes
  // emitted and nothing re-serializes them (ADR-0042).
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
 * `nextval` is atomic, so there is no race to lose, nothing to retry and no lock to take — the
 * whole of the machinery `messages.seq` needs, absent because the number is global rather than
 * per User (ADR-0043).
 *
 * It is also **outside the transaction's rollback**, which is why a rolled-back publish burns a
 * number and leaves a gap. That is expected and meaningless: gaplessness would prove nothing
 * anyway, since the Operator is trusted and owns the database, and detecting a withheld
 * Decision needs the hash chain ADR-0001 rejected. Nothing checks, compacts or reports a gap.
 *
 * The sequence is asked for by `pg_get_serial_sequence` rather than by the name `drizzle-kit`
 * happened to generate, and the table and column are read off the schema objects, so nothing
 * here is a second spelling of a name the migration owns. The `::int` is what makes
 * PostgreSQL's `bigint` arrive as a JavaScript number rather than as the string `pg` renders
 * one as; the column itself is an `integer`, so the cast narrows nothing that was not already
 * narrow.
 */
async function drawSeq(tx: Transaction): Promise<number> {
  const table = `${decisionsSchema.schemaName}.${getTableName(decisions)}`;
  const [drawn] = await tx
    .select({
      seq: sql<number>`nextval(pg_get_serial_sequence(${table}, ${decisions.seq.name}))::int`,
    })
    // A one-row source to select from, because Drizzle's builder requires a `from` where
    // PostgreSQL does not. Reading `nextval` off `decisions` itself would draw one number per
    // row in the table, which is the wrong number of numbers on the second publish.
    .from(sql`(select 1) as drawing`);
  if (drawn === undefined) {
    throw new Error("the sequence behind decisions.seq answered no row");
  }
  return drawn.seq;
}

/**
 * The log, ascending by `seq`, and the one query every surface answers from.
 *
 * `before` and no cursor at all select **descending** and reverse in memory, because the newest
 * page is what a client opening the log wants and PostgreSQL cannot answer "the last fifty in
 * ascending order" without one or the other. The reversal is the whole of that asymmetry and it
 * is invisible from outside: every page arrives ascending, so a client concatenates them
 * without reversing anything (ADR-0035).
 *
 * On the part's own handle rather than a widened one: a read takes no transaction (ADR-0023),
 * and this part reads nothing but its own table.
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
