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

  readonly helpers?: Readonly<Record<string, Handlebars.HelperDelegate>>;

  readonly partials?: Readonly<Record<string, string>>;

  readonly post?: (signal: Signal<TPayload>, outcome: PostOutcome) => void | Promise<void>;
};

const compileOptions: CompileOptions = { noEscape: true, strict: true };

/**
 * Renders one prompt per signal using strict Handlebars with HTML escaping disabled.
 * Syntax errors in the main template fail construction; missing template values fail the signal.
 * Helpers and partials are local to this handler.
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

      let text: string;
      try {
        text = render(data);
      } catch (error) {
        throw new Error(`Cannot render prompt for ${signal.kind}: ${reason(error)}`, {
          cause: error,
        });
      }

      return [{ session, text, ...context, ...charged }];
    },

    ...(options.post === undefined ? {} : { post: options.post }),
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
