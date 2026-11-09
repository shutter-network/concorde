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

/**
 * The chat frames of a Run that finishes with one reply, as the daemon sent them. `between` goes
 * after the status frames and before the reply, which is where a Run's model calls were observed.
 */
export function settledRun(
  said = "I did it.",
  between: readonly Written[] = [],
): readonly Written[] {
  return [...runStatuses, ...between, ...runReply(said)];
}

const runStatuses: readonly Written[] = [
  { event: "chat", payload: { seq: 1, state: "status", phase: "preparing_workspace" } },
  { event: "chat", payload: { seq: 2, state: "status", phase: "preparing_context" } },
  { event: "chat", payload: { seq: 4, state: "status", phase: "starting_model" } },
];

function runReply(said: string): readonly Written[] {
  return [
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
 * canonical session key, and a `session.message` record whose `__openclaw` names no Run gets the
 * Run's id there and the session key beside the message; one that carries its own `runId` is sent
 * as written.
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
          ...events.map((written) => stamped(written, runId, sessionKey)),
        ];
      }
      case "chat.abort":
        return [ok({ ok: true, aborted: true, runIds: [] })];
      default:
        return [ok({})];
    }
  };
}

function stamped(written: Written, runId: string, sessionKey: string): Written {
  const payload = written.payload;
  if (!isRecord(payload)) return written;
  if (written.event === "chat" || written.event === "agent") {
    return payload.runId === undefined
      ? { ...written, payload: { runId, sessionKey, ...payload } }
      : written;
  }
  if (written.event === "session.message" && isRecord(payload.message)) {
    const message = payload.message;
    const openclaw = isRecord(message.__openclaw) ? message.__openclaw : {};
    if (openclaw.runId !== undefined) return written;
    const [, agentId] = sessionKey.split(":");
    return {
      ...written,
      payload: {
        sessionKey,
        agentId,
        ...payload,
        message: {
          ...message,
          __openclaw: {
            runId,
            id: randomUUID(),
            recordTimestampMs: Date.now(),
            transcriptPosition: { lineOffset: 1, byteOffset: 1 },
            seq: 1,
            ...openclaw,
          },
        },
      },
    };
  }
  return written;
}

/** The usage of one model call, as the daemon's transcript record carries it (Finding 3). */
export type ModelCall = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** The daemon's computed cost of the call, `usage.cost.total`. */
  readonly cost?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly content?: readonly Written[];
};

/**
 * The `session.message` record of one assistant message, which a subscribed connection receives
 * once per model call with that call's full usage. The scripted daemon stamps the Run's id into
 * `__openclaw` when it sends it.
 */
export function modelCall(call: ModelCall): Written {
  const cacheRead = call.cacheRead ?? 0;
  const cacheWrite = call.cacheWrite ?? 0;
  const cost = call.cost ?? 0;
  return {
    event: "session.message",
    payload: {
      message: {
        role: "assistant",
        content: call.content ?? [{ type: "text", text: "Done." }],
        api: "openai-completions",
        provider: call.provider ?? "mock",
        model: call.model ?? "mock-model",
        usage: {
          input: call.input,
          output: call.output,
          totalTokens: call.input + call.output + cacheRead + cacheWrite,
          cacheRead,
          cacheWrite,
          cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        },
        stopReason: call.stopReason ?? "stop",
        timestamp: 1794180731352,
        responseId: "concorde-mock",
      },
    },
  };
}

/**
 * The synthetic assistant record the daemon writes for a model call it could not complete, usage
 * all zero and `stopReason: "error"`; a refused call produces one (Finding 3).
 */
export const refusedCall: ModelCall = {
  input: 0,
  output: 0,
  stopReason: "error",
  content: [{ type: "text", text: "The agent run failed before producing a reply." }],
};

/**
 * The frames a Run's model calls produce, in the order observed: the Prompt's own `user` record
 * first, then per call the `agent` `usage` frame with the running output total and the call's
 * `session.message` record.
 */
export function modelCalls(...calls: readonly ModelCall[]): readonly Written[] {
  const frames: Written[] = [promptRecord];
  let outputTokens = 0;
  for (const call of calls) {
    outputTokens += call.output;
    frames.push(...callFrames(call, outputTokens, frames.length));
  }
  return frames;
}

const promptRecord: Written = {
  event: "session.message",
  payload: {
    message: {
      role: "user",
      content: [{ type: "text", text: "what happened?" }],
      timestamp: 1794180731000,
    },
  },
};

// The daemon emits the running output total the moment a call's stream ends, nothing for a call
// that produced no output, and the call's record after it.
function callFrames(call: ModelCall, outputTokens: number, seq: number): readonly Written[] {
  return [
    ...(call.output > 0
      ? [{ event: "agent", payload: { stream: "usage", data: { outputTokens }, seq } }]
      : []),
    modelCall(call),
  ];
}

/**
 * What the daemon sent once `chat.abort` stopped a Run while a model call was in flight
 * (Finding 5): the `aborted` terminal with `stopReason: "rpc"` carrying what the call had streamed
 * so far, the lifecycle end, two all-zero transcript records for the cut call, and the lifecycle
 * error that follows for the same Run and is not a second failure. The cut call's usage is in
 * none of them: the daemon closed the provider's stream before its usage chunk.
 */
export function abortedFrames(streamed = "word0"): readonly Written[] {
  const partial = { role: "assistant", content: [{ type: "text", text: streamed }], timestamp: 3 };
  return [
    { event: "chat", payload: { seq: 11, state: "aborted", stopReason: "rpc", message: partial } },
    {
      event: "agent",
      payload: { stream: "lifecycle", data: { phase: "end", stopReason: "rpc", aborted: true } },
    },
    modelCall({
      input: 0,
      output: 0,
      provider: "openclaw",
      model: "gateway-injected",
      content: partial.content,
    }),
    modelCall({ input: 0, output: 0, stopReason: "aborted", content: [] }),
    {
      event: "agent",
      payload: {
        stream: "lifecycle",
        data: {
          phase: "error",
          stopReason: "aborted",
          aborted: true,
          error: "This operation was aborted",
        },
      },
    },
  ];
}

export type AbortableRunOptions = {
  /** The reply the Run ends with when nothing stops it. */
  readonly said?: string;
  /** How long each call after the first is in flight: the window in which an abort lands. */
  readonly holdMs?: number;
};

type LiveRun = { readonly sessionKey: string; readonly stopped: PromiseWithResolvers<void> };

/**
 * A daemon whose Run can be stopped between its model calls, as the real one was. After each
 * call's record the Run holds for `holdMs`, the time the next call would be in flight; a
 * `chat.abort` naming the Run and its Session that arrives in that window ends it with
 * `abortedFrames`, and the calls not yet made never start. Left alone, the Run plays every call
 * and finishes with `said`. The abort is answered as the daemon answers it:
 * `{ ok: true, aborted: true, runIds: [runId] }` for a Run it stopped, `runIds: []` for one it
 * does not know or that had already ended.
 */
export function abortableDaemon(
  calls: readonly ModelCall[],
  options: AbortableRunOptions = {},
): DaemonReply {
  const said = options.said ?? "Done.";
  const holdMs = options.holdMs ?? 250;
  const live = new Map<string, LiveRun>();
  const scripted = scriptedDaemon();

  async function* play(ack: Written, runId: string, run: LiveRun): AsyncIterable<Written> {
    const stamp = (written: Written): Written => stamped(written, runId, run.sessionKey);
    yield ack;
    yield* runStatuses.map(stamp);
    yield stamp(promptRecord);
    let outputTokens = 0;
    for (const [index, call] of calls.entries()) {
      if (index > 0 && (await stoppedWithin(holdMs, run.stopped.promise))) {
        live.delete(runId);
        yield* abortedFrames().map(stamp);
        return;
      }
      outputTokens += call.output;
      yield* callFrames(call, outputTokens, 5 + index).map(stamp);
    }
    live.delete(runId);
    yield* runReply(said).map(stamp);
  }

  return (request, connection) => {
    const ok = (payload: Written): Written => ({ type: "res", id: request.id, ok: true, payload });
    switch (request.method) {
      case "chat.send": {
        const runId = randomUUID();
        const run: LiveRun = {
          sessionKey: canonicalKey(request.params.sessionKey, request.params.agentId, connection),
          stopped: Promise.withResolvers<void>(),
        };
        live.set(runId, run);
        return play(ok({ runId, status: "started" }), runId, run);
      }
      case "chat.abort": {
        const runId = request.params.runId;
        const run = typeof runId === "string" ? live.get(runId) : undefined;
        const key = canonicalKey(request.params.sessionKey, request.params.agentId, connection);
        if (run === undefined || run.sessionKey !== key) {
          return [ok({ ok: true, aborted: false, runIds: [] })];
        }
        run.stopped.resolve();
        return [ok({ ok: true, aborted: true, runIds: [runId] })];
      }
      default:
        return scripted(request, connection);
    }
  };
}

function stoppedWithin(ms: number, stopped: Promise<void>): Promise<boolean> {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle(false), ms);
    void stopped.then(() => {
      clearTimeout(timer);
      settle(true);
    });
  });
}

// The daemon stores a bare key as `agent:<agentId>:<key>`, under the agent id it was sent or its
// own agent when none was (Finding 4).
function canonicalKey(key: unknown, agentId: unknown, connection: ConnectionRecord): string {
  const bare = String(key ?? "");
  const owner = typeof agentId === "string" ? agentId : connection.agentId;
  return bare.startsWith("agent:") ? bare : `agent:${owner}:${bare}`;
}
