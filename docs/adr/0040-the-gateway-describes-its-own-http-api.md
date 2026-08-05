# The Gateway describes its own HTTP API

> **Names updated by [ADR-0045](./0045-the-framework-builds-only-the-irreducible-infrastructure.md).**
> `createGatewayWithDefaults` is now `createGateway`, and `src/default-gateway.ts` is now
> `src/gateway.ts`. The parts this ADR says register their routes "inside the constructor"
> now register them inside the Operator's `extend`, which the constructor calls after it has
> registered `@fastify/swagger`. So the ordering argument below is unchanged: the hook is in
> place before any part's routes, and this constructor is still the only party that can
> arrange it. The decision itself stands.

Both servers carry an OpenAPI 3.0.3 description of themselves, generated from the route
schemas the framework already validates with, served as JSON at `/openapi.json` and as a
browsable UI at `/docs`. `createGatewayWithDefaults` registers `@fastify/swagger` and
`@fastify/swagger-ui` on each instance before it constructs any part, and every one of the
sixteen routes gains a `response` schema and a sentence saying what it does.

```
agent server   /openapi.json  /docs   9 routes   Signal Worker 4, User Manager 3, HTTP Messenger 2
public server  /openapi.json  /docs   7 routes   User Manager 5, HTTP Messenger 2
```

This pays a cost [ADR-0025](./0025-the-pi-adapter-spawns-one-confined-process-per-run.md)
accepted and named: *"every deployment holds a copy of `src/core/routes.ts` in prose and
nothing keeps the copies honest."* The copy in `example/AGENTS.md` is deleted rather than
maintained, and what replaces it is a URL.

## Only this constructor can do it

`@fastify/swagger` discovers routes with an `onRoute` hook, so a route registered before it
is invisible to it. Measured against `@fastify/swagger` 9.8.1 on Fastify 5.11.2: with the
routes queued first the generated document has **zero paths**, and this holds even when both
registrations are queued in the same tick, because avvio runs them in the order they were
queued rather than in the order they resolve.

Every part registers its routes inside its own constructor
([ADR-0032](./0032-components-wire-themselves-at-construction.md)), and all three
constructors run inside `createGatewayWithDefaults`. By the time an Operator holds
`gateway.components.agentServer.fastify`, the route plugins are already queued. There is no
window. So the choice was never where this belongs; it was whether it exists at all on the
default path, or whether wanting an API description means hand-writing `createGateway` with
all six entries, which ADR-0038 prices as expensive and means it.

The reverse asymmetry decided the second package. `@fastify/swagger-ui` has **no ordering
constraint**: registered after the parts' routes it still serves, and a route registered
after *it* still reaches the document. Owning the UI was therefore a choice rather than a
necessity, and it was taken anyway, so that a Gateway assembled the default way is
browsable without the Operator learning any of the above.

**Construction order in `src/default-gateway.ts` now carries a third load-bearing reason**,
alongside the migration registration order
([ADR-0036](./0036-the-http-messengers-user-id-is-a-foreign-key.md)) and the worker-before-
Messenger cycle. None of the three is visible in the record the function returns.

## A response schema is a serializer, not a description

Nothing in this repository declared a `response` schema before, so the document would
otherwise have described sixteen requests precisely and said `"Default Response"` sixteen
times about what comes back. That is the half prose was already adequate for, and the half a
client author needs least.

Declaring them is not free and not reversible in effect, because Fastify compiles a response
schema into `fast-json-stringify` and **silently strips every field the schema does not
declare**. Verified: a record with four fields answered through a two-field schema arrives
with two, no warning anywhere. A required field the handler does not supply is the other
direction, and turns a working route into a 500 at serialization time.

This is the outbound twin of the hazard `unknownQueryRefusal` exists to fight, and it bites
the opposite party. `removeAdditional` punishes a caller who mistypes; this punishes an
author who adds a field to a record and forgets its schema. Fastify's own documentation does
not state the stripping behaviour at all, which is why it was measured rather than read.

It is taken because the framework wants the property regardless of the document. Fastify's
stated purposes are *"drastically increase throughput and help prevent accidental disclosure
of sensitive information"*, and the second is precisely what `asUserRecord` already holds by
hand with the comment *"The password hash is not on this wire, ever."* A response schema is
a second, independent enforcement of that rule on the one route where a leak would matter.
The OpenAPI document is the third beneficiary of a Fastify feature, not the reason for it.

**The drift is silent, so it gets a test.** One round-trip assertion per record type: build
the record in process, read it over the wire, compare the whole thing. This generalises what
`src/users/users.test.ts:287` already stumbled into, and it is the only non-circular
assertion of its kind that existed. Every other body comparison in the suite compares one
HTTP response against another, so a uniformly stripped field is stripped on both sides and
passes. The rule being followed is the repository's own, stated for the two migration
hand-edits: a loud failure is left loud, and a silent one is given something that scans for
it.

## Inline, not `$ref`

Records are written into each route's schema directly. Nothing calls `addSchema`, no `$id`
exists, and the emitted document has no `components/schemas`.

The alternative was measured: shared schemas with a one-line `refResolver` produce a 6.6 KB
document with five named models, against 10.8 KB with the shapes inlined at each use site,
and a client generator run against the first emits `MessageRecord` where the second invents
`MessagesGet200Response`. That is a real gain and it was declined, for three reasons.

The first is that it is a gain for exactly one consumer, a code generator. For the agent,
which is the consumer ADR-0025 is about, inlining is arguably better: the shape is at the
use site with no indirection to resolve, and 4 KB is not worth an indirection. For a person
in Swagger UI the two render almost identically.

The second is that `$id` is a namespace, and a global one. A part's schemas are visible to
its own plugin, but child contexts inherit the root, so an Operator who has called
`addSchema({$id: "Error"})` on a server the framework also uses collides at construction with
`FST_ERR_SCH_ALREADY_PRESENT`. There are ways around that, including declaring the schemas
inside each route plugin so each gets its own encapsulation, which was verified to work and
to keep [ADR-0032](./0032-components-wire-themselves-at-construction.md)'s exported plugins
usable on a bare instance. All of them are mechanism inside every part, permanently, to save
4 KB.

The third is that inlining asks nothing of a part. A part declares `response` beside the
`body` and `querystring` it already declares, and the server, having the plugin, consumes it.
That keeps the parts exactly as standalone as they are today: a deployment with no HTTP
Messenger simply has no `MessageRecord` in its document, and nothing notices.

The one shared shape is the error body, which is a plain exported constant in
`src/route-conventions.ts` next to `notFound()`. That file exists to stop each part answering
differently, and three parts inventing three error schemas would contradict a uniformity that
was already deliberate.

**This is the decision to revisit if typed client generation is ever wanted.** It is the only
one here that a future requirement clearly overturns.

## The prose moves into the document

`example/AGENTS.md` loses its route table, its field shapes and every sentence about how the
API behaves, and gains a pointer. What makes that safe is that the sentences are not deleted:
the framework's own semantics move into `info.description`, per-route `description`, and
property descriptions on the fields where the name is not the whole story. That reads
*"reaching this port is access"*, *"reads are not scoped by Session or by User"*
([ADR-0011](./0011-the-agent-has-full-read-access.md)), *"`limit` is capped and a larger value
is refused rather than quietly reduced"*, *"an unknown query parameter is a 400"*, and
*"`POST /users` has nowhere for Attributes to arrive through"*. Those are facts about the
code, and they now ship with it.

What stays in `AGENTS.md` is what was never API documentation: who the agent is, that in
*this* deployment every Signal has the kind `message.received` and its `payload` is the
Message, that the Db is unreachable, and the URL itself, which the framework cannot derive
from where a server binds. Routes are tagged, so sixteen of them arrive in Swagger UI as
groups rather than as one list.

## Consequences

- **Two runtime dependencies, and 2.5 MB of them.** `dependencies` goes from three entries
  to five, and `@fastify/swagger-ui` brings `@fastify/static`, `fastify-plugin`,
  `openapi-types`, `rfdc` and `yaml` with it, plus a bundled copy of Swagger UI's static
  assets that every consumer carries whether or not anyone will open a browser. Caret ranges,
  and both must be imported *and called* in the annotated `main.ts` that
  `scripts/check-package.ts` writes, which is what proves a dependency is declared rather
  than merely present in our own tree.
- **`/docs` and `/openapi.json` are framework-owned paths on both servers, and there is no
  option to move or remove them.** A public `/docs` publishes a browsable index of
  `/auth/tokens` and the Message routes to anyone who can reach the Public server. That is
  defensible, since it documents an API whose whole purpose is to be called from outside, but
  it is the framework choosing an exposure posture on the Operator's behalf, and it is the
  kind of choice ADR-0038 was otherwise careful to decline. An Operator who objects leaves
  the constructor. An Operator who already has a route at either path collides at `ready()`,
  which is loud.
- **`info.version` is a constant in source and describes the wrong thing.** OpenAPI requires
  the field; the document describes a *deployment's* API, including whatever routes the
  Operator registered themselves, so the framework's version is a category error however it
  is obtained. Reading `package.json` at runtime was rejected for buying a more precisely
  wrong answer at the price of a file read inside a constructor documented as doing no I/O,
  and a second reach outside the call in the one module that already confesses one for
  `DATABASE_URL`. A test asserts the constant matches `package.json`, because a
  hand-maintained value with no reader is exactly the thing that drifts.
- **An Operator's own route is described only if it was `register`ed.** Found while building
  this and recorded rather than fixed. Fastify fires `onRoute` *as a route is declared*, so a
  route written straight onto the instance in the stretch this constructor returns into,
  `publicServer.fastify.get("/ask", …)`, is declared before the queued plugin has added its
  hook and never reaches the document; the same route inside a `register` call is declared at
  boot, by which time the hook is there. The route is served either way and only the
  description differs, which is what makes it quiet. `register` is already the door
  [ADR-0032](./0032-components-wire-themselves-at-construction.md) points at and the
  quickstart's first spelling, so what this costs is one sentence there rather than a
  mechanism; `default-gateway.test.ts` pins both spellings so the difference cannot change
  unnoticed. Closing it would mean running the plugin's body synchronously, which is reaching
  inside a package to save a sentence.
- **`docs/quickstart.md` stops carrying the third copy.** Its route table and field shapes
  were a second hand-made transcription, and its section headed "This copy can go stale"
  described a problem that is now answered. Both shrink to a pointer, or the trade is two
  hand-made copies plus a specification.
- **The agent pays a fetch and roughly 10 KB of context per Run** to learn what a
  fifteen-line table told it for free. What it buys is that the answer cannot be wrong. A
  stale table produces an agent that asks for something absent, gets a 404 and stops asking,
  which reads as an incurious model rather than as documentation drift, and that failure is
  the one being traded away.
- **ADR-0038's refusal to accept a Fastify instance is now twice-shown wrong and still
  stands.** That ADR named `trustProxy` as a case it knowingly excluded, *"which is not
  exotic"*; `@fastify/swagger` was the second, and `@fastify/cors`, `@fastify/helmet` and
  `@fastify/rate-limit` all want in before routes too. The restriction is not architectural:
  `createGateway` takes a record of Components and knows nothing about servers, and
  `serverComponent` explicitly takes an instance the caller constructed. It is two lines in
  `src/default-gateway.ts`. This ADR routes around it rather than fixing it, because
  delivering a document and unblocking one are different things, and an Operator left to
  register the plugin themselves would rediscover the ordering trap above. The open question
  is recorded here rather than resolved.
