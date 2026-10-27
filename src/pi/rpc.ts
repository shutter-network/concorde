import { createConnection } from "node:net";
import { type Framed, framedRecords } from "./framing.ts";

export type Answered = {
  readonly command: string;
  readonly success: boolean;
  readonly error: string | undefined;
  readonly data: Readonly<Record<string, unknown>> | undefined;
};

export type RpcChannel = {
  send(command: string, fields?: Readonly<Record<string, unknown>>): Promise<Answered>;
  /** Send a command without waiting for its response. Read the response from `records`. */
  notify(command: string): void;
  readonly records: AsyncIterator<Framed>;
  dropped(): string | undefined;
  close(): void;
};

export async function openRpcChannel(host: string, port: number): Promise<RpcChannel> {
  const socket = createConnection({ host, port });
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);

  const failedToConnect = await new Promise<Error | undefined>((settled) => {
    socket.once("connect", () => settled(undefined));
    socket.once("error", (error) => settled(error));
  });
  if (failedToConnect !== undefined) {
    socket.destroy();
    throw new Error(
      `Cannot connect to agent instance at ${host}:${port}: ${failedToConnect.message}. Check the address and RPC listener.`,
      { cause: failedToConnect },
    );
  }

  let dropped: string | undefined;
  socket.on("error", (error) => {
    dropped ??= error.message;
  });

  const records = framedRecords(
    (async function* () {
      try {
        for await (const chunk of socket) yield chunk as Uint8Array;
      } catch (error) {
        dropped ??= error instanceof Error ? error.message : String(error);
      }
    })(),
  );

  let sent = 0;
  return {
    records,
    dropped: () => dropped,
    close: () => socket.destroy(),

    notify(command) {
      sent += 1;
      socket.write(`${JSON.stringify({ id: String(sent), type: command })}\n`);
    },

    async send(command, fields) {
      sent += 1;
      const id = String(sent);
      socket.write(`${JSON.stringify({ id, type: command, ...fields })}\n`);

      for (;;) {
        const step = await records.next();
        if (step.done === true) {
          throw new Error(
            `Agent instance ${host}:${port} closed the connection before answering ${command}${dropped === undefined ? "" : `: ${dropped}`}`,
          );
        }
        const framed = step.value;
        if (framed.kind !== "record") {
          throw new Error(
            `Agent instance ${host}:${port} sent an invalid RPC record while awaiting ${command}: ${JSON.stringify(framed.line.slice(0, 200))}`,
          );
        }
        if (framed.record.type !== "response") continue;

        const record = framed.record;
        if (record.id !== id) {
          throw new Error(
            `Agent instance ${host}:${port} answered request ${JSON.stringify(record.id)}; expected ${JSON.stringify(id)}`,
          );
        }
        const answered = readResponse(record);
        if (answered.command !== command) {
          throw new Error(
            `Agent instance ${host}:${port} answered request ${id} for ${JSON.stringify(answered.command)}; expected ${JSON.stringify(command)}`,
          );
        }
        return answered;
      }
    },
  };
}

function readResponse(record: Readonly<Record<string, unknown>>): Answered {
  const data = record.data;
  return {
    command: typeof record.command === "string" ? record.command : "",
    success: record.success === true,
    error: typeof record.error === "string" ? record.error : undefined,
    data:
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined,
  };
}
