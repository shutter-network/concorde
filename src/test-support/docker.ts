/**
 * What the one opt-in container test needs of the machine it runs on.
 *
 * That test is **opt-in and skipped**, which is a deliberate trade rather than
 * timidity. It needs a container runtime, an image built from the network, and about
 * ten seconds; `npm run check` is the inner loop and the command CI is measured by, so
 * a test that slow does not belong in it by default. Everything else about running an
 * agent in a container is a fast test — the composed command line in
 * `../pi/runtime.test.ts`, the pure functions over captured output in
 * `../pi/output.test.ts`, and the stub container runtime in
 * `../container/agent-container.test.ts` — so what is being skipped is exactly the three
 * things nothing else can prove: that mounts resolve, that user ids match, and that a
 * Session resumes.
 *
 * `npm run test:container` sets the variable. CI runs it as its own step.
 */

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The variable that opts in. */
export const containerTestsVariable = "SAF_CONTAINER_TESTS";

/**
 * How the agent's container reaches this process.
 *
 * `host.docker.internal` resolves by itself under Docker Desktop and not at all under
 * a plain Linux daemon, where `--add-host` below supplies it. One name for both is what
 * keeps the test's configuration the same everywhere.
 */
export const hostFromContainer = "host.docker.internal";

/**
 * What a container needs to reach a server on this host.
 *
 * Required on Linux, where `host.docker.internal` is not a name the daemon knows;
 * harmless under Docker Desktop, which defines it anyway. `host-gateway` has been a
 * supported value since Docker 20.10.
 *
 * Note what this means for a deployment: the Agent server binding loopback works from a
 * container under Docker Desktop and **does not** under a plain Linux daemon, where the
 * server has to be bound somewhere the bridge can reach. Two separate values, the `host`
 * the Operator gives Fastify's `listen` and the address they write into the agent's own
 * `AGENTS.md`, both theirs and neither derivable from the other (ADR-0010).
 */
export const addHostToGateway = `--add-host=${hostFromContainer}:host-gateway`;

/** The image the container test runs, built from `./pi-image/Dockerfile`. */
export const piImageTag = "saf-pi-test:0.83.0";

/**
 * Why the container tests are being skipped, or `false` when they are not.
 *
 * A reason rather than a boolean, because `node:test` prints it: a test that vanishes
 * silently is a test nobody notices has stopped running.
 */
export async function skipContainerTests(): Promise<string | false> {
  if (process.env[containerTestsVariable] === undefined) {
    return `set ${containerTestsVariable}=1 to run the container tests (npm run test:container); they need Docker, the network, and about ten seconds`;
  }
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch (error) {
    return `no container runtime answered: ${error instanceof Error ? error.message : String(error)}`;
  }
  return false;
}

/**
 * Builds the test image and returns its tag, or takes one the environment names.
 *
 * `SAF_PI_IMAGE` is for a machine with no network or a registry of its own; anything it
 * names has to satisfy what `./pi-image/Dockerfile` documents.
 */
export async function buildPiImage(): Promise<string> {
  const given = process.env.SAF_PI_IMAGE;
  if (given !== undefined && given !== "") return given;
  const context = fileURLToPath(new URL("./pi-image", import.meta.url));
  // Every time, because the layer cache makes a rebuild of an unchanged Dockerfile
  // about a second, and a stale image is a confusing failure to chase.
  await run("docker", ["build", "--tag", piImageTag, context], { maxBuffer: 1 << 24 });
  return piImageTag;
}

/**
 * A TCP port nothing is listening on.
 *
 * Needed because the agent is told where the Agent server is in a file written before the
 * Run, and that file has to carry the port, while the port is only known after listening
 * — so the port is chosen first and both values are built from it. The gap between
 * closing this socket and the server taking the port is a race in principle and has never
 * been one in practice.
 */
export async function reservePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((listening) => socket.listen(0, "127.0.0.1", listening));
  const address = socket.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a TCP port");
  }
  const { port } = address;
  await new Promise<void>((closed) => socket.close(() => closed()));
  return port;
}
