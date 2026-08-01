# Signal Handlers receive only the Signal

> **Superseded in one detail** by [ADR-0031](./0031-parts-that-run-are-components.md).
> The Signal Worker (this ADR's Core) takes its Handler map as a **construction option**
> rather than an argument to `start`, because a Component's `start` takes none. So *"the
> Core is constructed, handlers are built against it, and the Core is handed its handler
> map when it starts"* is now *"handlers are built, and the Signal Worker is constructed
> with them"*, and **a Handler can no longer close over the Signal Worker itself**.
> Nothing in the repository did. An Operator who wants to emit a Signal from a Handler
> declares a `let` first and assigns it after construction, in the entry point, which is
> where this ADR already puts Handler construction. Everything else here stands, and the
> central claim stands more firmly: there is still no context object, and dependencies are
> still declared in a Handler's own factory.

A Signal Handler is a plain object with `handle(signal)` returning zero or more Prompts, and an optional `post(signal, { failed })`. There is **no context object**. Everything a handler needs — a logger, the Workspace path, the Messenger, its prompt template — it closes over, because the Operator's entry point already holds every object in the Gateway.

Every web framework passes a context, so the absence needs explaining. We considered a full `ctx` carrying whatever a handler might plausibly want, including the Messenger. Rejected: it would put messaging in the Core's handler contract, and the Core knowing nothing about identity or messaging is what [ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md) bought. We then considered a minimal `ctx` of `{ log, workspace, signals }`, holding only things the Core legitimately owns. Rejected too, because it is a second way to obtain things the entry point can already pass, and a handler's dependencies are better declared in its factory than supplied ambiently.

The ordering works out without circularity: the Core is constructed, handlers are built against it, and the Core is handed its handler map when it starts ([ADR-0021](./0021-the-framework-has-no-plugin-system.md)). A handler may therefore close over the Core itself.

## Consequences

- **The Core exposes a read API over the Signal log as public surface**, since handlers reach it by closure rather than through a context. This is what makes [ADR-0009](./0009-signal-handlers-are-arbitrary-code.md)'s stated capabilities actually reachable: deduplication and rate limiting are queries over prior Signals — "has this idempotency key arrived?", "how many of this kind from this User in the last hour?" — so neither needs a handler-owned table, which [ADR-0021](./0021-the-framework-has-no-plugin-system.md) declines to provide.
- **Handlers are factories, and the entry point is where dependencies are visible.** That is a few more lines in the entry point, in exchange for a handler whose dependencies are enumerated in its own signature.
- **Testing needs no framework harness.** A handler is a function of a Signal and whatever was passed to its factory, so a fake Messenger is an object literal.
- **A Prompt is `{ session, text }`**, where `session` names an existing Session and `null` requests a fresh one, and **the framework passes the name through untouched**. This bullet originally said the framework validated it at this seam against a transcription of `pi`'s session-id grammar, so that an invalid name failed at the handler rather than mid-Run, and it named `user_<id>` as the convention that grammar implies. Both are gone, and nothing replaced them: what makes a name acceptable is the Agent Runtime's to say ([ADR-0016](./0016-agent-configuration-is-opaque-to-the-framework.md)), and the runtime says it itself. `pi` validates `--session-id` and exits 1 with its own message, which the adapter puts in the failed Run's `error` beside the offending name in the Run's `session` — a diagnostic that cannot drift from the runtime the way a copy of its grammar can, and one a second Agent Runtime with different rules gets for free. What it costs is the pre-flight check over a whole fan-out: an invalid name now fails its own Run and the Prompts around it still run, which is what every other kind of failed Run already does ([ADR-0017](./0017-failed-runs-are-not-retried.md)). The framework names no Session convention at all — per-user Sessions are one of [ADR-0006](./0006-session-routing-is-chosen-by-the-signal-handler.md)'s topologies rather than the recommended one.
