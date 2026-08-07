/**
 * This is an ordinary `SignalHandler` built by an ordinary function, with no registration and no
 * base to extend, so an Operator who outgrows it stops calling it and returns a Handler of their
 * own from the same place. Nothing has to be unwired for that to work, and nothing here may grow a
 * hook that would make it untrue.
 *
 * `noEscape` must stay. Remove it and every Prompt carries `&#x27;` where an apostrophe belongs,
 * with nothing in any log to say so, because a Prompt is text for a model rather than markup for a
 * browser (ADR-0027).
 *
 * The two Operator callbacks are awaited outside the try/catch below on purpose. An error thrown by
 * one of them is theirs to recognise, and wrapping it in a sentence about a template would put our
 * words on their bug.
 */

import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import type { Prompt, Signal, SignalHandler } from "./signals/handlers.ts";

export type TemplateHandlerOptions<TPayload = unknown> = {
  /**
   * The Handlebars file, as a path or a `file:` URL, read and compiled again for every Prompt.
   * Edit the wording and the next Signal renders through it, with no restart.
   *
   * A relative path resolves against the process's working directory. For a template beside the
   * module that names it, write `new URL("./prompt.hbs", import.meta.url)`.
   *
   * It is compiled with `noEscape`, so nothing substituted is HTML-escaped, and with `strict`,
   * which fails the Signal on a variable `data` did not supply. `strict` also disables inverse
   * sections: a caret block such as `^absent` throws, and the `unless` helper is what to write in
   * its place. The `if`, `each` and `else` helpers behave as usual.
   */
  readonly template: string | URL;

  /**
   * Which Session this Signal's Prompt continues, or `null` to ask for a fresh one.
   *
   * The topology is yours: one Session per User, one per Run, or one for the whole agent. A
   * returned Promise is awaited.
   */
  readonly session: (signal: Signal<TPayload>) => string | null | Promise<string | null>;

  /**
   * The values the template substitutes. A name the template references and this does not supply
   * fails the Signal rather than rendering as nothing.
   *
   * A returned Promise is awaited, so this can be `async`, and it is where a Handler reads what the
   * Prompt needs: the Message log, the Workspace, or tables of your own.
   */
  readonly data: (signal: Signal<TPayload>) => unknown;

  /**
   * Handlebars helpers, registered on an environment belonging to this Handler alone. Another
   * Handler built by another call cannot see them, and neither can the shared `Handlebars`
   * instance. What a helper returns is substituted unescaped, like everything else.
   */
  readonly helpers?: Readonly<Record<string, Handlebars.HelperDelegate>>;

  /**
   * Handlebars partials, as template source rather than as templates already compiled.
   *
   * They are compiled here with the same options as the template itself, so `noEscape` and `strict`
   * hold inside them too.
   */
  readonly partials?: Readonly<Record<string, string>>;
};

// Both are load-bearing and both are argued in the file header. What they do to a template is
// documented on `TemplateHandlerOptions.template`, because a template author has to know.
const compileOptions: CompileOptions = { noEscape: true, strict: true };

/**
 * Builds a Signal Handler that renders one Prompt per Signal from a Handlebars template.
 *
 * One Prompt, always. It never fans a Signal out across several Sessions and never declines one,
 * although the Handler contract allows both. It has no post phase either, and gains one by being
 * spread: `{ ...templateHandler(options), post }` is a Handler.
 *
 * A template that cannot be read, and one that does not render, each fail the Signal with a message
 * naming the file. Handlebars names the variable, the line and the column, and never the file,
 * which is the one thing an Operator running several templates needs.
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

  // What both failure messages name. `String` on a URL gives the `file:` form, which is the
  // spelling an Operator wrote and so the one they can search for.
  const location = String(options.template);

  return {
    async handle(signal: Signal<TPayload>): Promise<readonly Prompt[]> {
      // Outside the wrapping below on purpose; see the file header.
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
        // A parse error, or `strict` refusing a variable `data` did not supply. Either way the
        // library's message is missing the file name, which is what this one adds.
        throw new Error(`the prompt template ${location} did not render: ${reason(error)}`, {
          cause: error,
        });
      }

      return [{ session, text }];
    },
  };
}

// The message alone, because this ends up in the Signal's `error` column rather than on a console
// where a stack would be read.
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
