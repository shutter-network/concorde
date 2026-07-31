# Signal Handlers receive only the Signal

A Signal Handler is a plain object with `handle(signal)` returning zero or more Prompts, and an optional `post(signal, { failed })`. There is **no context object**. Everything a handler needs — a logger, the Workspace path, the Messenger, its prompt template — it closes over, because the Operator's entry point already holds every object in the Gateway.

Every web framework passes a context, so the absence needs explaining. We considered a full `ctx` carrying whatever a handler might plausibly want, including the Messenger. Rejected: it would put messaging in the Core's handler contract, and the Core knowing nothing about identity or messaging is what [ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md) bought. We then considered a minimal `ctx` of `{ log, workspace, signals }`, holding only things the Core legitimately owns. Rejected too, because it is a second way to obtain things the entry point can already pass, and a handler's dependencies are better declared in its factory than supplied ambiently.

The ordering works out without circularity: the Core is constructed, handlers are built against it, and the Core is handed its handler map when it starts ([ADR-0021](./0021-the-framework-has-no-plugin-system.md)). A handler may therefore close over the Core itself.

## Consequences

- **The Core exposes a read API over the Signal log as public surface**, since handlers reach it by closure rather than through a context. This is what makes [ADR-0009](./0009-signal-handlers-are-arbitrary-code.md)'s stated capabilities actually reachable: deduplication and rate limiting are queries over prior Signals — "has this idempotency key arrived?", "how many of this kind from this User in the last hour?" — so neither needs a handler-owned table, which [ADR-0021](./0021-the-framework-has-no-plugin-system.md) declines to provide.
- **Handlers are factories, and the entry point is where dependencies are visible.** That is a few more lines in the entry point, in exchange for a handler whose dependencies are enumerated in its own signature.
- **Testing needs no framework harness.** A handler is a function of a Signal and whatever was passed to its factory, so a fake Messenger is an object literal.
- **A Prompt is `{ session, text }`**, where `session` names an existing Session and `null` requests a fresh one. The framework validates the name at this seam against `pi`'s session-id grammar, `/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`, so an invalid name fails at the handler rather than mid-Run. Note that grammar **rejects colons**, so the convention is `user_<id>`, not `user:<id>`.
