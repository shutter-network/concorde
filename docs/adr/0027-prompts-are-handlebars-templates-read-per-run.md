# Prompts are Handlebars templates, read per Run, unescaped

The framework ships a Signal Handler that renders a Prompt from a **Handlebars** template on disk. The template file is read and compiled **per Run**, so an Operator can iterate on prompt wording without restarting the Gateway.

We considered a minimal `{{name}}` substitution of about fifteen lines with no dependency, on the grounds that Signal Handlers are already arbitrary code ([ADR-0009](./0009-signal-handlers-are-arbitrary-code.md)) so every conditional and loop an engine offers is available *before* rendering — the handler queries what it needs and passes strings. Handlebars was chosen anyway: it is a syntax people already know, and pushing presentation logic into a template is worth more than the dependency it costs. That cost is five transitive packages (`minimist`, `neo-async`, `source-map`, `wordwrap`, `uglify-js`), and the compiler must ship because templates are read at runtime rather than precompiled.

## Compiled with `noEscape` and `strict`

**`noEscape: true` is not optional and must not be "fixed".** Handlebars HTML-escapes `{{value}}` by default, converting `&`, `<`, `>`, `"`, `'`, `` ` `` and `=`. An apostrophe in a User's message would reach the agent as `&#x27;`. Escaping here defends against the wrong threat: the output is a prompt, not a web page, and [ADR-0003](./0003-prompt-injection-is-an-accepted-risk.md) accepts prompt injection rather than pretending to escape it. With `noEscape`, `{{x}}` and `{{{x}}}` behave identically.

**`strict: true`** so a mistyped variable throws rather than rendering an empty string. The trade-off is real: under [ADR-0017](./0017-failed-runs-are-not-retried.md) a broken template fails that Signal permanently. It is still the right way round — a prompt with a silent hole reaches the agent and misleads it invisibly, where a failed Signal appears in the Signal log with an error.

## Consequences

- **An isolated environment per handler**, via `Handlebars.create()`, so registering `helpers` and `partials` never mutates a global instance the Operator may also be using.
- **`strict` disables inverse sections**, which Handlebars documents and which is worth knowing before writing a template: `{{^absent}}…{{/absent}}` throws, where `{{#if absent}}`, `{{#unless absent}}`, `{{#each absent}}` and `{{else}}` all render as usual. Every ordinary way of asking "was this supplied?" still works, but the one spelling that does not fails the Signal permanently, so it is pinned by a test rather than left to be discovered.
- **A malformed template is a permanent failure**, not a warning. That is the price of reading per Run, and it is visible in the Signal log rather than silent.
- **No escaping or sanitisation is applied to substituted values.** User text enters the prompt verbatim, deliberately.
- The template handler is one predefined implementation of the ordinary Signal Handler contract, not a special case in the framework. An Operator who outgrows it writes a handler ([ADR-0024](./0024-signal-handlers-receive-only-the-signal.md)).
