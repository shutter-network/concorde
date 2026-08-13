/**
 * One Run in one fresh container, generic over which agent program runs in it. An Agent Container
 * is the declaration of that container: the image, what it reaches on disk, the networks, the
 * environment and the flags the framework does not model. It is inert, and creates nothing until a
 * Run starts.
 *
 * {@link createAgentContainerRuntime} is the entry point. It takes an
 * {@link AgentContainerRuntimeSpec}, which is an {@link AgentContainer} beside one function that
 * answers each Run with a {@link RunPlan}: what to put after the image, what to write on stdin, and
 * how to read stdout. {@link AgentContainerRuntime} comes back, a Runtime the Signal Worker
 * accepts, and `commandFor` on it composes one Run's {@link ComposedCommand} and starts nothing.
 * {@link MountTable} is the disk half, one {@link Mount} per directory or file, and
 * {@link mountArguments} turns a table into container arguments on its own.
 *
 * Reach for this to drive an agent program this package does not adapt. For `pi`,
 * `@shutter-network/concorde/pi` supplies that one function and two defaults, and takes an
 * {@link AgentContainer} written exactly as it is written here. Nothing on this subpath names an
 * agent program or reads a value one of them defines, so what the agent finds in its image and on
 * its command line stays the author's to decide.
 *
 * Nothing here reads the filesystem. {@link createAgentContainerRuntime} composes a command line
 * once, at construction, so a declaration that cannot mean anything is refused where the Operator
 * wrote it. Whether a path exists is the container runtime's answer, and it arrives at the first
 * Run as a Run that failed and will not be retried. This subpath has no Component and no route, it
 * does not use the Db, and it exports no schema.
 *
 * @example
 * A Runtime for an agent program of your own: it takes the Prompt on stdin and prints what it said
 * on stdout.
 * ```ts
 * import { createAgentContainerRuntime } from "@shutter-network/concorde/agent-container";
 * import { createGateway } from "@shutter-network/concorde/gateway";
 *
 * const runtime = createAgentContainerRuntime({
 *   container: {
 *     image: "my-own-agent:1",
 *     networks: ["concorde_default"],
 *     // Only what is named here reaches the agent. None of the Gateway's own environment does.
 *     env: { MY_AGENT_KEY: process.env.MY_AGENT_KEY ?? "" },
 *     mounts: {
 *       // The host's path to the shared tree, and every entry written under it.
 *       runtimeDir: "/srv/concorde",
 *       entries: [
 *         { agentPath: "/workspace", path: "workspace" },
 *         { agentPath: "/workspace/AGENTS.md", path: "AGENTS.md", readOnly: true },
 *       ],
 *     },
 *   },
 *   // Called once per Run, and its result drives both the command line and the reading of stdout.
 *   run: (prompt) => ({
 *     args: ["--session", prompt.session],
 *     stdin: prompt.text,
 *     outcome: async (stdout) => {
 *       const chunks: Uint8Array[] = [];
 *       for await (const chunk of stdout) chunks.push(chunk);
 *       const said = Buffer.concat(chunks).toString("utf8").trim();
 *       // A bad stream is a failed Run and never a throw, which would kill the container.
 *       return said === "" ? { ok: false, error: "the agent said nothing" } : { ok: true };
 *     },
 *   }),
 * });
 *
 * // The whole command line, with the defaults applied and every environment value hidden.
 * console.log(runtime.commandFor({ session: "notes", text: "say hello" }).redactedArgs);
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime,
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 * ```
 *
 * @module
 */

export type {
  AgentContainer,
  AgentContainerRuntime,
  AgentContainerRuntimeSpec,
  ComposedCommand,
  RunPlan,
} from "./agent-container.ts";
export { createAgentContainerRuntime } from "./agent-container.ts";
export type { Mount, MountTable } from "./mount-table.ts";
export { mountArguments } from "./mount-table.ts";
