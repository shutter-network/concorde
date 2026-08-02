# The HTTP Messenger is an opinionated Messenger

The first messaging Producer to ship is not *the* Messenger. It is the **HTTP Messenger**,
and it is named for the freedoms it declines rather than for its transport. The transport
reading of the name would say nothing: every part of this framework is reached over HTTP,
the agent included ([ADR-0010](./0010-the-agent-reaches-the-gateway-over-http.md)). The
qualifier is free for a more useful job, which is to say that this part is one set of
choices out of several a messaging Producer could make, and that a deployment disagreeing
with them is disagreeing with *this* part rather than with the framework.

Four freedoms declined:

1. **The content shape.** A Message is a `text` string. No `jsonb`, no payload convention,
   no registry of payload types.
2. **The Signal `kind`.** The constant `message.received`, exported, and not a construction
   option. Two HTTP Messengers in one Gateway are unconstructable anyway (duplicate routes,
   one shared schema), so the only use for a configurable `kind` would be dodging a
   collision with the Operator's own Producer, and they are the party who can rename: their
   Handler map is a literal in their own entry point.
3. **The route layout.** Both route groups land at `/messages`, on the Public server and on
   the Agent server respectively, and there is no prefix option.
4. **The wiring.** Both servers are required constructor arguments, and no route plugin is
   exported.

## Fixing the shape inverts ADR-0007's premise

[ADR-0007](./0007-messages-carry-arbitrary-json-payloads.md) left the payload arbitrary and
gave a reason: a fixed envelope with declared payload types "would cost every deployment
something in order to buy a property nobody needs", because "user-facing clients of a
Shared Agent are built for that specific agent and may carry domain knowledge, so there is
no generic client to serve".

That reasoning is sound and its premise is contingent. It is true of a framework, which has
no client at all, and false of the first thing anyone builds with one: a person typing into
a text box and reading what comes back. Fixing the shape is not an exception to ADR-0007's
argument, it is the argument run in the other direction. **A fixed shape is what creates
the generic client ADR-0007 correctly observed did not exist.** With a `text` column, a
client is a text box, a list and two query parameters, and it is portable across every
deployment that constructs this part.

The cost ADR-0007 named is real and is still paid, only by a different party: a deployment
whose Messages are not text pays it, and pays it by not constructing this part. That is
cheaper than the arbitrary payload was, because the arbitrary payload charged every
deployment for the freedom, including the ones that wanted a text box.

## Requiring both servers, and exporting no plugin, is a departure

[ADR-0032](./0032-components-wire-themselves-at-construction.md) established two things
that both existing parts do. Server options are optional, so omitting one switches a route
group off; and the route plugins stay exported, because "passing the server is the easy
path; the plugin is the door out" for an Operator who needs our routes inside their own
scoped plugin, behind a shared hook, or under a version prefix.

This part does neither, and the divergence is deliberate rather than an oversight.

**Both servers are required** because neither half is a capability. The User Directory
without an Agent server is a deployment that manages Users elsewhere, and without a Public
server it is a deployment that authenticates its own way
([ADR-0030](./0030-passwords-are-traded-for-bearer-tokens.md)): both are coherent objects
that do less. An HTTP Messenger with no Public server cannot be reached by the people it
exists for, and one with no Agent server cannot be answered by the agent. Each is not a
smaller Messenger but a broken one, and making them unconstructable is cheaper than
documenting them.

**No plugin is exported** because the door out has nowhere to go. The User Directory's
plugin is useful in isolation: it is a set of routes over its own tables, and an Operator
mounting it under `/v2` still has a working User Directory. This part's routes are half of
a contract whose other half is the Signal `kind`, the record shape and a client written
against both. An Operator who needs these routes somewhere else, or behind a hook of their
own, is an Operator who wants a different messaging part, and ADR-0021 already says what to
do about that.

## A deployment that wants the freedoms back writes a peer

Not a configuration flag, and not a subclass: a **second messaging Producer**, with its own
PostgreSQL schema, its own Signal `kind` and its own tables, sharing nothing with this one
but the User Directory and the Signal Worker. That is the extension mechanism the framework
already has ([ADR-0021](./0021-the-framework-has-no-plugin-system.md)): a Producer is
ordinary code that emits Signals, and there is no plugin contract to satisfy. Nothing in
this part may assume it is the only one.

The cost is recorded rather than solved: **two messaging Producers mean two Message logs**,
and the agent reads a person's history from both, separately. There is no merged read and
no place to put one, because `seq` is per User and per log
([ADR-0035](./0035-a-users-messages-are-one-log-read-by-cursor.md)), so two logs cannot be
interleaved by one cursor. A deployment that wants one history keeps one Producer.

## Consequences

- **The name is the whole of the up-front price** for a second messaging Producer that may
  never exist. `CONTEXT.md` therefore has no unqualified **Messenger** term: this part is
  the HTTP Messenger, and a future peer names itself.
- **The part ships on its own subpath, `./http-messenger`.** The reserved and deliberately
  unresolvable `./messenger` stays reserved, and now says something it did not say before:
  that *the* Messenger is not what shipped.
- **A `kind` with no Handler registered is a 201 followed by a permanently failed Signal**
  ([ADR-0017](./0017-failed-runs-are-not-retried.md)). The Message is stored, the agent
  never sees it, and the failure is visible only on the Signal row. This is documented and
  not guarded: for the Messenger to check the Handler map, it would have to reach into the
  Worker for something [ADR-0024](./0024-signal-handlers-receive-only-the-signal.md)
  deliberately removed.
- **A retried POST is a second Message, a second Signal and a second Run**, and nothing
  notices. Idempotency is deferred rather than declined, and the fixed body shape is exactly
  why it can be: an `Idempotency-Key` **header** is addable later at no cost to it.
- **There is no `maxLength` on the text.** Fastify's 1 MB `bodyLimit` is already the bound,
  and it belongs to the Operator on the server they constructed rather than to us.
- **The record shape is one shape everywhere**: the POST response, both reads, the
  trusted-code methods and the Signal payload. `direction` is redundant in the payload,
  where it is always `inbound`, and `seq` is redundant for most Handlers. Both are paid so
  that the part has one shape rather than two kept parallel by hand.
