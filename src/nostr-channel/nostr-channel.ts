/**
 * Four shapes here are load-bearing, and each has a way of looking like an accident.
 *
 * **Outbound is two halves and they must stay two**
 * ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)). `send` runs
 * inside the caller's transaction and settles everything knowable there; `drain` is the network act
 * and runs after that transaction commits. Moving the publish up into `send` either holds a
 * transaction open across a round trip to the Relay or leaves a recipient holding words a rollback
 * erased. Moving the seal down into `drain` turns the size bound into a queue row that fails once
 * and stops, and puts the agent's secret key into the pump.
 *
 * **`admit` runs its steps in that order for a reason.** The envelope is opened and checked first,
 * because a forged or malformed one must cost nothing. The author is resolved to a User before any
 * transaction is opened, so an unrecorded key leaves no row anywhere, not even a processed one.
 * Only then is the wrap's id claimed and the Message written, in one transaction.
 *
 * **The subscription asks for no `since`** (ADR-0049). NIP-59 randomises a wrap's timestamp up to
 * two days into the past, so a watermark silently discards most of what is in flight. The whole
 * store is re-read on every connect and `received`'s primary key absorbs the repeats.
 *
 * **`NRelay1` shapes the lifecycle twice.** It connects when it is constructed, which is why it is
 * built in `start` and not in this constructor, and its `close` is terminal, which is why a stop
 * followed by a start builds a fresh one. It was taken over `nostr-tools`' own `Relay` because that
 * one injects `since` on reconnect even when none was supplied, which would defeat the paragraph
 * above on the first reconnection.
 */

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

// Which Channel this is, fixed by its type and not an option: two Channels on one Messenger are
// unconstructable anyway, so a name a Developer could set would only be a name they could get wrong.
const channelName = "nostr";

// How long the Relay is given to serve its NIP-11 document before the answer is "no limit". Asked
// once per connection but awaited inside a caller's transaction, so the bound matters: an
// unanswered HTTP request would otherwise hold that transaction open for as long as the operating
// system was willing to wait.
const relayInfoTimeoutMs = 5_000;

export type NostrChannelOptions = {
  /**
   * The Db this component queries through, and where the inbound transaction is opened.
   *
   * Writing the Message, emitting its Signal and recording that this envelope was read are one act,
   * so they share one transaction of this component's own.
   */
  readonly db: Db;
  /**
   * The Messenger that owns the log. Construct it before this.
   *
   * The constructor registers with it, which is what makes this the Channel that reaches people and
   * hands back the only way to write an inbound Message. A second Channel on the same Messenger is
   * refused there, so a deployment runs one medium.
   */
  readonly messenger: Messenger;
  /**
   * The Users component whose Users these public keys belong to.
   *
   * Nothing is called on it. It is named because `pubkeys.user_id` is a foreign key onto that
   * table of Users, so this component needs the real one rather than something shaped like it:
   * there is no route here to authenticate, and a Nostr public key is not a credential the Gateway
   * issued.
   */
  readonly users: Users;
  /**
   * The Shared Agent's Nostr secret key: 32 raw bytes, and the second keypair a deployment running
   * this holds.
   *
   * Raw bytes because that is both Nostr libraries' own convention, and because the framework parses
   * no key material and generates none. An Operator reads their own key and states it here, exactly
   * as they hand a `KeyObject` they built themselves to the signing identity. No `nsec` decoder is
   * shipped, so an Operator holding one calls `nip19.decode` themselves.
   *
   * It cannot be the signing identity and could not become one, that key being Ed25519 and this
   * curve secp256k1. Copying this one impersonates the agent to its Users; copying that one forges
   * its commitments.
   */
  readonly secretKey: Uint8Array;
  /**
   * The Relay to connect to, as a `ws://` or `wss://` address.
   *
   * One Relay, and the Operator's own, so that Users' conversations do not traverse a stranger's
   * server. It is used exactly as given, with no normalisation: Relays treat trailing variants as
   * distinct addresses, and the address this agent authenticates with and the address it publishes
   * in its relay list are compared by whatever rule the Relay chose.
   */
  readonly relayUrl: string;
  /**
   * Defaults to a `pino` instance on stdout.
   *
   * A dropped envelope is a debug line and the only trace of it anywhere, nothing being stored for
   * one. A reply the Relay refused is an error line beside the queue row that keeps the reason, and
   * a relay list the Relay refused is a warning and nothing else.
   */
  readonly logger?: Logger;
};

/**
 * The Nostr Channel as a Component: an identity, one Relay connection, and the one act of admission.
 *
 * Three tables are what it keeps, and no Message is among them: which public key belongs to which
 * User, which envelopes it has already turned into Messages, and which replies the Relay has not
 * taken yet. The Messages themselves are the Messenger's, whichever medium they travelled by.
 *
 * It admits nobody by itself. A message from a public key nobody recorded through
 * {@link NostrChannel.recordPublicKey} is dropped with nothing stored for it, so a stranger who
 * learns the agent's public key can neither reach the log nor grow the tables.
 *
 * The Relay connection is real work at both ends: nothing connects at construction, `start` opens
 * it and `stop` closes it. What survives a stop is what PostgreSQL holds. A reply that was queued
 * and not published keeps its row and goes out at the next start, and a Message already written
 * stays written.
 */
export type NostrChannel = Channel & {
  /**
   * The Shared Agent's own Nostr public key, in lowercase hex, derived from the secret key it was
   * built with.
   *
   * What a User's client shows as the agent, and what an Operator tells a User to message. It is an
   * address as well as an identity, which is what makes it unrotatable in practice: every recorded
   * key was written from the other side, and every User's client holds this one.
   *
   * Hex and not an `npub`, for the reason the constructor takes bytes. An Operator who wants the
   * human-facing form calls `nip19.npubEncode` on it themselves.
   */
  readonly publicKey: string;

  /**
   * Records that one Nostr public key belongs to one User, and proves nothing.
   *
   * The Operator establishes out of band that the key is that person's, and this stores what they
   * decided. It is the whole of admission over this medium, and deliberately the whole: no route on
   * either server records a key, because recording one grants access to a Message log, so it sits
   * with the other writes an injected prompt cannot reach. The cost is that the agent cannot admit a
   * stranger.
   *
   * A write, so it takes the caller's transaction first: the key and whatever the Operator records
   * about the admission commit together or not at all. `publicKey` is 64 lowercase hex characters,
   * which is what a Nostr public key is on the wire.
   *
   * It replaces nothing. There is no rotation here, in the same sense that there is none for either
   * identity.
   *
   * @throws `MalformedPublicKeyError` if that is not what `publicKey` is.
   * @throws `NoSuchUserError` if no User has that id.
   * @throws `PublicKeyConflictError` if that key belongs to another User, or that User already has
   *   one. Every refusal here runs in a savepoint, so none of them aborts the caller's transaction.
   */
  recordPublicKey<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    publicKey: string,
  ): Promise<void>;

  /**
   * Takes an outbound Message inside the transaction writing it, and publishes nothing.
   *
   * The Messenger calls this, and trusted code reaches its `send` instead and gets this for free.
   * What happens here is everything knowable before a commit: the recipient's key is read on the
   * caller's own transaction, the reply is sealed into one gift wrap, its size on the wire is
   * compared against what the Relay advertises, and the finished wrap is queued. A failure at any of
   * those steps throws and rolls the Message back with it, so a Message recorded as sent was always
   * one that could go out.
   *
   * It never touches the Relay. The publish waits for the commit and happens in
   * {@link NostrChannel.drain}, so a rollback after this returns leaves nobody holding words the
   * log denies.
   *
   * @throws `UnrecordedPublicKeyError` if no Nostr public key is recorded for that User.
   * @throws `MessageTooLargeError` if the wrap exceeds the Relay's advertised maximum message
   *   length. The Relay is asked for that maximum once per connection, so a Channel that has not
   *   started has not asked and bounds nothing: an over-long reply sent to a stopped Channel is
   *   queued, and fails once at the next start rather than here.
   */
  send<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    message: MessageRecord,
  ): Promise<void>;

  /**
   * Publishes every queued reply the Relay has not answered for yet, and resolves when none is left.
   *
   * The half of a send that happens after the commit, exposed so that a caller can wait for it
   * rather than for a database notification. A running deployment needs no call: `start` wires the
   * notification a queued reply raises to this same method.
   *
   * A reply the Relay accepts leaves no trace. A reply it refuses keeps its row, carrying the
   * Relay's own reason, and is never attempted again, not by a later notification and not by a later
   * process. A refusal is a row and a log line rather than a throw.
   *
   * A reply the Relay took but never answered for, because the process stopped between the two,
   * still has its row and goes out again at the next start. Both the Relay and the recipient's
   * client key on the event's own id, so what a User sees is still one message.
   *
   * It publishes nothing while the Channel is stopped, and whatever is queued then waits for the
   * next `start`.
   */
  drain(): Promise<void>;

  /**
   * Opens the connection to the Relay, subscribes to the agent's own gift wraps, publishes the
   * agent's relay list, and publishes whatever a previous process left queued.
   *
   * Nothing connects before this, and this waits for none of it: a Relay that is down is an outage
   * rather than a boot failure, and the client reconnects with a backoff of its own. A second
   * `start` finds a client already built and does nothing.
   *
   * The relay list is one event naming the Relay this Channel was built with, and it is the only
   * thing the agent publishes about itself. It buys two narrow things and not discoverability: a
   * client that refuses to message a public key with no such list will message this one, and a
   * client that reads one is steered to the right Relay. Only a client already on that Relay can
   * read it. A Relay that refuses it is a warning on the log and a Channel that started anyway, and
   * a restart says it again at no cost, the kind being replaceable.
   */
  start(): Promise<void>;

  /**
   * Closes the connection, and stops both admitting what arrives on it and publishing what is
   * queued for it.
   *
   * It returns once nothing is in flight, so a Message half-written when shutdown began is either
   * committed or rolled back before the Db is closed under it. A publish interrupted here leaves its
   * row untouched rather than marking it refused, so the next `start` attempts it.
   */
  stop(): Promise<void>;
};

/**
 * Builds the Nostr Channel and registers it with the Messenger.
 *
 * Nothing here connects, listens or applies DDL.
 *
 * @throws `ChannelAlreadyRegisteredError` if a Channel is already registered with that Messenger.
 */
export function createNostrChannel(options: NostrChannelOptions): NostrChannel {
  // The component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(nostrChannelTables);
  const log = options.logger ?? defaultLogger();
  const publicKey = getPublicKey(options.secretKey);

  // The live client, or `undefined` while stopped. Its presence is what `start` guards on.
  let relay: NRelay1 | undefined;
  // How `stop` interrupts a read or a publish that is waiting on the Relay rather than the Db.
  let reading: AbortController | undefined;
  // The subscription loop, so `stop` can wait for whatever it was in the middle of.
  let subscribed: Promise<void> = Promise.resolve();
  // The one announcement this start makes, held for the same reason the subscription is.
  let announced: Promise<void> = Promise.resolve();
  // The `LISTEN` registration that turns a queued reply into a drain, held so `stop` closes it.
  let listening: Listening | undefined;
  // The drains that have been asked for, chained end to end. A queue and not a lock: two drains
  // overlapping would each read the same unpublished rows and publish them twice, and a second
  // caller merely awaiting the first would miss a row queued after that pass had already read. So
  // each `drain` waits for the one before it and then makes its own pass, which is what lets a
  // caller treat its own return as "everything I queued is dealt with".
  let draining: Promise<void> = Promise.resolve();
  // What the Relay says it accepts, asked once per connection and awaited by every `send`. A promise
  // rather than a number, because the NIP-11 document is an HTTP round trip the client makes lazily
  // and a send must not race it. It never rejects: the client answers `undefined` for a Relay that
  // serves no document, which is a Relay this imposes no size bound for. Reset by every `start`,
  // since a Relay that was restarted may answer differently.
  let advertisedLimit: Promise<number | undefined> = Promise.resolve(undefined);

  // The one filter this component ever asks for: gift wraps addressed to the agent. No `since`, for
  // the reason in the file header.
  const inbox = { kinds: [giftWrapKind], "#p": [publicKey] };

  // Answers a NIP-42 challenge with a signed kind 22242, wired to the same secret key. Without it a
  // private Relay is not private, and requiring authentication for writes too is what NIP-59's own
  // spam-protection section recommends. The `relay` tag carries the address as the Operator gave it,
  // because every Relay differs on how it normalises one before comparing.
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
   * Says where this agent receives private direct messages, and says nothing else about it.
   *
   * One kind 10050 per start, carrying one `["relay", url]` tag. The spec's tag name and not the
   * `["r", url]` much of the ecosystem emits: research found the two nearly evenly split in the
   * wild, and the clients this reaches at all are the ones that read the specification.
   *
   * A refusal is a warning and never a throw. It reaches `start` through a promise nobody awaits, so
   * a Relay that will not take it delays no boot and fails none.
   */
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
      // A `stop` mid-publish is not a refusal, and the next start announces again regardless.
      if (signal.aborted) return;
      log.warn(
        { err: error, relay: options.relayUrl },
        "the Relay would not take the agent's Nostr relay list, so a client that requires one may refuse to message this agent",
      );
    }
  }

  // One envelope, from the Relay to a Message in a User's log, or dropped. For why the three steps
  // run in this order, see the file header.
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
   * older than the oldest of the last, which is `until`, inclusive in NIP-01, so a page repeats its
   * own boundary and the primary key on `received` absorbs the repeat along with the tie when
   * several events share one second.
   *
   * The cost is recorded rather than solved: every connect re-reads the whole store this way, which
   * is affordable because the store is one permissioned deployment's direct messages, and because
   * the alternative is not a valid cursor for gift wraps at all.
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
   * iterator, so there is no catch-up mode and no second code path. Each `EOSE` is also the signal
   * that the Relay has served all it means to, which is when the paged read above runs: once on the
   * first connect, and again after every reconnect, because the client re-sends this `REQ`
   * unchanged.
   *
   * Everything is awaited in turn, so an envelope is never being admitted twice at once. The client
   * buffers what arrives meanwhile.
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

  // The Relay's own advertised maximum message length, or `undefined` if it advertises none. The
  // client fetches the NIP-11 document lazily and caches it, so this is one HTTP request per
  // connection. It never rejects: every failure, no document, a malformed one, or a Relay that is
  // not answering, is `undefined`, which is honestly "this Relay states no bound" rather than a
  // reason to refuse a send.
  async function limitOf(client: NRelay1): Promise<number | undefined> {
    const information = await client.getRelayInfo({
      signal: AbortSignal.timeout(relayInfoTimeoutMs),
    });
    return information?.limitation?.max_message_length;
  }

  /**
   * One queued wrap, published once: forgotten if the Relay took it, retired with a reason if not.
   *
   * There is no retry and no attempt cap, which is
   * [ADR-0017](../../docs/adr/0017-failed-runs-are-not-retried.md) applied to publishing: a row
   * nobody cleared is a Message an Operator can see was not delivered, and a loop hiding it would
   * make that invisible. The one thing that is not a refusal is a `stop`, which aborts the wait and
   * leaves the row exactly as it was, so the next start attempts it and nothing here is half done.
   */
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

  // One pass over everything nothing has attempted, oldest first, one wrap at a time.
  async function drainOnce(): Promise<void> {
    const client = relay;
    const controller = reading;
    // Stopped, so there is nowhere to publish to. Every row stays claimable for the next start,
    // which is the same state a previous process leaves behind.
    if (client === undefined || controller === undefined) return;
    for (const row of await selectUnpublished(handle)) {
      if (controller.signal.aborted) return;
      await publish(row, client, controller.signal);
    }
  }

  // The public drain: this caller's own pass, behind every pass already asked for.
  function drain(): Promise<void> {
    const mine = draining.then(
      () => drainOnce(),
      () => drainOnce(),
    );
    // Held without its rejection, so a pass that failed on the Db does not reject the next
    // caller's, and so `stop` can await the tail of the chain without catching anything.
    draining = mine.catch(() => {});
    return mine;
  }

  // A drain nobody is awaiting: the notification path, and the one at start. A Db failure here is
  // logged and swallowed rather than allowed to take the process down. The rows are still there, and
  // the next notification retries the pass, which is not a retry of a publish, since a wrap that
  // reached the Relay has no row left to select.
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

    // The first half of a send, and every line of it is something that can be known without
    // touching the Relay. Each refusal throws inside the caller's transaction, which takes the
    // Messenger's row with it: a Message recorded as sent that nothing will deliver is a durable
    // claim that somebody was told something.
    send: async (tx, message) => {
      // On the caller's transaction and not this component's handle, so that an Operator who
      // admits a User and answers them in one transaction is not refused by a read that cannot
      // see their own uncommitted write.
      const recipient = await selectPublicKeyFor(tx, message.userId);
      if (recipient === undefined) throw new UnrecordedPublicKeyError(message.userId);

      // Sealed here rather than in the drain, which is what turns the Relay's advertised maximum
      // into a synchronous refusal instead of a queue row that fails once and stops, and what
      // keeps the agent's secret key out of the half that runs after the commit.
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
      // A second `start` finds a client already built. Building another would leave two
      // subscriptions admitting the same envelopes, which the primary key would absorb in
      // silence, so the guard is here rather than left to the constraint.
      if (relay !== undefined) return;
      const controller = new AbortController();
      reading = controller;
      // Constructed here and not in the component's constructor, because this client connects
      // when it is built and closes an idle socket after thirty seconds by default. So this is
      // both the "nothing connects at construction" rule and what that library needs.
      const client = new NRelay1(options.relayUrl, { auth: authenticate });
      relay = client;
      // Asked for now and awaited by the first `send` that needs it, so that the size bound costs
      // a transaction nothing once the answer is in hand. Not awaited here: a Relay that is down
      // is an outage and not a boot failure.
      advertisedLimit = limitOf(client);
      // Not awaited, for the same reason. `stop` is what waits for this.
      subscribed = subscribe(client, controller.signal);
      // Nor this. It is published on every start rather than once ever, because the Relay is a
      // transport and not a store: one that was rebuilt between two starts holds nothing this
      // agent said, and a kind in the replaceable range makes saying it again free.
      announced = announce(client, controller.signal);
      // The outbound wakeup. A queued wrap's `NOTIFY` shares the transaction that wrote its row,
      // so the drain is woken exactly when there is something to publish and never for a Message
      // a rollback erased. `connected` covers the first registration and every reconnection
      // alike: anything notified before a registration was in place was never delivered, and that
      // includes every wrap a previous process left behind, which is what attempts them at start.
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
      // Closed before either wait, so that nothing new is woken while what is in flight finishes.
      if (listening !== undefined) {
        await listening.close();
        listening = undefined;
      }
      if (client !== undefined) await closeRelay(client);
      // After the close, so that whatever was mid-transaction when the socket went finishes
      // before the Db is stopped under it. The drain is waited for too: its own abort makes an
      // in-flight publish return without writing, and this is what makes that "returned".
      await subscribed;
      subscribed = Promise.resolve();
      await announced;
      announced = Promise.resolve();
      await draining;
      draining = Promise.resolve();
      advertisedLimit = Promise.resolve(undefined);
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
 * `NRelay1.close` waits for the socket's close event after asking for the close. A socket that has
 * not finished connecting fires that event synchronously inside the request, before anything is
 * listening for it, and the underlying socket then stops at `CLOSING` rather than `CLOSED`, so the
 * wait never ends. That case is not exotic: a Gateway whose start fails stops every Component it had
 * started, which for this one is a `stop` a moment after a `start`, and a `stop` that never returns
 * would hang a shutdown.
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
