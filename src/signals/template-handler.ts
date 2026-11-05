import Handlebars from "handlebars";
import type { PostOutcome, Prompt, Signal, SignalHandler } from "./handlers.ts";

export type TemplateHandlerOptions<TPayload = unknown> = {
  /** Template source, not a file path. Read template files before constructing the handler. */
  readonly template: string;

  readonly session: (signal: Signal<TPayload>) => string | null | Promise<string | null>;

  readonly data: (signal: Signal<TPayload>) => unknown;

  readonly context?: (signal: Signal<TPayload>) => unknown;

  /** Sets `Prompt.userId`. Return `null` or omit this function to assign no User to the Run. */
  readonly user?: (signal: Signal<TPayload>) => string | null | Promise<string | null>;

  /** Sets `Prompt.resources`. Omit this function to name none. */
  readonly resources?: (signal: Signal<TPayload>) => readonly string[] | Promise<readonly string[]>;

  /**
   * Sets `Prompt.tag`, and makes the same value available to the template as `{{tag}}` beside
   * the data's own top-level values, so the template writes it into the text with one
   * expression. It takes precedence over a data value named `tag`, and `data` must return an
   * object when this function is given, or the Signal fails. Mint a fresh random value per
   * Signal. Omit this function to write none, which yields a Run no request can be attributed
   * to.
   */
  readonly tag?: (signal: Signal<TPayload>) => string | Promise<string>;

  readonly helpers?: Readonly<Record<string, Handlebars.HelperDelegate>>;

  readonly partials?: Readonly<Record<string, string>>;

  readonly post?: (signal: Signal<TPayload>, outcome: PostOutcome) => void | Promise<void>;
};

const compileOptions: CompileOptions = { noEscape: true, strict: true };

/**
 * Renders one prompt per signal using strict Handlebars with HTML escaping disabled.
 * Syntax errors in the main template fail construction; missing template values fail the signal.
 * Helpers and partials are local to this handler.
 * Register `quoteHelper` as `quote` to wrap external text in delimiters.
 */
export function templateHandler<TPayload = unknown>(
  options: TemplateHandlerOptions<TPayload>,
): SignalHandler<TPayload> {
  const environment = Handlebars.create();
  for (const [name, helper] of Object.entries(options.helpers ?? {})) {
    environment.registerHelper(name, helper);
  }
  for (const [name, partial] of Object.entries(options.partials ?? {})) {
    environment.registerPartial(name, partial);
  }

  // Handlebars.compile parses lazily; precompile makes syntax errors fail construction.
  environment.precompile(options.template, compileOptions);
  const render = environment.compile(options.template, compileOptions);

  return {
    async handle(signal: Signal<TPayload>): Promise<readonly Prompt[]> {
      const session = await options.session(signal);
      const data = await options.data(signal);
      const context =
        options.context === undefined ? {} : { context: await options.context(signal) };
      const userId = options.user === undefined ? null : await options.user(signal);
      const charged = userId === null ? {} : { userId };
      const held =
        options.resources === undefined ? {} : { resources: await options.resources(signal) };
      const tagged = options.tag === undefined ? {} : { tag: await options.tag(signal) };

      let scope: unknown = data;
      if (options.tag !== undefined) {
        if (!isRecord(data)) {
          throw new Error(
            `Cannot render prompt for ${signal.kind}: data must be an object when tag is used, and it was ${kindOf(data)}`,
          );
        }
        scope = { ...data, ...tagged };
      }

      let text: string;
      try {
        text = render(scope);
      } catch (error) {
        throw new Error(`Cannot render prompt for ${signal.kind}: ${reason(error)}`, {
          cause: error,
        });
      }

      return [{ session, text, ...context, ...charged, ...held, ...tagged }];
    },

    ...(options.post === undefined ? {} : { post: options.post }),
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}
