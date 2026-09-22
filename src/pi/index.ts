/**
 * The `pi` Agent Implementation, driven as an **Agent Instance** the Operator runs.
 *
 * An Agent Implementation is the interchangeable agent program a Run happens in, and `pi` is the
 * one this package adapts. The Gateway does not start it: an Operator runs `pi --mode rpc` behind a
 * listener, in a container of their own, and {@link createPiRuntime} builds the Runtime the
 * Signal Worker performs each Run through — one connection per Run, opened when a Prompt exists and
 * closed when the agent has settled.
 *
 * {@link PiInstance} is the whole of the configuration and it is three values: where the instance
 * is, and where it keeps Sessions. There is no model, no provider, no image, no mount and no
 * credential here, because none of that is the Gateway's any more. What `pi` reads on disk and what
 * it is started with belong to the Operator's own compose file, and this subpath cannot refuse a
 * deployment that got them wrong: that deployment is a Gateway which starts, serves, and then fails
 * its Runs with whatever the agent says.
 *
 * Two things this subpath does refuse, and both are the Operator's mistake rather than the agent's.
 * A `sessionsDir` that is relative or missing is refused at construction, where the Operator wrote
 * it. A Session name outside `pi`'s own grammar fails that one Run, naming the Session: a Session is
 * addressed by path over RPC and `pi` will open any path it is handed, so the grammar is carried
 * here and a Handler's string can neither escape the directory nor reach the agent unchecked.
 *
 * An unreachable Agent Instance is a failed Run and never a boot failure, on the **Relay**
 * precedent. There is no startup probe, and adding one would turn an outage in a part the Operator
 * runs into a Gateway that will not start for any Party.
 *
 * @example
 * A Gateway whose Runtime is an Agent Instance on the agent network.
 * ```ts
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "@shutter-network/concorde/gateway";
 * import { createPiRuntime } from "@shutter-network/concorde/pi";
 * import { templateHandler } from "@shutter-network/concorde/signals";
 *
 * const runtime = createPiRuntime({
 *   // The service the Operator's compose file runs `pi --mode rpc` in, and the port its
 *   // listener accepts on. Nothing of the agent's environment is named here.
 *   host: "agent",
 *   port: 4000,
 *   // As the Agent Instance sees it, not as this process does: the Gateway never opens it.
 *   // `<sessionsDir>/<session>.jsonl` is the file one Session lives in.
 *   sessionsDir: "/sessions",
 * });
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime,
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   handlers: () => ({
 *     "note.written": templateHandler({
 *       template: readFileSync(new URL("./prompts/note-written.hbs", import.meta.url), "utf8"),
 *       session: () => "notes",
 *       data: (signal) => signal.payload,
 *     }),
 *   }),
 * });
 *
 * await gateway.start();
 * ```
 *
 * @module
 */

export type { PiInstance } from "./runtime.ts";
export { createPiRuntime } from "./runtime.ts";
