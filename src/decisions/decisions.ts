import { and, asc, desc, getTableName, gt, lt, sql } from "drizzle-orm";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Db, Handle } from "../db/index.ts";
import type { Component } from "../gateway/components.ts";
import { type CursorWindow, limitSchema } from "../route-conventions.ts";
import type { Signatures } from "../signatures/index.ts";
import { agentDecisionRoutes, publicDecisionRoutes } from "./routes.ts";
import { decisions, decisionsSchema, decisionsTables } from "./schema/index.ts";

type DecisionsHandle = Handle<typeof decisionsTables>;

const decisionsPrefix = "/decisions";

const decisionTyp = "concorde-decision+jws";

export type DecisionRecord = {
  readonly seq: number;
  readonly statement: string;
  readonly jws: string;
  readonly createdAt: string;
};

export type DecisionWindow = CursorWindow;

export type DecisionsOptions = {
  readonly db: Db;
  readonly signatures: Signatures;
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
  readonly publicServer: {
    readonly fastify: FastifyInstance;
    readonly requireUser: preHandlerAsyncHookHandler;
  };
};

export type Decisions = Component & {
  /** Signs and persists a decision. Sequence gaps can occur after rollback; do not assume consecutive numbers. */
  publish<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    statement: string,
  ): Promise<DecisionRecord>;

  /**
   * Cursors are exclusive. `after` selects the next page; otherwise selects the latest page
   * before `before`, if supplied. Results are ascending by seq. Defaults to 50 records.
   */
  history(options?: {
    readonly after?: number;
    readonly before?: number;
    readonly limit?: number;
  }): Promise<DecisionRecord[]>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

export function createDecisions(options: DecisionsOptions): Decisions {
  const handle = options.db.handle(decisionsTables);

  const readHistory = (window: DecisionWindow) => selectDecisions(handle, window);

  const readNumbered = async (seq: number) => {
    const [atOrAfter] = await readHistory({ after: seq - 1, limit: 1 });
    return atOrAfter?.seq === seq ? atOrAfter : undefined;
  };

  const publishSigned = <TSchema extends Record<string, unknown>>(
    on: Handle<TSchema>,
    statement: string,
  ) => publishDecision(on, options.signatures, statement);

  const agentRoutes = agentDecisionRoutes({
    history: readHistory,
    numbered: readNumbered,
    publish: (statement) => options.db.tx((tx) => publishSigned(tx, statement)),
  });
  const publicRoutes = publicDecisionRoutes(
    { history: readHistory, numbered: readNumbered },
    options.publicServer.requireUser,
  );

  options.agentServer.fastify.register(agentRoutes, { prefix: decisionsPrefix });
  options.publicServer.fastify.register(publicRoutes, { prefix: decisionsPrefix });

  return {
    publish: publishSigned,
    history: (asked) => readHistory({ ...asked, limit: asked?.limit ?? limitSchema.default }),

    start: async () => {},
    stop: async () => {},
  };
}

async function publishDecision<TSchema extends Record<string, unknown>>(
  tx: Handle<TSchema>,
  signatures: Signatures,
  statement: string,
): Promise<DecisionRecord> {
  const seq = await drawSeq(tx);

  const createdAt = new Date();

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

async function drawSeq<TSchema extends Record<string, unknown>>(
  tx: Handle<TSchema>,
): Promise<number> {
  const table = `${decisionsSchema.schemaName}.${getTableName(decisions)}`;
  const [drawn] = await tx
    .select({
      seq: sql<number>`nextval(pg_get_serial_sequence(${table}, ${decisions.seq.name}))::int`,
    })
    .from(sql`(select 1) as drawing`);
  if (drawn === undefined) {
    throw new Error("the sequence behind decisions.seq answered no row");
  }
  return drawn.seq;
}

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
