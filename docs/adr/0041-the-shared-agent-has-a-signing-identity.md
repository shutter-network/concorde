# The Shared Agent has a signing identity

A Shared Agent holds an Ed25519 keypair, and that keypair **is** its identity: the public
half is what a third party knows it by, and everything signed with the private half is a
statement of *this* Shared Agent. The **Operator holds it in trust**, which is the same
trust [ADR-0001](./0001-the-gateway-is-trusted.md) already grants, applied to one more
asset.

This has to be read against ADR-0001, which says the opposite in as many words:

> **Non-repudiation is a non-goal.** No Party needs to be able to prove after the fact
> what the agent was told or what it replied. Logging exists for operations and debugging,
> not as evidence.

and which lists "cryptographic audit logs" among the mechanisms it considered and rejected.

## What a signature proves, stated unflatteringly

**That the Operator committed to this string on this Shared Agent's behalf. Nothing about
the agent's conduct.** The Operator can sign a string the agent never produced; a Signal
Handler constructs every Prompt and could have written the statement itself; and an injected
agent can ask for anything to be signed ([ADR-0003](./0003-prompt-injection-is-an-accepted-risk.md)).
A verifier holding a Signed Statement learns that this identity stands behind it, and
learns nothing at all about how it came to be.

That is why this does not overturn ADR-0001 so much as narrow it. What ADR-0001 rejected was
making *the shield itself* verifiable without trust — attestation, threshold control,
transparency over what the agent was told. This makes one **output** portable, and its whole
audience is a party who never touches the Gateway's API: an external system, or a Party's own
auditor holding a public key. Trust in the Operator is undiminished, because it is the only
thing standing behind the signature.

Two lines elsewhere in the repository are therefore qualified rather than repealed.
ADR-0001's non-repudiation consequence stands **for the conversation** — Prompts, Runs,
Messages, and what any Party said — and `architecture.md`'s "no party can prove what the
agent was told or replied" stays true word for word. Neither of those becomes provable, and
nothing here makes them so.

## The private key never enters the Agent Container

The framework holds it; the agent reaches signing over the Agent server like everything else
([ADR-0010](./0010-the-agent-reaches-the-gateway-over-http.md)). Mounting it into the
container was the alternative, and reads like the natural one given that the key is
conceptually the agent's — but custody by a trusted host *is* what "conceptually the agent's"
means, and putting the bytes inside the container buys nothing, since the Operator built the
image and wrote the Mount Table anyway.

Three arguments against mounting it, in increasing order of cost:

- The **Mount Table declares mounts and verifies nothing**
  ([ADR-0028](./0028-the-mount-table-declares-mounts-and-verifies-nothing.md)) and the Agent
  Container is inert ([ADR-0033](./0033-an-agent-is-a-container-and-one-function.md)). A
  private key would be the first mount whose *contents* a framework guarantee rests on, and
  [ADR-0004](./0004-runtime-confinement-is-the-deployments-responsibility.md) has already
  declined to provide the confinement protecting it.
- ADR-0003 accepts prompt injection. A mounted key turns a successful injection from "the
  agent said something wrong to a User" into "this identity attested to an attacker's
  statement, undeniably, to verifiers who never touch the Gateway".
- **The decisive one: a leaked key signs forever.** An attacker who exfiltrates it once
  produces artifacts offline, with no Run, no Signal and no record — including artifacts
  dated after the Operator shut the deployment down. There is nothing to revoke. With the key
  in the Gateway, stopping the Gateway stops all signing.

**The cost, recorded and not guarded: an injected agent can still get an arbitrary string
signed.** It only has to call the endpoint. This decision does not prevent a bad signature;
it keeps the identity from outliving the Gateway, and it makes every Decision mediated,
numbered and timestamped. Mitigation is where it always is, in the Signal Handler and the
prompt (ADR-0003, [ADR-0009](./0009-signal-handlers-are-arbitrary-code.md)).

## One Shared Agent, one keypair, and no second name for it

Nothing identifying the deployment goes into what is signed. The keypair is the identity, so
an identifier beside it would be a **second** answer to "which Shared Agent said this" — one
cryptographic, one not — and a verifier would have to check both and decide what to do when
they disagree. That is a worse object than the failure it prevents.

**Cost, recorded: staging needs its own keypair, and nothing generates one, checks for one or
warns.** An Operator who copies the production key into staging produces staging artifacts
indistinguishable from real ones. Copying the key means copying the agent, and that is true
whether or not a name is written next to it.

## Consequences

- **The framework never generates a keypair**, and no key means construction throws.
  Generating one would fail quietly in the worst way: a fresh key per restart leaves every
  prior artifact unverifiable with nothing anywhere saying so. Persisting a generated one
  into the Db would put a *usable* private key in a table, against invariant 7 of
  [`data-model.md`](../data-model.md) — "a stored credential is never readable, only
  verifiable".
- **Publishing the public key is not governance.** ADR-0001 puts governance out of scope, and
  deciding who the Parties are and what they should trust remains out of scope. Serving a
  public key is not that, so the Signatures component serves one.
- **There is no key rotation and no key identifier on any record.** Change the key and the
  Decision log holds artifacts under two keys with nothing saying which; a verifier needs the
  old public key out of band. Recorded rather than solved.
- **A deployment holding its identity in an HSM cannot use this.** A non-exportable hardware
  key has no `KeyObject`, and there is no seam for one
  ([ADR-0042](./0042-a-signature-is-a-compact-jws.md)).
