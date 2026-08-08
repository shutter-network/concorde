# The Messenger owns the log and Channels reach people

> **Confirmed by [ADR-0053](./0053-nostr-auth-verifies-nip-98-per-request.md), and nothing here
> is superseded.** The last paragraph below rejects a shared identity table and says a future
> Authenticator would keep a copy of the Nostr Channel's public keys. That Authenticator exists,
> it is **Nostr Auth**, and it keeps its own table. The rejection came out stronger than the
> argument made for it, because the two tables are **not one fact stored twice**:
> `saf_nostr_channel.pubkeys` says where to send, is keyed by the User and holds one key each,
> while `saf_nostr_auth.grants` says who may act as a User over HTTP, is keyed by the key and
> holds as many as a person has signers. Two grants, two cardinalities, two directions, sharing a
> value. Unifying them was never available at any price, so the paragraph's *"one duplicated row"*
> understates what full separation bought. The recorded cost is paid all the same, and for the
> first time: two calls write the two tables and nothing checks that they agree, so a person may
> be reachable over Nostr and refused on `GET /decisions`.
>
> Two names below moved. The Channel's schema is **`saf_nostr_channel`**, renamed once a second
> component spoke the protocol, and the HTTP Channel no longer takes the Users component's hook,
> that hook being the Public server's now
> ([ADR-0052](./0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)).
> The Channel still owns no tables.

A generic **Messenger** owns the Message log: the table, the per-User `seq`, the cursored read,
`send`, `history`, the one Signal `kind`, and the Agent server routes. A **Channel** owns reaching
one person over one medium. The HTTP Messenger becomes the **HTTP Channel**, keeps only its Public
server routes, and owns no tables at all.

This **supersedes most of
[ADR-0034](./0034-the-http-messenger-is-an-opinionated-messenger.md)**, which predicted a
different answer to the same question and priced it honestly. Its four declined freedoms survive;
three of them move up to the Messenger. Its extension mechanism does not: a deployment that wants
a second way of reaching people writes a **Channel**, not a second messaging Producer.

## What ADR-0034 predicted, and why we did something else

That ADR said a deployment disagreeing with the HTTP Messenger writes *"a **second messaging
Producer**, with its own PostgreSQL schema, its own Signal `kind` and its own tables, sharing
nothing with this one but the User Manager and the Signal Worker"*, and recorded the bill:

> The cost is recorded rather than solved: **two messaging Producers mean two Message logs**, and
> the agent reads a person's history from both, separately. There is no merged read and no place
> to put one, because `seq` is per User and per log, so two logs cannot be interleaved by one
> cursor. A deployment that wants one history keeps one Producer.

That bill is what a generic Messenger refunds. One log, one `seq`, one cursored read, whichever
medium a Message travelled by. It matters most for the thing the Message log is *for*: `CONTEXT.md`
calls it *"the **durable** record of what was said"*, and a durable record split in two by
transport is a worse record than one.

The alternative shape, a Nostr adapter that reached into the HTTP Messenger and called its
`submit`, was rejected on a sharper point than layering. **An HTTP inbound Message arrives with an
authenticated `request.safUser`; a Nostr DM arrives from a pubkey the Gateway never issued.** Those
are two different admission mechanisms, and an adapter would have had to launder one into the other
before it could write anything.

## The interface is two members, and that is not the plugin system ADR-0021 rejected

```ts
type Channel = Component & {
  readonly name: string;
  send<T>(tx: Handle<T>, message: MessageRecord): Promise<void>;
};
```

[ADR-0021](./0021-the-framework-has-no-plugin-system.md) rejected a contract that the Messenger,
the Scheduler and an Operator's own code would all satisfy, because *"enumerating what an Operator
actually wants to vary produced eleven seams, and they have nothing in common"*, and because *"the
two-kind split fails on the first example: the Messenger emits Signals **and** serves routes **and**
owns tables"*. Its own conclusion is the licence for this type: *"Two methods is what survived
that, and it is why widening the population cost nothing."* A `Channel` is a `Component` with a
name and one more method, which is the same order of narrowness, over a population of one kind of
thing rather than eleven.

**A channel wires itself.** `createNostrChannel({ messenger, ... })` calls `messenger.register(self)`
at the end of its own constructor, which is
[ADR-0032](./0032-components-wire-themselves-at-construction.md) verbatim: the same act as a
component registering its routes on the servers it was handed. It has to be self-registration
rather than a constructor argument, because the Messenger is built first (a channel needs it) and
the reference therefore cannot run the other way at construction time.

**`register` returns a handle, and that deletes a public method.**

```ts
type MessengerHandle = {
  receive<T>(tx: Handle<T>, userId: string, text: string): Promise<void>;
};
```

The channel keeps the handle and writes inbound Messages through it. The Messenger has no public
`receive`, so **only a registered channel can write an inbound Message**, and a channel cannot claim
to be a different channel because it never names itself in the call. The alternative,
`messenger.receive(tx, userId, channelName, text)`, is one more argument and one more thing to lie
about.

**`send` is the method on both sides, and `enqueue` was rejected for lying.** A channel's `send`
promises only "this Message is yours now". HTTP's implementation is a no-op, because HTTP delivery
is the User asking: there is nothing to enqueue and no queue to put it in, so a member called
`enqueue` would be false for one of the two channels that exist. Four Components already have
no-op `start` and `stop` (`CONTEXT.md`: *"The User Manager, the HTTP Messenger, Signatures and
Decisions have no work at either end and are Components anyway"*), so a no-op member is a shape
this design already defends.

## One channel per Messenger, refused rather than documented

`register` throws on a second channel. The Messenger therefore has no channel routing, `send` is
`send(tx, userId, text)` with no channel argument, the log has no `channel` column, and the Signal
payload names no channel. This follows ADR-0034's own instinct that *"making them unconstructable
is cheaper than documenting them"*.

**The cost is this ADR's own justification, and it is deferred rather than paid.** With one channel
there is nothing to merge, so the refund described above is a capability the design *can* deliver
and does not yet. What the extraction buys today is that a channel is small to write. The day a
second one is wanted, three things arrive together: the `channel` argument, a `channel` column on
both directions, and the channel name in the Signal payload. None of them is hard; all of them are
unnecessary now, and a `channel` column that is constant in every row is a column that answers no
question.

**A deployment therefore picks HTTP or Nostr, not both**, and `example/` keeps HTTP: the
quickstart's spine is `POST /auth/tokens`, `POST /messages`, `GET /messages?after=1`. So the Nostr
Channel is the first component with no entry in `example/main.ts`, a pattern held for eight
components before it, and that is recorded here as a cost rather than defended.

## The servers split, and the split is the interesting part

Taking the log out of the HTTP Messenger reallocates its two route groups by asking what each one
is *about*.

- **The Agent server routes are about the log**, not about HTTP as a medium. The agent sending a
  Message and reading a User's history are the same acts whichever channel delivers them. They go
  to the **Messenger**, and become channel-agnostic.
- **The Public server routes are what HTTP as a channel actually is.** Submit and poll by cursor
  ([ADR-0035](./0035-a-users-messages-are-one-log-read-by-cursor.md)). They stay with the **HTTP
  Channel**.

So the HTTP Channel shrinks to exactly the polling API a browser talks to, with a no-op `send`,
no-op `start` and `stop`, and **no schema and no tables**: the second component of which that is
true, after Signatures ([ADR-0042](./0042-a-signature-is-a-compact-jws.md)). Its subpath carries a
constructor and nothing beside it, which
[ADR-0047](./0047-a-component-is-one-subpath.md) already has a shape for.

## Outbound is a durable row and a listener, never an inline publish

`channel.send` runs inside the caller's transaction and must not perform the network act. **A
publish cannot be rolled back and a transaction can**, and both orderings of the naive version
break:

- Publish first, then something later in the caller's transaction fails. The recipient's client
  already holds the message and the rollback erases the row, so a person saw something the agent
  has no record of. That is the inverse of the property this framework already keeps, that *"a
  Message that was stored always has its Signal"*.
- Publish and let it throw, rolling the transaction back. Sound, but it holds a database
  transaction open across a round trip to a relay, so an unreachable relay pins a transaction until
  TCP timeout.

So `channel.send` does everything it can do synchronously (resolve the address, build the payload,
bound the size, write a queue row, `NOTIFY`) and **throws for anything knowable at send time**,
which gives the caller a useful exception and leaves nothing half-done. The network act happens
after commit, in a `db.listen` registration the channel opens in its own `start`. That is the
Signal Worker's own pattern rather than a new one: a Producer writes a row in its transaction and
the side-effecting work happens after it commits.

**The Messenger has no worker and does not know one exists.** Its `start` and `stop` stay no-ops.
The listener belongs to whichever channel needs one, and HTTP needs none. The word "worker" is not
used for it in any document, because `CONTEXT.md` spends that word on the Signal Worker, where it
means *"one Signal at a time, globally"*.

## Ordering in the Gateway's record

The Messenger **and** every channel are keyed before the Signal Worker. ADR-0034's reason applied to
one component and now applies to two: a Signal Handler's post phase sends a failure notice after
the drain ([ADR-0017](./0017-failed-runs-are-not-retried.md)), and that notice now runs
`messenger.send` into `channel.send`, so both have to outlive it.

## Considered and rejected

**A `Transport` type, and the word.** Rejected as a name on ADR-0034's own argument: *"The transport
reading of the name would say nothing: every part of this framework is reached over HTTP, the agent
included."* "The HTTP Transport" is that tautology written down. **Channel** names a route to a
person, which is the thing.

**`deliver()` as the interface member.** Rejected while the objection looked like "one real
implementor and one no-op", which turned out to be wrong twice: no-op members are already defended
here, and the real problem with `deliver` is that it promises arrival, which Nostr cannot provide.

**`reachable(userId)` as a third member**, letting `send` fail fast. Rejected: `channel.send`
already runs inside the transaction and can resolve the address itself, so the fail-fast exception
is available without an interface member and without a second query.

**Fan-out with no channel named**, and **a per-User preferred channel**. Both rejected as framework
policy. Routing is the Signal Handler's, which is
[ADR-0006](./0006-session-routing-is-chosen-by-the-signal-handler.md) one layer out, and a Handler
holds the Signal that says where the conversation is. Both become relevant again the day a second
channel is constructable, and neither is the framework's call then either.

**Naming the component `Messages`, per [ADR-0044](./0044-components-are-named-for-what-they-own.md).**
That rule turned Signer into Signatures and User Manager into Users, and it was aimed at a
component named after one of its routes. This component holds the log, registers channels and emits
the Signal; "Messenger" covers all three where "Messages" covers one. `CONTEXT.md` had also already
reserved the name for exactly this arrival: *"the qualifier is the one price paid up front for a
peer that may never exist."* The price is refunded.

**A shared identity table on Users**, mapping `(scheme, subject)` to a User so a Nostr Channel and a
future NIP-98 Authenticator would read one row. Rejected, and the reasoning is worth keeping because
it nearly went the other way. A pubkey survives the removal of either part, which argues it is
identity and belongs to neither; but three writers in three parts and a `unique` constraint that
delivers *uniqueness without authenticity* made it a trust root shared between messaging and
authentication for the sake of one duplicated row. Full separation was cheaper: the Nostr Channel
owns its own pubkey table, a future Authenticator owns its own copy, and two private tables can
always be unified later where a shipped shared one cannot be unshipped.
