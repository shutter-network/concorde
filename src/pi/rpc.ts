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
      `could not reach the Agent Instance at ${host}:${port}: ${failedToConnect.message}. That is the address an Operator gave createPiRuntime, and the Agent Instance is theirs to run`,
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

    async send(command, fields) {
      sent += 1;
      const id = String(sent);
      socket.write(`${JSON.stringify({ id, type: command, ...fields })}\n`);

      for (;;) {
        const step = await records.next();
        if (step.done === true) {
          throw new Error(
            `the Agent Instance at ${host}:${port} ended the connection without answering the ${command} command${dropped === undefined ? "" : `: ${dropped}`}`,
          );
        }
        const framed = step.value;
        if (framed.kind !== "record") {
          throw new Error(
            `the Agent Instance at ${host}:${port} wrote something that is not a record while the ${command} command was outstanding, so nothing it says can be trusted: ${JSON.stringify(framed.line.slice(0, 200))}`,
          );
        }
        if (framed.record.type !== "response") continue;

        const record = framed.record;
        if (record.id !== id) {
          throw new Error(
            `the Agent Instance at ${host}:${port} answered request ${JSON.stringify(record.id)} while ${JSON.stringify(id)} was the only one outstanding, so its answers cannot be matched to the commands they are for`,
          );
        }
        const answered = readResponse(record);
        if (answered.command !== command) {
          throw new Error(
            `the Agent Instance at ${host}:${port} answered request ${id} as the ${JSON.stringify(answered.command)} command when it was the ${JSON.stringify(command)} command`,
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
