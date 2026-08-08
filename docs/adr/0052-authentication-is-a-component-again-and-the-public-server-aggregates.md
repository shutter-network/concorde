# Authentication is a component again, and the Public server aggregates

The password hash and the Token leave the Users component for a new one, **Password Auth**, which
owns the login and the four routes around it. Users keeps identity: the opaque id, Attributes, and
nothing a person presents. An **Auth** is a Component with one more member, and the Public server
holds the registered Auths and composes them into the one `requireUser` every protected route
takes.

This **reverts the second half of
[ADR-0014](./0014-users-are-opaque-ids-and-authentication-is-pluggable.md)'s title**, which
[ADR-0030](./0030-passwords-are-traded-for-bearer-tokens.md) had retired, and it retires ADR-0030's
own central sentence in exchange. Both of those are recorded below rather than left for a reader to
notice.

## Why now, when the same idea was refused twice

ADR-0014 named an **Authenticator** and shipped nothing. ADR-0030 deleted the term on two arguments,
and only one of them has failed:

> An interface would also have been the wrong seam. A `verify(request)` implementation still has to
> answer "and where does the credential live?", so an OIDC deployment would reimplement our token
> storage to satisfy an interface whose purpose was sparing them work. **The useful extension point
> is issuance, not verification.**

That objection was correct about `verify` and wrong to conclude there was therefore no seam. **The
seam is who owns the secret, not who verifies a credential.** Password Auth owns a hash table and a
Token table; Nostr Auth owns a table of granted public keys and no Token at all
([ADR-0053](./0053-nostr-auth-verifies-nip-98-per-request.md)). That asymmetry is what makes the
population real, and it is also what answers ADR-0030's question: an Auth knows where its credential
lives because it is the thing that put it there.

What changed underneath is plurality. ADR-0030 was written when a deployment had one login, so
"replace our authentication" meant "do not register our plugin" and there was nothing to compose.
Splitting messaging into a Messenger and Channels
([ADR-0048](./0048-the-messenger-owns-the-log-and-channels-reach-people.md)) put a second medium in
front of a person, and a person reached over Nostr does not have a password. Login became plural at
the moment reaching became plural.

## The type is one member, and something calls it

```ts
type Auth = Component & {
  authenticate(request: FastifyRequest): Promise<AuthOutcome>;
};

type AuthOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly code: "invalid_request" | "invalid_token"; readonly detail?: string }
  | { readonly kind: "authenticated"; readonly user: UserRecord };
```

[ADR-0021](./0021-the-framework-has-no-plugin-system.md) rejected a contract that every part would
satisfy, and ADR-0048 admitted `Channel` anyway on one test: the Messenger **calls** `send` on
whatever registered with it. `Auth` passes the same test and would fail without the aggregate. A
population of components an Operator merely constructs and wires by hand needs no type; a population
something walks on every request does.

`authenticate` **answers with the User record and not an id.** That is forced rather than chosen:
`createGateway` builds both servers before it calls `extend`, and Users is constructed inside
`extend`, so the aggregate can never hold Users and can never resolve an id. Every Auth therefore
takes Users. The graph still gets smaller: Signatures, Decisions and the HTTP Channel stop taking it,
so Users goes from four dependents to two.

**Three outcomes and not two.** `absent` means "this request carries nothing of my scheme, ask the
next one"; `refused` means "it named my scheme and failed". Collapsing them into `undefined` was
considered and would have made the walk's result independent of registration order, which is a real
property to give up. It was given up because Nostr's credential fails in six mechanically distinct
ways where a password fails in one, and an Operator whose reverse proxy rewrites the URL would
otherwise get a bare 401 for a configuration mistake. A thrown error keeps its ordinary meaning:
something broke, and the request is a 500.

## The aggregate is on the server, and it is on both servers

`serverComponent` gains `registerAuth(auth)` and a `requireUser` hook. An Auth registers itself at
the end of its own constructor, which is
[ADR-0032](./0032-components-wire-themselves-at-construction.md) and ADR-0048's self-registering
Channel verbatim. A component with protected routes reads `publicServer.requireUser`, and the hook
is late-bound over the list, so construction order inside `extend` does not matter.

Two alternatives were live. **Users as the aggregator** was rejected on the grounds that a Users
component holding no credential but holding the list of things that check credentials is the worst
of both. **The aggregate in `extend`'s bag**, built by `createGateway` beside the Db and the servers,
was the closer call: it keeps `serverComponent` a generic wrapper and puts no dead member on the
Agent server. It lost because an Auth's login route is registered on the Public server, so under that
shape the two halves of "how a person authenticates here" sit on different objects, where the server
answers both.

**The Agent server gets the same two members and nobody should use them.** Every caller there is
trusted ([ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md)), so nothing registers
an Auth with it and `requireUser` on an Agent route fails every request. That is a documentation cost
and it is accepted; the alternative was a second server type, or Fastify decoration, which ADR-0030
already refused for scoping reasons.

**Zero registered Auths throws rather than answering 401.** The Messenger's `NoChannelError` is the
precedent: a wiring mistake that presents as a credential problem is worse than one that fails
loudly.

## What the wire learns, and what the log learns

The rule is that **the mechanics may speak and the population may not.** A signature that does not
verify, an event outside the freshness window, a `u` tag that does not match, a malformed header and
an expired Token say nothing about who exists here, and may be told apart. A wrong password, an
unknown Token, an unrecorded public key and a User that is not there all answer the question "is this
identity here?", and stay one answer. ADR-0030's *"Failures are indistinguishable"* is therefore
narrowed rather than reversed: it holds exactly where it was aimed, at enumeration.

So the refusal carries a **closed** code the framework defines and an optional `detail` the framework
never sends. The wire gets a 401, the body it already got (`errorSchema`, one message, no new
response schema anywhere), and a `WWW-Authenticate` header naming every registered scheme with RFC
6750's `error=` on the one that refused. The detail goes to the logging seam, because a `u` tag
mismatch is an Operator's problem to diagnose and not a client's to read.

That header also fixes a conformance bug this framework has shipped since ADR-0030: `unauthorized()`
sends no `WWW-Authenticate` at all, and RFC 7235 says a 401 must carry one. Only the aggregate knows
every registered scheme, so it is the first object able to write an honest one.

## Consequences

- **ADR-0030's extension point is gone from Users.** *"`issueToken` is public: a deployment
  establishes identity however it likes and mints a token"* is no longer true of Users, because the
  Token is Password Auth's. Password Auth exposes `issueToken` itself, so a deployment with a
  corporate header can still construct it and mint from it rather than writing a whole Auth, but it
  is borrowing another component's credential now and the sentence has to say so.
- **`password_hash` being nullable stops meaning anything.** It existed so a User authenticated some
  other way need never have one. Such a User now simply has no row in Password Auth.
- **The agent can no longer create a User.** `POST /users` is removed rather than stripped of its
  password parameter, so the Agent server's Users routes are read-only. This supersedes ADR-0014's
  *"provisioning happens two ways"*: it happens one way, from trusted code. The next sentence of
  ADR-0014 survives untouched, because a Signal Handler is Operator code with `db.tx` and can create
  a User and set a password in one transaction. The removal is the same guard as that route already
  carrying no Attributes parameter: an injected prompt that could mint a User **and** set its password
  has minted itself an account it can log into.
- **`GET /auth/me` becomes `GET /users/me`.** It only echoes `request.safUser`, so it is
  scheme-independent and cannot live under one scheme's prefix. It is the Users component's one
  Public route.
- **There is no Sessions component, and the trigger for one is recorded.** Extracting the Token into
  a part of its own was refused as premature. The day a challenge-over-channel Auth arrives it will
  need a Token too, since a one-time code is not a per-request credential, and that is the moment to
  extract rather than duplicate. Nothing is deployed, so the extraction is free today and a migration
  later.
- **A deployment running two schemes has an ordered list**, and an Auth left out of it silently stops
  working. There is no combinator to get wrong and no registration the type checker can prove
  complete.
- **`shared-agent-framework/gateway` grows an authentication vocabulary.** `Auth` and its outcome
  live beside `Component` and `serverComponent`, because that subpath already owns the framework's
  other structural contract. A bare `/auth` subpath was rejected as the first with no constructor
  in it.
