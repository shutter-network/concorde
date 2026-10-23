import type { MessageRecord } from "../messenger/messages.ts";
import type { IssuedToken } from "../password-auth/routes.ts";
import type { UserRecord } from "../users/routes.ts";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const pollLimit = 200;

export class UnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`no answer from ${url}`, { cause });
    this.name = "UnreachableError";
  }
}

export class RefusedError extends Error {
  readonly status: number;
  constructor(method: string, url: string, status: number, said: string) {
    super(`${method} ${url} answered ${status}: ${said}`);
    this.name = "RefusedError";
    this.status = status;
  }
}

export class MalformedResponseError extends Error {
  constructor(what: string, said: string) {
    super(`${what} was not answered as expected: ${said}`);
    this.name = "MalformedResponseError";
  }
}

export type ClientOptions = {
  readonly baseUrl: string;
  readonly signal?: AbortSignal;
  readonly fetch?: Fetch;
};

export type Client = {
  logIn(credentials: { readonly user: string; readonly password: string }): Promise<IssuedToken>;
  open(): Promise<readonly MessageRecord[]>;
  poll(): Promise<readonly MessageRecord[]>;
  say(text: string): Promise<MessageRecord>;
};

export function urlFor(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.href;
}

export function createClient(options: ClientOptions): Client {
  const call: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  let token: string | undefined;
  let cursor = 0;
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
      const page = asMessageList(await request("GET", "messages", {}));
      advance(page);
      return page;
    },

    async poll() {
      const page = asMessageList(
        await request("GET", "messages", { after: String(cursor), limit: String(pollLimit) }),
      );
      advance(page);
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

function refusalIn(said: string): string {
  try {
    const body: unknown = JSON.parse(said);
    if (typeof body === "object" && body !== null && "message" in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {}
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
