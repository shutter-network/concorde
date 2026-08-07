/**
 * The fake Relay, driven by the real client library, which is the only way to find out
 * whether it is a Relay.
 *
 * The subject of every assertion here is what a client can observe — an event served,
 * an end-of-stored-events, a publish accepted or refused, a subscription that succeeds
 * after authenticating — because that is all a Channel written against this will be
 * able to observe either.
 *
 * No Docker and no network: a WebSocket server on the loopback interface, and both ends
 * in this process. Every test closes its client before it stops its Relay, so nothing is
 * left retrying a socket that has gone; the suite exiting on its own is what proves it.
 */

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

        // Everything stored arrives ahead of the end-of-stored-events, or the end
        // means nothing.
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
          // The challenge arrived unprompted: nothing had been asked for when the
          // client answered it. That is the whole difference between the two timings,
          // and it is only visible from a client that waits.
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

        // Refused, authenticated, asked again — the same retry the other timing forces,
        // reached here by asking before the challenge had been answered.
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

          // The client asked before it was challenged, was refused, authenticated, and
          // asked again. That order is the whole point of this timing: a client that
          // waited for a challenge before subscribing would still be waiting.
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

        // The newest two, which is the order NIP-01 has a Relay apply a cap in — and
        // the reason a client that wants the rest has to page backwards for them.
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
          // Asked through the client rather than with a `fetch` of our own, because the
          // client is what derives the HTTP address from the WebSocket one — and a
          // document served somewhere that derivation does not reach would be a fixture
          // nothing could read.
          const information = await client.getRelayInfo();
          assert.equal(information?.limitation?.max_message_length, 4096);
        });
      },
    );
  });

  it("advertises nothing when it was given no document, which is not an error", async () => {
    await withRelay({}, async (relay) => {
      await withClient(relay, async (client) => {
        // A Relay that publishes no NIP-11 document is an ordinary Relay, so the answer
        // is `undefined` and not a rejection — which is what lets a Channel treat it as
        // "this Relay states no limits" rather than as a failure.
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

        // The whole store again, not only what was missed, so the wait is for all of
        // it: stopping at the first replayed event would race the rest of them.
        await waitUntil(
          "the client re-subscribes and is served the whole store again",
          async () => subscription.events.length === 3,
        );

        // The re-sent REQ is the one it first sent, unchanged: the client adds no
        // window of its own, so what it was down for is what it gets back.
        const requests = relay.received.filter((message) => message.verb === "REQ");
        assert.equal(requests.length, 2);
        assert.equal(requests[0]?.connection, 1);
        assert.equal(requests[1]?.connection, 2);
        assert.deepEqual(requests[1]?.filters, requests[0]?.filters);

        // What it holds survives the restart, and the replay is newest first, so the
        // event held while it was down leads and the one it already had follows it.
        // That repeat is what the Channel's own deduplication is for.
        assert.deepEqual(
          subscription.events.map((event) => event.content),
          ["held all along", "held while the Relay was down", "held all along"],
        );

        subscription.close();
      });
    });
  });
});

/** A signed note, with a stated `created_at` so that "newest" is decided and not raced. */
function note(content: string, createdAt: number): NostrEvent {
  return finalizeEvent({ kind: 1, content, tags: [], created_at: createdAt }, generateSecretKey());
}

/** A started Relay, stopped whether the body passed or threw. */
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

/**
 * A real client pointed at it, closed whether the body passed or threw — before the
 * Relay stops, so nothing is left retrying a socket that has gone.
 *
 * The backoff is a fixed 25ms rather than the library's own second-long exponential
 * one, so the reconnect test is a test and not a pause. It is written out structurally
 * because the type belongs to a transitive dependency this package does not declare.
 */
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

/** A subscription driven in the background, collecting what the Relay serves it. */
type Subscription = {
  /** Every event served, in arrival order. */
  readonly events: readonly NostrEvent[];
  /** Resolves when the Relay says it has served everything it holds. */
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
    } catch {
      // Closing the subscription aborts the iterator, which is how it ends.
    }
  })();

  return { events, reachedEnd, close: () => stop.abort() };
}
