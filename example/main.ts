import path from "node:path";
import { createGatewayWithDefaults, templateHandler } from "shared-agent-framework";
import { type MessageRecord, messageReceivedKind } from "shared-agent-framework/http-messenger";
import { createPiRuntime } from "shared-agent-framework/pi";

const hostDir = process.env.HOST_DIR;
if (hostDir === undefined) {
  throw new Error(
    "set HOST_DIR to this directory's path on the host: the agent's mounts are resolved there, not here",
  );
}

const runtime = createPiRuntime({
  image: "saf-agent:0.83.0",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  networks: ["saf_agent"],
  mounts: {
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
    hostPaths: { [import.meta.dirname]: hostDir },
  },
});

const gateway = createGatewayWithDefaults({
  runtime,
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
