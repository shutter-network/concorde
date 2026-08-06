/**
 * A Signal Handler that renders its Prompt from a Handlebars file on disk.
 *
 * It satisfies the ordinary `SignalHandler` contract and closes over what it needs. An
 * Operator who outgrows it stops calling it and writes their own Handler, with nothing to
 * unwire.
 *
 * The file is read and compiled once per Prompt, which is once per Run. Edit the wording and
 * the next Signal renders through it, with no restart.
 */

import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import type { Prompt, Signal, SignalHandler } from "./signals/handlers.ts";

/** What `templateHandler` needs. Every dependency is named here rather than in a context. */
export type TemplateHandlerOptions<TPayload = unknown> = {
  /**
   * The Handlebars file, as a path or a `file:` URL. Re-read for every Prompt.
   *
   * A relative path resolves against the process's working directory. For a template beside
   * the module that names it, write `new URL("./prompt.hbs", import.meta.url)`.
   */
  readonly template: string | URL;

  /**
   * Which Session this Signal's Prompt continues, or `null` for a fresh one.
   *
   * The topology is yours to choose: one Session per User, one per Run, or one for the whole
   * agent.
   */
  readonly session: (signal: Signal<TPayload>) => string | null | Promise<string | null>;

  /**
   * The values the template substitutes. A referenced value this does not supply fails the
   * Signal rather than rendering empty.
   *
   * A returned Promise is awaited, so this can be `async`. That is where a Handler queries
   * what the Prompt needs: the Message log, the Workspace, or your own tables.
   */
  readonly data: (signal: Signal<TPayload>) => unknown;

  /**
   * Handlebars helpers, registered on this Handler's own environment and invisible to every
   * other one. Their output is substituted unescaped, like everything else.
   */
  readonly helpers?: Readonly<Record<string, Handlebars.HelperDelegate>>;

  /**
   * Handlebars partials, as template source rather than as compiled templates.
   *
   * This Handler compiles them with the same options as the template itself, so `noEscape`
   * and `strict` hold inside them too.
   */
  readonly partials?: Readonly<Record<string, string>>;
};

/**
 * A Prompt is text for a model, not markup for a browser.
 *
 * `noEscape` must stay. Remove it and prompts carry `&#x27;` where an apostrophe belongs,
 * with nothing in any log to say so.
 *
 * `strict` turns a variable the data function did not supply into a failed Signal. It also
 * disables inverse sections, so `{{^absent}}…{{/absent}}` throws. Write `{{#unless absent}}`
 * instead. `{{#if}}`, `{{#each}}` and `{{else}}` all render as usual.
 */
const compileOptions: CompileOptions = { noEscape: true, strict: true };

/**
 * Builds a Signal Handler that renders one Prompt per Signal from a Handlebars template.
 *
 * One Prompt, always. This Handler does not fan out to several Sessions, and it does not
 * decline a Signal. The contract allows both. To add a post phase, wrap it:
 * `{ ...templateHandler(options), post }` is a valid Handler.
 *
 * @param options The template, the Session to continue, and the values to substitute.
 *
 * @example
 * ```ts
 * import { templateHandler } from "shared-agent-framework";
 *
 * const handler = templateHandler<{ userId: string; body: string }>({
 *   template: new URL("./prompts/message-received.hbs", import.meta.url),
 *   session: (signal) => `user_${signal.payload.userId}`,
 *   data: (signal) => signal.payload,
 *   helpers: { upper: (value: string) => value.toUpperCase() },
 * });
 * ```
 */
export function templateHandler<TPayload = unknown>(
  options: TemplateHandlerOptions<TPayload>,
): SignalHandler<TPayload> {
  // One environment per Handler, so a helper or a partial cannot reach another Handler's
  // templates or the shared `Handlebars` instance. Built once, because it holds only what was
  // passed to this factory and none of it changes.
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
      // Outside the wrapping below on purpose. These are the Operator's own functions, and an
      // error from one is theirs to recognise rather than the template's.
      const session = await options.session(signal);
      const data = await options.data(signal);

      // Read and compiled per Prompt, which is per Run. Separated from rendering because the
      // two failures want different words. A wrong path and a wrong template are found in
      // different places.
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
        // A parse error, or `strict` refusing a variable the data function did not supply.
        // Handlebars names the variable, its line and its column, but never the file. That is
        // the one thing an Operator with several templates needs.
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
