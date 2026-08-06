/**
 * The `pi` Agent Implementation, from `shared-agent-framework/pi`.
 *
 * `createPiRuntime` is the whole of it for an Operator. Hand it an Agent Container, which comes
 * from the package root, because nothing about a container is `pi`'s. Then pass what comes back as
 * the Signal Worker's `runtime`. It contributes two overridable defaults and `piRun`, and nothing
 * else.
 *
 * The other two exports are pure functions and are here to be read. `piRun` is what makes this `pi`
 * rather than any other agent. A Prompt goes in. The flags, the stdin and the outcome reader for
 * one Run come out. An author of a second Agent Implementation should read it, because it is the
 * entire size of the job. `interpretPiOutput` reads the JSONL event stream into a Run outcome. It
 * is where three traps live. The exit code says nothing, the terminal record is `agent_settled`
 * rather than `agent_end`, and the framing is LF-only.
 *
 * There is no configuration type, no resolver and no invocation composer, because there is no
 * `pi`-shaped configuration left. The image, the mounts, the networks, the environment and the
 * flags describe a container and come from the package root. The model and the provider go in a
 * `settings.json` the Operator mounts. The working directory and the agent's own directory go in a
 * `Dockerfile` they build. The framework writes no file and names no path.
 *
 * @example
 * A Gateway whose Runtime is `pi`, in a container the Operator declared.
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({
 *     image: "my-agent:1",
 *     networks: ["saf_default"],
 *     // Only what is named here reaches the agent. None of the Gateway's own environment does.
 *     env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
 *     mounts: {
 *       entries: [
 *         { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
 *         { agentPath: "/workspace/AGENTS.md", gatewayPath: "/srv/saf/AGENTS.md", readOnly: true },
 *       ],
 *     },
 *   }),
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
 * @example
 * A second Agent Implementation, written by copying `piRun`.
 * ```ts
 * import type { RunPlan } from "shared-agent-framework";
 * import { createAgentContainerRuntime } from "shared-agent-framework";
 *
 * // One function is the whole of what an Agent Implementation adds.
 * const runtime = createAgentContainerRuntime({
 *   container: { image: "my-other-agent:1", entrypoint: ["other-agent"] },
 *   run: (prompt): RunPlan => ({
 *     args: ["--json", "--session", prompt.session],
 *     // On stdin, never argv: a Prompt is arbitrary text and an agent reads argv its own way.
 *     stdin: prompt.text,
 *     outcome: async (stdout) => {
 *       for await (const _chunk of stdout) {
 *         // Read the whole stream, even once the outcome is known: a subprocess whose stdout
 *         // stops being read blocks as soon as the pipe fills.
 *       }
 *       return { ok: true };
 *     },
 *   }),
 * });
 * ```
 *
 * @module
 */

export { interpretPiOutput } from "./output.ts";
export { createPiRuntime, piRun } from "./runtime.ts";
