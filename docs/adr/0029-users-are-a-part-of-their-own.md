# Users are a part of their own

Users belong to the **User Directory**: a part of the Gateway with its own PostgreSQL
schema, its own migration descriptor, and its own export subpath, constructed like any
other. [ADR-0014](./0014-users-are-opaque-ids-and-authentication-is-pluggable.md) put
them inside the Messenger, and [`architecture.md`](../architecture.md) and
[`data-model.md`](../data-model.md) said so; that ownership is superseded here.
Everything else in ADR-0014 stands — ids are opaque and Gateway-issued, no naming
scheme is privileged, attributes are arbitrary JSON the Gateway cannot meaningfully
index, and self-registration remains a Signal rather than a feature.

The reason is the one [ADR-0021](./0021-the-framework-has-no-plugin-system.md) already
gave for rejecting a common `Component` abstraction: parts that vary independently
should not be bundled. Identity and messaging vary independently, and the asymmetry is
severe. A deployment wanting authenticated HTTP clients against its own routes and no
chat at all would have had to construct a Messenger it never uses — and the Messenger
is both the largest part in the framework and the one most likely to be replaced
wholesale. The reverse case is rarer and cheaper: a deployment replacing the User
Directory keeps the Messenger.

The cost of the split is a **foreign key we do not get**, since
[ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md) forbids one part's table
referencing another's. The Messenger's `user_id` will be a plain uuid with nothing
enforcing that it names a real User. That constraint was not load-bearing: nothing
removes a User (below), so the dangling reference it would have prevented cannot arise.

## What the agent may do

The Agent server carries `POST /users` — which takes an initial password and **takes no
attributes** — plus reads, and nothing else. Replacing an existing User's password and
issuing a token are not routes at all; they are methods on the constructed object,
reachable only from Operator code.

The line falls at attributes rather than at credentials because that is where the
escalation runs. [ADR-0008](./0008-party-is-not-in-the-data-model.md) and ADR-0014 make
attributes the place grouping and authorization live, so an agent able to choose them
could create a User with `role: "admin"`, give it a password, and log in as an
administrator. Since [ADR-0003](./0003-prompt-injection-is-an-accepted-risk.md) accepts
that a hostile User may steer the agent, and the Agent server has no authentication at
all, every capability on that surface is a capability an injection may reach.

Two properties of this design are worth stating because they are easy to mistake for
something weaker. First, the restriction is an **absent capability, not a guard**: the
route has no attributes parameter, so there is no validator to bypass, no allow-list to
configure, and nothing to get wrong. Second, onboarding stays coherent — the agent can
create a User who is able to log in — which the obvious alternative ("the agent may
create a User but give it no credential") does not, since that User could never
authenticate and the agent could not finish what it was permitted to start.

Trusted code is unrestricted, and that is the intended asymmetry. Signal Handlers are
Operator-authored and therefore trusted ([ADR-0009](./0009-signal-handlers-are-arbitrary-code.md),
[ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md)); they hold the
object and may set attributes, replace passwords, and issue tokens. Only the agent's
HTTP surface is narrowed, because only it is reachable by an injected prompt.

## Consequences

- **Nothing removes a User.** No delete route, no deactivation, no `deactivated_at`
  column. This is stronger than ADR-0014's "removal is deactivation, not erasure", and
  it is deliberate rather than unbuilt: a hard delete could not reach Session
  directories or the Workspace, so it would look like erasure without being any, and a
  deactivation flag put a state and two authentication branches into the code for a
  capability no deployment has yet asked for. Removal returns as an ADR and a
  migration when one does.
- **The User Directory is not a Producer.** It emits no Signals and takes no reference
  to the Core. A Signal on login is refused rather than merely omitted:
  [ADR-0012](./0012-the-gateway-is-a-serial-signal-worker.md) makes the worker globally
  serial, so a Signal per login turns any authentication burst — a client refreshing
  on expiry, or the unthrottled guessing
  [ADR-0030](./0030-passwords-are-traded-for-bearer-tokens.md) accepts — into a Run
  queue that starves every real Signal behind it. A deployment wanting the Signal emits
  it itself, atomically, because writes take the transaction first
  ([ADR-0023](./0023-cross-component-writes-take-an-explicit-transaction.md)).
- **An injected agent can create unlimited unprivileged Users**, and nothing reaps
  them. Consistent with ADR-0003's practice of naming risks rather than building
  guards, and switched off wholesale by not registering the Agent server plugin —
  which is what ADR-0014's "which a deployment may disable" already meant.
- **`outbox_cursor` leaves the User row.** It is Outbox state rather than identity, and
  Outboxes stay the Messenger's ([ADR-0015](./0015-outboxes-are-cursor-read-logs.md)),
  so it moves to a Messenger-owned table. Deleting a User would therefore not delete
  their cursor — moot while nothing deletes one.
- **Seeding the first User is out of scope and the Operator's.** ADR-0014 gives Users
  no natural key, so there is nothing to match on and *"create this User if absent"* is
  not expressible. An Operator seeds once, out of band, and records the id; the entry
  point does not do it at boot. `create` deliberately does not accept an explicit id,
  which would have made boot-time seeding idempotent at the price of inviting a
  hardcoded uuid into every copy of a deployment's source.
- **Reads cannot see a caller's own uncommitted write.** Writes take the transaction and
  reads use the part's own handle, so a Handler that creates a User inside a
  transaction and then reads it back gets nothing. `create` returns the User, so the
  read-back has no reason to exist; ADR-0023 already records that nothing prevents an
  Operator from ignoring this.
