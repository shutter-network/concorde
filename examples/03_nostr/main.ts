import { createGateway } from "shared-agent-framework/gateway";
import {
  createMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "shared-agent-framework/messenger";
import { createNostrChannel } from "shared-agent-framework/nostr-channel";
import { createPiRuntime } from "shared-agent-framework/pi";
import { templateHandler } from "shared-agent-framework/signals";
import { createUsers } from "shared-agent-framework/users";

const relayUrl = process.env.RELAY_URL!;

const secretKey = Uint8Array.from(Buffer.from(process.env.NOSTR_AGENT_SECRET_KEY!, "hex"));

const people = [
  { name: "alice", pubkey: process.env.ALICE_PUBKEY! },
  { name: "bob", pubkey: process.env.BOB_PUBKEY! },
];

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
  extend: ({ db, agentServer, worker }) => {
    const users = createUsers({ db, agentServer });
    const messenger = createMessenger({ db, users, worker, agentServer });
    const nostr = createNostrChannel({ db, messenger, users, secretKey, relayUrl });
    return { users, messenger, nostr };
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

const { db, users, nostr } = gateway.components;

if ((await users.list({ limit: 1 })).length === 0) {
  await db.tx(async (tx) => {
    for (const person of people) {
      const user = await users.create(tx);
      await users.setAttributes(tx, user.id, { name: person.name });
      await nostr.recordPublicKey(tx, user.id, person.pubkey);
    }
  });
}

console.log(`the agent answers to ${nostr.publicKey} on ${relayUrl}`);
for (const user of await users.list()) {
  console.log(`user ${user.id} ${JSON.stringify(user.attributes)}`);
}

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
