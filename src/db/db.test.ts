import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { applySchema } from "../test-support/apply-schema.ts";
import { cutListeningBackends, listeningBackends } from "../test-support/backends.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { alpha, widgets } from "../test-support/fixtures.ts";
import { waitUntil } from "../test-support/wait.ts";
import type { ChannelListener, Db, Handle } from "./index.ts";
import { openDb } from "./index.ts";

let database: TestDatabase;
let db: Db;

before(async () => {
  database = await createTestDatabase("db");
  db = database.db;
  await applySchema(db, { alpha, widgets });
});

after(() => database.drop());

async function record<TSchema extends Record<string, unknown>>(
  tx: Handle<TSchema>,
  label: string,
): Promise<void> {
  await tx.insert(widgets).values({ label });
}

async function labels(): Promise<string[]> {
  const rows = await db.handle({ widgets }).select({ label: widgets.label }).from(widgets);
  return rows.map((row) => row.label).sort();
}

describe("db.start", () => {
  it("opens the pool, so a database nothing answers on fails at start", async () => {
    const unreachable = openDb("postgres://concorde:concorde@127.0.0.1:1/none");
    try {
      await assert.rejects(() => unreachable.start(), /ECONNREFUSED/);
    } finally {
      await unreachable.stop();
    }
  });
});

describe("db.handle", () => {
  it("returns a handle scoped to the schema it was given", async () => {
    const alpha = db.handle({ widgets });
    await alpha.insert(widgets).values({ label: "handle-typed" });

    const found = await alpha.query.widgets.findMany({
      where: (w, { eq }) => eq(w.label, "handle-typed"),
    });
    assert.deepEqual(
      found.map((row) => row.label),
      ["handle-typed"],
    );
  });
});

describe("db.tx", () => {
  it("commits when the callback returns, and returns its value", async () => {
    const returned = await db.tx(async (tx) => {
      await record(tx, "committed");
      return "value";
    });

    assert.equal(returned, "value");
    assert.ok((await labels()).includes("committed"));
  });

  it("rolls back when the callback throws, and rethrows", async () => {
    await assert.rejects(
      () =>
        db.tx(async (tx) => {
          await record(tx, "rolled-back");
          throw new Error("deliberate");
        }),
      /deliberate/,
    );

    assert.ok(!(await labels()).includes("rolled-back"));
  });

  it("makes a function taking a handle or a transaction join the caller's transaction", async () => {
    await record(db.handle({ widgets }), "via-handle");
    assert.ok((await labels()).includes("via-handle"));

    await assert.rejects(
      () =>
        db.tx(async (tx) => {
          await record(tx, "via-transaction");
          const inside = await tx.select({ label: widgets.label }).from(widgets);
          assert.ok(inside.some((row) => row.label === "via-transaction"));
          throw new Error("abandon");
        }),
      /abandon/,
    );

    assert.ok(!(await labels()).includes("via-transaction"));
  });
});

describe("db.listen", () => {
  function recording(): {
    readonly payloads: string[];
    readonly losses: unknown[];
    connections(): number;
    readonly listener: ChannelListener;
  } {
    const payloads: string[] = [];
    const losses: unknown[] = [];
    let connections = 0;
    return {
      payloads,
      losses,
      connections: () => connections,
      listener: {
        notified: (payload) => {
          payloads.push(payload);
        },
        connected: () => {
          connections += 1;
        },
        lost: (error) => {
          losses.push(error);
        },
      },
    };
  }

  function notify(channel: string, payload: string, on: Handle = db.handle({})): Promise<unknown> {
    return on.execute(sql`select pg_notify(${channel}, ${payload})`);
  }

  async function connected(reported: () => number, atLeast = 1): Promise<void> {
    await waitUntil(`the listening connection is up (${atLeast})`, async () => {
      return reported() >= atLeast;
    });
  }

  it("delivers what was notified on its channel, with its payload", async () => {
    const recorded = recording();
    const listening = db.listen("first_channel", recorded.listener);
    try {
      await connected(recorded.connections);

      await notify("other_channel", "not for us");
      await notify("first_channel", "for us");
      await waitUntil("the notification arrives", async () => recorded.payloads.length > 0);

      assert.deepEqual(recorded.payloads, ["for us"]);
      assert.deepEqual(recorded.losses, []);
    } finally {
      await listening.close();
    }
  });

  it("never delivers a notification from a transaction that rolled back", async () => {
    const recorded = recording();
    const listening = db.listen("transactional", recorded.listener);
    try {
      await connected(recorded.connections);

      await assert.rejects(
        () =>
          db.tx(async (tx) => {
            await notify("transactional", "abandoned", tx);
            throw new Error("deliberate");
          }),
        /deliberate/,
      );

      await db.tx((tx) => notify("transactional", "committed", tx));
      await waitUntil("the committed notification arrives", async () => {
        return recorded.payloads.length > 0;
      });

      assert.deepEqual(recorded.payloads, ["committed"]);
    } finally {
      await listening.close();
    }
  });

  it("keeps its connection outside the pool, so a saturated pool cannot deafen it", async () => {
    const recorded = recording();
    const listening = db.listen("saturated", recorded.listener);
    const sender = openDb(database.url);
    try {
      await connected(recorded.connections);
      assert.equal(await listeningBackends(db), 1, "the listener should have a backend of its own");

      const saturating = Array.from({ length: 12 }, () =>
        db.handle({}).execute(sql`select pg_sleep(0.3)`),
      );
      await notify("saturated", "while busy", sender.handle({}));
      await waitUntil("the notification arrives while the pool is busy", async () => {
        return recorded.payloads.length > 0;
      });
      assert.deepEqual(recorded.payloads, ["while busy"]);

      await Promise.all(saturating);
    } finally {
      await sender.stop();
      await listening.close();
    }
  });

  it("reconnects when its connection is cut, and reports the loss", async () => {
    const recorded = recording();
    const listening = db.listen("cut", recorded.listener);
    try {
      await connected(recorded.connections);
      await cutListeningBackends(db);

      await connected(recorded.connections, 2);
      assert.ok(recorded.losses.length > 0, "the loss should have been reported");

      await notify("cut", "after the cut");
      await waitUntil("a notification arrives on the new connection", async () => {
        return recorded.payloads.length > 0;
      });
      assert.deepEqual(recorded.payloads, ["after the cut"]);
    } finally {
      await listening.close();
    }
  });

  it("releases its connection and stops delivering when closed", async () => {
    const recorded = recording();
    const listening = db.listen("closed", recorded.listener);
    await connected(recorded.connections);
    await listening.close();
    await listening.close();

    assert.equal(await listeningBackends(db), 0, "the connection should be gone");

    await notify("closed", "too late");
    await new Promise((resume) => setTimeout(resume, 50));
    assert.deepEqual(recorded.payloads, []);
  });

  it("closes what listening opened when the Db stops", async () => {
    const other = openDb(database.url);
    const recorded = recording();
    other.listen("orphan", recorded.listener);
    await connected(recorded.connections);
    assert.equal(await listeningBackends(db), 1);

    await other.stop();
    assert.equal(await listeningBackends(db), 0);
  });
});
