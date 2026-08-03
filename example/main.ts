import path from "node:path";
import { createGatewayWithDefaults, templateHandler } from "shared-agent-framework";
import { type MessageRecord, messageReceivedKind } from "shared-agent-framework/http-messenger";
import { createPiRuntime } from "shared-agent-framework/pi";

// Where this directory is on the **host**. No process inside a container can work that out,
// and every mount below is resolved by the host's daemon rather than by this filesystem, so
// it is required rather than guessed: a wrong answer is a mount that resolves to somewhere
// real and wrong, forever, with nothing saying so (ADR-0028). `compose.yml` sets it.
const hostExampleDir = process.env.HOST_EXAMPLE_DIR;
if (hostExampleDir === undefined) {
  throw new Error(
    "set HOST_EXAMPLE_DIR to this directory's path on the host: the agent's mounts are resolved there, not here",
  );
}

const runtime = createPiRuntime({
  image: "saf-agent:0.83.0",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  networks: ["saf_agent"],
  mounts: {
    // Two of these four name paths that **do not exist in this container**: `AGENTS.md` and
    // `settings.json` are read by the agent, so they are not in the Gateway's image, and
    // the daemon mounts them from the host through `hostPaths` below. That is legal because
    // resolving a Mount Table performs no I/O at all (ADR-0028).
    entries: [
      {
        containerPath: "/workspace",
        gatewayPath: path.join(import.meta.dirname, "state", "workspace"),
      },
      {
        containerPath: "/home/agent/.pi/agent",
        gatewayPath: path.join(import.meta.dirname, "state", "agent"),
      },
      {
        containerPath: "/workspace/AGENTS.md",
        gatewayPath: path.join(import.meta.dirname, "AGENTS.md"),
        readOnly: true,
      },
      {
        containerPath: "/home/agent/.pi/agent/settings.json",
        gatewayPath: path.join(import.meta.dirname, "settings.json"),
        readOnly: true,
      },
    ],
    // One prefix, and one fact: this directory, over there. Every entry above is under it,
    // which is the whole reason the state lives inside `example/` rather than beside it.
    hostPaths: { [import.meta.dirname]: hostExampleDir },
  },
});

const gateway = createGatewayWithDefaults({
  runtime,
  // Both `0.0.0.0`, and neither is exposed by that alone: this process is in a container,
  // so a bind reaches the networks the container joined and nothing else. 8080 is published
  // to the host by `compose.yml` and 7411 is published to nobody, which is what keeps the
  // unauthenticated Agent server unreachable from outside the stack (ADR-0010).
  publicListen: { port: 8080, host: "0.0.0.0" },
  agentListen: { port: 7411, host: "0.0.0.0" },
  handlers: () => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: new URL("./prompts/message-received.hbs", import.meta.url),
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.components.db.migrate();
await gateway.start();

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
