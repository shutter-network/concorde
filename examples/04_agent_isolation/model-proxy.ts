import { createServer } from "node:http";

const upstream = new URL(process.env.MODEL_UPSTREAM_URL!);
const header = process.env.MODEL_AUTH_HEADER!;
const value = process.env.MODEL_AUTH_VALUE!;
const port = Number(process.env.MODEL_PROXY_PORT);

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  header.toLowerCase(),
]);

const server = createServer((request, response) => {
  const target = new URL(upstream.pathname.replace(/\/$/, "") + request.url, upstream);

  const forwarded = new Headers();
  for (const [name, given] of Object.entries(request.headers)) {
    if (given === undefined || hopByHop.has(name.toLowerCase())) continue;
    forwarded.set(name, Array.isArray(given) ? given.join(", ") : given);
  }
  forwarded.set(header, value);

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : (ReadableStream.from(request) as BodyInit);

  fetch(target, {
    method: request.method,
    headers: forwarded,
    body,
    // @ts-expect-error duplex is required by undici for a streamed body and is not in the DOM types
    duplex: "half",
    redirect: "manual",
  })
    .then(async (answer) => {
      response.writeHead(
        answer.status,
        Object.fromEntries([...answer.headers].filter(([n]) => !hopByHop.has(n.toLowerCase()))),
      );
      if (answer.body === null) return response.end();
      for await (const chunk of answer.body) response.write(chunk);
      response.end();
    })
    .catch((error) => {
      console.error(`the model proxy could not reach ${upstream.host}: ${String(error)}`);
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "the model proxy could not reach the provider" }));
    });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`model proxy on ${port}, forwarding to ${upstream.href} and injecting ${header}`);
});

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => server.close());
}
