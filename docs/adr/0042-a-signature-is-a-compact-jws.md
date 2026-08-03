# A signature is a compact JWS

A **Signed Statement** is a compact JWS ([RFC 7515](https://www.rfc-editor.org/rfc/rfc7515)),
`header.payload.signature`, base64url, one URL-safe string. The Signatures component makes
them, checks them, serves the public key, and **stores nothing**.

```
eyJhbGciOiJFZERTQSIsInR5cCI6InNhZi1kZWNpc2lvbitqd3MifQ.eyJzZXEiOjcsImNyZWF0…
header   {"alg":"EdDSA","typ":"saf-decision+jws"}
payload  {"seq":7,"createdAt":"2026-08-03T10:14:02.318Z","statement":"…"}
```

## Why a standard, and why this one

The hand-rolled alternative was a documented preimage — a domain separator, the fields, the
statement last so it could contain anything — and it was the design until the question "isn't
there a standard for this?" was asked. There is, and it does two jobs better than the
hand-rolled version did.

**The scheme is inside the signature.** The signing input is
`BASE64URL(header) || '.' || BASE64URL(payload)`, so `alg` is covered: swap it, or swap `typ`,
and verification fails. A hand-rolled preimage has to remember to include its own version tag;
JWS cannot omit it.

**Canonicalization never arises.** "Sign canonical JSON" is a footgun — key order, unicode
escaping, number formatting, whether the verifier's library agrees with ours — and it is
exactly why the first design refused JSON. JWS is safe *because it never re-serializes*: the
verifier decodes the bytes it was handed and parses them. A JSON payload is fine when it is
signed as bytes.

And it is verifiable everywhere: `jose`, `joserfc`, `PyJWT`, `go-jose`, `jose4j`, or browser
WebCrypto with no library at all.

## `jose` builds them, and this reverses an earlier draft

An earlier version of this ADR made "we emit it with no dependency" part of the argument: compact
JWS is three base64url segments over `node:crypto`, which `src/users/secrets.ts` already uses for
scrypt "and therefore no dependency". **That was the wrong instinct, and it is reversed here.**
Signatures depends on [`jose`](https://www.npmjs.com/package/jose) — zero dependencies of its own,
`type: "module"` so it needs nothing bridged for [ADR-0026](./0026-one-esm-only-package-built-with-tsc.md),
and its `KeyInput` accepts a Node `KeyObject` directly, so the key option below is unaffected.

What hand-rolling would have kept in our hands is the reason not to:

- **The `alg` → (hash, `dsaEncoding`, padding) mapping.** This was the most dangerous code in the
  design and it is now `jose`'s. The trap is concrete and was measured rather than imagined: Node's
  `sign()` emits **DER** for EC unless passed `dsaEncoding: "ieee-p1363"`, giving a 71-byte `ES256`
  signature where RFC 7518 requires exactly 64 — and our own `verify()` accepts the 71-byte one
  happily. A self-consistent implementation cannot see the bug; every other library on earth
  rejects the artifact.
- **Key/alg compatibility.** `jose` throws when a key cannot perform the stated `alg`. Hand-rolled,
  this had to be an explicit construction check, because `sign(null, data, key)` does *not* throw on
  a non-Ed25519 key — an RSA key signs happily, producing a JWS whose header claims `EdDSA` with an
  RSA signature inside, unverifiable by everyone and detectable only in somebody else's verifier.
- **Verification parsing** for `POST /verify`: segment count, malformed base64url, an unparseable
  header. All defensive code we would have written.
- Segment assembly, base64url, and the JWK export.

What stays ours is small, and is no longer dangerous: deriving `alg` from the key when it is not
given. Get that wrong now and `jose` throws at construction; get it wrong in the hand-rolled design
and we shipped an artifact nobody could verify.

**Consequences of the dependency**, each small: a fourth runtime dependency on a caret range beside
`handlebars`, `pg` and `pino`; `scripts/check-package.ts` must *import and call* it in the runtime
step, which Signatures satisfies by existing; and signing is `async`, which `publish` already is. A
plain **dependency and not a peer**, unlike `fastify` and `drizzle-orm`: nothing of `jose`'s crosses
our API, since we answer with strings and the key type is `node:crypto`'s.

**And it inverts the test oracle.** With `jose` signing, a test that verifies with `jose` is
self-verification. The independent implementation is now the built-in one: tests verify the emitted
string by hand with `node:crypto`, and assert the artifact's structure directly — 64 bytes for
Ed25519, base64url with no `+`, `/` or `=`, the signing input reconstructed by splitting the
**emitted** string rather than rebuilt from our own objects, and **no `d` member in `jwks.json`**,
which is what stands between a wrong key argument and the private scalar being served from an
unauthenticated route.

Rejected, with reasons worth keeping:

- **OpenPGP / GPG.** Needs a real library on both sides, Node ships nothing, and the cleartext
  signature framework has its own canonicalization traps in dash-escaping and trailing
  whitespace. Its key model is PGP packets and a web of trust; we have one raw key and no trust
  graph. Adopting a system to use 5% of it.
- **SSH signatures (`SSHSIG`).** Ed25519-native, has a namespace field for domain separation,
  and `ssh-keygen -Y verify` is on every machine — but library support outside OpenSSH is thin,
  and the wire format is length-prefixed blobs rather than three strings.
- **A JWT.** JWS with claims semantics, and the trap next door: verifiers' JWT libraries
  routinely reject a token with no `exp`, and a Signed Statement never expires. Hence JWS with
  our own field names — `statement`, `createdAt`, `seq` — and a `typ` that keeps it out of a
  JWT validator's hands.
- **PASETO.** Better designed (the version implies the algorithm, so there is no `alg` to
  confuse), and dropped on ecosystem size alone.
- **A bare signature over the statement bytes.** No domain separation, so any other thing this
  identity ever signs is replayable as a Statement and vice versa.

## The key is a `KeyObject`, and `alg` is derived unless the key is ambiguous

`signingKey` is a `crypto.KeyObject`; the framework parses no PEM and reads no environment.
The Operator writes `createPrivateKey(readFileSync(path))` and decides for themselves whether
that path came from a file, an env var or a secrets manager — the same division as `HOST_DIR`
in `example/main.ts`, and [ADR-0016](./0016-agent-configuration-is-opaque-to-the-framework.md)'s
instinct applied to a secret. A `KeyObject` also holds its material in the OpenSSL layer rather
than as a JS value, so it does not stringify into a log line by accident.

`signingAlg` is **optional and derived from the key**, because for every key type but one the
key determines it: `OKP`/`Ed25519` and `OKP`/`Ed448` give `EdDSA`, and `EC` with `P-256`,
`P-384` or `secp256k1` gives `ES256`, `ES384` or `ES256K`. **RSA is the exception** — `RS256`,
`RS384`, `RS512`, `PS256`, `PS384` and `PS512` are all valid for the same key, and
`asymmetricKeyDetails` carries only `modulusLength` and `publicExponent`. So an RSA key throws
at construction with a message naming the choice. There is no standard *derivation*: JWK has an
optional `alg` member ([RFC 7517](https://www.rfc-editor.org/rfc/rfc7517) §4.4) and Node leaves
it absent for every key type.

One detail is still a bug if written the other way, and the other two moved to `jose`:

- **Derive from the JWK export, not from `asymmetricKeyDetails`.** The latter gives OpenSSL's
  curve names — `prime256v1`, `secp384r1` — where the JWK gives JOSE's own, `P-256` and
  `P-384`. The JWK is already the vocabulary the header needs, and it is the vocabulary `jose`
  is handed.
- The `alg` → (hash, `dsaEncoding`, padding) mapping and the key/alg compatibility check are
  **`jose`'s**, for the reasons in the section above. Do not reintroduce either; a second
  mapping that disagrees with the library's is worse than none.

**Two costs, recorded.** A `KeyObject` cannot represent a **KMS or HSM key**, which is
asynchronous and has no exportable private half; a signer-function seam would have supported it
and is given up. And an RSA key with no `signingAlg` **still throws at construction** — that
refusal is ours, not `jose`'s, because the ambiguity is in the key rather than in any algorithm.

## `typ` is the agent's, and nothing is reserved

`POST /sign` takes a `typ` and defaults to `saf-statement+jws`. The Decisions component passes
`saf-decision+jws` through the in-process method. **`saf-decision+jws` is not reserved**, so the
agent can ask for it, and that is fine: the agent already has the authority to make Decisions —
`POST /decisions` *is* that authority — so a decision-typed artifact minted through the generic
route is the same authority exercised without a log row, not a forgery.

The positive argument is stronger than the absence of a negative one. **Domain separation between
the agent's own categories is something only the agent can express.** If it signs receipts, votes
and approvals, each wants its own `typ` so a receipt cannot be replayed as a vote; under one fixed
label they collapse into one domain and cross-replay between them becomes possible. The framework
does not know those categories exist. Explicit typing is
[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725) §3.11's own recommendation, and
[RFC 9068](https://www.rfc-editor.org/rfc/rfc9068)'s `typ: "at+jwt"` is the same move.

**Consequence: `typ` is the agent's signed claim about its artifact, not a framework guarantee.**
A verifier holding a `saf-decision+jws` learns this identity labelled it a Decision — not that it
is shaped like the Decisions component's, and not that a row exists. Only an artifact *fetched
from the log* is guaranteed well-formed. Policing `typ` would be an opinion the framework holds
nowhere else; it does not police what the agent puts in a Message either.

## Three routes, and what the second one is worth

| Server | Route | |
| --- | --- | --- |
| Agent | `POST /sign` | `{ statement, typ? }` → the Signed Statement |
| Public | `POST /verify` | the lazy check |
| Public | `GET /jwks.json` | the JWK Set, unauthenticated |

**`POST /verify` proves less than it looks like it proves, and that must be documented rather
than fixed.** It answers "is this signature ours?" and *you have to believe the answer*: to the
verifier the identity exists for — a third party who does not trust the Operator — a
Gateway-supplied verdict is worthless, since a dishonest Gateway says `true` to anything. It is
genuinely useful to a **User**, who trusts the Operator already (ADR-0001) and wants a check
without embedding a JOSE library. So it ships as the convenience it is, and the documentation
says real verification is offline against the public key.

`GET /jwks.json` is what makes that possible, and it serves a JWK **Set** — `{"keys":[…]}` — even
with one key, because that is RFC 7517's own container and it means a client points `jose`'s
`createRemoteJWKSet` at the URL with no glue. A bare JWK needs hand-parsing in every language.
Unauthenticated, a public key being public.

## Consequences

- **`jose` is a runtime dependency of Signatures alone.** Decisions never touches a JWS — it asks
  for one and stores the string — so nothing else in the framework imports it. An earlier draft of
  this ADR argued for hand-rolling and no dependency, and the section above records why that was
  reversed rather than deleting it.
- **The Signatures component has no schema, no tables and no migrations** — the first part of the
  framework with none. It is a Component anyway
  ([ADR-0037](./0037-the-gateway-is-a-record-of-components.md)), on the User Manager's grounds:
  the record holds every part, not only the ones that run.
- **Signing is unrecorded, and that is a real regression from what ADR-0041 could otherwise
  claim.** An injected agent mints unlimited Signed Statements with no row anywhere. Mitigated,
  not solved, by logging each signing at info level with the `typ` and a **SHA-256 digest** of
  the statement rather than the statement itself, so the trail is a trail and not a shadow copy
  of everything the agent ever signed sitting in stdout. Logs are for operations, which ADR-0001
  already says.
- **The wire format is frozen the day the first Statement is signed.** A verifier reconstructs
  nothing, but they do parse; `saf-decision+jws` and `saf-statement+jws` are the only escape
  hatch, and changing the payload's field names is a new `typ`.
- **Prefixes are fixed and no route plugin is exported**, on
  [ADR-0034](./0034-the-http-messenger-is-an-opinionated-messenger.md)'s reasoning: these routes
  are half of a contract whose other half is the artifact shape.
