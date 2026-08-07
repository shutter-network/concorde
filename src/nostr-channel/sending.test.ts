/**
 * The agent answers, and what a User's Nostr client, an Operator's SQL and the Relay each end up
 * holding.
 *
 * **Every test here is about the seam a publish cannot cross.** A publish cannot be rolled back
 * and a transaction can, so the send is two halves: everything knowable happens inside the
 * caller's transaction and throws there with nothing recorded, and the network act happens after
 * it commits
 * ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)). So the
 * assertions come in pairs — what the Relay received, and what the log and the queue say — because
 * either one alone would pass for a Channel that had put the two halves back together.
 *
 * Everything is asserted at the top seam. The reply is read out of the fake Relay the way the
 * recipient's own client reads it, over the real two layers and with the seal's author compared,
 * and never by reaching into the Channel. `drain` is the one production seam this needs: without
 * it every outbound assertion would race a database notification. One test deliberately does not
 * use it, so that the notification wiring is proven once rather than assumed everywhere.
 *
 * Real PostgreSQL, a real WebSocket, a real HTTP request for the Relay's NIP-11 document, and the
 * Signal Worker constructed but never started: nothing outbound emits a Signal.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import type { NostrEvent } from "nostr-tools/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Db } from "../db/index.ts";
import { serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import type { MessageRecord } from "../messenger/messages.ts";
import { createMessenger, type Messenger } from "../messenger/messenger.ts";
import * as messengerSchema from "../messenger/schema.ts";
import * as signalsSchema from "../signals/schema.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import {
  type FakeRelay,
  type FakeRelayOptions,
  startFakeRelay,
} from "../test-support/fake-relay.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { readDirectMessage } from "../test-support/nostr-envelopes.ts";
import { waitUntil } from "../test-support/wait.ts";
import * as usersSchema from "../users/schema.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createNostrChannel, type NostrChannel } from "./nostr-channel.ts";
import * as nostrChannelSchema from "./schema.ts";
import { nostrChannelTables, outbox } from "./schema.ts";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let database: TestDatabase;
let db: Db;
let users: Users;
let worker: SignalWorker;

before(async () => {
  database = await createTestDatabase("nostr_sending");
  db = database.db;
  await applySchema(db, signalsSchema, usersSchema, messengerSchema, nostrChannelSchema);
  users = createUsers({ db, tokenTtl: 60 * 60 * 1000 });
  worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {}, logger: silent });
});

after(() => database.drop());

/** One deployment's worth of Nostr: a Relay, a Messenger and the Channel registered with it. */
type Deployment = {
  readonly relay: FakeRelay;
  readonly messenger: Messenger;
  readonly channel: NostrChannel;
};

/**
 * A Messenger and the one Channel registered with it, pointed at a Relay and **not started**.
 *
 * A Messenger of its own each time, because a Channel registers with one Messenger once. The
 * secret key is a parameter for the one test that needs two Channels to be the same agent across
 * a restart.
 */
function deploymentFor(relay: FakeRelay, secretKey: Uint8Array = generateSecretKey()): Deployment {
  const messenger = createMessenger({
    db,
    users,
    worker,
    agentServer: serverComponent(Fastify(), nowhere),
  });
  const channel = createNostrChannel({
    db,
    messenger,
    users,
    secretKey,
    relayUrl: relay.url,
    logger: silent,
  });
  return { relay, messenger, channel };
}

/**
 * A started Relay, a Messenger and a **started** Channel, torn down whether the body threw or not.
 *
 * Started here, unlike the inbound suite's, because most claims in this file are about a Channel
 * that has a Relay to publish to. The two tests about a Channel that has not started build their
 * own from `deploymentFor` and say so.
 */
async function withDeployment(
  body: (deployment: Deployment) => Promise<void>,
  options: FakeRelayOptions = {},
): Promise<void> {
  const relay = await startFakeRelay(options);
  const deployment = deploymentFor(relay);
  await deployment.channel.start();
  try {
    await body(deployment);
  } finally {
    await deployment.channel.stop();
    await relay.stop();
  }
}

/** A User the Operator admitted, holding the secret key their own client would hold. */
type Recipient = { readonly id: string; readonly secretKey: Uint8Array };

async function admit(channel: NostrChannel): Promise<Recipient> {
  const secretKey = generateSecretKey();
  const id = await db.tx(async (tx) => {
    const user = await users.create(tx);
    await channel.recordPublicKey(tx, user.id, getPublicKey(secretKey));
    return user.id;
  });
  return { id, secretKey };
}

/** A User with no Nostr key recorded: a person the agent has no way to reach over this medium. */
async function unreachable(): Promise<string> {
  const user = await db.tx((tx) => users.create(tx));
  return user.id;
}

/** The agent answering somebody, through the surface a Signal Handler's post phase uses. */
function answer(messenger: Messenger, userId: string, text: string): Promise<MessageRecord> {
  return db.tx((tx) => messenger.send(tx, userId, text));
}

/**
 * The queue rows for one User, which is the query an Operator makes to answer "why not".
 *
 * Asked per User rather than of the whole table, because the refused row one test leaves behind is
 * the point of that test and must not become the next one's noise.
 */
function queuedFor(userId: string): Promise<(typeof outbox.$inferSelect)[]> {
  return db.handle(nostrChannelTables).select().from(outbox).where(eq(outbox.userId, userId));
}

/**
 * Every reply the Relay is holding, and nothing else the agent published.
 *
 * A start also publishes the agent's relay list, which is a claim `connecting.test.ts` owns and
 * noise here: filtering to the gift wrap keeps "the Relay has one event" meaning "one reply".
 */
function replies(relay: FakeRelay): readonly NostrEvent[] {
  return relay.published.filter((event) => event.kind === 1059);
}

/** How many times this exact event was ever offered to the Relay, accepted or refused. */
function offered(relay: FakeRelay, eventId: string): number {
  return relay.received.filter(
    (message) => message.verb === "EVENT" && message.event?.id === eventId,
  ).length;
}

/**
 * What the Relay's one and only reply says, read as its recipient's own client reads it.
 *
 * Asserting the count here rather than at each call site is what makes "exactly one event per
 * reply" part of every one of these assertions rather than a claim one test makes alone.
 */
function soleReplyTo(relay: FakeRelay, recipient: Recipient): string | undefined {
  assert.equal(replies(relay).length, 1);
  const [wrap] = replies(relay);
  return wrap === undefined
    ? undefined
    : readDirectMessage(wrap, recipient.secretKey)?.rumor.content;
}

describe("the agent's reply reaching a User's Nostr client", () => {
  it("arrives once, readable by that User alone, with the agent as its sealed author", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);
      const eavesdropper = generateSecretKey();

      await answer(messenger, recipient.id, "the deploy finished");
      await channel.drain();

      // One event for one reply. The protocol's self-copy — a second wrap addressed to the
      // sender, so a client can recover its own sent messages — is deliberately not published:
      // the agent's record of what it said is the Message log.
      assert.equal(replies(relay).length, 1);
      const [wrap] = replies(relay);
      assert.ok(wrap !== undefined);

      // Read the way the recipient's own client reads it, and the seal's author is what makes the
      // answer attributable: the gift wrap is signed by a throwaway key and the rumor is not
      // signed at all, so this is the only thing that says the agent wrote it.
      const read = readDirectMessage(wrap, recipient.secretKey);
      assert.equal(read?.rumor.content, "the deploy finished");
      assert.equal(read?.sealAuthor, channel.publicKey);
      assert.equal(read?.rumor.pubkey, channel.publicKey);
      // NIP-17's private direct message, which is the kind the User's client threads by, and
      // addressed to them so it lands in the conversation they already have with the agent.
      assert.equal(read?.rumor.kind, 14);
      assert.deepEqual(read?.rumor.tags, [["p", getPublicKey(recipient.secretKey)]]);

      // And by nobody else. A second key gets exactly what an anonymous reader of the Relay
      // gets, which is nothing.
      assert.equal(readDirectMessage(wrap, eavesdropper), undefined);

      // A successful publish leaves no row behind, so anything in this table is something an
      // Operator wants to see.
      assert.deepEqual(await queuedFor(recipient.id), []);
    });
  });

  it("tells the Relay nothing about who is being answered, or when", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);
      const recipientKey = getPublicKey(recipient.secretKey);

      // Five, because the wrap's timestamp is randomised across two days and one sample cannot
      // tell a randomised clock from an honest one.
      for (const nth of [1, 2, 3, 4, 5]) await answer(messenger, recipient.id, `reply ${nth}`);
      await channel.drain();
      assert.equal(replies(relay).length, 5);

      const seconds = Math.floor(Date.now() / 1000);
      for (const wrap of replies(relay)) {
        // The recipient, and nobody else: no second `p` tag, and no tag naming the agent.
        assert.deepEqual(wrap.tags, [["p", recipientKey]]);
        // Signed by a throwaway key, so the Relay cannot even see which of its Users is talking.
        assert.notEqual(wrap.pubkey, channel.publicKey);
        assert.notEqual(wrap.pubkey, recipientKey);
        // Nothing in the clear. Both layers are encrypted, so the words are not on the wire.
        assert.equal(wrap.content.includes("reply"), false);
        // Never dated in the future, which some Relays refuse outright.
        assert.ok(wrap.created_at <= seconds);
      }

      // And not the real time either: NIP-59 randomises the wrap's date up to two days into the
      // past, so five of them all landing inside the last hour would take about a billion runs.
      const oldest = Math.min(...replies(relay).map((wrap) => wrap.created_at));
      assert.ok(oldest < seconds - 3600, "the published timestamps should not be the real ones");
    });
  });

  it("publishes without being told to, because the queue row wakes the drain", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);

      // The one test in this file that does not call `drain`. Everything else drives that seam
      // directly, so this is what proves the wiring behind it exists at all: the row and its
      // notification commit together, and the Channel is listening.
      await answer(messenger, recipient.id, "nobody drained this");

      // Waited for on the row and not on the Relay, which records a publish before it answers
      // for it: the row goes when the answer arrives, so it is the later of the two.
      await waitUntil(
        "the notification reaches the Relay",
        async () => (await queuedFor(recipient.id)).length === 0,
      );
      assert.equal(soleReplyTo(relay, recipient), "nobody drained this");
      assert.deepEqual(await queuedFor(recipient.id), []);
    });
  });
});

describe("a reply that could never go out", () => {
  it("refuses a User with no recorded key, and records no Message", async () => {
    await withDeployment(async ({ relay, messenger }) => {
      const stranger = await unreachable();

      await assert.rejects(
        () => answer(messenger, stranger, "nobody will read this"),
        /UnrecordedPublicKeyError/,
      );

      // The refusal happened inside the transaction that was writing the Message, so the row went
      // with it. Nothing claims to have been sent, and nothing is queued to try later.
      assert.deepEqual(await messenger.history(stranger), []);
      assert.deepEqual(await queuedFor(stranger), []);
      assert.deepEqual(replies(relay), []);
    });
  });

  it("refuses a reply larger than the Relay accepts, and records no Message", async () => {
    await withDeployment(
      async ({ relay, messenger, channel }) => {
        const recipient = await admit(channel);

        // Encryption is base64 of base64, so a reply is roughly a floor plus twice its length by
        // the time it is a wrap. This one is comfortably past a 4 KB Relay.
        await assert.rejects(
          () => answer(messenger, recipient.id, "x".repeat(8000)),
          /MessageTooLargeError/,
        );
        assert.deepEqual(await messenger.history(recipient.id), []);
        assert.deepEqual(await queuedFor(recipient.id), []);
        assert.deepEqual(replies(relay), []);

        // And the bound is a bound rather than a blanket refusal: the same Relay takes a reply
        // that fits, which is what says the size was compared against what it advertised.
        await answer(messenger, recipient.id, "short enough");
        await channel.drain();
        assert.equal(replies(relay).length, 1);
      },
      { information: { limitation: { max_message_length: 4096 } } },
    );
  });

  it("publishes nothing for a transaction that rolls back", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);

      // The Operator's own transaction: the agent answers, the Operator records why, and then
      // something else in it fails. Both halves of their work are lost — and so is the wrap,
      // which is the point of building it here rather than publishing it here.
      await assert.rejects(
        () =>
          db.tx(async (tx) => {
            await messenger.send(tx, recipient.id, "said inside a doomed transaction");
            await users.setAttributes(tx, recipient.id, { told: "yes" });
            throw new Error("the Operator's own work failed");
          }),
        /the Operator's own work failed/,
      );

      await channel.drain();
      assert.deepEqual(await messenger.history(recipient.id), []);
      assert.deepEqual(await queuedFor(recipient.id), []);
      assert.deepEqual(replies(relay), []);
      assert.deepEqual((await users.get(recipient.id))?.attributes, {});
    });
  });

  it("commits the answer and the Operator's own record together", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);

      const said = await db.tx(async (tx) => {
        const message = await messenger.send(tx, recipient.id, "we shipped it");
        await users.setAttributes(tx, recipient.id, { told: "yes" });
        return message;
      });

      await channel.drain();
      assert.equal((await messenger.history(recipient.id))[0]?.id, said.id);
      assert.deepEqual((await users.get(recipient.id))?.attributes, { told: "yes" });
      assert.equal(soleReplyTo(relay, recipient), "we shipped it");
    });
  });
});

describe("a publish the Relay will not take", () => {
  it("leaves one durable row carrying the Relay's own reason, and is never attempted again", async () => {
    await withDeployment(
      async ({ relay, messenger, channel }) => {
        const recipient = await admit(channel);

        const said = await answer(messenger, recipient.id, "the Relay will not take this");
        await channel.drain();

        // The Message stands: it was accepted for delivery, and what failed happened afterwards.
        assert.equal(
          (await messenger.history(recipient.id))[0]?.text,
          "the Relay will not take this",
        );

        const [row] = await queuedFor(recipient.id);
        assert.ok(row !== undefined, "a refused publish should leave a row an Operator can find");
        // The reason as the protocol gives it, prefix and all, so "the Relay was down" and "the
        // Relay refused this" are distinguishable without reading prose.
        assert.equal(row.reason, "blocked: this Relay does not take those");
        assert.notEqual(row.failedAt, null);
        // And the row names the Message, which is the whole route from a stuck queue back to the
        // words: the wrap itself is encrypted to the recipient.
        assert.equal(row.messageId, said.id);

        const eventId = row.eventId;
        assert.equal(offered(relay, eventId), 1);

        // Three more chances to get it wrong: a drain of its own, a further Message's
        // notification, and a stop and start — which is the case a restart would hide.
        await channel.drain();
        await answer(messenger, recipient.id, "a later reply, which wakes the drain again");
        await channel.drain();
        await channel.stop();
        await channel.start();
        await channel.drain();

        assert.equal(offered(relay, eventId), 1);
        assert.equal((await queuedFor(recipient.id)).length, 2);
      },
      { refuse: () => "blocked: this Relay does not take those" },
    );
  });
});

describe("a reply queued while the Channel is not running", () => {
  it("is published when it starts, which is how work outlives a process", async () => {
    const relay = await startFakeRelay();
    // Two Channels on one identity, one after the other: the second is the next process, holding
    // the same key and the same Relay, and finding a row the first one left behind. Each gets its
    // own Messenger, because a second Channel on one Messenger is refused at registration.
    const secretKey = generateSecretKey();
    const { messenger, channel: first } = deploymentFor(relay, secretKey);
    const { channel: second } = deploymentFor(relay, secretKey);

    try {
      const recipient = await admit(first);
      // Never started, so nothing was listening for the notification and nothing published: this
      // is a process that took the Message and died before it got it out.
      await answer(messenger, recipient.id, "queued by a process that went away");
      assert.equal((await queuedFor(recipient.id)).length, 1);
      assert.deepEqual(replies(relay), []);

      await second.start();
      // Waited for on the row rather than on the Relay, because the Relay records a publish
      // before it answers for it and the row goes when the answer arrives. Waiting on the Relay
      // would be waiting for the earlier of the two.
      await waitUntil(
        "the next process publishes it and forgets the row",
        async () => (await queuedFor(recipient.id)).length === 0,
      );
      assert.equal(soleReplyTo(relay, recipient), "queued by a process that went away");
      assert.deepEqual(await queuedFor(recipient.id), []);
    } finally {
      await first.stop();
      await second.stop();
      await relay.stop();
    }
  });

  it("survives a stop in the middle of the publish, and goes out on the next start", async () => {
    // The Relay takes the first frame and says nothing about it, which is what a Relay under load
    // does and the only way to hold the Channel inside its own publish long enough to shut it
    // down. The second offer of the same event is answered normally, so the restart can finish.
    let stalledOnce = false;
    const relay = await startFakeRelay({
      stall: () => {
        if (stalledOnce) return false;
        stalledOnce = true;
        return true;
      },
    });
    const { messenger, channel } = deploymentFor(relay);

    try {
      await channel.start();
      const recipient = await admit(channel);

      const said = await answer(messenger, recipient.id, "interrupted halfway out");
      await waitUntil("the Channel is waiting inside the publish", async () =>
        relay.received.some((message) => message.verb === "EVENT"),
      );

      // The Gateway shuts down while that publish is outstanding. This returning at all is half
      // the claim: a `stop` that waited for an answer nobody was going to give would hang a
      // shutdown rather than end one.
      await channel.stop();

      // A stop is not a refusal. The row is exactly as the transaction left it — no reason, no
      // failure time — so the next process attempts it rather than reading it as retired.
      const [row] = await queuedFor(recipient.id);
      assert.equal(row?.reason, null);
      assert.equal(row?.failedAt, null);
      assert.equal(row?.messageId, said.id);
      // And no partial transaction: the Message it belongs to is in the log.
      assert.equal((await messenger.history(recipient.id))[0]?.id, said.id);
      assert.deepEqual(replies(relay), []);

      await channel.start();
      await waitUntil(
        "the reply goes out after the restart and the row is forgotten",
        async () => (await queuedFor(recipient.id)).length === 0,
      );
      assert.equal(soleReplyTo(relay, recipient), "interrupted halfway out");
      assert.deepEqual(await queuedFor(recipient.id), []);
    } finally {
      await channel.stop();
      await relay.stop();
    }
  });
});
