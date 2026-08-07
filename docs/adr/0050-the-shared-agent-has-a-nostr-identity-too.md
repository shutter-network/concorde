# The Shared Agent has a Nostr identity too

A Shared Agent that runs a Nostr Channel holds **a second keypair**: secp256k1, BIP-340 Schnorr,
32 raw bytes, held by the Channel and not by Signatures. It is not a second name for the signing
identity and it cannot become one, because the curves differ.

This **amends [ADR-0041](./0041-the-shared-agent-has-a-signing-identity.md)** on one sentence that
`CONTEXT.md` repeats: *"One Shared Agent, one keypair, and no second name for it, so copying the key
copies the agent."* Both halves stop being true. Nothing else in ADR-0041 changes: the Operator still
holds every key in trust, which is [ADR-0001](./0001-the-gateway-is-trusted.md)'s trust applied to
one more asset, and what a signature proves is still what that ADR said unflatteringly.

## The keys cannot be one key, and this is not a preference

NIP-01: *"Signatures, public key, and encodings are done according to the Schnorr signatures
standard for the curve `secp256k1`"*, with x-only 32-byte public keys, hex on the wire. The signing
identity is Ed25519, and [ADR-0042](./0042-a-signature-is-a-compact-jws.md) already refuses
secp256k1 at construction because `ES256K` is not in `jose`'s algorithm table. That refusal was
about a key that could not produce a JWS; the same fact read from the other side says an Ed25519 key
cannot produce a Nostr event. There is no mapping between the curves, so a deployment running both
Signatures and a Nostr Channel holds two secrets.

Node makes the middle ground unavailable too. `node:crypto` will handle `secp256k1` as a named EC
curve, but only for **ECDSA**, not BIP-340 Schnorr, and WebCrypto rejects the curve outright. So even
a secp256k1 PEM would need `@noble/curves` to sign an event, and would need its parity byte stripped
to be a Nostr pubkey.

## Two identities, two audiences, and different blast radius

This is the useful thing to write down, because "the agent has two keys" invites the question of
which one *is* the agent.

- **The Ed25519 key is what a verifier of a Decision checks.** Its audience is a party who never
  touches the Gateway: an external system, or a Party's auditor holding a public key
  ([ADR-0043](./0043-decisions-are-one-global-log.md)).
- **The Nostr key is what a User's client sees as the agent's npub.** Its audience is the people
  talking to it.

**Copying the Nostr key lets you impersonate the agent to its users. Copying the Ed25519 key lets
you forge its commitments.** Only the second forges anything a third party would rely on after the
fact, and only the first is exposed to whoever operates the relay. So the two are not
interchangeable in value either, and a deployment that rotates one has not rotated the other.

A rotation consequence follows and is recorded rather than solved: **the Nostr pubkey is an address
as well as an identity**, so rotating it invalidates every `saf_nostr` pubkey row from the other
side, and every User's client still holds the old npub. There is no rotation mechanism, in the same
sense that there is none for the signing identity.

## The constructor takes 32 raw bytes

`createNostrChannel({ secretKey: Uint8Array, ... })`. This is the libraries' own convention, read
from the installed packages: `nostr-tools`' `generateSecretKey()` returns a `Uint8Array`,
`getPublicKey(secretKey: Uint8Array)` returns hex, `finalizeEvent(t, secretKey: Uint8Array)`, and
`@nostrify/nostrify`'s `NSecSigner(secretKey: Uint8Array)`. `nsec1…` is a human-handling encoding
only, and NIP-19 says so: those forms *"MUST NOT be used in NIP-01 events"*.

It also keeps ADR-0041's rule literal: **the framework parses no key material and generates none**,
so a deployment brings its own identity or does not start. `createSignatures` takes a `KeyObject`
the Operator produced from a PEM they read; this takes bytes the Operator decoded from a file they
read. **No `nsec` decoder is shipped**, because shipping one would be the framework parsing key
material behind a friendlier name. An Operator holding an `nsec` calls `nip19.decode` themselves.

## Signatures does not hold it, and the glossary has to say so

`CONTEXT.md` describes Signatures as *"The Component that holds the Shared Agent's signing identity"*.
There is now an identity it does not hold. The Nostr key goes to the Channel, because Signatures
makes compact JWS and this key cannot make one, and because Signatures **stores nothing and has no
schema** ([ADR-0047](./0047-a-component-is-one-subpath.md)), which is a shape worth not disturbing
for a key only one other component can use.

The consequence is that **no single component can answer "who is this agent"**, and nothing tries to.
There is no combined identity document, no JWKS entry for the Nostr key (it is not a JWK-expressible
key for any algorithm `jose` will sign with), and no route that lists both. A verifier of a Decision
and a User with a Nostr client are asking different questions of different components.

## The example needs a second decoy

`example/insecure-example-only-signing-key.pem` is a committed throwaway PKCS8 Ed25519 key whose
worthlessness is shouted at four points of contact: its filename, `compose.yml`, `main.ts`, and the
quickstart. A committed throwaway Nostr secret gets the same four, so that
`docker compose up -d --build` still comes up from a fresh clone with no manual key step.

It is committed **hex-encoded** rather than as an `nsec`, so `main.ts` reads it with one line and no
import, which mirrors the PEM read and avoids the example depending on `nip19` to demonstrate a
constructor that takes bytes.

This lands only when the Nostr Channel reaches `example/`, which
[ADR-0048](./0048-the-messenger-owns-the-log-and-channels-reach-people.md) defers: one channel per
Messenger means the example keeps HTTP.

## Considered and rejected

**Reusing the signing identity.** Impossible, above. Recorded because it is the first thing a reader
will ask.

**Taking an `nsec1…` string in the constructor.** The most convenient form, since it is what every
tool emits and what NIP-49 encrypts. Rejected on ADR-0041's parse-nothing rule: the framework would
be decoding key material, and a constructor that accepts a bech32 string will be asked next to
accept hex, and then a file path.

**A signer interface** of `{ getPublicKey, signEvent, nip44: { encrypt, decrypt } }`, so the secret
could live in a NIP-46 remote bunker or an HSM and never enter the Gateway. This is the right
eventual shape and is **deferred rather than rejected**. Worth recording that it is bigger than it
looks: gift wrapping needs *encryption and decryption*, not only signing, because conversation keys
are ECDH with the agent's secret, so the interface is three capabilities rather than one. NIP-46
happens to expose all three as RPCs.

**Signatures holding both keys** and handing the Nostr one to the Channel. Rejected: it would give
Signatures a key it cannot use for any of its three routes, and the thing it would buy, one place to
ask who the agent is, is not a question anything asks.
