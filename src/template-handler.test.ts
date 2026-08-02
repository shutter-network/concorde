/**
 * The Prompt template Handler.
 *
 * Most of this needs no database: a Handler is a function of a Signal and whatever
 * its factory was given (ADR-0024), so the rendering criteria are unit tests over
 * files in a temporary directory. The last two are not — "fails that Signal with a
 * reason" is a claim about the Signal log, and "does not stop the worker" is a claim
 * about what happens to the *next* Signal, so those run through a real Signal Worker against
 * real PostgreSQL with the template edited underneath a worker that never restarts.
 *
 * The escaping assertions are byte-for-byte on purpose. `noEscape: true` looks like
 * a mistake to anyone who knows Handlebars from web work, and the damage from
 * "fixing" it — prompts with `&#x27;` where an apostrophe should be — is invisible
 * in every log and every Run outcome (ADR-0027).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { eq } from "drizzle-orm";
import Handlebars from "handlebars";
import type { Db } from "./db/index.ts";
import type { Prompt, Signal, SignalHandler, SignalHandlers } from "./signals/handlers.ts";
import { signalsMigrations } from "./signals/migrations.ts";
import { signals } from "./signals/schema.ts";
import { createSignalWorker, type SignalWorker } from "./signals/worker.ts";
import { templateHandler } from "./template-handler.ts";
import { createTestDatabase, type TestDatabase } from "./test-support/database.ts";
import { type FakeRuntime, fakeRuntime } from "./test-support/fake-runtime.ts";
import { waitUntil } from "./test-support/wait.ts";

/**
 * Every character Handlebars escapes by default, in text a User could plausibly
 * write. If any of them comes back transformed, the Prompt reaching the agent is
 * not what the Operator's data function said (ADR-0003).
 */
const everythingHandlebarsWouldEscape = `it's <b>&</b> \`tick\` "quoted" =equals`;

/** A template file in a directory of its own, so a test can rewrite it in place. */
async function templateFile(t: TestContext, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "saf-template-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "prompt.hbs");
  await writeFile(file, source, "utf8");
  return file;
}

/** The Signal a Handler is handed. Only the payload differs between these tests. */
function aSignal<TPayload>(payload: TPayload): Signal<TPayload> {
  return {
    id: "6f1a3c7e-0000-4000-8000-000000000001",
    kind: "test.signal",
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
 * A Handler over a template file holding `source`, routed to a fresh Session and
 * given `data`.
 *
 * The Session name and the payload are each the subject of a test of their own and
 * noise in every other, so they are filled in here. The file comes back with the
 * Handler because a failure message is expected to name it.
 */
async function handlerOver(
  t: TestContext,
  source: string,
  data: unknown = {},
): Promise<{ file: string; handler: SignalHandler<null> }> {
  const file = await templateFile(t, source);
  return {
    file,
    handler: templateHandler<null>({ template: file, session: () => null, data: () => data }),
  };
}

/** What `source` renders to, given `data`. */
async function renders(t: TestContext, source: string, data: unknown): Promise<string> {
  const { handler } = await handlerOver(t, source, data);
  return (await onlyPrompt(handler, null)).text;
}

/**
 * Asserts the Handler rejects, with a message that names the template and says what
 * went wrong.
 *
 * Naming the template is the load-bearing half: Handlebars reports the variable and
 * its line and column but never the file, and an Operator with several templates has
 * no way to tell which one failed from that alone.
 */
async function rejectsNaming(
  handler: SignalHandler<null>,
  file: string,
  reason: RegExp,
): Promise<void> {
  await assert.rejects(
    () => Promise.resolve(handler.handle(aSignal(null))),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(file),
        `the reason should name the template; it was: ${error.message}`,
      );
      assert.match(error.message, reason);
      return true;
    },
  );
}

describe("the template Handler", () => {
  it("renders a Signal through the template file into a Prompt for the Session it chose", async (t) => {
    const file = await templateFile(t, "Hello {{name}}. You asked about {{topic}}.\n");
    const handler = templateHandler<{ readonly userId: string; readonly name: string }>({
      template: file,
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => ({ name: signal.payload.name, topic: "the weather" }),
    });

    assert.deepEqual(await onlyPrompt(handler, { userId: "42", name: "Bob" }), {
      session: "user_42",
      text: "Hello Bob. You asked about the weather.\n",
    });
  });

  it("routes to a fresh Session when the naming function returns null", async (t) => {
    const file = await templateFile(t, "one-off");
    const handler = templateHandler<null>({
      template: file,
      session: () => null,
      data: () => ({}),
    });

    assert.deepEqual(await onlyPrompt(handler, null), { session: null, text: "one-off" });
  });

  it("takes an asynchronous Session name and asynchronous data", async (t) => {
    const file = await templateFile(t, "{{greeting}} from {{where}}");
    const handler = templateHandler<null>({
      template: file,
      session: async () => "looked_up",
      data: async () => ({ greeting: "hi", where: "a query" }),
    });

    assert.deepEqual(await onlyPrompt(handler, null), {
      session: "looked_up",
      text: "hi from a query",
    });
  });

  it("reads the template again for every Prompt, so an edit changes the next one", async (t) => {
    const file = await templateFile(t, "the first wording, {{name}}");
    const handler = templateHandler<null>({
      template: file,
      session: () => null,
      data: () => ({ name: "Bob" }),
    });

    assert.equal((await onlyPrompt(handler, null)).text, "the first wording, Bob");
    await writeFile(file, "the second wording, {{name}}", "utf8");
    assert.equal((await onlyPrompt(handler, null)).text, "the second wording, Bob");
  });

  it("takes a URL as well as a path, since a template beside a module is found that way", async (t) => {
    const file = await templateFile(t, "from a URL");
    const handler = templateHandler<null>({
      template: new URL(`file://${file}`),
      session: () => null,
      data: () => ({}),
    });

    assert.equal((await onlyPrompt(handler, null)).text, "from a URL");
  });
});

describe("a substituted value", () => {
  it("reaches the Prompt byte for byte, escaping nothing", async (t) => {
    const text = await renders(t, "{{value}}", { value: everythingHandlebarsWouldEscape });

    assert.equal(text, everythingHandlebarsWouldEscape);
    // Spelled out as well as compared, so a failure says which escape crept back in
    // rather than only that two long strings differ.
    for (const character of ["'", "&", "<", ">", "`", '"', "="]) {
      assert.ok(text.includes(character), `${character} should reach the Prompt unchanged`);
    }
    assert.ok(!text.includes("&#"), "no numeric HTML entity should appear in a Prompt");
    assert.ok(!text.includes("&amp;"), "no named HTML entity should appear in a Prompt");
  });

  it("renders identically through {{x}} and {{{x}}}", async (t) => {
    const text = await renders(t, "[{{value}}] [{{{value}}}]", {
      value: everythingHandlebarsWouldEscape,
    });

    assert.equal(text, `[${everythingHandlebarsWouldEscape}] [${everythingHandlebarsWouldEscape}]`);
  });

  it("is unescaped inside a partial too", async (t) => {
    const file = await templateFile(t, "{{> quoted}}");
    const handler = templateHandler<null>({
      template: file,
      session: () => null,
      data: () => ({ value: everythingHandlebarsWouldEscape }),
      partials: { quoted: "<<{{value}}>>" },
    });

    assert.equal((await onlyPrompt(handler, null)).text, `<<${everythingHandlebarsWouldEscape}>>`);
  });

  it("is unescaped when a helper produced it", async (t) => {
    const file = await templateFile(t, "{{shout value}}");
    const handler = templateHandler<null>({
      template: file,
      session: () => null,
      data: () => ({ value: "it's & it's" }),
      helpers: { shout: (value: string) => value.toUpperCase() },
    });

    assert.equal((await onlyPrompt(handler, null)).text, "IT'S & IT'S");
  });
});

describe("a template that cannot produce a Prompt", () => {
  it("throws when the data function did not supply a variable the template reads", async (t) => {
    const { file, handler } = await handlerOver(t, "Hello {{name}}, about {{topic}}.", {
      name: "Bob",
    });

    await rejectsNaming(handler, file, /"topic" not defined/);
  });

  it("throws when a nested field the template reads is absent", async (t) => {
    const { file, handler } = await handlerOver(t, "{{user.name}}", { user: {} });

    await rejectsNaming(handler, file, /"name" not defined/);
  });

  it("throws when a variable is referenced inside a partial and not supplied", async (t) => {
    const file = await templateFile(t, "{{> quoted}}");
    const handler = templateHandler<null>({
      template: file,
      session: () => null,
      data: () => ({}),
      partials: { quoted: "<<{{value}}>>" },
    });

    // `strict` reaches inside partials, which is the other half of what compiling
    // them here rather than accepting pre-compiled ones buys.
    await rejectsNaming(handler, file, /"value" not defined/);
  });

  it("throws when the template file is missing", async (t) => {
    const present = await templateFile(t, "unused");
    const missing = path.join(path.dirname(present), "absent.hbs");
    const handler = templateHandler<null>({
      template: missing,
      session: () => null,
      data: () => ({}),
    });

    await rejectsNaming(handler, missing, /could not be read/);
  });

  it("throws when the template is malformed", async (t) => {
    const { file, handler } = await handlerOver(t, "{{#if always}}never closed", { always: true });

    await rejectsNaming(handler, file, /did not render/);
  });

  it("carries the underlying error as the cause, so a log line keeps it", async (t) => {
    const { handler } = await handlerOver(t, "{{missing}}");

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
  it("throws on an inverse section over a value that was not supplied", async (t) => {
    const { file, handler } = await handlerOver(t, "{{^absent}}nothing here{{/absent}}");

    await rejectsNaming(handler, file, /"absent" not defined/);
  });

  it("still renders every block form that asks whether a value is there", async (t) => {
    for (const source of [
      "{{#if absent}}X{{/if}}",
      "{{#each absent}}X{{/each}}",
      "{{#with absent}}X{{/with}}",
    ]) {
      assert.equal(await renders(t, source, {}), "", `${source} should render nothing`);
    }
    assert.equal(await renders(t, "{{#unless absent}}Z{{/unless}}", {}), "Z");
    assert.equal(await renders(t, "{{#if absent}}X{{else}}E{{/if}}", {}), "E");
  });
});

describe("a Handler's Handlebars environment", () => {
  it("keeps its helpers and partials invisible to another Handler in the same process", async (t) => {
    const shared = "{{shout name}} {{> signature}}";
    const withOwn = templateHandler<null>({
      template: await templateFile(t, shared),
      session: () => null,
      data: () => ({ name: "Bob" }),
      helpers: { shout: (value: string) => String(value).toUpperCase() },
      partials: { signature: "-- the Gateway" },
    });
    const withNone = templateHandler<null>({
      template: await templateFile(t, shared),
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
  it("does not register a partial another Handler can resolve", async (t) => {
    const template = "{{> signature}}";
    templateHandler<null>({
      template: await templateFile(t, template),
      session: () => null,
      data: () => ({}),
      partials: { signature: "-- the Gateway" },
    });
    const withNone = templateHandler<null>({
      template: await templateFile(t, template),
      session: () => null,
      data: () => ({}),
    });

    await assert.rejects(
      () => Promise.resolve(withNone.handle(aSignal(null))),
      /partial signature could not be found/,
    );
  });

  it("leaves the shared Handlebars instance the Operator may also use untouched", async (t) => {
    templateHandler<null>({
      template: await templateFile(t, "{{shout name}}"),
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
 * PostgreSQL is real and the Runtime is the only fake (ADR-0022), and the
 * Signal Worker here is started once and never restarted — which is what "no restart" in
 * the ticket means and what a second `templateHandler` call in a fresh process would not
 * demonstrate.
 */
describe("the template Handler under the worker", () => {
  let database: TestDatabase;
  let db: Db;

  before(async () => {
    database = await createTestDatabase("template_handler");
    db = database.db;
    db.registerMigrations(signalsMigrations);
    await db.migrate();
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

  it("hands the rendered Prompt to the Runtime, and picks up an edited template with no restart", async (t) => {
    const file = await templateFile(t, "the first wording");
    const handler = templateHandler<unknown>({
      template: file,
      session: () => "user_42",
      data: () => ({}),
    });

    await withWorker({ "prompt.render": handler }, async (worker, runtime) => {
      const first = await emit(worker, "prompt.render");
      assert.deepEqual(await settled(first), { state: "done", error: null });

      // The Gateway keeps running while the Operator edits the file.
      await writeFile(file, "the second wording", "utf8");

      const second = await emit(worker, "prompt.render");
      assert.deepEqual(await settled(second), { state: "done", error: null });

      assert.deepEqual(
        runtime.recorded.map((run) => run.prompt),
        [
          { session: "user_42", text: "the first wording" },
          { session: "user_42", text: "the second wording" },
        ],
      );
    });
  });

  /**
   * All three ways a template can fail, through the worker rather than as a throw:
   * the criteria are about what the Signal log ends up saying, and each Handler here
   * has its own template so a reason naming the wrong one is caught.
   */
  it("fails only its own Signal, with a reason naming its own template, and keeps working", async (t) => {
    const good = await templateFile(t, "a Prompt that renders");
    const missing = path.join(path.dirname(good), "not-there.hbs");
    const unsupplied = await templateFile(t, "Hello {{whoever}}");
    const malformed = await templateFile(t, "{{#if always}}never closed");

    const of = (template: string): SignalHandler =>
      templateHandler({ template, session: () => null, data: () => ({}) });
    const handlers: SignalHandlers = {
      "prompt.good": of(good),
      "prompt.missing": of(missing),
      "prompt.unsupplied": of(unsupplied),
      "prompt.malformed": of(malformed),
    };

    await withWorker(handlers, async (worker, runtime) => {
      const broken = {
        [missing]: await emit(worker, "prompt.missing"),
        [unsupplied]: await emit(worker, "prompt.unsupplied"),
        [malformed]: await emit(worker, "prompt.malformed"),
      };
      // Emitted last, so reaching `done` means the worker survived all three.
      const after = await emit(worker, "prompt.good");

      for (const [template, signalId] of Object.entries(broken)) {
        const outcome = await settled(signalId);
        assert.equal(outcome.state, "failed", `${template} should have failed its Signal`);
        assert.ok(
          outcome.error !== null && outcome.error.includes(template),
          `the Signal's reason should name ${template}; it was: ${outcome.error}`,
        );
      }

      assert.deepEqual(await settled(after), { state: "done", error: null });
      // No Run was ever started for a Signal whose Prompt could not be produced.
      assert.deepEqual(
        runtime.recorded.map((run) => run.prompt.text),
        ["a Prompt that renders"],
      );
    });
  });
});
