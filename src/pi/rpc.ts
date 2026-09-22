/**
 * The RPC channel: one TCP connection to an Agent Instance, opened for one Run and closed at the
 * end of it.
 *
 * Always written as the **RPC channel** and never as an unqualified Channel, the way a PostgreSQL
 * notification channel is: a Channel in this framework is what reaches one person over one medium,
 * and this reaches the agent.
 *
 * `node:net` and nothing else, which is the whole of the client. The protocol is JSON lines in both
 * directions, so a library would buy the two things this file already has — framing, which is
 * `./framing.ts`, and correlation, which is eleven lines below — and cost the package a runtime
 * dependency that every consumer installs. `dependencies` is unchanged by the Agent Instance, and
 * that is a claim worth keeping true.
 *
 * **Commands are never pipelined.** One is written, its response is awaited, and only then is the
 * next written. That is not a limitation of the code below, which correlates by `id` and would
 * survive interleaving; it is what makes the correlation checkable at all. A response whose `id` is
 * not the outstanding one therefore means the assumption underneath the whole file is false, and it
 * fails the Run rather than being matched up, because reading another command's answer as this
 * command's is how a Run comes to be switched into a Session nobody asked for.
 *
 * Events are skipped while a response is outstanding, and that is safe for the one sequence this
 * channel is driven through. `switch_session` and `get_state` produce no events at all, and the
 * `prompt` response is written when the Prompt is **accepted**, before the agent has run: nothing
 * skipped there can be an assistant message or the settle. A second command sent while the agent is
 * streaming would break that, which is one more reason there is not one.
 *
 * Nothing here knows what a Session is, what a Prompt is, or what ends a Run. It writes commands,
 * answers with responses, and hands the rest of the stream to whoever asks.
 */

import { createConnection } from "node:net";
import { type Framed, framedRecords } from "./framing.ts";

/** What one command was answered with. */
export type Answered = {
  /** The command the Agent Instance says this answers, which is checked against the one sent. */
  readonly command: string;
  readonly success: boolean;
  /** Present when `success` is false, and written for a person by the Agent Instance. */
  readonly error: string | undefined;
  /**
   * Whatever the response carried, uninterpreted.
   *
   * `switch_session` answers `{ cancelled: boolean }` and `get_state` a dozen fields including
   * `sessionFile`, and which of them matter is the Runtime's business rather than this file's.
   */
  readonly data: Readonly<Record<string, unknown>> | undefined;
};

/** One connection to an Agent Instance, for the length of one Run. */
export type RpcChannel = {
  /**
   * Writes one command and answers with its response.
   *
   * @throws If the connection ended before the response arrived, or if what came back was another
   *   command's answer. Both mean the Run cannot be trusted to have happened, and the caller turns
   *   the message into a failed Run.
   */
  send(command: string, fields?: Readonly<Record<string, unknown>>): Promise<Answered>;
  /**
   * Everything that has not been read as a response, as an iterator the outcome reader pulls.
   *
   * An iterator and not an iterable: whoever reads the events of a Run takes what it needs and
   * leaves the stream open, because closing it is this channel's job and `close` below is where it
   * happens.
   */
  readonly records: AsyncIterator<Framed>;
  /**
   * Why the connection went away, if it did so by failing rather than by being closed.
   *
   * Read after a Run has already failed, to say `read ECONNRESET` beside `the stream ended`. A
   * dropped connection reaches the reader as nothing at all — the records simply stop — so without
   * this the Agent Instance dying mid-Run and the Agent Instance hanging up politely produce the
   * same sentence.
   */
  dropped(): string | undefined;
  /** Closes the connection. Called for every Run, whatever the outcome, and never twice. */
  close(): void;
};

/**
 * Opens one connection to an Agent Instance.
 *
 * @throws If the Agent Instance cannot be reached, with the address in the message. That is a failed
 *   Run and never a boot failure: nothing calls this until a Prompt exists, which is the **Relay**
 *   precedent — a remote thing the Operator runs is an outage and not a configuration error, and a
 *   startup probe would only turn a Gateway that serves every other Party into one that will not
 *   start.
 */
export async function openRpcChannel(host: string, port: number): Promise<RpcChannel> {
  const socket = createConnection({ host, port });
  // The commands are tiny and strictly sequential, so Nagle's algorithm has nothing to coalesce and
  // everything to delay: a 40-millisecond wait on each of three commands, three times per Run.
  socket.setNoDelay(true);

  // Node emits exactly one of these two, and both are awaited because a later stream error cannot
  // answer whether there was anything listening in the first place.
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
  // Attached before a byte is written. An `error` event with no listener takes the whole Gateway's
  // process down, and a write to a socket the Agent Instance has already closed is exactly how one
  // arrives.
  socket.on("error", (error) => {
    dropped ??= error.message;
  });

  const records = framedRecords(
    (async function* () {
      try {
        for await (const chunk of socket) yield chunk as Uint8Array;
      } catch (error) {
        // A dropped connection is the end of the stream and never a throw. The Run it was carrying
        // fails on the records that are missing, which is a sentence about the Run rather than
        // about a socket.
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
      // Per connection, and a connection is per Run. Nothing is correlated across Runs and nothing
      // needs to be.
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
        // An event of some earlier work, or of this Prompt being accepted; see the file header for
        // why passing over it is safe and for the one thing that would make it unsafe.
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

/** One `response` record, in the shape a caller branches on. */
function readResponse(record: Readonly<Record<string, unknown>>): Answered {
  const data = record.data;
  return {
    command: typeof record.command === "string" ? record.command : "",
    // `=== true` rather than truthiness: a response with no `success` at all is not a success.
    success: record.success === true,
    error: typeof record.error === "string" ? record.error : undefined,
    data:
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined,
  };
}
