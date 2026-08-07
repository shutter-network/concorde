/**
 * The `pi` Agent Implementation, from `shared-agent-framework/pi`. An Agent Implementation is the
 * interchangeable agent program a Run happens in, and `pi` is the one this package adapts.
 *
 * {@link createPiRuntime} is the whole of it for an Operator: hand it an Agent Container, and pass
 * what comes back as the Signal Worker's `runtime`. {@link piRun} and {@link interpretPiOutput} are
 * pure functions, exported to be called from a test and to be read. `piRun` is what makes this `pi`
 * rather than some other agent, and it is the entire size of the job for an author writing a second
 * Agent Implementation.
 *
 * Nothing about a container is here. The Agent Container, the Mount Table, the argument assembly,
 * the confinement flags, the process handling and the diagnosis appended to a failure all come from
 * the package root, generic over which agent runs, so a second Agent Implementation takes them
 * unchanged.
 *
 * Nothing `pi`-shaped is here either, and there is no configuration type at all. The model and the
 * provider are `defaultModel` and `defaultProvider` in a `settings.json` the Operator mounts. The
 * working directory and the agent's own directory are `WORKDIR` and `PI_CODING_AGENT_DIR` in an
 * image the Operator builds, no `pi` image being published. The Session directory is `pi`'s own to
 * resolve. Nothing here writes a file or names a path, and so nothing here can refuse a deployment
 * that is missing one: that deployment is a Gateway which starts, serves, and then fails its first
 * Run permanently.
 *
 * @example
 * A Gateway whose Runtime is `pi`, in a container the Operator declared.
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 *
 * const runtime = createPiRuntime({
 *   image: "my-agent:1",
 *   networks: ["saf_default"],
 *   // Only what is named here reaches the agent. None of the Gateway's own environment does.
 *   env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
 *   mounts: {
 *     entries: [
 *       { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
 *       { agentPath: "/workspace/AGENTS.md", gatewayPath: "/srv/saf/AGENTS.md", readOnly: true },
 *     ],
 *   },
 * });
 *
 * // The command line, without starting a container: the one way to see the defaults applied.
 * console.log(runtime.commandFor({ session: "notes", text: "say hello" }).redactedArgs);
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime,
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   handlers: () => ({
 *     "note.written": templateHandler({
 *       template: new URL("./prompts/note-written.hbs", import.meta.url),
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

export { interpretPiOutput } from "./output.ts";
export { createPiRuntime, piRun } from "./runtime.ts";
