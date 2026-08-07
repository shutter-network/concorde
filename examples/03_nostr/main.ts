import path from "node:path";
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
const relayUrl = fromEnv("RELAY_URL");

// The framework parses no key material and generates none, so the hex becomes 32 raw bytes here.
const secretKey = Uint8Array.from(Buffer.from(fromEnv("NOSTR_AGENT_SECRET_KEY"), "hex"));

// Public keys and no secrets. An Operator records the key they were handed out of band, and the
// person keeps the half that signs.
const people = [
  { name: "alice", pubkey: fromEnv("ALICE_PUBKEY") },
  { name: "bob", pubkey: fromEnv("BOB_PUBKEY") },
];

const publicPort = 8083;
const agentPort = 7411;
const tokenTtl = 30 * 24 * 60 * 60 * 1000;

const runtime = createPiRuntime({
  image: "saf-nostr-agent:0.83.0",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  networks: ["saf_nostr_agent"],
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
    const users = createUsers({ db, tokenTtl, agentServer, publicServer });
    const messenger = createMessenger({ db, users, worker, agentServer });
    // The Channel registers itself with the Messenger and registers no route anywhere. The
    // relay is what a person reaches over this medium, so the Public server carries only the
    // login and there is nothing on it to message.
    const nostr = createNostrChannel({ db, messenger, users, secretKey, relayUrl });
    return { users, messenger, nostr };
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

const { db, users, nostr } = gateway.components;

// One transaction for both people. A User comes into existence, gets whatever the Operator
// records about them, and is admitted to this medium, and either all of that commits or none of
// it does. Guarded by an empty list so a restart does not mint a second pair.
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
