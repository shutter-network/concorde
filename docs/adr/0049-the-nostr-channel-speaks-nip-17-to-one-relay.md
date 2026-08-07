# The Nostr Channel speaks NIP-17 to one relay

The Nostr Channel exchanges NIP-17 private direct messages, gift-wrapped per NIP-59 and encrypted
per NIP-44, over a single WebSocket connection to **one relay the Operator runs**, authenticated
with NIP-42. It speaks no NIP-04. It publishes a kind 10050 relay list about itself and nothing
else. It stores three tables and treats the relay as a transport rather than a store.

A Channel in the sense of
[ADR-0048](./0048-the-messenger-owns-the-log-and-channels-reach-people.md): it owns reaching a
person, and the Messenger owns the log.

## NIP-17 only, on a shrinking-island argument rather than a privacy one

NIP-04 is one event: AES-256-CBC over an ECDH secret, recipient in a `p` tag. Its own spec text
carries the header tags `unrecommended` and *"deprecated in favor of NIP-17"*, says it *"leaks
metadata in the events"*, and says it *"must not be used for anything you really need to keep
secret"*. A relay, and any anonymous reader of that relay, sees sender, recipient, real timestamp,
approximate length, and the whole conversation graph.

**The privacy argument for NIP-17 is weaker here than it looks**, and that is worth writing down so
nobody re-derives it as decisive. The leak is to whoever reads the relay; the relay is the
Operator's; the Gateway is trusted with everything already
([ADR-0001](./0001-the-gateway-is-trusted.md)); and the plaintext sits in the Operator's own Message
log regardless. Close anonymous reads with NIP-42 and most of the leak is closed with them.

What decided it is that **the NIP-04 island is shrinking rather than stable**. Research into current
client source found Amethyst, written by NIP-17's own author, *removed* NIP-04 in v1.06.0
(2026-03-21), while Damus and Primal remain kind-4 only with no NIP-17 code in either. There is
therefore no single protocol that reaches the whole ecosystem, and a new component should not ship
onto the side being abandoned.

**Dual-stack was refused.** It doubles the crypto surface, adds a second inbound path, and requires
per-recipient protocol selection by reading each User's kind 10050, all to serve an audience the
Operator hand-picks. Which is the fact that makes this choice cheap for this framework and expensive
for a public agent: the deployment is permissioned, Users are preregistered, and onboarding already
says "add this relay", so it can equally say "use a client that speaks NIP-17".

**The recorded cost is blunt: the agent is unreachable from Damus and Primal**, which are plausibly
most Nostr users.

## We reimplement NIP-59's unwrap, because the library cannot express the one MUST

NIP-17 states a `MUST` that is the whole authentication of the envelope:

> Clients MUST verify if pubkey of the `kind:13` is the same pubkey as that of the
> `unsignedMessageRumor`, otherwise any sender can impersonate any other by simply changing the
> pubkey on the rumor.

It is the only authentication because the gift wrap is signed by a random one-time key and the rumor
is not signed at all. NIP-44's ECDH binds the *seal's* author honestly, since forging a seal that
claims another pubkey would need that pubkey's secret to produce a payload that decrypts. But the
rumor's `pubkey` is a plain field inside the seal, and nothing compares the two.

`nostr-tools` version 2.24.1 ships this, read from the installed package:

```js
function unwrapEvent(wrap, recipientPrivateKey) {
  const unwrappedSeal = nip44Decrypt(wrap, recipientPrivateKey);
  return nip44Decrypt(unwrappedSeal, recipientPrivateKey);
}
```

**It returns the rumor and discards the seal**, so a caller never sees `seal.pubkey` and the check is
not merely omitted but unexpressible. An attacker seals with their own key and writes a victim's
pubkey in the rumor; both layers decrypt cleanly; the function hands back a rumor that appears to be
the victim's. Since this Channel resolves a User from `rumor.pubkey`, that is one User speaking as
another into their Message log, and it is the bug 0xchat shipped for about two and a half years.

So the Channel unwraps in two explicit steps over `nostr-tools/nip44` and performs the comparison
itself. About ten lines, and they are the security core of the component:

```ts
const seal = JSON.parse(nip44.decrypt(wrap.content, convKey(sk, wrap.pubkey)));
if (seal.kind !== 13 || seal.tags.length !== 0) return;   // NIP-59: tags MUST be empty
const rumor = JSON.parse(nip44.decrypt(seal.content, convKey(sk, seal.pubkey)));
if (rumor.pubkey !== seal.pubkey) return;                 // the MUST
if (rumor.pubkey === agentPubkey) return;                 // nobody speaks as the agent
if (rumor.kind !== 14) return;                            // not a chat message
```

**A forged-rumor test is part of this decision, not a nicety.** It is the only thing that would
notice the check being refactored away, and no comparison of one HTTP response against another can
see it.

## One relay, and a deliberate violation of a MUST

NIP-17 also says: *"Clients MUST only publish events to the relays listed in the recipient's kind
10050 event. If such a list is not found that indicates the user is not ready to receive messages
and clients shouldn't try."*

**We publish to the Operator's one relay regardless, and read no recipient's kind 10050.** This is
recorded as a violation rather than described as a design, because a reader who knows NIP-17 will
otherwise assume it is a bug.

The justification is that the deployment is permissioned. Every User is preregistered by the
Operator, who tells them the relay; so the outbox model NIP-65 and kind 10050 exist to solve, which
is *discovery* between strangers, solves a problem this deployment does not have. Research measured
the general case going the other way: a message published to a relay the recipient's client does not
read is silently never seen, with no error and no bounce. Permissioned onboarding is exactly what
turns that from a broken feature into an onboarding step.

**NIP-42 auth is on**, wired to the same secret key: one `auth(challenge)` callback returning a
signed kind 22242. Without it a private relay is not private, and requiring auth for *writes* too is
what NIP-59's own spam-protection section recommends. One consequence follows from the crypto and is
worth stating so nobody configures around it: **a DM inbox relay can never authorize writes by
`event.pubkey`**, because a gift wrap is signed by a fresh random key. Authorization goes on the
NIP-42 identity or on the `p` tag.

**Which Relay to run is the Operator's choice and this framework does not make it**, but the research
that informed this ADR found one thing surprising enough to record, because an Operator will otherwise
assume the opposite: **advertising support for NIP-17 does not mean enforcing its read rule.** Relays
were driven with real gift wraps and a forged-recipient filter, and several served a victim's wraps to
an authenticated third party while listing NIP-17 among their supported NIPs. As of 2026-08-07:
`nostr-rs-relay` 0.10.0 enforced it correctly with two config lines (`nip42_auth` and `nip42_dms`), on
an amd64-only published image; Chorus was recommended by a broader survey because the same enforcement
is unconditional and default-on, at the cost of building the image; `nostream` ships the relevant option
**off**; and strfry's equivalent landed in early August 2026, is in no tagged release, ships off, is
undocumented, and leaked a victim's wrap to an authenticated third party under test. **Test the Relay
you choose with a forged-recipient request before trusting it**, and do not take a supported-NIPs list
as evidence. All of these findings will age; the method for checking them will not.

## We publish kind 10050 about ourselves, and no profile

One replaceable event at `start`, listing the Operator's relay with the spec's `["relay", url]` tag.
Republishing on every boot is idempotent because the kind is replaceable.

**It buys two narrow things and not discovery.** It stops Amethyst v1.06.0 and later refusing to
message a pubkey with no kind 10050, and it steers spec-compliant senders to the right relay. Only a
client already connected to that relay can read it, which is the onboarding assumption again.

No kind 0 profile, so the agent appears in clients as a bare npub. NIP-24's `bot: true` field was
considered for exactly the right reason (*"the content is entirely or partially the result of
automation"*) and is not worth a second published event yet.

Research found the tag name split nearly in half in the wild, 171 events using `["relay", url]`
against 117 using `["r", url]`. We publish the spec form only, on the grounds that the clients this
targets are the NIP-17 natives.

## No `since`, and the dedupe is a primary key

One subscription: `req([{ kinds: [1059], "#p": [agentPubkey] }])`. NIP-01 delivers stored events,
then `EOSE`, then live ones on the same iterator, so there is one code path and no catch-up mode.

**A `created_at` watermark is not a valid cursor for gift wraps.** NIP-59 randomizes the wrap's
timestamp up to two days into the past (*"all timestamps SHOULD be in the past"*), so an event
arriving now can be dated two days ago. Research measured this on a live relay: of 28 events a
`since`-less subscription received live, a `since = now` subscription on the same connection
received 2.

The answer is not a cleverer window. **The dedupe set is the correctness mechanism and `since` is
only an optimisation**, so we omit `since` entirely, re-read what the relay holds on every connect,
and let a `primary key` absorb the repeats. One table:

```
saf_nostr.received(event_id text primary key, received_at timestamptz)
```

The insert goes in **the same transaction** as `handle.receive`. A conflict means already processed.
Three other problems collapse into that one constraint: reconnect overlap, the `created_at` tie
hazard when paginating stored results with `until`, and the fact that a dropped stranger's event
gets no row at all and is therefore harmlessly re-dropped on every connect. Because only *admitted*
events get rows, the table is the same order of magnitude as the Message log and needs no pruning.

**Unknown senders are dropped and nothing is stored.** The system is permissioned, so an unknown
pubkey has no User to attach a Message to; and an agent whose npub is published will be DM'd by
strangers, so recording rejected ones would let anyone fill the Operator's disk.

## The wrap is built inside the transaction, and published once

`channel.send` resolves the pubkey, builds the seal and **a single** gift wrap, compares the
serialized event against the relay's advertised `max_message_length` from its NIP-11 document, and
stores the finished wrap in a queue row. The listener is then a pump: read, publish, delete on
`["OK", id, true, ""]`, or leave the row with a reason.

Building it early is what makes the size bound a synchronous throw rather than a lost message. A
32 KB reply becomes roughly a 66 KB wrap, about a 1.4 KB floor plus 2.1x because it is base64 of
base64, and strfry's default `maxEventSize` is 65536. Under the other ordering an over-long reply
would be a queue row that fails once and stops. It also keeps key material out of the listener and
makes the queue row self-contained.

**No self-copy.** `nip59.wrapManyEvents` produces a second wrap p-tagged to the sender so a client
can recover its own sent messages. The agent's record of its own messages is the Message log, so
`wrapEvent` is used instead: half the publish volume, and the agent's own wraps stay off its own
subscription.

**A failed publish is not retried.** The row stays with its reason and the Operator sees it. This is
[ADR-0017](./0017-failed-runs-are-not-retried.md) applied consistently, and its cost is recorded: a
relay restart during a send loses that Message, and recovering it is the Operator replaying a row by
hand. Retries, backoff and an attempt cap are all deferred, and the queue table is the place they
would land.

## The libraries, and why the socket is not ours

`@nostrify/nostrify` for the socket and `nostr-tools` for `nip44` and `nip19`, both **direct
dependencies with caret ranges**, confined to `src/nostr-channel/**` by a Biome override in the same
way `pg` is confined to `src/db/**`. They are not peer dependencies because nothing from either
crosses the API boundary: the constructor takes a `Uint8Array`, a URL string, and our own
components. The two existing peers, `drizzle-orm` and `fastify`, are exactly the two whose types a
consumer names.

The deciding fact against writing the socket ourselves, or using `nostr-tools`' own `Relay`, is at
`nostr-tools/lib/esm/relay.js:343-350`:

```js
const isReconnection = this.reconnectAttempts > 0;
…
if (sub.lastEmitted) { sub.filters[f].since = sub.lastEmitted + 1; }
```

**It injects `since` on reconnect even when none was supplied**, mutating the filter object in
place, and then filters client-side against it. So "omit `since`" is a decision that library
overrides on the first reconnect, and given the measurement above one reconnect discards nearly
everything in flight. `enableReconnect` also defaults to `false`. `NRelay1` instead stores the REQ
verbatim and replays it unchanged, defaults to `ExponentialBackoff(1000)`, and carries NIP-42 as a
first-class option with a post-auth retry.

The cost is transitive weight: ten runtime dependencies including `ws` (Node has a global
`WebSocket`), `websocket-ts`, `zod`, `lru-cache`, and `@types/node` in `dependencies`, which pushes
a types package into every consumer's tree. Hand-rolling the socket was the alternative, and
[ADR-0042](./0042-a-signature-is-a-compact-jws.md)'s principle cuts both ways: the *dangerous* code
here is the crypto and the seal check, and we take a library for the first and write the second
ourselves. It was decided the other way because a subtly wrong reconnect loses a User's messages
silently, and silent failure is the thing this codebase consistently declines to hand-roll.

Two API facts shape the Component. `NRelay1` connects when constructed and closes an idle socket
after 30 seconds by default, so it is constructed in `start` rather than in the Channel's
constructor, which keeps the convention that nothing connects at construction. And `close()` is
terminal, so `stop` then `start` builds a fresh one.

## Tests, and no real Relay among them

Every test runs against an **in-process fake Relay**: a WebSocket server implementing enough of NIP-01,
with configurable AUTH-challenge timing, since Relays differ on whether the challenge arrives on connect
or only when a client touches a restricted resource, and a client that waits for one before subscribing
deadlocks against the second kind.

**An opt-in test against a real Relay container was considered and declined.** It would have been the
shape `npm run test:container` already has for `pi`: skipped by default, one environment variable, its
own CI step. It is not built, for two reasons. Which Relay to run is unresolved (see the section above),
so the test would have encoded a choice nobody has made; and what it would add over the fake is real
AUTH timing, real event validation and real size limits, each of which the fake can be *told* to
reproduce. The cost is recorded rather than solved: **nothing in this repository ever speaks to a real
Relay**, so a divergence between the fake and every real implementation is invisible here and surfaces
in a deployment. The fake's fidelity is therefore load-bearing, and a bug traced to it should be fixed
by making the fake wrong in the same way a real Relay is, not by working around it in the Channel.

## Considered and rejected

**NIP-04, alone or alongside.** Above.

**A `since` window of two days plus a margin.** Rejected as strictly less correct for more code: it
still misses an event backdated beyond the window, and nothing detects the miss. It is one filter
field when history makes a restart slow, and by then the real number will be known instead of
guessed.

**NIP-77 negentropy as a gap-free backstop.** Genuinely the robust answer, and deferred: it depends
on relay support this deployment has not verified, and the `since`-less subscription already
re-reads everything the relay holds.

**Reading each recipient's kind 10050 and publishing there.** The interoperable design, and the
right one for a public agent. Rejected here because the deployment is permissioned, and taking it
would mean the Channel needs a relay pool rather than a relay.
