/**
 * The Db is the one PostgreSQL client in a Gateway. Every other part queries through it, so a
 * deployment holds one pool, and `pg` reaches no code but this.
 *
 * {@link openDb} makes one from a connection URL. {@link Db} is what comes back, a Component whose
 * programmatic API hands out a schema-typed {@link Handle} per component, runs a callback inside a
 * {@link Transaction}, and registers a PostgreSQL `LISTEN` on a connection of its own.
 * {@link ChannelListener} is what that registration reports to, and {@link Listening} is what
 * cancels it.
 *
 * `createGateway` opens a Db already and passes it to `extend`, so call {@link openDb} yourself
 * only when you assemble a Gateway by hand. Either way it is constructed before every component
 * that queries through it, each taking it as an option.
 *
 * **It applies no DDL and verifies none**, so a database behind the code starts cleanly and fails
 * at the first query instead. The Db owns no tables and exports no schema of its own: every table
 * belongs to a component, and putting them all in place is the Operator's own `drizzle-kit` run,
 * before the Gateway starts.
 *
 * @example
 * A pool opened by hand, a handle typed to one component's tables, and a write inside a
 * transaction.
 * ```ts
 * import { sql } from "drizzle-orm";
 * import { openDb } from "shared-agent-framework/db";
 * import { users, usersTables } from "shared-agent-framework/users";
 *
 * const db = openDb(process.env.DATABASE_URL ?? "");
 * // Nothing was on the wire until here, which is what lets every component be constructed first.
 * await db.start();
 *
 * // One handle per component, typed to that component's tables and to no others.
 * const handle = db.handle(usersTables);
 * const everybody = await handle.select().from(users);
 * console.log(`${everybody.length} users`);
 *
 * // Both writes commit together, or neither does. Only what goes through `tx` is in it.
 * await db.tx(async (tx) => {
 *   await tx.execute(sql`insert into audit (event) values ('the roll was read')`);
 *   await tx.execute(sql`update counters set reads = reads + 1`);
 * });
 *
 * await db.stop();
 * ```
 *
 * @module
 */

export type { ChannelListener, Db, Handle, Listening, Transaction } from "./db.ts";
export { openDb } from "./db.ts";
