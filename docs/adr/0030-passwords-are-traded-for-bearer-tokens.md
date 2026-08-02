# Passwords are traded for bearer tokens

A User authenticates by presenting a password once, at a login route, and receives a
Gateway-issued **bearer token** which accompanies every request thereafter. The token
stays what [ADR-0014](./0014-users-are-opaque-ids-and-authentication-is-pluggable.md)
made it — the default request credential, the minimum that works for a REST client
without presuming a browser or a human. What changes is that the Gateway now holds
password hashes, superseding ADR-0014's *"It holds no passwords"*. Its neighbouring
claim survives untouched and is reaffirmed here: the Gateway **runs no
account-recovery flow**. No email, no reset tokens, no security questions. A forgotten
password is trusted code setting a new one.

Password-on-every-request was the alternative, and HTTP Basic against a stored hash is
the shape most web frameworks make easiest. It was rejected because the hash is a
memory-hard KDF by design, so every authenticated request would pay it and an
unauthenticated flood would become a memory-exhaustion amplifier. Caching a verified
credential to avoid that is a session with worse properties than a token. A stateless
JWT was rejected for the opposite reason: it cannot be revoked, which contradicts
ADR-0014's *"Deleting a User invalidates their credential"*, and recovering revocation
means a denylist table — the token table, reached by a longer road and with a signing
key to manage.

## The Authenticator is deleted

ADR-0014 named authentication a replaceable component, the **Authenticator**, and the
second half of its title goes with this decision. Its own justification is what
retires it: *"Pluggability is not motivated by any particular scenario — it is that
authentication is irrelevant to mediating a Shared Agent, so it stays out of the
core."* That goal is met by construction once the User Manager is a separate part
([ADR-0029](./0029-users-are-a-part-of-their-own.md)) — not registering its Public
server plugin is how a deployment replaces our authentication, exactly as
[ADR-0021](./0021-the-framework-has-no-plugin-system.md) says replacing the Messenger
means not constructing ours.

An interface would also have been the wrong seam. A `verify(request)` implementation
still has to answer "and where does the credential live?", so an OIDC deployment would
reimplement our token storage to satisfy an interface whose purpose was sparing them
work. **The useful extension point is issuance, not verification.** `issueToken` is
public: a deployment establishes identity however it likes — OIDC, a wallet signature,
a corporate header — and mints a token, after which every route in the Gateway,
including the Messenger's, still sees an ordinary bearer token and learns nothing about
how it was obtained. `password_hash` is nullable so such a User need never have one.

## How each secret is stored

The two want opposite treatment, which is the part most likely to be "corrected" later
by someone applying one rule to both.

The **token** is 32 bytes from `randomBytes`, and is stored as a plain single-pass
SHA-256 with no salt. A KDF exists to make a low-entropy input expensive to guess; the
token already carries 256 bits of uniform entropy, so stretching it would add
per-request cost for nothing, and a salt would defend against a precomputed dictionary
that cannot exist. Verification is a lookup *by* the hash, so the index does the
comparison and there is no per-row loop and no constant-time compare.

The **password** is scrypt from `node:crypto` — chosen over argon2 and bcrypt because
it is memory-hard, in the standard library, and needs no native build in a package
whose tarball check must import and call every runtime dependency. Its cost parameters
are stored **with each hash**, PHC-style, rather than fixed in code. This is not
anticipating a migration: with no account-recovery flow, fixed parameters could never
change at all, because raising them would make every existing hash unverifiable and the
only remedy would be a password reset for every User — the one thing this framework has
decided not to build. Stored parameters cost a format and a parser, and there is
deliberately no rehash-on-login: new passwords get the current cost, old hashes keep
verifying at theirs.

## Consequences

- **Nothing is rate limited, and no lockout exists.** The login route can be guessed at
  freely. [ADR-0013](./0013-the-core-framework-stays-generic.md) puts a concern the
  framework declines to decide at an extension point, and rate limiting belongs to the
  deployment's edge: an in-process limiter does not survive a second Gateway process,
  and it sits behind whatever proxy is already terminating TLS and already able to do
  this properly. Per-User lockout was refused outright — it hands an attacker a cheaper
  attack (locking a User out deliberately) than the one it prevents.
- **Failures are indistinguishable.** One status, one message, and a scrypt verify
  against a fixed dummy hash when no User matches, so neither the body nor the response
  time answers whether an account exists. Enumeration is worth something here, because
  attributes govern authorization.
- **Tokens accumulate forever.** `expires_at` is not nullable, so no token is immortal,
  but nothing reaps expired rows. A background sweeper was refused as disproportionate —
  the framework has no scheduled machinery of its own — so a deployment that cares runs
  a periodic delete, documented in the quickstart as an operational note.
- **Revocation is the User's, and it is the only removal there is.** Logging out drops
  the presented token; a second route drops all of a User's tokens. Since ADR-0029
  removes Users never, these routes are the sole mechanism by which any credential in
  the system stops working before it expires.
- **A User may change their own password, and may not recover one.** Changing requires
  the current password, so it proves possession of the credential rather than replacing
  it without proof, which is the line between self-service and account recovery.
- **`request.safUser` is public API.** A `declare module "fastify"` augmentation is
  shipped, so every deployment's `FastifyRequest` gains the field whether or not it
  constructs the part. The name is namespaced because an unqualified `user` is what
  `@fastify/jwt` claims. The value is assigned by a preHandler rather than declared with
  `decorateRequest`, which costs one hidden-class transition per authenticated request
  and buys back the whole problem `decorateRequest` creates for a library: a decoration
  is scoped to the plugin instance that made it, so escaping that scope means depending
  on `fastify-plugin` and either surrendering route prefixes or re-implementing them.
  Plain assignment leaves both route plugins ordinary, prefixed by the Operator through
  Fastify's own mechanism.
- **A route that omits the preHandler typechecks and reads nothing.** The augmentation
  cannot express "set only after `requireUser` ran". Accepted, as everywhere else that
  Operator code is guidance rather than construction.
- **The Gateway is still not an identity provider**, and the sentence is worth keeping
  even though its supporting clause changed. It holds a hash so a client can obtain a
  token; it runs no recovery, issues no assertions to third parties, and federates with
  nothing.
</content>
