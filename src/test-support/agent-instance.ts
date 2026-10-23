import { createServer, type Server, type Socket } from "node:net";

export type Written = Record<string, unknown>;

export const dropsTheConnection: Written = { theInstanceHangsUp: true };
export const resetsTheConnection: Written = { theInstanceDies: true };

export type Reply = (command: Received) => readonly Written[] | Promise<readonly Written[]>;

export type Received = {
  readonly id: unknown;
  readonly type: string;
} & Record<string, unknown>;

export type FakeInstance = {
  readonly host: string;
  readonly port: number;
  readonly received: Received[];
  connections(): number;
  ended(): number;
  close(): Promise<void>;
};

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
    socket.on("error", () => {});

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
