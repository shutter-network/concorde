/**
 * A Signal Handler that renders its Prompt from a Handlebars file on disk.
 *
 * This is **one predefined Handler, not a framework special case** (ADR-0027). It
 * satisfies the ordinary contract in `core/handlers.ts` and closes over everything
 * it needs, exactly as an Operator's own Handler does (ADR-0024) — so an Operator
 * who outgrows it stops calling it and writes the twenty lines themselves, with
 * nothing to unwire.
 *
 * The file is read and compiled **per Prompt**, which is per Run: an Operator
 * iterating on wording edits the file and the next Signal renders through it, with
 * no restart. A file read costs nothing next to a Run.
 *
 * Two compile options carry ADR-0027's decisions; the reasoning is there, and what
 * follows is only what someone editing this file has to know.
 *
 * **`noEscape: true` must not be "fixed".** It is the one thing here that looks like
 * a mistake to anyone who knows Handlebars from web work, and removing it is
 * invisible in every log and every Run outcome — the damage is prompts carrying
 * `&#x27;` where an apostrophe should be. `template-handler.test.ts` asserts the
 * substitution byte for byte for that reason and no other.
 *
 * **`strict: true`** turns a variable the data function did not supply into a failed
 * Signal instead of a hole in the Prompt. Its side effect is worth knowing before
 * writing a template: it **disables inverse sections**, so `{{^absent}}…{{/absent}}`
 * throws where `{{#if absent}}`, `{{#unless absent}}`, `{{#each absent}}` and
 * `{{else}}` all render as usual. Handlebars documents that, and a test pins it, so
 * the failure is not discovered by a Signal that fails permanently (ADR-0017).
 *
 * Both options apply inside partials as well, which is why partials are taken as
 * source strings rather than as already-compiled templates: a template compiled
 * elsewhere would carry someone else's options, and escaping would come back in
 * through it.
 */

import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import type { Prompt, Signal, SignalHandler } from "./core/handlers.ts";

/**
 * What `templateHandler` needs. Everything is supplied here rather than through a
 * context object, so a Handler's dependencies are enumerated in its own factory call
 * (ADR-0024).
 */
export type TemplateHandlerOptions<TPayload = unknown> = {
  /**
   * The Handlebars file, as a path or a `file:` URL. Re-read for every Prompt.
   *
   * A relative path resolves against the process's working directory, which is the
   * Operator's to know; a template that lives beside the module referring to it is
   * better named with `new URL("./prompt.hbs", import.meta.url)`.
   */
  readonly template: string | URL;

  /**
   * Which Session this Signal's Prompt continues, or `null` for a fresh one
   * (ADR-0006).
   *
   * The name is validated by the Core against the Agent Runtime's grammar, which
   * **rejects colons** — the convention is `user_<id>`, never `user:<id>`.
   */
  readonly session: (signal: Signal<TPayload>) => string | null | Promise<string | null>;

  /**
   * The values the template substitutes. Anything the template references and this
   * does not supply fails the Signal rather than rendering empty.
   *
   * A returned Promise is awaited, so this may be `async` — which is where a Handler
   * queries what the prompt needs: the Message log, the Workspace, the Operator's own
   * tables, through whatever it closed over.
   */
  readonly data: (signal: Signal<TPayload>) => unknown;

  /**
   * Handlebars helpers, registered on this Handler's own environment and invisible
   * to every other (`Handlebars.create()`, per ADR-0027). Their output is
   * substituted unescaped like everything else.
   */
  readonly helpers?: Readonly<Record<string, Handlebars.HelperDelegate>>;

  /**
   * Handlebars partials, as template source. Compiled by this Handler's environment
   * with the same options as the template itself, so `noEscape` and `strict` hold
   * inside them too — which is exactly what passing a pre-compiled template would
   * lose.
   */
  readonly partials?: Readonly<Record<string, string>>;
};

/**
 * The two options that are the whole of ADR-0027, spelled once.
 *
 * Applied at `compile` because Handlebars carries compile options per template
 * rather than per environment — there is nowhere to set them once and be safe.
 */
const compileOptions: CompileOptions = { noEscape: true, strict: true };

/**
 * A Signal Handler that renders one Prompt per Signal from a Handlebars template.
 *
 * One Prompt, always: fanning out to several Sessions and declining a Signal
 * altogether are both things the contract allows and this Handler does not do,
 * because a template file says nothing about how many Prompts there should be. A
 * Handler that needs either is an Operator's own — and one that needs a post phase
 * can wrap this: `{ ...templateHandler(options), post }` is a valid Handler, since a
 * Handler is a plain object.
 */
export function templateHandler<TPayload = unknown>(
  options: TemplateHandlerOptions<TPayload>,
): SignalHandler<TPayload> {
  // One environment per Handler, so registering a helper or a partial cannot reach
  // another Handler's templates or the shared `Handlebars` instance the Operator may
  // be using for something else (ADR-0027). Built once here rather than per Prompt:
  // it holds only what was passed to this factory, and none of it changes.
  const environment = Handlebars.create();
  for (const [name, helper] of Object.entries(options.helpers ?? {})) {
    environment.registerHelper(name, helper);
  }
  for (const [name, partial] of Object.entries(options.partials ?? {})) {
    environment.registerPartial(name, partial);
  }

  /** What the failure messages name. `String` on a URL gives the `file:` form. */
  const location = String(options.template);

  return {
    async handle(signal: Signal<TPayload>): Promise<readonly Prompt[]> {
      // Outside the wrapping below on purpose: these are the Operator's own
      // functions, and an error from one is theirs to recognise, not something to
      // re-blame on the template.
      const session = await options.session(signal);
      const data = await options.data(signal);

      // Read and compiled per Prompt, which is per Run. Separated from rendering
      // because the two failures want different words: a path that is wrong and a
      // template that is wrong are found in different places.
      let source: string;
      try {
        source = await readFile(options.template, "utf8");
      } catch (error) {
        throw new Error(`the prompt template ${location} could not be read: ${reason(error)}`, {
          cause: error,
        });
      }

      let text: string;
      try {
        text = environment.compile(source, compileOptions)(data);
      } catch (error) {
        // A parse error, or `strict` refusing a variable the data function did not
        // supply. Handlebars names the variable and its line and column but never
        // the file, which is the one thing an Operator with several templates needs.
        throw new Error(`the prompt template ${location} did not render: ${reason(error)}`, {
          cause: error,
        });
      }

      return [{ session, text }];
    },
  };
}

/** What goes in the Signal's `error` column: the message alone. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
