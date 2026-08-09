/**
 * The Prompt template Handler.
 *
 * Most of this needs no database: a Handler is a function of a Signal and whatever
 * its factory was given (ADR-0024), so the rendering criteria are unit tests over
 * string literals. The last two are not. "Fails that Signal with a
 * reason" is a claim about the Signal log, and "does not stop the worker" is a claim
 * about what happens to the *next* Signal, so those run through a real Signal Worker against
 * real PostgreSQL.
 *
 * The escaping assertions are byte-for-byte on purpose. `noEscape: true` looks like
 * a mistake to anyone who knows Handlebars from web work, and the damage from
 * "fixing" it — prompts with `&#x27;` where an apostrophe should be — is invisible
 * in every log and every Run outcome (ADR-0027).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import Handlebars from "handlebars";
import type { Db } from "../db/index.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeRuntime, fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import type { Prompt, Signal, SignalHandler, SignalHandlers } from "./handlers.ts";
import * as signalsSchema from "./schema.ts";
import { signals } from "./schema.ts";
import { templateHandler } from "./template-handler.ts";

/**
 * Every character Handlebars escapes by default, in text a User could plausibly
 * write. If any of them comes back transformed, the Prompt reaching the agent is
 * not what the Operator's data function said (ADR-0003).
 */
const everythingHandlebarsWouldEscape = `it's <b>&</b> \`tick\` "quoted" =equals`;

/** The kind every Signal below carries, and the one a failure message is expected to name. */
const signalKind = "test.signal";

/** The Signal a Handler is handed. Only the payload differs between these tests. */
function aSignal<TPayload>(payload: TPayload): Signal<TPayload> {
  return {
    id: "6f1a3c7e-0000-4000-8000-000000000001",
    kind: signalKind,
    payload,
    emittedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

/**
 * The single Prompt this Handler always produces. Asserting the count here rather
 * than in every test is what makes "one Signal, one Prompt" a property of the
 * Handler instead of an assumption each test repeats.
 */
async function onlyPrompt<TPayload>(
  handler: SignalHandler<TPayload>,
  payload: TPayload,
): Promise<Prompt> {
  const prompts = await handler.handle(aSignal(payload));
  assert.equal(prompts.length, 1, "the template Handler produces exactly one Prompt");
  const [prompt] = prompts;
  assert.ok(prompt !== undefined);
  return prompt;
}

/**
 * A Handler over `source`, routed to a fresh Session and given `data`.
 *
 * The Session name and the payload are each the subject of a test of their own and
 * noise in every other, so they are filled in here.
 */
function handlerOver(source: string, data: unknown = {}): SignalHandler<null> {
  return templateHandler<null>({ template: source, session: () => null, data: () => data });
}

/** What `source` renders to, given `data`. */
async function renders(source: string, data: unknown): Promise<string> {
  return (await onlyPrompt(handlerOver(source, data), null)).text;
}

/**
 * Asserts the Handler rejects, with a message that names the Signal's kind and says
 * what went wrong.
 *
 * Naming the kind is the load-bearing half: Handlebars reports the variable and its
 * line and column but never which template it was rendering, and a deployment with
 * several Handlers has no way to tell which one failed from that alone.
 */
async function rejectsNaming(handler: SignalHandler<null>, reason: RegExp): Promise<void> {
  await assert.rejects(
    () => Promise.resolve(handler.handle(aSignal(null))),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(signalKind),
        `the reason should name the Signal kind; it was: ${error.message}`,
      );
      assert.match(error.message, reason);
      return true;
    },
  );
}

describe("the template Handler", () => {
  it("renders a Signal through the template into a Prompt for the Session it chose", async () => {
    const handler = templateHandler<{ readonly userId: string; readonly name: string }>({
      template: "Hello {{name}}. You asked about {{topic}}.\n",
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => ({ name: signal.payload.name, topic: "the weather" }),
    });

    assert.deepEqual(await onlyPrompt(handler, { userId: "42", name: "Bob" }), {
      session: "user_42",
      text: "Hello Bob. You asked about the weather.\n",
    });
  });

  it("routes to a fresh Session when the naming function returns null", async () => {
    const handler = templateHandler<null>({
      template: "one-off",
      session: () => null,
      data: () => ({}),
    });

    assert.deepEqual(await onlyPrompt(handler, null), { session: null, text: "one-off" });
  });

  it("takes an asynchronous Session name and asynchronous data", async () => {
    const handler = templateHandler<null>({
      template: "{{greeting}} from {{where}}",
      session: async () => "looked_up",
      data: async () => ({ greeting: "hi", where: "a query" }),
    });

    assert.deepEqual(await onlyPrompt(handler, null), {
      session: "looked_up",
      text: "hi from a query",
    });
  });
});

describe("a substituted value", () => {
  it("reaches the Prompt byte for byte, escaping nothing", async () => {
    const text = await renders("{{value}}", { value: everythingHandlebarsWouldEscape });

    assert.equal(text, everythingHandlebarsWouldEscape);
    // Spelled out as well as compared, so a failure says which escape crept back in
    // rather than only that two long strings differ.
    for (const character of ["'", "&", "<", ">", "`", '"', "="]) {
      assert.ok(text.includes(character), `${character} should reach the Prompt unchanged`);
    }
    assert.ok(!text.includes("&#"), "no numeric HTML entity should appear in a Prompt");
    assert.ok(!text.includes("&amp;"), "no named HTML entity should appear in a Prompt");
  });

  it("renders identically through {{x}} and {{{x}}}", async () => {
    const text = await renders("[{{value}}] [{{{value}}}]", {
      value: everythingHandlebarsWouldEscape,
    });

    assert.equal(text, `[${everythingHandlebarsWouldEscape}] [${everythingHandlebarsWouldEscape}]`);
  });

  it("is unescaped inside a partial too", async () => {
    const handler = templateHandler<null>({
      template: "{{> quoted}}",
      session: () => null,
      data: () => ({ value: everythingHandlebarsWouldEscape }),
      partials: { quoted: "<<{{value}}>>" },
    });

    assert.equal((await onlyPrompt(handler, null)).text, `<<${everythingHandlebarsWouldEscape}>>`);
  });

  it("is unescaped when a helper produced it", async () => {
    const handler = templateHandler<null>({
      template: "{{shout value}}",
      session: () => null,
      data: () => ({ value: "it's & it's" }),
      helpers: { shout: (value: string) => value.toUpperCase() },
    });

    assert.equal((await onlyPrompt(handler, null)).text, "IT'S & IT'S");
  });
});

/**
 * A template that does not compile fails one call, and a template that does not render
 * fails another. The split is the whole point of compiling at construction: the first
 * kind never reaches a Signal, and under ADR-0017 a Signal it did reach would stay
 * failed forever.
 *
 * Both cases here are the reason `templateHandler` calls `precompile` and discards it.
 * Handlebars' own `compile` defers the parse *and* the code generation to the first
 * render, so with either one left to it the case below reaches `handle` instead.
 */
describe("a template that does not compile", () => {
  it("throws from the call that builds the Handler when it does not parse", () => {
    assert.throws(
      () => handlerOver("{{#if always}}never closed", { always: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // Handlebars' own words, kept rather than wrapped: they name the line and the
        // column, and there is no Signal here to name instead.
        assert.match(error.message, /Parse error on line 1/);
        return true;
      },
    );
  });

  // Parses and then fails the code generator, which is the half a parse check alone
  // would miss and leave failing a Signal.
  it("throws from the same call when it parses and the code generator refuses it", () => {
    assert.throws(
      () => handlerOver("{{> quoted one two}}"),
      /Unsupported number of partial arguments/,
    );
  });
});

describe("a template that cannot produce a Prompt", () => {
  it("throws when the data function did not supply a variable the template reads", async () => {
    const handler = handlerOver("Hello {{name}}, about {{topic}}.", { name: "Bob" });

    await rejectsNaming(handler, /"topic" not defined/);
  });

  it("throws when a nested field the template reads is absent", async () => {
    const handler = handlerOver("{{user.name}}", { user: {} });

    await rejectsNaming(handler, /"name" not defined/);
  });

  it("throws when a variable is referenced inside a partial and not supplied", async () => {
    const handler = templateHandler<null>({
      template: "{{> quoted}}",
      session: () => null,
      data: () => ({}),
      partials: { quoted: "<<{{value}}>>" },
    });

    // `strict` reaches inside partials, which is the other half of what compiling
    // them here rather than accepting pre-compiled ones buys.
    await rejectsNaming(handler, /"value" not defined/);
  });

  it("carries the underlying error as the cause, so a log line keeps it", async () => {
    const handler = handlerOver("{{missing}}");

    await assert.rejects(
      () => Promise.resolve(handler.handle(aSignal(null))),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.cause instanceof Error, "the Handlebars error should survive as the cause");
        return true;
      },
    );
  });
});

/**
 * The side effect of `strict` that an Operator will meet while writing a template,
 * and the one place it costs them something.
 *
 * Handlebars documents that strict mode disables inverse operations, so
 * `{{^absent}}` throws where every other way of asking "was this supplied?" renders.
 * Pinned in both directions: without the first assertion the failure is discovered
 * by a Signal that fails permanently (ADR-0017), and without the rest a later reader
 * could conclude `strict` makes presence tests impossible and drop it.
 */
describe("strict mode's reach", () => {
  it("throws on an inverse section over a value that was not supplied", async () => {
    const handler = handlerOver("{{^absent}}nothing here{{/absent}}");

    await rejectsNaming(handler, /"absent" not defined/);
  });

  it("still renders every block form that asks whether a value is there", async () => {
    for (const source of [
      "{{#if absent}}X{{/if}}",
      "{{#each absent}}X{{/each}}",
      "{{#with absent}}X{{/with}}",
    ]) {
      assert.equal(await renders(source, {}), "", `${source} should render nothing`);
    }
    assert.equal(await renders("{{#unless absent}}Z{{/unless}}", {}), "Z");
    assert.equal(await renders("{{#if absent}}X{{else}}E{{/if}}", {}), "E");
  });
});

describe("a Handler's Handlebars environment", () => {
  it("keeps its helpers and partials invisible to another Handler in the same process", async () => {
    const shared = "{{shout name}} {{> signature}}";
    const withOwn = templateHandler<null>({
      template: shared,
      session: () => null,
      data: () => ({ name: "Bob" }),
      helpers: { shout: (value: string) => String(value).toUpperCase() },
      partials: { signature: "-- the Gateway" },
    });
    const withNone = templateHandler<null>({
      template: shared,
      session: () => null,
      data: () => ({ name: "Bob" }),
    });

    assert.equal((await onlyPrompt(withOwn, null)).text, "BOB -- the Gateway");
    await assert.rejects(
      () => Promise.resolve(withNone.handle(aSignal(null))),
      /"shout" not defined/,
    );
  });

  // Its own test rather than part of the one above, because that one rejects on the
  // helper and never reaches the partial: helpers and partials are two registries and
  // the first assertion says nothing about the second.
  it("does not register a partial another Handler can resolve", async () => {
    const template = "{{> signature}}";
    templateHandler<null>({
      template,
      session: () => null,
      data: () => ({}),
      partials: { signature: "-- the Gateway" },
    });
    const withNone = templateHandler<null>({
      template,
      session: () => null,
      data: () => ({}),
    });

    await assert.rejects(
      () => Promise.resolve(withNone.handle(aSignal(null))),
      /partial signature could not be found/,
    );
  });

  it("leaves the shared Handlebars instance the Operator may also use untouched", () => {
    templateHandler<null>({
      template: "{{shout name}}",
      session: () => null,
      data: () => ({ name: "Bob" }),
      helpers: { shout: (value: string) => String(value).toUpperCase() },
      partials: { signature: "-- the Gateway" },
    });

    assert.equal("shout" in Handlebars.helpers, false, "no helper should reach the default export");
    assert.equal(
      "signature" in Handlebars.partials,
      false,
      "no partial should reach the default export",
    );
  });
});

/**
 * The two criteria that are about the Signal log rather than the Handler.
 *
 * PostgreSQL is real and the Runtime is the only fake (ADR-0022). "Does not stop the
 * worker" is a claim about what happens to the *next* Signal, so the worker here is
 * started once and never restarted.
 */
describe("the template Handler under the worker", () => {
  let database: TestDatabase;
  let db: Db;

  before(async () => {
    database = await createTestDatabase("template_handler");
    db = database.db;
    await applySchema(db, signalsSchema);
  });

  after(() => database.drop());

  /** Fast enough that nothing here waits on a sweep it does not care about. */
  const sweepIntervalMs = 5;

  async function stateOf(signalId: string): Promise<{ state: string; error: string | null }> {
    const [row] = await db
      .handle({ signals })
      .select({ state: signals.state, error: signals.error })
      .from(signals)
      .where(eq(signals.id, signalId));
    assert.ok(row !== undefined, `Signal ${signalId} should exist`);
    return row;
  }

  async function settled(signalId: string): Promise<{ state: string; error: string | null }> {
    await waitUntil(`Signal ${signalId} has settled`, async () => {
      const { state } = await stateOf(signalId);
      return state === "done" || state === "failed";
    });
    return stateOf(signalId);
  }

  async function emit(worker: SignalWorker, kind: string): Promise<string> {
    return db.tx((tx) => worker.emit(tx, { kind, payload: {} }));
  }

  async function withWorker(
    handlers: SignalHandlers,
    body: (worker: SignalWorker, runtime: FakeRuntime) => Promise<void>,
  ): Promise<void> {
    const runtime = fakeRuntime();
    const worker = createSignalWorker({ db, runtime, handlers, sweepIntervalMs });
    await worker.start();
    try {
      await body(worker, runtime);
    } finally {
      await worker.stop();
    }
  }

  it("hands the rendered Prompt to the Runtime", async () => {
    const handler = templateHandler<unknown>({
      template: "the wording",
      session: () => "user_42",
      data: () => ({}),
    });

    await withWorker({ "prompt.render": handler }, async (worker, runtime) => {
      const signalId = await emit(worker, "prompt.render");
      assert.deepEqual(await settled(signalId), { state: "done", error: null });

      assert.deepEqual(runtime.recorded, [{ session: "user_42", text: "the wording" }]);
    });
  });

  /**
   * Both ways a template can still fail once it has parsed, through the worker rather
   * than as a throw: the criteria are about what the Signal log ends up saying, and two
   * Handlers fail here so a reason naming the wrong kind is caught. A third way, a
   * template that does not parse, cannot be reached from here any more, because no
   * Handler over one can be built.
   */
  it("fails only its own Signal, with a reason naming its own kind, and keeps working", async () => {
    const of = (template: string): SignalHandler =>
      templateHandler({ template, session: () => null, data: () => ({}) });
    const handlers: SignalHandlers = {
      "prompt.good": of("a Prompt that renders"),
      "prompt.unsupplied": of("Hello {{whoever}}"),
      "prompt.no-partial": of("{{> nowhere}}"),
    };

    await withWorker(handlers, async (worker, runtime) => {
      const broken = {
        "prompt.unsupplied": await emit(worker, "prompt.unsupplied"),
        "prompt.no-partial": await emit(worker, "prompt.no-partial"),
      };
      // Emitted last, so reaching `done` means the worker survived both.
      const after = await emit(worker, "prompt.good");

      for (const [failedKind, signalId] of Object.entries(broken)) {
        const outcome = await settled(signalId);
        assert.equal(outcome.state, "failed", `${failedKind} should have failed its Signal`);
        assert.ok(
          outcome.error?.includes(failedKind),
          `the Signal's reason should name ${failedKind}; it was: ${outcome.error}`,
        );
      }

      assert.deepEqual(await settled(after), { state: "done", error: null });
      // No Run was ever started for a Signal whose Prompt could not be produced.
      assert.deepEqual(
        runtime.recorded.map((prompt) => prompt.text),
        ["a Prompt that renders"],
      );
    });
  });
});
