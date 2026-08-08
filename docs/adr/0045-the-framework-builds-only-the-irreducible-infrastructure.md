# The framework builds only the irreducible infrastructure

`createGateway` builds the Db, both self-describing servers and the Signal Worker, and
nothing else. The four parts a deployment might not want, the User Manager, Signatures,
Decisions and the HTTP Messenger, are constructed by the Operator in the `extend` callback,
each a single `create*` call wired from the infrastructure the constructor hands it. This
reverses [ADR-0038](./0038-the-default-assembly-is-a-constructor.md), which built all eight,
required a `signingKey` of every deployment, and priced any partial exit as a full
hand-written `createGateway`.

```ts
type InfraComponents = {
  db: Db;
  agentServer: Component & { readonly fastify: FastifyInstance };
  publicServer: Component & { readonly fastify: FastifyInstance };
  worker: SignalWorker;
};

function createGateway<E extends GatewayExtension = Record<string, never>>(options: {
  databaseUrl: string;                                   // required; no environment read
  runtime: Runtime;
  agentListen: FastifyListenOptions;
  publicListen: FastifyListenOptions;
  extend?: (components: InfraComponents) => E;           // the four parts go here
  handlers: (components: InfraComponents & E) => SignalHandlers;
  logger?: Logger;
  sweepIntervalMs?: number;
}): Gateway<InfraComponents & E>;
```

## Why the four are the Operator's

The opinion ADR-0038 baked in was never the wiring or the order. Those are facts identical
in every deployment using these parts, and a constructor that spares each Operator
rediscovering them is worth having. The opinion was that every deployment wants a User
Manager, a signing identity, a Decision log and messaging, and the tell was in the options:
`signingKey` was required of a deployment that never publishes a Decision, and `tokenTtl` of
one with no password login at all. We have no firm basis for those opinions yet. A
department may want no signing identity, or no messaging, and under ADR-0038 it constructed
both anyway and handed over a key it never used.

Removing the opinion costs little, which is what makes removal the right call rather than a
loss. Each of the four is a one-liner given the infrastructure, and `extend` already existed
as the seam that hands the Operator that infrastructure. So the four move out of the
constructor's body and into the Operator's `extend`, on display in the deployment that holds
the opinion instead of hidden in a framework that had no basis for holding it.

## What `createGateway` keeps, because it is fact and not opinion

It builds the Db from a required `databaseUrl`, both servers with `Fastify()` and
`serverComponent`, and the Signal Worker with the empty-map mutation that breaks the
worker-then-Messenger-then-handler cycle ([ADR-0031](./0031-parts-that-run-are-components.md),
[ADR-0034](./0034-the-http-messenger-is-an-opinionated-messenger.md)). It registers
`@fastify/swagger` on each server **before it calls `extend`**, which is the one place the
registration can go and the reason [ADR-0040](./0040-the-gateway-describes-its-own-http-api.md)
survives untouched: the parts register their routes inside `extend`, after the `onRoute`
hook is in place.

And it keys the Worker **last** in the record it returns, although the Worker is constructed
early. Construction order is not key order, a distinction ADR-0038's body already relied on,
so the drain still runs while the servers, the Db and the Operator's own parts are all live.
Nothing about the stop order ADR-0038 reasoned out changes.

`extend` and `handlers` keep their shape. `extend` receives the four infrastructure
Components and returns the Operator's own; `handlers` receives both and returns the
`kind`-to-Handler map, and runs second so a Handler can close over a part that `extend`
built. `GatewayExtension` now forbids the four infrastructure keys by name rather than eight,
by the same `?: never` that forbade them before.

## The framework reads no environment

`databaseUrl` is required, and the fallback to `DATABASE_URL` in the environment is gone. It
was the only `process.env` read in the shipped package, the one input a caller could not see
at the call site, and ADR-0038 recorded it as a wart rather than defending it. With the
Operator already reading `BASE_DIR_HOST`, `BASE_DIR_GATEWAY`, `SIGNING_KEY_FILE` and the model credential by hand
([ADR-0016](./0016-agent-configuration-is-opaque-to-the-framework.md),
[ADR-0041](./0041-the-shared-agent-has-a-signing-identity.md)), the framework reading a
fourth variable for them was the odd one out. The Operator reads `DATABASE_URL` itself now,
one line in `main.ts`, and "the framework parses nothing and reads nothing" is whole.

## `createBareGateway`

Today's `createGateway`, the primitive that takes a record of Components and returns an
ordered Gateway ([ADR-0037](./0037-the-gateway-is-a-record-of-components.md)), is renamed
`createBareGateway`. The new `createGateway` is built on it. `createBareGateway` is the
escape for a deployment whose infrastructure shape itself is wrong: a server it constructed
with `trustProxy`, no Worker at all, a Db opened some other way. That is the same escape
ADR-0038 named, at the same price of writing the record by hand, now one layer down and
reached only when the infrastructure and not merely the parts is what differs.

## Consequences

- **The package root stops importing `./users`, `./signatures`, `./decisions` and
  `./http-messenger`.** ADR-0038's "the root now imports `./users` and `./http-messenger`"
  reverses: `createGateway` imports the Db, the servers and the Worker and nothing about the
  four parts. The subpath exports carry them, and a deployment imports the ones it builds.
- **The Operator owns the construction order again, and one case of it is load-bearing.** The
  User Manager before the HTTP Messenger, because `messages.user_id` is a foreign key onto
  `saf_users.users.id` and `db.migrate()` applies descriptors in registration order
  ([ADR-0036](./0036-the-http-messengers-user-id-is-a-foreign-key.md)). Built the wrong way
  round, the first migration of a new deployment fails with `schema "saf_users" does not
  exist`, which is loud. This is the cost ADR-0038 removed and this ADR re-accepts on purpose:
  it is one ordering, it fails legibly, and it is the Operator's to get right in exchange for
  the parts being theirs to choose. **The migration half of that reason has since gone**:
  under [ADR-0046](./0046-the-operator-owns-migrations.md) the framework applies nothing, so
  there is no registration order to get wrong. What survives is the same ordering for a
  narrower reason — `createHttpMessenger` takes the User Manager as an argument, so it cannot
  be written backwards — and the mistake that is still expressible moved one layer up, to
  which schemas the Operator puts in their barrel, where it fails with the same message.
- **A deployment that publishes no Decision holds no key.** With Signatures and Decisions the
  Operator's to construct, a Gateway that signs nothing constructs neither and passes no
  `signingKey`. Under ADR-0038 there was no such arrangement, because one fixed shape with a
  required key was the price of the assembly having a single set of keys.
- **`src/default-gateway.ts` is renamed `src/gateway.ts`**, and its test with it, since
  "default" described the assembly this ADR removes. It stays the one shipped module that
  imports a value from `fastify`, and `scripts/check-package.ts` names it under the new name
  in place of the old.
- **An example's `main.ts` shows the four parts in `extend`.** The reference deployment becomes
  the worked example of the common case rather than a consumer of a call that hid it, and a
  reader sees the wiring and the order ADR-0038 had folded away. That reading cost is the
  point, not a regression: the order and the wiring are the Operator's now, so they are where
  the Operator can see them.
