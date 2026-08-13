import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDecisions } from "@shutter-network/concorde/decisions";
import { createGateway } from "@shutter-network/concorde/gateway";
import { createHttpChannel } from "@shutter-network/concorde/http-channel";
import {
  createMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "@shutter-network/concorde/messenger";
import { createPasswordAuth } from "@shutter-network/concorde/password-auth";
import { createPiRuntime } from "@shutter-network/concorde/pi";
import { templateHandler } from "@shutter-network/concorde/signals";
import { createSignatures } from "@shutter-network/concorde/signatures";
import { createUsers } from "@shutter-network/concorde/users";

const signingKey = createPrivateKey(readFileSync(process.env.SIGNING_KEY_FILE!));

const people = [
  { name: "alice", password: process.env.ALICE_PASSWORD! },
  { name: "bob", password: process.env.BOB_PASSWORD! },
];

const tokenTtl = 30 * 24 * 60 * 60 * 1000;

const runtime = createPiRuntime({
  image: process.env.AGENT_IMAGE!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    AGENT_SERVER_URL: process.env.AGENT_SERVER_URL!,
  },
  networks: [process.env.AGENT_NETWORK!],
  mounts: {
    runtimeDir: process.env.RUNTIME_DIR_HOST!,
    entries: [
      { agentPath: "/workspace", path: "state/workspace" },
      { agentPath: "/home/agent/.pi/agent", path: "state/agent" },
      { agentPath: "/workspace/AGENTS.md", path: "AGENTS.md", readOnly: true },
      { agentPath: "/home/agent/.pi/agent/settings.json", path: "settings.json", readOnly: true },
    ],
  },
});

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL!,
  runtime,
  publicListen: { host: process.env.PUBLIC_HOST!, port: Number(process.env.PUBLIC_PORT) },
  agentListen: { host: process.env.AGENT_HOST!, port: Number(process.env.AGENT_PORT) },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, agentServer, publicServer });
    const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl });
    const signatures = createSignatures({ signingKey, agentServer, publicServer });
    const decisions = createDecisions({ db, signatures, agentServer, publicServer });
    const messenger = createMessenger({ db, users, worker, agentServer });
    const httpChannel = createHttpChannel({ db, messenger, publicServer });
    return { users, passwordAuth, signatures, decisions, messenger, httpChannel };
  },
  handlers: () => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: `A message arrived for you from user {{userId}}. They said:

{{text}}

This message is {{userId}}'s. Your answer goes to {{userId}} and to no one else.

Answer them by sending them a Message. Your final reply here reaches nobody.`,
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.start();

const { db, users, passwordAuth } = gateway.components;

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
