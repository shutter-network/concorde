import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
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

// The Shared Agent's identity, read here because the framework reads nothing: it takes a
// `KeyObject` and parses no PEM, opens no file and looks at no environment variable, so
// whether this path came from a file, a secrets manager or a shell is this entry point's
// business and nobody else's (ADR-0016, ADR-0041). It is the same division `HOST_DIR` above
// is on, and this is the one place a reader sees whose job it is.
//
// Nothing generates one, deliberately: a fresh key per restart would leave every Decision
// ever published unverifiable, with nothing anywhere saying so.
const signingKeyFile = process.env.SIGNING_KEY_FILE;
if (signingKeyFile === undefined) {
  throw new Error(
    "set SIGNING_KEY_FILE to a PEM private key: it is the Shared Agent's identity, and the framework will not invent one",
  );
}
const signingKey = createPrivateKey(readFileSync(signingKeyFile));

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
  signingKey,
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
