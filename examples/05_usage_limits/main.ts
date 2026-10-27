import { createGateway } from "@shutter-network/concorde/gateway";
import { createHttpChannel } from "@shutter-network/concorde/http-channel";
import {
  createMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "@shutter-network/concorde/messenger";
import { createPasswordAuth } from "@shutter-network/concorde/password-auth";
import { createPiRuntime } from "@shutter-network/concorde/pi";
import type { SignalHandler } from "@shutter-network/concorde/signals";
import { createUsers } from "@shutter-network/concorde/users";

const people = [
  { name: "alice", password: process.env.ALICE_PASSWORD! },
  { name: "bob", password: process.env.BOB_PASSWORD! },
];

const dailyTokenLimit = Number(process.env.DAILY_TOKEN_LIMIT);
if (!Number.isSafeInteger(dailyTokenLimit) || dailyTokenLimit <= 0) {
  throw new Error("Set DAILY_TOKEN_LIMIT to a positive whole number of tokens.");
}

const limitReached = "Your daily usage limit is reached. It resets at 00:00 UTC.";
const tryAgain = "I could not complete that request. Please try again in a minute.";

const tokenTtl = 30 * 24 * 60 * 60 * 1000;

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const runtime = createPiRuntime({
  host: process.env.AGENT_INSTANCE_HOST!,
  port: Number(process.env.AGENT_INSTANCE_PORT),
  sessionsDir: process.env.AGENT_SESSIONS_DIR!,
});

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL!,
  runtime,
  publicListen: { host: process.env.PUBLIC_HOST!, port: Number(process.env.PUBLIC_PORT) },
  agentListen: {
    host: process.env.AGENT_SERVER_HOST!,
    port: Number(process.env.AGENT_SERVER_PORT),
  },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, agentServer, publicServer });
    const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl });
    const messenger = createMessenger({ db, users, worker, agentServer });
    const httpChannel = createHttpChannel({ db, messenger, publicServer });
    return { users, passwordAuth, messenger, httpChannel };
  },
  handlers: ({ db, usage, messenger }) => {
    const tell = (userId: string, text: string) => db.tx((tx) => messenger.send(tx, userId, text));

    const messageHandler: SignalHandler<MessageRecord> = {
      async handle(signal) {
        const { userId, text } = signal.payload;
        const used = await usage.total({ userId, since: startOfUtcDay(new Date()) });
        if (used.totalTokens >= dailyTokenLimit) {
          await tell(userId, limitReached);
          return [];
        }
        return [
          {
            session: `user_${userId}`,
            text: `User ${userId} sent this message:

${text}

Send your reply through the gateway messaging API. Your final model response is not delivered.`,
            userId,
            usageLimit: dailyTokenLimit - used.totalTokens,
          },
        ];
      },
      async post(signal, outcome) {
        if (outcome.limited) {
          await tell(signal.payload.userId, limitReached);
        } else if (outcome.failed) {
          await tell(signal.payload.userId, tryAgain);
        }
      },
    };

    return { [messageReceivedKind]: messageHandler };
  },
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
console.log(`each user may use ${dailyTokenLimit} model tokens per UTC day`);

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
