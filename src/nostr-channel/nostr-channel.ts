import { NRelay1 } from "@nostrify/nostrify";
import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { Db, Handle, Listening } from "../db/index.ts";
import { defaultLogger, type Logger } from "../logging/logging.ts";
import type { MessageRecord } from "../messenger/messages.ts";
import type { Channel, Messenger } from "../messenger/messenger.ts";
import type { Users } from "../users/users.ts";
import {
  authenticationKind,
  directMessageRelaysKind,
  giftWrapKind,
  openEnvelope,
  sealEnvelope,
} from "./envelope.ts";
import { insertPublicKey, selectPublicKeyFor, selectUserFor } from "./identities.ts";
import {
  deletePublished,
  describeRefusal,
  MessageTooLargeError,
  outboxChannel,
  queueWrap,
  recordRefusal,
  selectUnpublished,
  UnrecordedPublicKeyError,
  wireSize,
  wrapOf,
} from "./outbound.ts";
import { nostrChannelTables, received } from "./schema/index.ts";

const channelName = "nostr";

const relayInfoTimeoutMs = 5_000;

export type NostrChannelOptions = {
  readonly db: Db;
  readonly messenger: Messenger;
  readonly users: Users;
  readonly secretKey: Uint8Array;
  readonly relayUrl: string;
  readonly logger?: Logger;
};

export type NostrChannel = Channel & {
  readonly publicKey: string;

  /**
   * Records one lowercase, 64-character hex key for an existing user's messaging.
   * Each user and each key may appear once; duplicates throw. Does not grant HTTP authentication.
   */
  recordPublicKey<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    publicKey: string,
  ): Promise<void>;

  send<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    message: MessageRecord,
  ): Promise<void>;

  /** Waits for one outbound drain attempt. Relay acceptance does not confirm delivery to the recipient. */
  drain(): Promise<void>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

/**
 * Registers with the messenger during construction. Inbound messages from unrecorded keys
 * are ignored. `start()` subscribes and publishes the relay list without waiting for the relay.
 * Outbound envelopes are persisted until accepted or explicitly refused by the relay.
 */
export function createNostrChannel(options: NostrChannelOptions): NostrChannel {
  const handle = options.db.handle(nostrChannelTables);
  const log = options.logger ?? defaultLogger();
  const publicKey = getPublicKey(options.secretKey);

  let relay: NRelay1 | undefined;
  let reading: AbortController | undefined;
  let subscribed: Promise<void> = Promise.resolve();
  let announced: Promise<void> = Promise.resolve();
  let listening: Listening | undefined;
  let draining: Promise<void> = Promise.resolve();
  let advertisedLimit: Promise<number | undefined> = Promise.resolve(undefined);

  const inbox = { kinds: [giftWrapKind], "#p": [publicKey] };

  async function authenticate(challenge: string): Promise<NostrEvent> {
    return finalizeEvent(
      {
        kind: authenticationKind,
        content: "",
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", options.relayUrl],
          ["challenge", challenge],
        ],
      },
      options.secretKey,
    );
  }

  async function announce(client: NRelay1, signal: AbortSignal): Promise<void> {
    const list = finalizeEvent(
      {
        kind: directMessageRelaysKind,
        content: "",
        created_at: Math.floor(Date.now() / 1000),
        tags: [["relay", options.relayUrl]],
      },
      options.secretKey,
    );
    try {
      await client.event(list, { signal });
    } catch (error) {
      if (signal.aborted) return;
      log.warn(
        { err: error, relay: options.relayUrl },
        "the Relay would not take the agent's Nostr relay list, so a client that requires one may refuse to message this agent",
      );
    }
  }

  async function admit(wrap: NostrEvent): Promise<void> {
    const opened = openEnvelope(wrap, options.secretKey, publicKey);
    if (!opened.ok) {
      log.debug({ event: wrap.id, reason: opened.reason }, "a Nostr envelope was dropped");
      return;
    }

    const userId = await selectUserFor(handle, opened.rumor.pubkey);
    if (userId === undefined) {
      log.debug(
        { event: wrap.id, author: opened.rumor.pubkey },
        "a Nostr message came from a public key no User holds, and was dropped",
      );
      return;
    }

    const stored = await options.db.tx(async (tx) => {
      const [claimed] = await tx
        .insert(received)
        .values({ eventId: wrap.id })
        .onConflictDoNothing()
        .returning({ eventId: received.eventId });
      if (claimed === undefined) return false;
      await inbound.receive(tx, userId, opened.rumor.content);
      return true;
    });
    if (stored) log.info({ event: wrap.id, userId }, "a Nostr message became a Message");
  }

  async function readStored(client: NRelay1, signal: AbortSignal): Promise<void> {
    let until: number | undefined;
    for (;;) {
      const filter = until === undefined ? inbox : { ...inbox, until };
      const page = await client.query([filter], { signal });
      if (page.length === 0) return;
      for (const wrap of page) await admit(wrap);
      const oldest = page.reduce((lowest, event) => Math.min(lowest, event.created_at), Infinity);
      if (until !== undefined && oldest >= until) return;
      until = oldest;
    }
  }

  async function subscribe(client: NRelay1, signal: AbortSignal): Promise<void> {
    try {
      for await (const message of client.req([inbox], { signal })) {
        if (message[0] === "EVENT") await admit(message[2]);
        else if (message[0] === "EOSE") await readStored(client, signal);
      }
      if (!signal.aborted) {
        log.warn({ relay: options.relayUrl }, "the Relay ended the Nostr Channel's subscription");
      }
    } catch (error) {
      if (signal.aborted) return;
      log.error(
        { err: error, relay: options.relayUrl },
        "the Nostr Channel's subscription failed and is not being retried",
      );
    }
  }

  async function limitOf(client: NRelay1): Promise<number | undefined> {
    const information = await client.getRelayInfo({
      signal: AbortSignal.timeout(relayInfoTimeoutMs),
    });
    return information?.limitation?.max_message_length;
  }

  async function publish(
    row: Awaited<ReturnType<typeof selectUnpublished>>[number],
    client: NRelay1,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await client.event(wrapOf(row), { signal });
    } catch (error) {
      if (signal.aborted) return;
      const reason = describeRefusal(error);
      await recordRefusal(handle, row.eventId, reason);
      log.error(
        { event: row.eventId, userId: row.userId, message: row.messageId, reason },
        "the Relay would not take a Nostr reply, and it is not being attempted again",
      );
      return;
    }
    await deletePublished(handle, row.eventId);
    log.info({ event: row.eventId, userId: row.userId }, "a Message reached the Relay");
  }

  async function drainOnce(): Promise<void> {
    const client = relay;
    const controller = reading;
    if (client === undefined || controller === undefined) return;
    for (const row of await selectUnpublished(handle)) {
      if (controller.signal.aborted) return;
      await publish(row, client, controller.signal);
    }
  }

  function drain(): Promise<void> {
    const mine = draining.then(
      () => drainOnce(),
      () => drainOnce(),
    );
    draining = mine.catch(() => {});
    return mine;
  }

  function wakeDrain(why: string): void {
    void drain().catch((error) => {
      log.error(
        { err: error, why },
        "the Nostr Channel's outbound drain stopped short, and retries when next woken",
      );
    });
  }

  const channel: NostrChannel = {
    name: channelName,
    publicKey,

    recordPublicKey: (tx, userId, offered) => insertPublicKey(tx, userId, offered),

    send: async (tx, message) => {
      const recipient = await selectPublicKeyFor(tx, message.userId);
      if (recipient === undefined) throw new UnrecordedPublicKeyError(message.userId);

      const wrap = sealEnvelope(message.text, options.secretKey, recipient);
      const bytes = wireSize(wrap);
      const limit = await advertisedLimit;
      if (limit !== undefined && bytes > limit) {
        throw new MessageTooLargeError(message.userId, bytes, limit);
      }

      await queueWrap(tx, { userId: message.userId, messageId: message.id, wrap });
    },

    drain,

    async start() {
      if (relay !== undefined) return;
      const controller = new AbortController();
      reading = controller;
      const client = new NRelay1(options.relayUrl, { auth: authenticate });
      relay = client;
      advertisedLimit = limitOf(client);
      subscribed = subscribe(client, controller.signal);
      announced = announce(client, controller.signal);
      listening = options.db.listen(outboxChannel, {
        notified: () => wakeDrain("notification"),
        connected: () => wakeDrain("listening"),
        lost: (error) =>
          log.warn(
            { err: error, channel: outboxChannel },
            "the Nostr Channel's outbound notifications dropped; reconnecting, and a queued reply waits until they are back",
          ),
      });
    },

    async stop() {
      const client = relay;
      relay = undefined;
      reading?.abort();
      reading = undefined;
      if (listening !== undefined) {
        await listening.close();
        listening = undefined;
      }
      if (client !== undefined) await closeRelay(client);
      await subscribed;
      subscribed = Promise.resolve();
      await announced;
      announced = Promise.resolve();
      await draining;
      draining = Promise.resolve();
      advertisedLimit = Promise.resolve(undefined);
    },
  };

  const inbound = options.messenger.register(channel);

  return channel;
}

async function closeRelay(client: NRelay1): Promise<void> {
  const alreadyClosed = new Promise<void>((resolve) => {
    client.socket.addEventListener("close", () => resolve(), { once: true });
  });
  await Promise.race([client.close(), alreadyClosed]);
}
