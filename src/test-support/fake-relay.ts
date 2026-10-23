import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Filter, matchFilters, type Event as NostrEvent, verifyEvent } from "nostr-tools";
import { type RawData, WebSocket, WebSocketServer } from "ws";

export type FakeRelayAuth = "none" | "on-connect" | "on-demand";

export type FakeRelayInformation = {
  readonly limitation?: {
    readonly max_message_length?: number;
  };
};

export type FakeRelayOptions = {
  readonly auth?: FakeRelayAuth;
  readonly information?: FakeRelayInformation;
  readonly maxLimit?: number;
  readonly refuse?: (event: NostrEvent) => string | undefined;
  readonly stall?: (event: NostrEvent) => boolean;
};

export type FakeRelayMessage = {
  readonly connection: number;
  readonly verb: string;
  readonly subscription?: string;
  readonly filters?: readonly Filter[];
  readonly event?: NostrEvent;
};

export type FakeRelay = {
  readonly url: string;
  readonly received: readonly FakeRelayMessage[];
  readonly published: readonly NostrEvent[];
  hold(...events: readonly NostrEvent[]): void;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type Connection = {
  readonly index: number;
  readonly socket: WebSocket;
  readonly challenge: string;
  challenged: boolean;
  authenticated: boolean;
  readonly subscriptions: Map<string, readonly Filter[]>;
};

const authenticationKind = 22242;

export async function startFakeRelay(options: FakeRelayOptions = {}): Promise<FakeRelay> {
  const received: FakeRelayMessage[] = [];
  const published: NostrEvent[] = [];
  const stored: NostrEvent[] = [];
  const connections = new Set<Connection>();

  let server: WebSocketServer | undefined;
  let http: Server | undefined;
  let opened = 0;
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

  function newestFirst(one: NostrEvent, other: NostrEvent): number {
    return other.created_at - one.created_at;
  }

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
    if (!verifyEvent(event)) {
      send(connection, ["OK", event.id, false, "invalid: the signature does not check out"]);
      return;
    }
    if (options.stall?.(event) === true) return;
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
    socket.on("error", () => void connections.delete(connection));

    if ((options.auth ?? "none") === "on-connect") challenge(connection);
  }

  async function start(): Promise<void> {
    if (server !== undefined) return;
    const site = createServer((_request, response) => {
      if (options.information === undefined) {
        response.writeHead(426, { "content-type": "text/plain" });
        response.end("Upgrade Required");
        return;
      }
      response.writeHead(200, { "content-type": "application/nostr+json" });
      response.end(JSON.stringify(options.information));
    });
    const next = new WebSocketServer({ server: site });
    next.on("connection", onConnection);
    await new Promise<void>((listening, failed) => {
      const settle = (error?: Error): void => {
        site.off("listening", ready);
        site.off("error", broke);
        error === undefined ? listening() : failed(error);
      };
      const ready = (): void => settle();
      const broke = (error: Error): void => settle(error);
      site.once("listening", ready);
      site.once("error", broke);
      site.listen(port, "127.0.0.1");
    });
    port = (site.address() as AddressInfo).port;
    server = next;
    http = site;
  }

  async function stop(): Promise<void> {
    const current = server;
    const site = http;
    if (current === undefined || site === undefined) return;
    server = undefined;
    http = undefined;
    for (const socket of current.clients) socket.terminate();
    connections.clear();
    await new Promise<void>((closed) => current.close(() => closed()));
    site.closeAllConnections();
    await new Promise<void>((closed) => site.close(() => closed()));
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
