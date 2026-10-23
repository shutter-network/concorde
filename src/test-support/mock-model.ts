import { createServer, type Server } from "node:http";
import { hostFromContainer } from "./docker.ts";

export type ModelMessage = {
  readonly role: string;
  readonly content: unknown;
  readonly tool_calls?: unknown;
};

export type ModelRequest = {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly texts: readonly string[];
};

export type ModelReply =
  | { readonly say: string }
  | { readonly bash: string }
  | { readonly refuse: { readonly status: number; readonly message: string } };

export type MockModel = {
  readonly baseUrl: string;
  readonly requests: readonly ModelRequest[];
  close(): Promise<void>;
};

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
  chunks.push(
    `data: ${JSON.stringify({
      id: "concorde-mock",
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
    id: "concorde-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-model",
    choices: [choice],
  })}\n\n`;
}

function close(server: Server): Promise<void> {
  return new Promise((closed, failed) => {
    server.close((error) => (error === undefined ? closed() : failed(error)));
    server.closeAllConnections();
  });
}
