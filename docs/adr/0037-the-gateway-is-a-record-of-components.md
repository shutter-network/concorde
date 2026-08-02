# The Gateway is a record of Components

`createGateway(components)` takes a record of Components keyed by the Operator's own
words, starts them in key order, stops them in the reverse of it, and unwinds a failed
start. What it returns is itself a Component, so the Gateway is a thing at last:

```ts
type Component = { start(): Promise<void>; stop(): Promise<void> };
type Gateway<C extends Record<string, Component>> = Component & { readonly components: C };
```

`components(list)` is deleted. So is `Component.name`. And the rule that only parts which
run are Components is withdrawn.

Two claims are superseded. [ADR-0021](./0021-the-framework-has-no-plugin-system.md):

> **The Gateway has no object.** It is one deployable assembled from a Store, two servers,
> a Core, and whichever Producers a deployment wants, and the Operator's entry point *is*
> that assembly. No god object, and nothing to grow capabilities on later.

and [ADR-0031](./0031-parts-that-run-are-components.md):

> `components(list)` returns a plain `{ start, stop }` and is not itself a Component.
> Nesting has no use here and would force it to carry a `name` that nothing reads.

What is *not* superseded is everything underneath. Start in the given order, stop in the
reverse, record a Component as started only once its `start` resolves, unwind everything
on a failure so that the postcondition is "everything is running or nothing is", stop
best-effort and idempotently, aggregate what teardown threw. That is ADR-0031's body and
it is unchanged. Nor is the central argument of ADR-0021 superseded: this is still not a
plugin contract, nothing declares dependencies, routes or tables, and the interface is two
methods precisely because enumerating what an Operator wants to vary produced seams with
nothing in common.

The Gateway satisfies `Component` because it has exactly a Component's shape, and
declaring that it does not would be an assertion nothing needs.

## The key does the work `name` used to

ADR-0031 gave every Component a `name`, and `src/components.ts` was candid about what it
bought:

> Nothing looks a Component up by it, nothing requires it to be unique, and the one place
> it is read is the error raised when this part's `start` throws while the unwind behind it
> throws too.

A record key does that job and does it better: unique by construction, and the Operator's
own word rather than the part's. Keeping both lets them disagree, so that
`createGateway({ db: theWorker })` reports that the signal worker failed to start while the
Operator is reading a key called `db`.

So `name` goes. `serverComponent` loses its first argument and becomes
`serverComponent(server, listen)`, and a failed start names the key it was under.

## Not only parts that run

The record is the Gateway's directory of its own parts, and a part that cannot be in it
cannot be reached through the Gateway at all. The User Manager and the HTTP Messenger
have nothing to start and nothing to release, and under ADR-0031 that kept them out. They
are Components now, with `start` and `stop` that do nothing.

The alternatives were a second bag beside `components`, or a field per part hung off the
returned object. Both invent a distinction the Operator does not care about: they want the
HTTP Messenger, and whether it happens to hold a timer this month is ours to know rather
than theirs. Membership also puts a part in a *position* before it needs one.
`example/gateway.ts` already anticipated the Messenger growing a real `stop` on the day
delivery stops being polling; under the old rule that day meant adding it to the order for
the first time and reasoning about where, and under this one the position is already
decided and already right.

**Both methods stay required**, and the reason has changed since ADR-0031 argued it. That
argument was about ceremony: a part with no work at either end has no position, so putting
it in the list implies its placement matters when it does not. That argument is now simply
wrong, because membership is the point. The reason they stay required is structural typing,
and with `name` gone it is decisive: a `Component` whose methods were both optional would
be the empty type, satisfied by every value in the program. A `MigrationDescriptor`, an
options bag, a string. The record is order-bearing and a wrong entry in it is silent by
construction, so the type has to be tight enough that an accident cannot happen.

## Consequences

- **A key that collides with a default is a type error.** `createGatewayWithDefaults`
  constrains the record its `extend` callback returns so that the default keys are
  forbidden ([ADR-0038](./0038-the-default-assembly-is-a-constructor.md)). Replacing a
  default in place would otherwise be silent, since a JavaScript spread overwrites the
  value and keeps the original key's position. An Operator who wants to substitute one is
  writing `createGateway` by hand, which is the honest way to say it.
- **Integer-like keys jump the queue and nothing checks it.** JavaScript orders `"2"`
  before `"db"` in any object, so a Component keyed `"2"` silently starts first. `"2fa"` is
  fine. A static refusal was considered and dropped: it costs a baffling error message to
  prevent someone naming a Component `"2"`. Recorded here rather than guarded against.
- **The start order is still load-bearing, still the Operator's, and still unchecked.**
  Nothing about a record makes the framework able to say that the Agent server must outlive
  the Signal Worker. What changed is that the *default* set now has one order chosen once,
  in the framework, with its reasoning beside it (ADR-0038).
- **"Part" is retired as a term.** `CONTEXT.md` defined it as the superset of Component,
  and after this the set it named is essentially the Runtime and the Agent Container it
  holds. A term whose extension is one branch of the design is not a term. Lowercase
  "part" survives as ordinary English, and the glossary stops policing it.
- **`serverComponent` is a breaking change** for anyone holding one, as is every Component
  that declared a `name` to satisfy the old interface. Extra properties are still allowed,
  so the change is to the constructor's arity rather than to what a Component may carry.
- **`start` called twice is still not guarded.** It would start a second Signal Worker and
  break serial execution ([ADR-0012](./0012-the-gateway-is-a-serial-signal-worker.md)), and
  it is still the Operator calling `start` twice in a file of their own.
- **Ordering and dependencies between an Operator's own Components are not expressible**
  beyond position in the record. A declaration of what depends on what was considered and
  deferred rather than rejected; it would move the wiring out of the entry point, which is
  where the Signal Handlers are built.
