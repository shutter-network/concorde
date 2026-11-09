import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type RawData, WebSocket, WebSocketServer } from "ws";

// A scripted OpenClaw daemon, 2026.8.1 as observed: every frame it sends is shaped like one the
// prototype recorded from the real daemon, and every frame it receives is kept for assertions.

export type Written = Record<string, unknown>;

export const dropsTheConnection: Written = { theDaemonHangsUp: true };

/** A request frame the daemon received, with the connection it arrived on. */
export type DaemonRequest = {
  readonly connection: number;
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
};

/** What one connection proved about itself at `connect`. */
export type ConnectionRecord = {
  readonly index: number;
  readonly nonce: string;
  /** The daemon's own agent, which a bare key resolves to when no `agentId` is sent. */
  readonly agentId: string;
  auth:
    | {
        readonly token: string | undefined;
        readonly deviceId: string | undefined;
        readonly signatureValid: boolean;
        readonly scopes: readonly string[];
      }
    | undefined;
  closed: boolean;
};

/**
 * Answers one request after `hello-ok`, with frames in order: a `{ type: "res" }` frame or an
 * `{ event, payload }` entry, which the daemon numbers and sends as an event frame. An async
 * iterable lets a test hold a Run open and release it.
 */
export type DaemonReply = (
  request: DaemonRequest,
  connection: ConnectionRecord,
) => Iterable<Written> | AsyncIterable<Written> | Promise<Iterable<Written>>;

export type FakeDaemonOptions = {
  /** The shared token, `gateway.auth.token` on the real daemon. */
  readonly token?: string;
  /** The agent a bare key resolves to, as the sole or default agent of the real daemon would. */
  readonly agentId?: string;
  readonly reply?: DaemonReply;
  /** Refuses `connect` with this error shape instead of answering `hello-ok`. */
  readonly refuseConnect?: (params: Written) => Written | undefined;
};

export type FakeDaemon = {
  readonly url: string;
  readonly token: string;
  readonly agentId: string;
  readonly received: readonly DaemonRequest[];
  readonly connections: readonly ConnectionRecord[];
  requests(method: string): DaemonRequest[];
  open(): number;
  ended(): number;
  close(): Promise<void>;
};

const defaultToken = "concorde-test-shared-token";
const defaultAgentId = "main";

const requiredScope: Record<string, string> = {
  "chat.send": "operator.write",
  "chat.abort": "operator.write",
  "sessions.messages.subscribe": "operator.read",
  "sessions.list": "operator.read",
};

const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

export async function startFakeDaemon(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const token = options.token ?? defaultToken;
  const agentId = options.agentId ?? defaultAgentId;
  const reply = options.reply ?? scriptedDaemon();
  const received: DaemonRequest[] = [];
  const connections: ConnectionRecord[] = [];
  const sockets = new Set<WebSocket>();
  let ended = 0;

  const http: Server = createServer();
  const server = new WebSocketServer({ server: http });

  server.on("connection", (socket) => {
    const record: ConnectionRecord = {
      index: connections.length,
      nonce: randomUUID(),
      agentId,
      auth: undefined,
      closed: false,
    };
    connections.push(record);
    sockets.add(socket);
    let eventSeq = 0;

    const send = (frame: Written): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(frame));
    };
    const event = (name: string, payload: unknown): void => {
      eventSeq += 1;
      send({ type: "event", event: name, payload, seq: eventSeq });
    };
    const error = (id: string, shape: Written): void => {
      send({ type: "res", id, ok: false, error: shape });
    };

    socket.on("close", () => {
      record.closed = true;
      ended += 1;
      sockets.delete(socket);
    });
    socket.on("error", () => {});
    socket.on("message", (data: RawData) => {
      void handle(JSON.parse(rawToString(data)) as Written);
    });

    event("connect.challenge", { nonce: record.nonce, ts: Date.now() });

    async function handle(frame: Written): Promise<void> {
      if (
        frame.type !== "req" ||
        typeof frame.id !== "string" ||
        typeof frame.method !== "string"
      ) {
        return;
      }
      const request: DaemonRequest = {
        connection: record.index,
        id: frame.id,
        method: frame.method,
        params: isRecord(frame.params) ? frame.params : {},
      };
      received.push(request);

      if (request.method === "connect") {
        answerConnect(request);
        return;
      }
      if (record.auth === undefined) {
        error(request.id, { code: "INVALID_REQUEST", message: "connect first" });
        return;
      }
      const needed = requiredScope[request.method];
      if (needed !== undefined && !record.auth.scopes.includes(needed)) {
        error(request.id, {
          code: "FORBIDDEN",
          message: `missing scope: ${needed}`,
          details: { code: "MISSING_SCOPE", missingScope: needed, requiredScopes: [needed] },
        });
        return;
      }
      for await (const written of await reply(request, record)) {
        if (written === dropsTheConnection) {
          socket.terminate();
          return;
        }
        if (written.type === "res") {
          send(written);
        } else if (typeof written.event === "string") {
          event(written.event, written.payload);
        }
      }
    }

    function answerConnect(request: DaemonRequest): void {
      const params = request.params;
      const refused = options.refuseConnect?.(params);
      if (refused !== undefined) {
        error(request.id, refused);
        socket.close(1008, "connect failed");
        return;
      }
      const auth = isRecord(params.auth) ? params.auth : {};
      const sentToken = typeof auth.token === "string" ? auth.token : undefined;
      if (sentToken === undefined) {
        error(request.id, {
          code: "INVALID_REQUEST",
          message: "unauthorized: gateway token missing (provide gateway auth token)",
          details: {
            code: "AUTH_TOKEN_MISSING",
            authReason: "token_missing",
            canRetryWithDeviceToken: false,
            recommendedNextStep: "update_auth_configuration",
          },
        });
        socket.close(1008, "unauthorized");
        return;
      }
      if (sentToken !== token) {
        error(request.id, {
          code: "INVALID_REQUEST",
          message: "unauthorized: gateway token mismatch (provide gateway auth token)",
          details: {
            code: "AUTH_TOKEN_MISMATCH",
            authReason: "token_mismatch",
            canRetryWithDeviceToken: true,
            recommendedNextStep: "retry_with_device_token",
          },
        });
        socket.close(1008, "unauthorized");
        return;
      }

      const device = isRecord(params.device) ? params.device : undefined;
      const requestedScopes = Array.isArray(params.scopes)
        ? params.scopes.filter((scope): scope is string => typeof scope === "string")
        : [];

      // The real daemon accepts a connection that sends no identity and hands it no scopes.
      if (device === undefined) {
        record.auth = { token: sentToken, deviceId: undefined, signatureValid: false, scopes: [] };
        send({ type: "res", id: request.id, ok: true, payload: helloOk(record, []) });
        return;
      }

      const signatureValid = verifiesChallenge(device, params, sentToken, record.nonce);
      record.auth = {
        token: sentToken,
        deviceId: typeof device.id === "string" ? device.id : undefined,
        signatureValid,
        scopes: requestedScopes,
      };
      if (!signatureValid) {
        error(request.id, {
          code: "INVALID_REQUEST",
          message: "unauthorized: device signature invalid",
          details: { code: "DEVICE_AUTH_INVALID_SIGNATURE" },
        });
        socket.close(1008, "unauthorized");
        return;
      }
      send({ type: "res", id: request.id, ok: true, payload: helloOk(record, requestedScopes) });
    }
  });

  await new Promise<void>((listening) => http.listen(0, "127.0.0.1", listening));
  const { port } = http.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}`,
    token,
    agentId,
    received,
    connections,
    requests: (method) => received.filter((request) => request.method === method),
    open: () => sockets.size,
    ended: () => ended,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((closed) => server.close(() => closed()));
      await new Promise<void>((closed) => http.close(() => closed()));
    },
  };
}

function helloOk(connection: ConnectionRecord, scopes: readonly string[]): Written {
  return {
    type: "hello-ok",
    protocol: 4,
    server: {
      version: "2026.8.1",
      buildId: "2026.8.1-ea806575e645-2026-08-31T02-56-59.000Z",
      bootId: "scripted",
      connId: `conn-${connection.index}`,
    },
    features: {
      methods: [
        "chat.send",
        "chat.abort",
        "chat.history",
        "agent",
        "agent.wait",
        "sessions.list",
        "sessions.send",
        "sessions.abort",
        "sessions.subscribe",
        "sessions.messages.subscribe",
        "sessions.messages.unsubscribe",
      ],
      events: ["agent", "chat", "chat.metadata.changed", "sessions.changed"],
    },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: {
      role: "operator",
      scopes,
      ...(scopes.length === 0
        ? {}
        : { deviceToken: "7jhB0-Wjg_KjA6-Zn8tuiOGeooLjtcYC4oBX4S6y4eo", issuedAtMs: Date.now() }),
    },
    policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 30000 },
  };
}

// The daemon checks a v3 payload: the fields the client signs, joined by `|`, with the device id
// the SHA-256 of the raw public key. A mismatch on either is refused as on the real daemon.
function verifiesChallenge(
  device: Record<string, unknown>,
  params: Record<string, unknown>,
  token: string,
  nonce: string,
): boolean {
  const { id, publicKey, signature, signedAt } = device;
  if (
    typeof id !== "string" ||
    typeof publicKey !== "string" ||
    typeof signature !== "string" ||
    typeof signedAt !== "number" ||
    device.nonce !== nonce
  ) {
    return false;
  }
  const raw = Buffer.from(publicKey, "base64url");
  if (raw.length !== 32) return false;
  if (createHash("sha256").update(raw).digest("hex") !== id) return false;

  const client = isRecord(params.client) ? params.client : {};
  const scopes = Array.isArray(params.scopes) ? params.scopes.map(String) : [];
  const payload = [
    "v3",
    id,
    String(client.id ?? ""),
    String(client.mode ?? ""),
    String(params.role ?? ""),
    scopes.join(","),
    String(signedAt),
    token,
    nonce,
    lowered(client.platform),
    lowered(client.deviceFamily),
  ].join("|");
  const key = createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, raw]),
    format: "der",
    type: "spki",
  });
  try {
    return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function lowered(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawToString(data: RawData): string {
  return Array.isArray(data) ? Buffer.concat(data).toString("utf8") : String(data);
}

/** The chat frames of a Run that finishes with one reply, as the daemon sent them. */
export function settledRun(said = "I did it."): readonly Written[] {
  return [
    { event: "chat", payload: { seq: 1, state: "status", phase: "preparing_workspace" } },
    { event: "chat", payload: { seq: 2, state: "status", phase: "preparing_context" } },
    { event: "chat", payload: { seq: 4, state: "status", phase: "starting_model" } },
    {
      event: "chat",
      payload: {
        seq: 5,
        state: "delta",
        deltaText: said,
        message: { role: "assistant", content: [{ type: "text", text: said }], timestamp: 1 },
      },
    },
    {
      event: "chat",
      payload: {
        seq: 14,
        state: "final",
        stopReason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: said }], timestamp: 2 },
      },
    },
  ];
}

/**
 * Answers the subscription, acknowledges `chat.send` with a fresh run id and then sends `events`
 * for that Run: a `chat` payload without a `runId` is stamped with the Run's id and its
 * canonical session key; one that carries its own `runId` is sent as written.
 */
export function scriptedDaemon(
  events: readonly Written[] = settledRun(),
): (request: DaemonRequest, connection: ConnectionRecord) => readonly Written[] {
  return (request, connection) => {
    const ok = (payload: Written): Written => ({ type: "res", id: request.id, ok: true, payload });
    switch (request.method) {
      case "sessions.messages.subscribe":
        return [
          ok({
            subscribed: true,
            key: canonicalKey(request.params.key, request.params.agentId, connection),
          }),
        ];
      case "chat.send": {
        const runId = randomUUID();
        const sessionKey = canonicalKey(
          request.params.sessionKey,
          request.params.agentId,
          connection,
        );
        return [
          ok({ runId, status: "started" }),
          ...events.map((written) =>
            isRecord(written.payload) && written.payload.runId === undefined
              ? { ...written, payload: { runId, sessionKey, ...written.payload } }
              : written,
          ),
        ];
      }
      case "chat.abort":
        return [ok({ ok: true, aborted: true, runIds: [] })];
      default:
        return [ok({})];
    }
  };
}

// The daemon stores a bare key as `agent:<agentId>:<key>`, under the agent id it was sent or its
// own agent when none was (Finding 4).
function canonicalKey(key: unknown, agentId: unknown, connection: ConnectionRecord): string {
  const bare = String(key ?? "");
  const owner = typeof agentId === "string" ? agentId : connection.agentId;
  return bare.startsWith("agent:") ? bare : `agent:${owner}:${bare}`;
}
