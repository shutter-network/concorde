import path from "node:path";
import { createGateway } from "shared-agent-framework/gateway";
import { createHttpChannel } from "shared-agent-framework/http-channel";
import {
  createMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "shared-agent-framework/messenger";
import { createPasswordAuth } from "shared-agent-framework/password-auth";
import { createPiRuntime } from "shared-agent-framework/pi";
import { templateHandler } from "shared-agent-framework/signals";
import { createUsers } from "shared-agent-framework/users";

function fromEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`set ${name}: the framework reads no environment, so this file does`);
  }
  return value;
}

const baseDirGateway = fromEnv("BASE_DIR_GATEWAY");
const baseDirHost = fromEnv("BASE_DIR_HOST");
const databaseUrl = fromEnv("DATABASE_URL");
const password = fromEnv("USER_PASSWORD");

const publicPort = 8081;
const agentPort = 7411;
const tokenTtl = 30 * 24 * 60 * 60 * 1000;

const runtime = createPiRuntime({
  image: "saf-minimal-agent:0.83.0",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  networks: ["saf_minimal_agent"],
  mounts: {
    entries: [
      {
        agentPath: "/workspace",
        gatewayPath: path.join(baseDirGateway, "state", "workspace"),
      },
      {
        agentPath: "/home/agent/.pi/agent",
        gatewayPath: path.join(baseDirGateway, "state", "agent"),
      },
      {
        agentPath: "/workspace/AGENTS.md",
        gatewayPath: path.join(baseDirGateway, "AGENTS.md"),
        readOnly: true,
      },
      {
        agentPath: "/home/agent/.pi/agent/settings.json",
        gatewayPath: path.join(baseDirGateway, "settings.json"),
        readOnly: true,
      },
    ],
    hostRoot: { gatewayPath: baseDirGateway, hostPath: baseDirHost },
  },
});

const gateway = createGateway({
  databaseUrl,
  runtime,
  publicListen: { host: "0.0.0.0", port: publicPort },
  agentListen: { host: "0.0.0.0", port: agentPort },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, agentServer, publicServer });
    // The one scheme this deployment accepts. It registers itself with the Public server, and that
    // server composes every registered Auth into the one `requireUser` the Channel's two routes
    // take. Build none and every route on that server refuses every request.
    const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl });
    const messenger = createMessenger({ db, users, worker, agentServer });
    const httpChannel = createHttpChannel({ db, messenger, publicServer });
    return { users, passwordAuth, messenger, httpChannel };
  },
  handlers: () => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: new URL("./message-received.hbs", import.meta.url),
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.start();

const { db, users, passwordAuth } = gateway.components;

// One transaction, so a User nobody can log in as never reaches the table. Guarded by an empty
// list so a restart does not mint a second person and invalidate the id you copied.
if ((await users.list({ limit: 1 })).length === 0) {
  await db.tx(async (tx) => {
    const user = await users.create(tx);
    await users.setAttributes(tx, user.id, { name: "the one person here" });
    await passwordAuth.setPassword(tx, user.id, password);
  });
}

for (const user of await users.list()) {
  console.log(`user ${user.id} logs in with the password ${password}`);
}

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
