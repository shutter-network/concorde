import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDecisions } from "shared-agent-framework/decisions";
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
import { createSignatures } from "shared-agent-framework/signatures";
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

// The framework parses no PEM and generates no keypair, so loading the identity is this file's
// job. WARNING: `insecure-example-only-signing-key.pem` is committed to this repository, so
// everyone who has read it can forge this agent's signature. Generate your own before any of
// this signs something you would defend.
const signingKey = createPrivateKey(readFileSync(fromEnv("SIGNING_KEY_FILE")));

const people = [
  { name: "alice", password: fromEnv("ALICE_PASSWORD") },
  { name: "bob", password: fromEnv("BOB_PASSWORD") },
];

const publicPort = 8082;
const agentPort = 7411;
const tokenTtl = 30 * 24 * 60 * 60 * 1000;

const runtime = createPiRuntime({
  image: "saf-decisions-agent:0.83.0",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  networks: ["saf_decisions_agent"],
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
    const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl });
    // Signatures before Decisions, which signs through it in process rather than over HTTP, so a
    // publish inside a transaction never leaves this process. Neither takes Users: a Decision is
    // addressed to nobody, and both protected reads run behind the Public server's own hook.
    const signatures = createSignatures({ signingKey, agentServer, publicServer });
    const decisions = createDecisions({ db, signatures, agentServer, publicServer });
    const messenger = createMessenger({ db, users, worker, agentServer });
    const httpChannel = createHttpChannel({ db, messenger, publicServer });
    return { users, passwordAuth, signatures, decisions, messenger, httpChannel };
  },
  handlers: () => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: new URL("./message-received.hbs", import.meta.url),
      // One Session per person, so neither conversation carries the other's context.
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.start();

const { db, users, passwordAuth } = gateway.components;

// Both people in one transaction, so a User nobody can log in as never reaches the table. Guarded
// by an empty list so a restart does not mint a second pair and invalidate the ids you copied.
if ((await users.list({ limit: 1 })).length === 0) {
  await db.tx(async (tx) => {
    for (const person of people) {
      const user = await users.create(tx);
      await users.setAttributes(tx, user.id, { name: person.name });
      await passwordAuth.setPassword(tx, user.id, person.password);
    }
  });
}

for (const user of await users.list()) {
  console.log(`user ${user.id} ${JSON.stringify(user.attributes)}`);
}
for (const person of people) {
  console.log(`${person.name} logs in with the password ${person.password}`);
}

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
