import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const containerTestsVariable = "CONCORDE_CONTAINER_TESTS";

export const hostFromContainer = "host.docker.internal";

export const addHostToGateway = `--add-host=${hostFromContainer}:host-gateway`;

export const piImageTag = "concorde-pi-test:0.85.1";

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

export async function buildPiImage(): Promise<string> {
  const given = process.env.CONCORDE_PI_IMAGE;
  if (given !== undefined && given !== "") return given;
  const context = fileURLToPath(new URL("./pi-image", import.meta.url));
  await run("docker", ["build", "--tag", piImageTag, context], { maxBuffer: 1 << 24 });
  return piImageTag;
}

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
