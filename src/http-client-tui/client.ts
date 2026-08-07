/**
 * The whole of what this client knows how to ask for: a Token, a User's own Message log, and a
 * submission. Three requests against two routes of the HTTP Channel and one of the Users
 * component, and nothing else. Decisions, Schedules and the Agent server are deliberately absent,
 * which is what lets one binary serve every deployment that runs an HTTP Channel with no
 * conditionals in it.
 *
 * The record types are imported from the components that answer with them, as types. So a field
 * renamed on `MessageRecord` fails the typecheck here rather than reaching a reader as an
 * `undefined` in their transcript. Nothing here imports a value from either, and the compiled
 * module therefore pulls in no part of the framework at run time.
 *
 * A response is read rather than cast. A response schema is a serializer that drops what it does
 * not declare and says nothing about it, so a Gateway can answer a Message with no `seq` and no
 * error anywhere. Reading the fields is what turns that into one sentence naming the route.
 *
 * The cursor and the echo set are the two pieces of state, and they are here rather than in the
 * caller because they are one thing: the poll walks forwards from the highest `seq` seen, and a
 * Message this client submitted comes back on that walk. The cursor is advanced by the poll and
 * never by a submission, because the agent may have written an outbound Message the client has not
 * read yet and a submission's `seq` says nothing about it.
 *
 * **A submission that completes during a poll is echoed.** The poll can read the row before `say`
 * has recorded its `seq`, so the reader sees their own line twice. Recorded rather than guarded:
 * the guard is a lock over both calls, and a duplicated line once in a while is cheaper than one.
 */

import type { MessageRecord } from "../messenger/messages.ts";
import type { IssuedToken, UserRecord } from "../users/routes.ts";

/** What `fetch` is here: the global by default, and a parameter so a test can answer without one. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** How many Messages a poll asks for, which is the cap the routes enforce. */
const pollLimit = 200;

/** No answer arrived: the connection was refused, the name did not resolve, or the read broke. */
export class UnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`no answer from ${url}`, { cause });
    this.name = "UnreachableError";
  }
}

/** The Gateway answered, and what it answered was a refusal. */
export class RefusedError extends Error {
  readonly status: number;
  constructor(method: string, url: string, status: number, said: string) {
    super(`${method} ${url} answered ${status}: ${said}`);
    this.name = "RefusedError";
    this.status = status;
  }
}

/** The Gateway answered something this client cannot read as the record the route describes. */
export class MalformedResponseError extends Error {
  constructor(what: string, said: string) {
    super(`${what} was not answered as expected: ${said}`);
    this.name = "MalformedResponseError";
  }
}

export type ClientOptions = {
  /** Where the Public server listens. A path on it is kept, so a Gateway behind a prefix works. */
  readonly baseUrl: string;
  /** Aborts a request in flight, so Ctrl-C during a poll is not waited out. */
  readonly signal?: AbortSignal;
  /** Defaults to the global `fetch`. */
  readonly fetch?: Fetch;
};

export type Client = {
  /** Trades the password for a Token and holds it. Every later call presents it. */
  logIn(credentials: { readonly user: string; readonly password: string }): Promise<IssuedToken>;
  /** The newest page of this User's log, oldest first, and the cursor every poll walks from. */
  open(): Promise<readonly MessageRecord[]>;
  /** What arrived since the last read, without the Messages this client submitted. */
  poll(): Promise<readonly MessageRecord[]>;
  /** Submits one inbound Message and answers with the stored record. */
  say(text: string): Promise<MessageRecord>;
};

/**
 * Joins a path onto a base URL, keeping any path the base carries.
 *
 * `path` is relative and carries no leading slash for that reason: `/messages` against
 * `http://host/saf` resolves to `http://host/messages` and loses the deployment's prefix.
 */
export function urlFor(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.href;
}

/** Builds the client. Nothing is requested until a method is called. */
export function createClient(options: ClientOptions): Client {
  const call: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  let token: string | undefined;
  let cursor = 0;
  /** The `seq` of every Message this client submitted and has not yet seen come back. */
  const submitted = new Set<number>();

  async function request(
    method: string,
    path: string,
    query: Readonly<Record<string, string>>,
    body?: unknown,
  ): Promise<unknown> {
    const url = urlFor(options.baseUrl, path, query);
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (options.signal !== undefined) init.signal = options.signal;

    // The body is read inside the same guard as the request. A connection that broke while the
    // answer was arriving is the same "no answer" as one that was refused, and is retried the
    // same way.
    let status: number;
    let said: string;
    try {
      const response = await call(url, init);
      status = response.status;
      said = await response.text();
    } catch (cause) {
      throw new UnreachableError(url, cause);
    }

    if (status < 200 || status >= 300) throw new RefusedError(method, url, status, refusalIn(said));
    if (said === "") return undefined;
    try {
      return JSON.parse(said);
    } catch {
      throw new MalformedResponseError(`${method} ${url}`, "the body is not JSON");
    }
  }

  /** Moves the cursor onto the last record of an ascending page. */
  function advance(page: readonly MessageRecord[]): void {
    const last = page.at(-1);
    if (last !== undefined && last.seq > cursor) cursor = last.seq;
  }

  return {
    async logIn(credentials) {
      const issued = asIssuedToken(
        await request(
          "POST",
          "auth/tokens",
          {},
          { user: credentials.user, password: credentials.password },
        ),
      );
      token = issued.token;
      return issued;
    },

    async open() {
      // No cursor at all, which is how the routes spell "the newest page". The client opens on
      // what a reader would have scrolled back to anyway.
      const page = asMessageList(await request("GET", "messages", {}));
      advance(page);
      return page;
    },

    async poll() {
      const page = asMessageList(
        await request("GET", "messages", { after: String(cursor), limit: String(pollLimit) }),
      );
      advance(page);
      // A full page means there are more, and the next poll one second later reads them: this
      // client is a conversation and not a bulk reader, so it does not loop here.
      return page.filter((record) => !submitted.delete(record.seq));
    },

    async say(text) {
      const record = asMessageRecord(
        await request("POST", "messages", {}, { text }),
        "POST /messages",
      );
      submitted.add(record.seq);
      return record;
    },
  };
}

/** The `message` of a refusal in Fastify's own error shape, or the body when it is not one. */
function refusalIn(said: string): string {
  try {
    const body: unknown = JSON.parse(said);
    if (typeof body === "object" && body !== null && "message" in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Not JSON, so the body itself is the whole of what the Gateway said.
  }
  return said === "" ? "with no body" : said;
}

function fieldsOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new MalformedResponseError(what, "the body is not an object");
  }
  return value as Record<string, unknown>;
}

function stringAt(fields: Record<string, unknown>, name: string, what: string): string {
  const value = fields[name];
  if (typeof value !== "string") throw new MalformedResponseError(what, `no ${name} in it`);
  return value;
}

function asMessageRecord(value: unknown, what: string): MessageRecord {
  const fields = fieldsOf(value, what);
  const seq = fields.seq;
  if (typeof seq !== "number") throw new MalformedResponseError(what, "no seq in it");
  const direction = fields.direction;
  if (direction !== "inbound" && direction !== "outbound") {
    throw new MalformedResponseError(what, `${String(direction)} is not a direction`);
  }
  // The return type is what checks the two literals against the framework's own union, so a
  // direction renamed there fails here rather than dropping every Message of that kind silently.
  return {
    id: stringAt(fields, "id", what),
    userId: stringAt(fields, "userId", what),
    direction,
    seq,
    text: stringAt(fields, "text", what),
    createdAt: stringAt(fields, "createdAt", what),
  };
}

function asMessageList(value: unknown): readonly MessageRecord[] {
  const what = "GET /messages";
  const messages = fieldsOf(value, what).messages;
  if (!Array.isArray(messages)) throw new MalformedResponseError(what, "no messages array in it");
  return messages.map((message) => asMessageRecord(message, what));
}

function asIssuedToken(value: unknown): IssuedToken {
  const what = "POST /auth/tokens";
  const fields = fieldsOf(value, what);
  const embedded = fieldsOf(fields.user, what);
  const user: UserRecord = {
    id: stringAt(embedded, "id", what),
    attributes: embedded.attributes,
    createdAt: stringAt(embedded, "createdAt", what),
  };
  return {
    token: stringAt(fields, "token", what),
    expiresAt: stringAt(fields, "expiresAt", what),
    user,
  };
}
