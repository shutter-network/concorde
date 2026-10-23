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
import type { PostOutcome, Prompt, Signal, SignalHandler, SignalHandlers } from "./handlers.ts";
import * as signalsSchema from "./schema/index.ts";
import { signals } from "./schema/index.ts";
import { templateHandler } from "./template-handler.ts";

const everythingHandlebarsWouldEscape = `it's <b>&</b> \`tick\` "quoted" =equals`;

const signalKind = "test.signal";

function aSignal<TPayload>(payload: TPayload): Signal<TPayload> {
  return {
    id: "6f1a3c7e-0000-4000-8000-000000000001",
    kind: signalKind,
    payload,
    emittedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

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

function handlerOver(source: string, data: unknown = {}): SignalHandler<null> {
  return templateHandler<null>({ template: source, session: () => null, data: () => data });
}

async function renders(source: string, data: unknown): Promise<string> {
  return (await onlyPrompt(handlerOver(source, data), null)).text;
}

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

  it("writes what the context function answers onto the Prompt, awaited if it has to be", async () => {
    const synchronous = templateHandler<{ readonly userId: string }>({
      template: "for {{who}}",
      session: () => null,
      data: (signal) => ({ who: signal.payload.userId }),
      context: (signal) => ({ user: signal.payload.userId }),
    });
    const asynchronous = templateHandler<{ readonly userId: string }>({
      template: "for {{who}}",
      session: () => null,
      data: (signal) => ({ who: signal.payload.userId }),
      context: async (signal) => ({ user: signal.payload.userId, looked: "up" }),
    });

    assert.deepEqual(await onlyPrompt(synchronous, { userId: "42" }), {
      session: null,
      text: "for 42",
      context: { user: "42" },
    });
    assert.deepEqual(await onlyPrompt(asynchronous, { userId: "42" }), {
      session: null,
      text: "for 42",
      context: { user: "42", looked: "up" },
    });
  });
});

describe("a substituted value", () => {
  it("reaches the Prompt byte for byte, escaping nothing", async () => {
    const text = await renders("{{value}}", { value: everythingHandlebarsWouldEscape });

    assert.equal(text, everythingHandlebarsWouldEscape);
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

describe("a template that does not compile", () => {
  it("throws from the call that builds the Handler when it does not parse", () => {
    assert.throws(
      () => handlerOver("{{#if always}}never closed", { always: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Parse error on line 1/);
        return true;
      },
    );
  });

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

describe("the template Handler's post phase", () => {
  it("is absent from a Handler built without one", () => {
    const handler = handlerOver("a Prompt that renders");

    assert.equal("post" in handler, false, "no post phase should be carried");
    assert.equal(handler.post, undefined);
  });

  it("is the Operator's own function, carried across unwrapped", async () => {
    const seen: { signal: Signal<{ readonly userId: string }>; outcome: PostOutcome }[] = [];
    const post = (signal: Signal<{ readonly userId: string }>, outcome: PostOutcome): void => {
      seen.push({ signal, outcome });
    };
    const handler = templateHandler<{ readonly userId: string }>({
      template: "a Prompt that renders",
      session: () => null,
      data: () => ({}),
      post,
    });

    assert.equal(handler.post, post, "the function should reach the Handler as it was written");
    const signal = aSignal({ userId: "u_1" });
    await handler.post?.(signal, { failed: true });
    assert.deepEqual(seen, [{ signal, outcome: { failed: true } }]);
  });
});

describe("the template Handler under the worker", () => {
  let database: TestDatabase;
  let db: Db;

  before(async () => {
    database = await createTestDatabase("template_handler");
    db = database.db;
    await applySchema(db, signalsSchema);
  });

  after(() => database.drop());

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
      assert.deepEqual(
        runtime.recorded.map((prompt) => prompt.text),
        ["a Prompt that renders"],
      );
    });
  });

  it("runs the post phase after the Run, and again when no Run was ever created", async () => {
    const outcomes: Record<string, PostOutcome> = {};
    const post =
      (kind: string) =>
      (_signal: Signal, outcome: PostOutcome): void => {
        outcomes[kind] = outcome;
      };
    const handlers: SignalHandlers = {
      "prompt.good": templateHandler({
        template: "a Prompt that renders",
        session: () => null,
        data: () => ({}),
        post: post("prompt.good"),
      }),
      "prompt.unsupplied": templateHandler({
        template: "Hello {{whoever}}",
        session: () => null,
        data: () => ({}),
        post: post("prompt.unsupplied"),
      }),
    };

    await withWorker(handlers, async (worker, runtime) => {
      const good = await emit(worker, "prompt.good");
      const unsupplied = await emit(worker, "prompt.unsupplied");

      assert.deepEqual(await settled(good), { state: "done", error: null });
      assert.equal((await settled(unsupplied)).state, "failed");

      assert.deepEqual(outcomes, {
        "prompt.good": { failed: false },
        "prompt.unsupplied": { failed: true },
      });
      assert.deepEqual(runtime.texts(), ["a Prompt that renders"]);
    });
  });

  it("records what a failing post phase said, and says nothing about the template", async () => {
    const handler = templateHandler({
      template: "a Prompt that renders",
      session: () => null,
      data: () => ({}),
      post: () => {
        throw new Error("the notification could not be delivered");
      },
    });

    await withWorker({ "prompt.render": handler }, async (worker, runtime) => {
      const signalId = await emit(worker, "prompt.render");
      const outcome = await settled(signalId);

      assert.equal(outcome.state, "failed");
      assert.equal(outcome.error, "Post phase failed: the notification could not be delivered");
      assert.deepEqual(runtime.texts(), ["a Prompt that renders"]);
    });
  });
});
