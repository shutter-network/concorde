/**
 * A fake Agent Instance: a TCP server that speaks `pi`'s RPC framing and says whatever a script
 * tells it to.
 *
 * It stands in for `pi --mode rpc` behind the Operator's listener, which is the only thing the
 * framework can see of an Agent Implementation now. That makes it the right size of fake: the seam
 * is a socket carrying JSON lines, so a fake on the other end of a real socket exercises everything
 * between "a Prompt exists" and "a Run is recorded" — the connection, the framing, the correlation
 * by `id`, the sequence, the reading of the events — with no Docker, no image, no model and no
 * network beyond loopback.
 *
 * What it deliberately cannot prove is that `pi` behaves as it is scripted to here. Two claims in
 * particular are `pi`'s and not ours: that `switch_session` creates a Session at a path that does
 * not exist, and that `get_state` answers with the path it was switched to. Those need the real
 * program, and `../pi/agent-instance.test.ts` is where they are made.
 *
 * Every connection is scripted from the beginning, which is what `socat ...,fork` does: each one is
 * its own `pi` process, so nothing a script is asked twice depends on the connection before it.
 */

import { createServer, type Server, type Socket } from "node:net";

/** One record written back to the client, as a plain object. */
export type Written = Record<string, unknown>;

/**
 * A place in a scripted stream where the Agent Instance goes away mid-Run.
 *
 * Two of them, because the two are different events on the client's socket and the Runtime is meant
 * to say so: a FIN is a peer that hung up, where an RST is `read ECONNRESET` and a process that
 * died. Compared by identity, so neither can be confused with a record a script meant to write.
 */
export const dropsTheConnection: Written = { theInstanceHangsUp: true };
/** The same, by way of an RST: the connection fails rather than ending. */
export const resetsTheConnection: Written = { theInstanceDies: true };

/**
 * What the fake says when a command arrives.
 *
 * The whole command is handed over, `id` included, so a script can answer with the wrong `id` on
 * purpose — which is how the claim that responses are correlated rather than counted gets tested at
 * all. Answering with nothing at all is a script saying "write no response", which is what a
 * dropped connection looks like from the client's side.
 */
export type Reply = (command: Received) => readonly Written[] | Promise<readonly Written[]>;

/** One command the fake was sent. */
export type Received = {
  readonly id: unknown;
  readonly type: string;
} & Record<string, unknown>;

/** A running fake, and what it saw. */
export type FakeInstance = {
  readonly host: string;
  readonly port: number;
  /** Every command received, in order, across every connection. */
  readonly received: Received[];
  /** How many connections have been opened, which is one per Run. */
  connections(): number;
  /** How many of them have ended, which is how "the Runtime closes it" is asserted. */
  ended(): number;
  close(): Promise<void>;
};

/**
 * Starts a fake Agent Instance on loopback and an ephemeral port.
 *
 * `reply` is called per command and answers with the records to write. It may write more than one —
 * a response and then a stream of events is exactly the shape of `prompt` — and the records are
 * written as separate socket writes, so a client that assumed one record per chunk is caught.
 */
export async function startFakeInstance(reply: Reply): Promise<FakeInstance> {
  const received: Received[] = [];
  let connections = 0;
  let ended = 0;
  let latest: Socket | undefined;

  const server: Server = createServer((socket) => {
    connections += 1;
    latest = socket;
    socket.on("close", () => {
      ended += 1;
    });
    // The fake is not the subject, so a client that hung up mid-write is not a test failure.
    socket.on("error", () => {});

    // The fake reads LF-framed lines the way the client does, and for the same reason: a command
    // carrying a U+2028 inside its Prompt is one record and not two.
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      for (;;) {
        const end = pending.indexOf("\n");
        if (end === -1) return;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.trim() === "") continue;
        void answer(socket, JSON.parse(line) as Received);
      }
    });
  });

  async function answer(socket: Socket, command: Received): Promise<void> {
    received.push(command);
    for (const record of await reply(command)) {
      if (socket.destroyed) return;
      // The two sentinels are places in a script rather than records; see their declarations.
      if (record === dropsTheConnection) {
        socket.destroy();
        return;
      }
      if (record === resetsTheConnection) {
        socket.resetAndDestroy();
        return;
      }
      socket.write(`${JSON.stringify(record)}\n`);
    }
  }

  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake took no port");

  return {
    host: "127.0.0.1",
    port: address.port,
    received,
    connections: () => connections,
    ended: () => ended,
    close: () =>
      new Promise<void>((closed) => {
        latest?.destroy();
        server.close(() => closed());
      }),
  };
}

/**
 * The records a settled Run is made of: an assistant message that answered, and the settle.
 *
 * Written out here because every case that is not about the events themselves needs a stream that
 * succeeds, and a test that spelled one out each time would be a test about JSON.
 */
export function settledRun(said = "I did it."): readonly Written[] {
  return [
    { type: "agent_start" },
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: said }] },
    },
    { type: "agent_settled" },
  ];
}

/**
 * A reply that drives the whole sequence: a switch that succeeds, a state naming `sessionFile`, and
 * a Prompt accepted and then settled.
 *
 * `sessionFile` is a function of the switch that arrived rather than a constant, because agreeing
 * with whatever was asked for is what a healthy Agent Instance does and what every case that is not
 * about the mismatch needs.
 */
export function scriptedInstance(events: readonly Written[] = settledRun()): Reply {
  let switchedTo: unknown;
  return (command) => {
    const response = (extra: Written = {}): Written[] => [
      { type: "response", id: command.id, command: command.type, success: true, ...extra },
    ];
    switch (command.type) {
      case "switch_session":
        switchedTo = command.sessionPath;
        return response({ data: { cancelled: false } });
      case "get_state":
        return response({ data: { sessionFile: switchedTo, isStreaming: false } });
      case "prompt":
        return [...response(), ...events];
      default:
        return response();
    }
  };
}
