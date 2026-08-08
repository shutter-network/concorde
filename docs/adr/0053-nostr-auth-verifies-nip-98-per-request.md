# Nostr Auth verifies NIP-98 per request

The second Auth
([ADR-0052](./0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)) accepts
a NIP-98 event on every request instead of issuing anything. A client signs a kind 27235 event naming
the URL and the method, sends it as `Authorization: Nostr <base64>`, and Nostr Auth verifies it,
looks the author up among the public keys the Operator granted, and answers with that User. There is
no login route, no Token, and no route of any kind.

This ships **with** ADR-0052 and not after it. Almost everything that decision adds is inert with one
Auth: the walk, the `absent` outcome, the header naming schemes, stopping at the first refusal. Half
of it would have been a mechanism built for a population of one, which is the shape ADR-0048 refused
for Channels on its own argument that *"a `channel` column that is constant in every row is a column
that answers no question."*

## The library's validator cannot be used

`nostr-tools` ships `nip98.validateToken`, and this component does not call it. Its freshness check
is one-sided:

```js
return Math.round(new Date().getTime() / 1e3) - event.created_at < 60;
```

An event stamped in the future subtracts to a negative number, passes, and **passes forever**. So a
client that sets `created_at` ten years ahead holds a credential with no expiry, and a client with a
fast clock holds one by accident.

The answer is the one
[ADR-0049](./0049-the-nostr-channel-speaks-nip-17-to-one-relay.md) already reached about
`unwrapEvent`: verify by hand over the primitive. `verifyEvent` is the primitive here, and the checks
above it are ours, with the window applied in **both** directions. Rewriting this through the
convenience function is the thing to refuse in review, exactly as it is in `envelope.ts`, and for the
same reason: the library's shape is not merely missing a check, it makes the check unexpressible.

The `u` tag is compared against an absolute URL, so the component is **told** its external base URL
at construction rather than reading Fastify's. Behind a proxy those differ, and a mismatch is the
likeliest first-run failure of the whole component. It is also the case the disclosure rule in
ADR-0052 exists for: the reason reaches the log, the client gets `invalid_token`.

## A replayable credential needs a table, and the table prunes itself

Nothing in NIP-98 prevents replay. A captured header is valid for the rest of its window, and on the
HTTP Channel's submission route that means the same Message twice and the agent woken twice. So every
admitted event id is recorded and a repeat is refused, which is the same mechanism and the same
argument as the Nostr Channel's `received` table: an inbound Nostr DM and an inbound Nostr-signed
request are one trust situation, and answering them differently inside one deployment would be an
inconsistency a reader trips on.

**The delete runs in the transaction that writes the row**, and this is a deliberate departure from
ADR-0030, which refused a reaper for the token table:

> **Tokens accumulate forever.** ... A background sweeper was refused as disproportionate, so a
> deployment that cares runs a periodic delete.

That is affordable because tokens grow at **login** rate. This table grows at **authenticated
request** rate, one row per request, where the useful contents are the last minute. Handing an
Operator a table that gains a million rows a day to hold sixty seconds of facts is a different
promise from handing them the token table. Pruning in the same transaction needs no lifecycle, no
configuration and no Operator action, and it buys a property worth stating plainly: **the table's
size is a function of traffic in the last window, not of traffic ever.**

The cost is one extra `DELETE` per authenticated request and concurrent requests racing on the same
dead rows, which PostgreSQL absorbs at the price of dead tuples and autovacuum. If that ever matters,
pruning probabilistically instead of every time is a change inside one function.

## A granted key is not a reachable key

The Nostr Channel already maps public keys to Users, and this component does not read that table.
ADR-0048 rejected a shared identity table and said a future Authenticator would keep its own copy.
**It turns out not to be a copy**, which makes that rejection stronger than the argument it was made
on:

- `saf_nostr_channel.pubkeys` means "I will send private direct messages to this key and accept them
  from it". Its primary key is `user_id`, deliberately, because the Channel must pick exactly one
  address to send to.
- Nostr Auth's table means "this key may act as this User over HTTP". It sends nothing, so nothing
  forces one key per User, and a person with a phone signer and a laptop signer has two. Its primary
  key is the **public key**, with `user_id` an ordinary column.

Two grants that share a value, with different cardinalities, in different directions. A person may be
reachable over Nostr without being allowed to drive the HTTP API as themselves, and the reverse.

Rows are written from **trusted code only**, `recordPublicKey`, mirroring the Channel's and carrying
the Channel's argument: no route on either server records one, so an injected prompt cannot grant
itself a User's identity. **Enrolment stays deferred**, exactly as the specification left it: a
deployment that wants a logged-in User to prove control of a key holds both components and writes
that route itself.

## The Channel's schema is renamed

`saf_nostr` was *"named for the protocol rather than for the component"*, which was fine while one
component spoke Nostr and is wrong the moment two do. It becomes **`saf_nostr_channel`**, and Nostr
Auth takes `saf_nostr_auth`. Nothing is deployed, so this costs a rename today and would cost a
migration later.

## Consequences

- **Nostr Auth registers no route on either server**, which makes it the second component of which
  that is true, after the Nostr Channel. A deployment running Nostr Auth and the Nostr Channel and
  nothing else has an empty Public server that still authenticates every request on it.
- **The two Nostr tables are written by two calls and nothing checks that they agree.** A key granted
  for messaging but not for authentication is a person who can direct-message the agent and gets 401
  on `GET /decisions`, with no single place to look. This is the recorded cost of ADR-0048's full
  separation, now paid for the first time.
- **`nostr-tools` is no longer the Nostr Channel's alone.** `biome.json`'s single confinement entry
  gains `!src/nostr-auth/**` and its message stops saying "the Nostr Channel's alone".
  `src/import-confinement.test.ts` gains the case, since that entry is asserted by running real Biome
  rather than by reading the configuration. Per that entry's known cost, the new exclusion frees `pg`
  and `jose` in that directory too.
- **Authentication over Nostr is a write.** A `GET` under this Auth inserts a row and deletes some,
  where the same request under Password Auth is one indexed select. The asymmetry is real and belongs
  in the component's documentation rather than in a reader's surprise.
- **Six failures are distinguishable and one is not.** Signature, kind, window, `u` tag, method and
  payload hash all reach the log with a reason. An author no `pubkeys` row grants is refused with the
  generic code, because that answer would otherwise tell a stranger which keys are enrolled.
