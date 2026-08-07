/**
 * The Nostr Channel: the way a User reaches a Shared Agent from the Nostr client they already
 * use, and it them.
 *
 * One call builds it. It registers **no route on either server**: what a User reaches over this
 * medium is a Relay, not the Gateway
 * ([ADR-0048](../../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). It
 * holds the Shared Agent's Nostr identity, keeps one connection to one Relay the Operator runs,
 * and turns NIP-17 private direct messages from recorded public keys into inbound Messages in the
 * Messenger's log — with a Signal, in one transaction, exactly as an HTTP submission does
 * ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)).
 *
 * **It is the first Component that opens a long-lived connection of its own**, so unlike the
 * other Channel its `start` and `stop` do real work: nothing connects at construction, `start`
 * builds the client and subscribes, and `stop` closes it. A stop followed by a start builds a
 * fresh client, because the library's `close` is terminal.
 *
 * **It admits nobody.** A message from a public key no `pubkeys` row names is dropped and nothing
 * whatever is stored for it, because the deployment is permissioned and an agent whose public
 * identity is known will be messaged by strangers. `recordPublicKey` is the only way in, it is
 * trusted code's alone, and it proves nothing.
 */

import { NRelay1 } from "@nostrify/nostrify";
import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { Db, Handle } from "../db/index.ts";
import { defaultLogger, type Logger } from "../logging.ts";
import type { Channel, Messenger } from "../messenger/messenger.ts";
import type { Users } from "../users/users.ts";
import { authenticationKind, giftWrapKind, openEnvelope } from "./envelope.ts";
import { insertPublicKey, selectUserFor } from "./identities.ts";
import { nostrChannelTables, received } from "./schema.ts";

/**
 * Which Channel this is, fixed by its type.
 *
 * Not a construction option: two Channels on one Messenger are unconstructable anyway, so a name
 * a Developer could set would only be a name they could get wrong.
 */
const channelName = "nostr";

/** Everything `createNostrChannel` needs: the Db, two Components, an identity and a Relay. */
export type NostrChannelOptions = {
  /**
   * The Db this component queries through. It takes a handle to its own two tables.
   *
   * Also where the inbound transaction is opened: the Message, its Signal and this component's
   * own record that the envelope was processed are one act, and the Messenger's inbound write
   * takes a transaction rather than opening one so that they can be.
   */
  readonly db: Db;
  /**
   * The Messenger that owns the log. Build it before this.
   *
   * The constructor calls `register` on it, which is what makes this Channel the one that reaches
   * people and hands back the only way to write an inbound Message. A second Channel on the same
   * Messenger is refused there, which is why a deployment runs Nostr or HTTP and not both.
   */
  readonly messenger: Messenger;
  /**
   * The User Manager whose Users these public keys belong to.
   *
   * Named nominally, and required, because `pubkeys.user_id` is a foreign key onto
   * `saf_users.users.id`. This component needs our Manager at the schema level, and nothing is
   * called on it: there is no route here for it to authenticate, and a Nostr public key is not a
   * credential the Gateway issued.
   */
  readonly users: Users;
  /**
   * The Shared Agent's Nostr secret key: **32 raw bytes**, and the second keypair a deployment
   * running this holds (ADR-0050).
   *
   * Raw bytes because that is both Nostr libraries' own convention, and because the framework
   * parses no key material and generates none: an Operator reads their own key and states it
   * here, exactly as they hand `createSignatures` a `KeyObject` they built themselves (ADR-0041).
   * No `nsec` decoder is shipped — shipping one would be the framework parsing key material behind
   * a friendlier name — so an Operator holding an `nsec` calls `nip19.decode` themselves.
   *
   * It cannot be the signing identity and could not become one: that key is Ed25519 and this
   * curve is secp256k1. Copying this one impersonates the agent to its Users; copying that one
   * forges its commitments.
   */
  readonly secretKey: Uint8Array;
  /**
   * The Relay to connect to, as a `ws://` or `wss://` address.
   *
   * One Relay, and the Operator's own, so that Users' conversations do not traverse a stranger's
   * server. It is used exactly as given, with no normalisation: Relays treat trailing variants as
   * distinct addresses, and NIP-42's `relay` tag is compared by whatever rule the Relay chose.
   */
  readonly relayUrl: string;
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
};

/**
 * The Nostr Channel as a Component: a Channel, its own public key, and the one act of admission.
 *
 * `recordPublicKey` is the only method trusted code calls. Everything else this component does,
 * it does for the Relay it is connected to or for the Messenger that registered it.
 *
 * A deployment holds it to key it in the Gateway's record, ahead of the Signal Worker like the
 * Messenger itself: a Signal Handler's post phase runs `messenger.send` into this component's
 * `send`, so it has to outlive the drain.
 */
export type NostrChannel = Channel & {
  /**
   * The Shared Agent's own Nostr public key, in lowercase hex, derived from the secret key it was
   * built with.
   *
   * What a User's client shows as the agent's identity, and what an Operator tells a User to
   * message. It is an address as well as an identity, which is what makes it unrotatable in
   * practice: every recorded key is a row written from the other side, and every User's client
   * holds the old one (ADR-0050).
   *
   * Hex and not an `npub`, for the reason there is no `nsec` decoder either. An Operator who
   * wants the human-facing form calls `nip19.npubEncode` themselves.
   */
  readonly publicKey: string;

  /**
   * Records that one Nostr public key belongs to one User, and **proves nothing**.
   *
   * An Operator records a key from their own code, having established out of band that it is
   * theirs. That is the whole of admission over this medium, and it is deliberately the whole:
   * **no route on either server records a key**, because doing so is authorization-shaped — it
   * grants access to a Message log — so it joins `users.setAttributes` in the class an injected
   * prompt cannot reach (ADR-0049). The recorded cost is that the agent cannot admit a stranger,
   * and a message from a key nobody recorded is dropped with nothing stored.
   *
   * A write, so it takes the caller's transaction first: recording a key and whatever the
   * Operator writes about the admission commit together or not at all. It replaces nothing —
   * there is no rotation here, in the same sense that there is none for either identity.
   *
   * @param publicKey 64 lowercase hex characters. An `npub` is refused rather than stored,
   *   because a stored one would match no message and nothing would say why.
   *
   * @throws `MalformedPublicKeyError` if that is not what it got.
   * @throws `NoSuchUserError` if no User has that id.
   * @throws `PublicKeyConflictError` if that key belongs to another User, or that User already
   *   has one. The insert runs in a savepoint, so no refusal aborts the caller's transaction.
   */
  recordPublicKey<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    publicKey: string,
  ): Promise<void>;

  /**
   * Opens the connection to the Relay and subscribes to the agent's own gift wraps.
   *
   * Nothing connects before this. It does not wait for the connection: a Relay that is down is an
   * outage rather than a boot failure, and the client reconnects with a backoff of its own. A
   * second `start` finds a client already built and does nothing.
   */
  start(): Promise<void>;

  /**
   * Closes the connection and stops handling what arrives on it.
   *
   * It returns once nothing is in flight, so a Message half-written when shutdown began is either
   * committed or rolled back before the Db is closed under it. The client is discarded rather
   * than reused, because the library's `close` is terminal; a later `start` builds a fresh one.
   */
  stop(): Promise<void>;
};

/**
 * Builds the Nostr Channel and registers it with the Messenger.
 *
 * Nothing here connects, listens or applies DDL — the connection is `start`'s. Key the result
 * before the Signal Worker, so that it stops after the drain.
 *
 * @throws `ChannelAlreadyRegisteredError` if a Channel is already registered with that Messenger.
 *
 * @example
 * Built in `extend`, after the Messenger it registers with, and given an identity the Operator
 * read for themselves.
 * ```ts
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "shared-agent-framework";
 * import { createMessenger } from "shared-agent-framework/messenger";
 * import { createNostrChannel } from "shared-agent-framework/nostr-channel";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * // The framework parses no key material: 32 raw bytes, decoded by the deployment.
 * const secretKey = Uint8Array.from(
 *   Buffer.from(readFileSync(process.env.NOSTR_KEY_FILE ?? "", "utf8").trim(), "hex"),
 * );
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   agentListen: { host: "127.0.0.1", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, publicServer, worker }) => {
 *     const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
 *     const messenger = createMessenger({ db, users, worker, agentServer });
 *     return {
 *       users,
 *       messenger,
 *       nostr: createNostrChannel({
 *         db,
 *         messenger,
 *         users,
 *         secretKey,
 *         relayUrl: process.env.RELAY_URL ?? "",
 *       }),
 *     };
 *   },
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // Admission, out of band and from trusted code, in a transaction of the Operator's own.
 * const { db, nostr } = gateway.components;
 * await db.tx((tx) => nostr.recordPublicKey(tx, "a-user-id", "ab".repeat(32)));
 * ```
 */
export function createNostrChannel(options: NostrChannelOptions): NostrChannel {
  // The component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(nostrChannelTables);
  const log = options.logger ?? defaultLogger();
  const publicKey = getPublicKey(options.secretKey);

  /** The live client, or `undefined` while stopped. Its presence is what `start` guards on. */
  let relay: NRelay1 | undefined;
  /** How `stop` interrupts a read that is waiting on the Relay rather than on the Db. */
  let reading: AbortController | undefined;
  /** The subscription loop, so `stop` can wait for whatever it was in the middle of. */
  let subscribed: Promise<void> = Promise.resolve();

  /**
   * The one filter this component ever asks for: gift wraps addressed to the agent.
   *
   * **No `since`, deliberately** (ADR-0049). NIP-59 randomises a wrap's timestamp up to two days
   * into the past, so a timestamp watermark silently discards most of what is in flight. The
   * whole store is re-read on every connect and the primary key on `received` absorbs it.
   */
  const inbox = { kinds: [giftWrapKind], "#p": [publicKey] };

  /**
   * Answers a NIP-42 challenge with a signed kind 22242, wired to the same secret key.
   *
   * Without it a private Relay is not private, and requiring authentication for *writes* too is
   * what NIP-59's own spam-protection section recommends. The `relay` tag carries the address as
   * the Operator gave it, because every Relay differs on how it normalises one before comparing.
   */
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

  /**
   * One envelope, from the Relay to a Message in a User's log — or dropped.
   *
   * The order is the decision (ADR-0049). The envelope is opened and checked first, because a
   * forged or malformed one must cost nothing. The author is then resolved to a User **before any
   * transaction is opened**, so an unrecorded key leaves no row anywhere, not even a processed
   * one. Only then is the wrap's id claimed and the Message written, in one transaction: a
   * conflict on that claim means this envelope has already been read, and a rollback un-reads it.
   */
  async function admit(wrap: NostrEvent): Promise<void> {
    const opened = openEnvelope(wrap, options.secretKey, publicKey);
    if (!opened.ok) {
      log.debug({ event: wrap.id, reason: opened.reason }, "a Nostr envelope was dropped");
      return;
    }

    const userId = await selectUserFor(handle, opened.rumor.pubkey);
    if (userId === undefined) {
      // Nothing is stored, which is the point: an agent whose public identity is known will be
      // messaged by strangers, and recording the rejected ones would let anyone fill the
      // Operator's disk. The cost is that this envelope is re-dropped on every connect.
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

  /**
   * Reads everything the Relay still holds, paging backwards past whatever cap it applied.
   *
   * A Relay serves a bounded number of stored events for one `REQ` and says nothing about having
   * done so, so the end of stored events is not the end of the store. Each page asks for what is
   * older than the oldest of the last, which is `until` — inclusive in NIP-01, so a page repeats
   * its own boundary and the primary key on `received` absorbs the repeat, along with the tie
   * when several events share one second.
   *
   * The cost is recorded rather than solved: every connect re-reads the whole store this way,
   * which is affordable because the store is one permissioned deployment's direct messages, and
   * because the alternative — a `since` watermark — is not a valid cursor for gift wraps at all.
   */
  async function readStored(client: NRelay1, signal: AbortSignal): Promise<void> {
    let until: number | undefined;
    for (;;) {
      const filter = until === undefined ? inbox : { ...inbox, until };
      const page = await client.query([filter], { signal });
      if (page.length === 0) return;
      for (const wrap of page) await admit(wrap);
      const oldest = page.reduce((lowest, event) => Math.min(lowest, event.created_at), Infinity);
      // The window has to move or the next page is this one again: a whole page sharing one
      // timestamp is where that happens, and stopping is the honest answer to it.
      if (until !== undefined && oldest >= until) return;
      until = oldest;
    }
  }

  /**
   * The one subscription, and the one path an envelope reaches `admit` by.
   *
   * NIP-01 delivers what the Relay holds, then `EOSE`, then what arrives afterwards, all on this
   * iterator — so there is no catch-up mode and no second code path. Each `EOSE` is also the
   * signal that the Relay has served all it means to, which is when the paged read above runs:
   * once on the first connect, and again after every reconnect, because the client re-sends this
   * `REQ` unchanged.
   *
   * Everything is awaited in turn, so an envelope is never being admitted twice at once. The
   * client buffers what arrives meanwhile.
   */
  async function subscribe(client: NRelay1, signal: AbortSignal): Promise<void> {
    try {
      for await (const message of client.req([inbox], { signal })) {
        if (message[0] === "EVENT") await admit(message[2]);
        else if (message[0] === "EOSE") await readStored(client, signal);
      }
      // Reached only when the Relay closed the subscription, which authentication it will not
      // accept is the usual cause. Nothing retries it: a Relay refusing this agent is an
      // Operator's problem to see rather than one to hide behind a loop.
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

  const channel: NostrChannel = {
    name: channelName,
    publicKey,

    recordPublicKey: (tx, userId, offered) => insertPublicKey(tx, userId, offered),

    // Outbound is issue 04's, and this refusal is what stands in for it until then. It throws
    // rather than doing nothing, so the Messenger's row rolls back with it: a Message recorded as
    // sent that nothing will deliver is a durable claim that somebody was told something.
    send: async (_tx, message) => {
      throw new Error(
        `the Nostr Channel cannot yet carry a Message to User ${message.userId}: publishing to the Relay is not built, and nothing was recorded`,
      );
    },

    async start() {
      // A second `start` finds a client already built. Building another would leave two
      // subscriptions admitting the same envelopes, which the primary key would absorb in
      // silence — so the guard is here rather than left to the constraint.
      if (relay !== undefined) return;
      const controller = new AbortController();
      reading = controller;
      // Constructed here and not in the component's constructor, because this client connects
      // when it is built and closes an idle socket after thirty seconds by default. So this is
      // both the "nothing connects at construction" rule and what that library needs.
      const client = new NRelay1(options.relayUrl, { auth: authenticate });
      relay = client;
      // Not awaited: a Relay that is down is an outage and not a boot failure, and the client
      // reconnects on its own. `stop` is what waits for this.
      subscribed = subscribe(client, controller.signal);
    },

    async stop() {
      const client = relay;
      relay = undefined;
      reading?.abort();
      reading = undefined;
      if (client !== undefined) await closeRelay(client);
      // After the close, so that whatever was mid-transaction when the socket went finishes
      // before the Db is stopped under it.
      await subscribed;
      subscribed = Promise.resolve();
    },
  };

  // Registered as itself, and before anything else can happen, so that a second Channel on one
  // Messenger throws before this one has opened a connection. What comes back is the inbound
  // write, and it exists on no other object anywhere.
  const inbound = options.messenger.register(channel);

  return channel;
}

/**
 * Closes the client, and does not wait for a close that has already happened.
 *
 * `NRelay1.close` waits for the socket's close event **after** asking for the close. A socket that
 * has not finished connecting fires that event synchronously inside the request, before anything
 * is listening for it, and the underlying socket then stops at `CLOSING` rather than `CLOSED` — so
 * the wait never ends. That case is not exotic: a Gateway whose start fails stops every Component
 * it had started, which for this one is a `stop` a moment after a `start`, and a `stop` that never
 * returns would hang a shutdown.
 *
 * So the event is subscribed to first, here, and whichever finishes first is the answer. The
 * library's own wait may stay pending, which costs one listener on a socket that will never fire
 * again; it never rejects, so nothing is left unhandled. Remove this when the library stops
 * subscribing after the fact.
 */
async function closeRelay(client: NRelay1): Promise<void> {
  const alreadyClosed = new Promise<void>((resolve) => {
    client.socket.addEventListener("close", () => resolve(), { once: true });
  });
  await Promise.race([client.close(), alreadyClosed]);
}
