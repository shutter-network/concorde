# A User's Messages are one log read by cursor in both directions

`seq` is per User and monotonic across **both** directions, so a User's Messages are one
numbered sequence whatever direction they travelled. One `GET` serves both reads a client
needs: the newest page when it opens, and everything after a cursor when it polls. The
**Outbox retires as a concept**, and its stored cursor table is deleted rather than moved.

[ADR-0015](./0015-outboxes-are-cursor-read-logs.md) made `seq` outbound-only, and
[ADR-0007](./0007-messages-carry-arbitrary-json-payloads.md) recorded the consequence: "a
User polling their Outbox does not receive their own Messages echoed back". That was stated
as a property, and it is a cost. A client rendering a conversation has to keep its own
record of what it sent, merge two streams, and decide what to do when its own record and
the server's disagree. The read that the obvious client needs is "everything I said and
everything I was told, in order", and an outbound-only cursor cannot express it: the two
directions have no common ordering to merge on, because only one of them is numbered.

Numbering both directions in one per-User sequence makes that read a single indexed query,
`where user_id = ? and seq > ? order by seq`, and makes the poll and the render the same
request with different parameters. Nothing is lost on the agent's side, which already
ignored `direction` and read both directions interleaved.

## What survives of ADR-0015, and what falls

Everything ADR-0015 argues about cursors survives, because the argument was never about
direction. Retention rather than destruction, so a client crashing mid-fetch loses nothing
and a UI has history to render. No acks and no redelivery bookkeeping, because a cursor
already solves the problem they address. A per-User sequence rather than a global one, which
is what [ADR-0007](./0007-messages-carry-arbitrary-json-payloads.md)'s no-cross-User-counter
rule requires. Fetching stays idempotent and safe to retry. Delivery stays polling.

What falls is one word in its scope: the log is not outbound-only, so there is no view over
it to name, and **Outbox** stops being a term. It is worth saying that it was absorbed
rather than dropped: an Outbox was already defined as a filter over the Message log rather
than a store of its own, and this change deletes the filter, not the log.

## The stored cursor is deleted, not ported

`data-model.md` specified a table of one row per User holding that User's read position.
It is deleted, and the reason is that it never had an owner: **nothing ever said who
advances it**, and both possible answers are things ADR-0015 itself rejects.

If the *server* advances it on read, the read is no longer idempotent. Reading twice does
not return the same thing, retrying a dropped connection loses Messages, and that is
ADR-0015's destructive queue rebuilt one layer up, with the difference that the rows survive
and only the client's ability to find them is destroyed.

If the *client* advances it, by naming its position in a write, then that write is an
acknowledgement. ADR-0015 rejected acks as "bookkeeping for a problem cursors already
solve", and a stored ack is worse than the ones it rejected: it is per-User rather than
per-Message, so a client with two devices has one shared position and each device moves the
other's.

The cursor a client needs is the largest `seq` it has seen, which it already holds, because
it is holding the Messages. There is nothing to store.

## The cost: `seq` is no longer written by one serial writer

Under ADR-0015 only outbound Messages carried a number, and outbound Messages are written by
the Signal Worker, which is serial globally
([ADR-0012](./0012-the-gateway-is-a-serial-signal-worker.md)). Assigning the next number
was therefore free of contention by construction. Numbering inbound Messages gives that up:
inbound writes arrive from concurrent HTTP requests, one User's own several clients can post
at once, and an inbound write races an outbound one regardless.

This is a real cost of the decision, and it is paid in the insert rather than avoided:

- The insert computes `coalesce(max(seq), 0) + 1` for that `user_id` inside a **savepoint**,
  and `unique (user_id, seq)` is what makes a lost race visible rather than silently
  renumbering somebody.
- A unique violation is retried, **bounded at five**, then answered with a 503. Five is not
  a correctness number: it is the point at which further attempts are answering the wrong
  question. The bound exists because an unbounded retry turns one pathological client into
  O(n²) inserts on a route nothing rate-limits.
- The savepoint is required whether or not the retry exists, because a constraint violation
  aborts the enclosing transaction, and on the inbound path the enclosing transaction is the
  one that also emits the Signal.

An advisory lock and a per-User counter table were both considered. They have identical
semantics to each other and to the retry, and the retry was chosen because it adds no state
and no new idiom to a repository that has neither today. Contention here is self-inflicted
and bounded: the only writers who can race for a number are one User's own clients, plus at
most one Run.

## Consequences

- **Invariant 2 of `data-model.md` still holds.** `seq` is scoped per User, so nothing about
  how busy the agent is for anyone else is legible in it. Carrying both directions changes
  what is numbered, not whose activity influences the number.
- **One read surface, three cursor cases, one order.** No cursor returns the newest page;
  `before=N` returns the newest page strictly below N; `after=N` walks forward from N. All
  three answer ascending by `seq`, so a client concatenates pages without reversing
  anything. Passing both is a 400, because it describes two windows.
- **The envelope carries no `hasMore`.** A full page says it: `messages.length === limit`.
- **Retention has nothing to configure**, which diverges from ADR-0015's "retention is kept
  by default and configured per deployment". Nothing removes a Message: no route, no TTL, no
  sweeper and no option. The table grows forever, exactly as `tokens` does, and that is an
  operational note rather than a background job.
- **There is no read state of any kind.** No stored cursor, no unread count, no receipts, and
  no cross-device sync. A second device shows the whole conversation, which is the behaviour
  a durable log gives away for free.
- **Push delivery stays addable without touching the data model**, because `?after=<seq>` is
  already the resume mechanism. The day SSE or long-polling arrives, this part becomes a
  Component ([ADR-0031](./0031-parts-that-run-are-components.md)) with a `LISTEN`
  registration and a `stop` that closes open responses. Until then it has nothing to start.
