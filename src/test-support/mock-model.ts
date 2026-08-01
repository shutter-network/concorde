/**
 * A scripted OpenAI-compatible model server, so a real agent Run needs no credentials.
 *
 * This is the one thing stubbed in the end-to-end test, and it is worth being exact
 * about what that leaves real: the container is real, the `pi` binary in it is real,
 * the mounts are real, the Prompt goes in on a real pipe, the agent's `bash` tool runs
 * real `curl` against the real Agent server, and the JSONL that comes back is real.
 * Only the model's answers are decided here — which is the part a provider key would
 * buy, and the part that would make the test non-deterministic if it were real.
 *
 * The wire format is what `pi`'s `openai-completions` API expects and nothing more:
 * `stream: true` with server-sent events, terminated by `[DONE]`. A plain JSON body is
 * not an option — `pi` asks for a stream and reports "Stream ended without
 * finish_reason" for anything else, which was worth finding out once.
 */

import { createServer, type Server } from "node:http";
import { hostFromContainer } from "./docker.ts";

/** One message as the model was given it. */
export type ModelMessage = {
  readonly role: string;
  readonly content: unknown;
  readonly tool_calls?: unknown;
};

/** One request the agent made of the model. */
export type ModelRequest = {
  /**
   * The system prompt: `pi`'s own, plus every context file it discovered for itself.
   *
   * That second half is where an `AGENTS.md` the Operator placed in the Workspace turns
   * up. Nothing of the framework's is in here, and no flag of the framework's put it
   * there (ADR-0025).
   */
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  /**
   * The text of every non-system message, in order — the Prompt, and every tool
   * result the agent got back. What the agent actually knew when it asked.
   */
  readonly texts: readonly string[];
};

/** What the model should answer. */
export type ModelReply =
  /** A final answer, which settles the Run. */
  | { readonly say: string }
  /** A `bash` tool call, which the agent really runs in its container. */
  | { readonly bash: string }
  /**
   * An HTTP failure instead of an answer.
   *
   * `400` is the case worth having: `pi --mode json` reports it inside the stream and
   * then **exits 0**, which is the trap the Run outcome must not be read from an exit
   * code (ADR-0025).
   */
  | { readonly refuse: { readonly status: number; readonly message: string } };

export type MockModel = {
  /** The base URL as the agent's container reaches it, for `models.json`. */
  readonly baseUrl: string;
  /** Every request, in the order they arrived. */
  readonly requests: readonly ModelRequest[];
  close(): Promise<void>;
};

/**
 * How many replies the agent has already made in this conversation.
 *
 * Counted from the request rather than kept here, so a reply function is a function of
 * what the agent knows and nothing else — which is what lets one function script every
 * Run in a test, since each Run is a fresh container and a fresh conversation.
 */
export function assistantMessages(request: ModelRequest): number {
  return request.messages.filter((message) => message.role === "assistant").length;
}

export async function startMockModel(
  reply: (request: ModelRequest, at: number) => ModelReply,
): Promise<MockModel> {
  const requests: ModelRequest[] = [];

  const server = createServer((incoming, response) => {
    let body = "";
    incoming.on("data", (chunk) => {
      body += String(chunk);
    });
    incoming.on("end", () => {
      const request = parse(body);
      requests.push(request);
      const answer = reply(request, requests.length - 1);

      if ("refuse" in answer) {
        response.writeHead(answer.refuse.status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: answer.refuse.message, type: "invalid_request" } }),
        );
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      for (const chunk of stream(answer)) response.write(chunk);
      response.end();
    });
  });

  await new Promise<void>((listening) => server.listen(0, "0.0.0.0", listening));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the mock model server reports no TCP address");
  }

  return {
    baseUrl: `http://${hostFromContainer}:${address.port}/v1`,
    requests,
    close: () => close(server),
  };
}

function parse(body: string): ModelRequest {
  const parsed = JSON.parse(body === "" ? "{}" : body) as { messages?: readonly ModelMessage[] };
  const messages = parsed.messages ?? [];
  const system = messages.find((message) => message.role === "system");
  return {
    system: system === undefined ? "" : textOf(system.content),
    messages,
    texts: messages
      .filter((message) => message.role !== "system")
      .map((message) => textOf(message.content)),
  };
}

/** The text of a message, whose content is a string or a list of content parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const { text } = part as { text?: unknown };
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** The reply as server-sent events, the way the chat-completions API streams. */
function stream(answer: { readonly say: string } | { readonly bash: string }): string[] {
  const chunks = [frame({ index: 0, delta: { role: "assistant", content: "" } })];
  if ("say" in answer) {
    chunks.push(
      frame({ index: 0, delta: { content: answer.say } }),
      frame({ index: 0, delta: {}, finish_reason: "stop" }),
    );
  } else {
    chunks.push(
      frame({
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: answer.bash }) },
            },
          ],
        },
      }),
      frame({ index: 0, delta: {}, finish_reason: "tool_calls" }),
    );
  }
  // `stream_options.include_usage` is what pi asks for, so the usage frame carries no
  // choices and comes last before the terminator.
  chunks.push(
    `data: ${JSON.stringify({
      id: "saf-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock-model",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
    "data: [DONE]\n\n",
  );
  return chunks;
}

function frame(choice: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: "saf-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-model",
    choices: [choice],
  })}\n\n`;
}

function close(server: Server): Promise<void> {
  return new Promise((closed, failed) => {
    server.close((error) => (error === undefined ? closed() : failed(error)));
    // Keep-alive sockets would otherwise hold the close open until they time out.
    server.closeAllConnections();
  });
}
