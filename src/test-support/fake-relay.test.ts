import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NRelay1 } from "@nostrify/nostrify";
import type { NostrEvent, NostrFilter } from "@nostrify/types";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { type FakeRelay, type FakeRelayOptions, startFakeRelay } from "./fake-relay.ts";
import { waitUntil } from "./wait.ts";

describe("the fake Relay", () => {
  it("serves what it holds, says it has run out, and streams what arrives after", async () => {
    await withRelay({}, async (relay) => {
      relay.hold(note("held before anyone connected", 100), note("held before too", 101));

      await withClient(relay, async (client) => {
        const subscription = subscribe(client, [{ kinds: [1] }]);
        await subscription.reachedEnd;

        assert.deepEqual([...subscription.events].map((event) => event.content).sort(), [
          "held before anyone connected",
          "held before too",
        ]);

        relay.hold(note("arrived while subscribed", 102));
        await waitUntil("the live event arrives", async () => subscription.events.length === 3);
        assert.equal(subscription.events[2]?.content, "arrived while subscribed");

        subscription.close();
      });
    });
  });

  it("accepts a publish and reports success", async () => {
    await withRelay({}, async (relay) => {
      await withClient(relay, async (client) => {
        const published = note("something to say", 100);
        await client.event(published);
        assert.deepEqual(
          relay.published.map((event) => event.id),
          [published.id],
        );
      });
    });
  });

  it("refuses a publish with the machine-readable reason it was told to give", async () => {
    const refused = note("something unwelcome", 100);
    await withRelay({ refuse: () => "blocked: this Relay does not take those" }, async (relay) => {
      await withClient(relay, async (client) => {
        await assert.rejects(
          () => client.event(refused),
          /blocked: this Relay does not take those/,
        );
        assert.deepEqual(relay.published, []);
      });
    });
  });

  it("challenges on connect, so a client that waits for one is served on its first ask", async () => {
    const secret = generateSecretKey();
    await withRelay({ auth: "on-connect" }, async (relay) => {
      relay.hold(note("only for authenticated readers", 100));

      await withClient(
        relay,
        async (client) => {
          await waitUntil("the Relay challenges unprompted", async () =>
            relay.received.some((message) => message.verb === "AUTH"),
          );
          assert.deepEqual(
            relay.received.map((message) => message.verb),
            ["AUTH"],
          );
          assert.equal(relay.received[0]?.event?.pubkey, getPublicKey(secret));

          const subscription = subscribe(client, [{ kinds: [1] }]);
          await subscription.reachedEnd;
          assert.equal(subscription.events[0]?.content, "only for authenticated readers");
          assert.deepEqual(
            relay.received.map((message) => message.verb),
            ["AUTH", "REQ"],
          );

          subscription.close();
        },
        secret,
      );
    });
  });

  it("serves a client that subscribed before it answered the challenge, on the retry", async () => {
    await withRelay({ auth: "on-connect" }, async (relay) => {
      relay.hold(note("only for authenticated readers", 100));

      await withClient(relay, async (client) => {
        const subscription = subscribe(client, [{ kinds: [1] }]);
        await subscription.reachedEnd;
        assert.equal(subscription.events[0]?.content, "only for authenticated readers");

        assert.deepEqual(
          relay.received.map((message) => message.verb),
          ["REQ", "AUTH", "REQ"],
        );

        subscription.close();
      });
    });
  });

  it("challenges only when a client asks for something restricted, and the retry succeeds", async () => {
    const secret = generateSecretKey();
    await withRelay({ auth: "on-demand" }, async (relay) => {
      relay.hold(note("only for authenticated readers", 100));

      await withClient(
        relay,
        async (client) => {
          const subscription = subscribe(client, [{ kinds: [1] }]);
          await subscription.reachedEnd;
          assert.equal(subscription.events[0]?.content, "only for authenticated readers");

          assert.deepEqual(
            relay.received.map((message) => message.verb),
            ["REQ", "AUTH", "REQ"],
          );
          assert.equal(
            relay.received.find((message) => message.verb === "AUTH")?.event?.pubkey,
            getPublicKey(secret),
          );

          subscription.close();
        },
        secret,
      );
    });
  });

  it("refuses a publish until the client authenticates, and takes it on the retry", async () => {
    const secret = generateSecretKey();
    const published = note("written by an authenticated client", 100);
    await withRelay({ auth: "on-demand" }, async (relay) => {
      await withClient(
        relay,
        async (client) => {
          await client.event(published);
          assert.deepEqual(
            relay.published.map((event) => event.id),
            [published.id],
          );
          assert.deepEqual(
            relay.received.map((message) => message.verb),
            ["EVENT", "AUTH", "EVENT"],
          );
        },
        secret,
      );
    });
  });

  it("serves fewer stored events than it holds when told to", async () => {
    await withRelay({ maxLimit: 2 }, async (relay) => {
      relay.hold(note("oldest", 100), note("middle", 101), note("newest", 102));

      await withClient(relay, async (client) => {
        const subscription = subscribe(client, [{ kinds: [1] }]);
        await subscription.reachedEnd;

        assert.deepEqual(
          subscription.events.map((event) => event.content),
          ["newest", "middle"],
        );

        subscription.close();
      });
    });
  });

  it("serves the NIP-11 document it was given, on the address the client was built with", async () => {
    await withRelay(
      { information: { limitation: { max_message_length: 4096 } } },
      async (relay) => {
        await withClient(relay, async (client) => {
          const information = await client.getRelayInfo();
          assert.equal(information?.limitation?.max_message_length, 4096);
        });
      },
    );
  });

  it("advertises nothing when it was given no document, which is not an error", async () => {
    await withRelay({}, async (relay) => {
      await withClient(relay, async (client) => {
        assert.equal(await client.getRelayInfo(), undefined);
      });
    });
  });

  it("can be stopped and restarted, and the client re-sends the subscription it had", async () => {
    await withRelay({}, async (relay) => {
      relay.hold(note("held all along", 100));

      await withClient(relay, async (client) => {
        const subscription = subscribe(client, [{ kinds: [1] }]);
        await subscription.reachedEnd;

        await relay.stop();
        relay.hold(note("held while the Relay was down", 101));
        await relay.start();

        await waitUntil(
          "the client re-subscribes and is served the whole store again",
          async () => subscription.events.length === 3,
        );

        const requests = relay.received.filter((message) => message.verb === "REQ");
        assert.equal(requests.length, 2);
        assert.equal(requests[0]?.connection, 1);
        assert.equal(requests[1]?.connection, 2);
        assert.deepEqual(requests[1]?.filters, requests[0]?.filters);

        assert.deepEqual(
          subscription.events.map((event) => event.content),
          ["held all along", "held while the Relay was down", "held all along"],
        );

        subscription.close();
      });
    });
  });
});

function note(content: string, createdAt: number): NostrEvent {
  return finalizeEvent({ kind: 1, content, tags: [], created_at: createdAt }, generateSecretKey());
}

async function withRelay(
  options: FakeRelayOptions,
  body: (relay: FakeRelay) => Promise<void>,
): Promise<void> {
  const relay = await startFakeRelay(options);
  try {
    await body(relay);
  } finally {
    await relay.stop();
  }
}

async function withClient(
  relay: FakeRelay,
  body: (client: NRelay1) => Promise<void>,
  secret: Uint8Array = generateSecretKey(),
): Promise<void> {
  const client = new NRelay1(relay.url, {
    backoff: { retries: 0, current: 25, next: () => 25, reset: () => {} },
    auth: async (challenge: string) =>
      finalizeEvent(
        {
          kind: 22242,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", relay.url],
            ["challenge", challenge],
          ],
        },
        secret,
      ),
  });
  try {
    await body(client);
  } finally {
    await client.close();
  }
}

type Subscription = {
  readonly events: readonly NostrEvent[];
  readonly reachedEnd: Promise<void>;
  close(): void;
};

function subscribe(client: NRelay1, filters: NostrFilter[]): Subscription {
  const events: NostrEvent[] = [];
  const stop = new AbortController();
  let served = (): void => {};
  const reachedEnd = new Promise<void>((resolve) => {
    served = resolve;
  });

  void (async () => {
    try {
      for await (const message of client.req(filters, { signal: stop.signal })) {
        if (message[0] === "EVENT") events.push(message[2]);
        if (message[0] === "EOSE") served();
      }
    } catch {}
  })();

  return { events, reachedEnd, close: () => stop.abort() };
}
