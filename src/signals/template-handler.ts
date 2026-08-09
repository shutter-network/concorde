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
 * `template` takes source and never a path, and widening it back to accept one is the thing to
 * refuse. A path costs a caller one `readFileSync` and buys the framework a whole class of
 * failure: a template read per Signal is a template that first fails a Signal, and a failed Signal
 * is permanently dead (ADR-0017), so the person who sent the message hears nothing.
 *
 * `Handlebars.compile` defers the parse *and* the code generation to the first render, so compiling
 * alone would leave a malformed template failing that first Signal after all. The discarded
 * `precompile` below is what moves both to construction: it is the entry point that runs them
 * eagerly, and its own output, a template spec that would need an `eval` to become a function, is
 * not what is wanted. So the template is parsed and compiled twice, once per Handler per process,
 * and that is the price. Parsing alone would be half of it: an unclosed block is a parse error, but
 * a partial called with two arguments is a code generation error and reaches the same Signal.
 *
 * What construction still cannot catch is a helper complaining about its own arguments. A bare
 * `#if` block with none throws from the built-in helper, which runs only with a context, so it
 * stays a render failure and there is no place to move it to.
 *
 * The two Operator callbacks are awaited outside the try/catch below on purpose. An error thrown by
 * one of them is theirs to recognise, and wrapping it in a sentence about a template would put our
 * words on their bug.
 */

import Handlebars from "handlebars";
import type { Prompt, Signal, SignalHandler } from "./handlers.ts";

export type TemplateHandlerOptions<TPayload = unknown> = {
  /**
   * The Handlebars source, compiled once when the Handler is built.
   *
   * Source, and not a path or a `file:` URL. A deployment that keeps its wording in a file reads
   * the file itself:
   * `template: readFileSync(new URL("./prompt.hbs", import.meta.url), "utf8")`. Nothing reads it
   * again after that, so an edit reaches no Prompt until the process starts again. In exchange a
   * template Handlebars cannot compile throws from {@link templateHandler}, before the Gateway
   * listens, instead of failing a Signal that nothing retries.
   *
   * It is compiled with `noEscape`, so nothing substituted is HTML-escaped, and with `strict`,
   * which fails the Signal on a variable `data` did not supply. `strict` also disables inverse
   * sections: a caret block such as `^absent` throws, and the `unless` helper is what to write in
   * its place. The `if`, `each` and `else` helpers behave as usual.
   */
  readonly template: string;

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
 * A template that compiles and then does not render fails the Signal, with a message naming the
 * Signal's kind. Handlebars names the variable, the line and the column, and never says which
 * Handler was rendering, which is the one thing an Operator running several of them needs.
 *
 * @throws if `template` does not compile. The message is Handlebars' own and names the line and
 * the column. A helper's complaint about its own arguments is not among these, because a helper
 * runs only with a context.
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

  // Compiled here and not left to `compile`, which does both its jobs on the first render. The
  // result is thrown away; what is wanted is the throw. See the file header.
  environment.precompile(options.template, compileOptions);
  const render = environment.compile(options.template, compileOptions);

  return {
    async handle(signal: Signal<TPayload>): Promise<readonly Prompt[]> {
      // Outside the wrapping below on purpose; see the file header.
      const session = await options.session(signal);
      const data = await options.data(signal);

      let text: string;
      try {
        text = render(data);
      } catch (error) {
        // `strict` refusing a variable `data` did not supply, or a partial this environment does
        // not hold. Either way the library's message says nothing about which Handler was
        // rendering, which is what the kind adds.
        throw new Error(`the prompt template for ${signal.kind} did not render: ${reason(error)}`, {
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
