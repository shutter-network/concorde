/**
 * A Relay a test can drive: a real WebSocket server on localhost, speaking enough of
 * NIP-01 that the real Nostr client library talks to it as if it were the one the
 * Operator runs.
 *
 * It plugs into the Relay address a Channel is constructed with, so it adds **no seam**
 * to the framework: nothing is injected, nothing is stubbed, and the client's own
 * reconnect, its NIP-42 flow and its post-authentication retry are all exercised for
 * real. That is the reason this is a socket rather than a fake relay object
 * ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)):
 * a localhost socket costs milliseconds, and a stub would have tested our own stub.
 *
 * **Its fidelity is load-bearing.** Nothing in this repository ever speaks to a real
 * Relay, so a divergence between this and every real implementation is invisible here
 * and surfaces in a deployment. A bug traced to one should be fixed by making this
 * wrong in the same way a real Relay is, not by working around it in the Channel.
 *
 * What it does **not** do, because nothing needs it yet: no NIP-11 document over HTTP,
 * so a client asking for the Relay's own limits gets nothing; no replaceable-event
 * semantics, so a second kind 10050 is a second stored event rather than a replacement;
 * no `COUNT`, and no NIP-50 search.
 *
 * `src/test-support` is excluded from the build, so none of this ships.
 */

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type Filter, matchFilters, type Event as NostrEvent, verifyEvent } from "nostr-tools";
import { type RawData, WebSocket, WebSocketServer } from "ws";

/** When the Relay issues its NIP-42 challenge, and whether it requires one at all. */
export type FakeRelayAuth =
  /** Open: every subscription and every publish is served unauthenticated. */
  | "none"
  /** The challenge arrives unprompted, as soon as the socket opens. */
  | "on-connect"
  /**
   * The challenge arrives only when a client first asks for something restricted,
   * immediately ahead of the refusal.
   *
   * Both are real Relay behaviours, and this is the one that deadlocks a client which
   * waits for a challenge before subscribing — which is why the timing is a knob and
   * not a constant.
   */
  | "on-demand";

export type FakeRelayOptions = {
  /** Defaults to `"none"`. */
  readonly auth?: FakeRelayAuth;
  /**
   * The most stored events one subscription is served, however many match.
   *
   * A real Relay caps a query and says nothing about having done so, which is what
   * makes a client's pagination past the cap worth exercising. Live events are not
   * capped, because nothing about a cap on stored results applies to them.
   */
  readonly maxLimit?: number;
  /**
   * Decides what a publish is answered with: the machine-readable reason to refuse it
   * with, or `undefined` to accept it. Called for every `EVENT` that got past
   * authentication and signature verification.
   */
  readonly refuse?: (event: NostrEvent) => string | undefined;
};

/** One message a client sent, as the Relay saw it. */
export type FakeRelayMessage = {
  /** Which connection it arrived on, counted from 1 in the order they opened. */
  readonly connection: number;
  /** NIP-01's verb: `REQ`, `CLOSE`, `EVENT`, `AUTH`, or whatever else was sent. */
  readonly verb: string;
  /** The subscription id, on a `REQ` or a `CLOSE`. */
  readonly subscription?: string;
  /** The filters, on a `REQ`, exactly as they arrived. */
  readonly filters?: readonly Filter[];
  /** The event, on an `EVENT` or an `AUTH`. */
  readonly event?: NostrEvent;
};

export type FakeRelay = {
  /** The address to construct a client with. Stable across a stop and a start. */
  readonly url: string;
  /** Every message a client sent, in arrival order. */
  readonly received: readonly FakeRelayMessage[];
  /** Every event the Relay accepted, in the order it accepted them. */
  readonly published: readonly NostrEvent[];
  /**
   * The Relay now holds these events: they are served to a subscription that arrives
   * later, and streamed at once to every open subscription they match.
   *
   * One method rather than two, because that is one behaviour: a Relay does not
   * distinguish what it held before a client connected from what reached it after.
   * An event it already holds is ignored, so holding one twice is not delivering it
   * twice.
   */
  hold(...events: readonly NostrEvent[]): void;
  /**
   * Binds the same port again, so a client reconnects to the address it was
   * constructed with. What the Relay holds survives, as a restarted Relay's store does.
   */
  start(): Promise<void>;
  /**
   * Drops every connection and releases the port, which is what a client sees when the
   * Operator's Relay goes away. Also the whole of the teardown: it leaves no handle, so
   * a test that calls it lets the suite exit on its own.
   */
  stop(): Promise<void>;
};

/** Per-socket state: a Relay's challenge and authentication are per connection. */
type Connection = {
  readonly index: number;
  readonly socket: WebSocket;
  readonly challenge: string;
  challenged: boolean;
  authenticated: boolean;
  readonly subscriptions: Map<string, readonly Filter[]>;
};

/** NIP-42's kind, which is the whole of what this reads out of that specification. */
const authenticationKind = 22242;

export async function startFakeRelay(options: FakeRelayOptions = {}): Promise<FakeRelay> {
  const received: FakeRelayMessage[] = [];
  const published: NostrEvent[] = [];
  const stored: NostrEvent[] = [];
  const connections = new Set<Connection>();

  let server: WebSocketServer | undefined;
  let opened = 0;
  // Zero until the first listen, and the assigned port from then on, which is what
  // makes `url` outlive a stop.
  let port = 0;

  function send(connection: Connection, message: readonly unknown[]): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    connection.socket.send(JSON.stringify(message));
  }

  function needsAuthentication(connection: Connection): boolean {
    return (options.auth ?? "none") !== "none" && !connection.authenticated;
  }

  function challenge(connection: Connection): void {
    if (connection.challenged) return;
    connection.challenged = true;
    send(connection, ["AUTH", connection.challenge]);
  }

  /** Newest first, which is the order NIP-01 asks a Relay to apply a `limit` in. */
  function newestFirst(one: NostrEvent, other: NostrEvent): number {
    return other.created_at - one.created_at;
  }

  /** What one `REQ` is served from the store: each filter capped on its own, then merged. */
  function storedFor(filters: readonly Filter[]): NostrEvent[] {
    const chosen = new Map<string, NostrEvent>();
    for (const filter of filters) {
      const cap = Math.min(
        filter.limit ?? Number.POSITIVE_INFINITY,
        options.maxLimit ?? Number.POSITIVE_INFINITY,
      );
      const matching = stored.filter((event) => matchFilters([filter], event)).sort(newestFirst);
      for (const event of matching.slice(0, cap)) chosen.set(event.id, event);
    }
    return [...chosen.values()].sort(newestFirst);
  }

  function hold(...events: readonly NostrEvent[]): void {
    for (const event of events) {
      if (stored.some((held) => held.id === event.id)) continue;
      stored.push(event);
      for (const connection of connections) {
        for (const [subscription, filters] of connection.subscriptions) {
          if (matchFilters([...filters], event)) send(connection, ["EVENT", subscription, event]);
        }
      }
    }
  }

  function onRequest(connection: Connection, message: readonly unknown[]): void {
    const subscription = String(message[1]);
    const filters = message.slice(2) as Filter[];
    received.push({ connection: connection.index, verb: "REQ", subscription, filters });

    if (needsAuthentication(connection)) {
      challenge(connection);
      send(connection, [
        "CLOSED",
        subscription,
        "auth-required: we only serve authenticated users",
      ]);
      return;
    }

    connection.subscriptions.set(subscription, filters);
    for (const event of storedFor(filters)) send(connection, ["EVENT", subscription, event]);
    send(connection, ["EOSE", subscription]);
  }

  function onEvent(connection: Connection, message: readonly unknown[]): void {
    const event = message[1] as NostrEvent | undefined;
    if (typeof event?.id !== "string") {
      send(connection, ["NOTICE", "invalid: an EVENT carries an event"]);
      return;
    }
    received.push({ connection: connection.index, verb: "EVENT", event });

    if (needsAuthentication(connection)) {
      challenge(connection);
      send(connection, [
        "OK",
        event.id,
        false,
        "auth-required: we only accept authenticated writes",
      ]);
      return;
    }
    // Real Relays validate before they apply policy, and a wrongly built event is
    // exactly the bug a test wants named rather than accepted in silence.
    if (!verifyEvent(event)) {
      send(connection, ["OK", event.id, false, "invalid: the signature does not check out"]);
      return;
    }
    const reason = options.refuse?.(event);
    if (reason !== undefined) {
      send(connection, ["OK", event.id, false, reason]);
      return;
    }

    published.push(event);
    send(connection, ["OK", event.id, true, ""]);
    hold(event);
  }

  function onAuthentication(connection: Connection, message: readonly unknown[]): void {
    const event = message[1] as NostrEvent | undefined;
    if (typeof event?.id !== "string") {
      send(connection, ["NOTICE", "invalid: an AUTH carries an event"]);
      return;
    }
    received.push({ connection: connection.index, verb: "AUTH", event });

    // The `relay` tag is recorded rather than compared. NIP-42 has the Relay check it,
    // and every Relay differs on how it normalises an address before doing so, which is
    // a divergence a test should be able to assert on rather than one this decides.
    const answered = event.tags.find((tag) => tag[0] === "challenge")?.[1];
    if (event.kind !== authenticationKind || answered !== connection.challenge) {
      send(connection, ["OK", event.id, false, "error: that is not the challenge we sent"]);
      return;
    }
    if (!verifyEvent(event)) {
      send(connection, ["OK", event.id, false, "error: the signature does not check out"]);
      return;
    }

    connection.authenticated = true;
    send(connection, ["OK", event.id, true, ""]);
  }

  function onMessage(connection: Connection, frame: string): void {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      send(connection, ["NOTICE", "invalid: that is not JSON"]);
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") {
      send(connection, ["NOTICE", "invalid: that is not a NIP-01 message"]);
      return;
    }

    switch (message[0]) {
      case "REQ": {
        onRequest(connection, message);
        break;
      }
      case "CLOSE": {
        const subscription = String(message[1]);
        received.push({ connection: connection.index, verb: "CLOSE", subscription });
        connection.subscriptions.delete(subscription);
        break;
      }
      case "EVENT": {
        onEvent(connection, message);
        break;
      }
      case "AUTH": {
        onAuthentication(connection, message);
        break;
      }
      default: {
        received.push({ connection: connection.index, verb: message[0] });
        send(connection, ["NOTICE", `invalid: we do not speak ${message[0]}`]);
        break;
      }
    }
  }

  function onConnection(socket: WebSocket): void {
    opened += 1;
    const connection: Connection = {
      index: opened,
      socket,
      challenge: randomUUID(),
      challenged: false,
      authenticated: false,
      subscriptions: new Map(),
    };
    connections.add(connection);

    socket.on("message", (data: RawData) => {
      onMessage(
        connection,
        Array.isArray(data) ? Buffer.concat(data).toString("utf8") : String(data),
      );
    });
    socket.on("close", () => void connections.delete(connection));
    // A socket dropped under us is what a test is often provoking, so it is not a failure.
    socket.on("error", () => void connections.delete(connection));

    if ((options.auth ?? "none") === "on-connect") challenge(connection);
  }

  async function start(): Promise<void> {
    if (server !== undefined) return;
    const next = new WebSocketServer({ host: "127.0.0.1", port });
    next.on("connection", onConnection);
    await new Promise<void>((listening, failed) => {
      const settle = (error?: Error): void => {
        next.off("listening", ready);
        next.off("error", broke);
        error === undefined ? listening() : failed(error);
      };
      const ready = (): void => settle();
      const broke = (error: Error): void => settle(error);
      next.once("listening", ready);
      next.once("error", broke);
    });
    port = (next.address() as AddressInfo).port;
    server = next;
  }

  async function stop(): Promise<void> {
    const current = server;
    if (current === undefined) return;
    server = undefined;
    // Terminate rather than close: an Operator's Relay going away is abrupt, and a
    // close handshake would leave the test waiting on the client to answer it.
    for (const socket of current.clients) socket.terminate();
    connections.clear();
    await new Promise<void>((closed) => current.close(() => closed()));
  }

  await start();

  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    published,
    hold,
    start,
    stop,
  };
}
