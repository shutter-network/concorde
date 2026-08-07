# shared-agent-framework/signatures

Signatures, from `shared-agent-framework/signatures`.

`createSignatures` is the whole of it for an Operator. Hand it the Shared Agent's private key,
both servers and the User Manager. It derives the public half and registers three routes. `POST
/sign` is where only the agent reaches it. `POST /verify` sits behind the Manager's single 401,
and `GET /jwks.json` in front of everything. Then key it in the Gateway's record before the
Signal Worker, so that it outlives the drain. A Signal Handler's post phase may still need to
sign.

The key is yours to load and ours to hold. It is a `crypto.KeyObject`, and this framework parses
no PEM, reads no environment variable and opens no file. Write
`createPrivateKey(readFileSync(path))` and decide for yourself where that came from. Nothing here
generates a keypair, so a restart cannot silently invalidate every artifact ever published.

It answers with one method, `sign`, which is what trusted code has and no request does. Decisions
holds this object and signs in process, never by calling the Gateway's own routes. `SignedClaims`
is what goes into the payload. The order of its keys is the order of the bytes. A compact JWS is
signed as exactly what was emitted.

## Example

A Gateway with Signatures, and a Statement signed from the Operator's own code.
```ts
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGateway } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createSignatures } from "shared-agent-framework/signatures";
import { createUsers } from "shared-agent-framework/users";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer }) => {
    const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
    return {
      users,
      signatures: createSignatures({
        signingKey: createPrivateKey(readFileSync("./signing-key.pem")),
        agentServer,
        publicServer,
        users,
      }),
    };
  },
  handlers: () => ({}),
});

await gateway.start();

// One URL-safe string, checkable against `GET /jwks.json` with any JOSE library.
const jws = await gateway.components.signatures.sign("my-receipt+jws", {
  statement: "paid in full",
  invoice: "2026-0043",
});
console.log(jws);
```

## Type Aliases

### Signatures

```ts
type Signatures = Component & {
  sign: (typ, claims) => Promise<string>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
```

What the constructor answers with: the one thing trusted code needs and no request can express.

`sign` is an in-process call and never an HTTP request. Decisions holds this object and calls the
method. A Decision published inside a transaction cannot go out over a socket and back. A Gateway
that signed by calling itself would take a route as a dependency of its own write path.

There is nothing here that verifies and nothing that hands out the key. Both are routes, because
both are answers to somebody outside, and a caller in this process holds the `KeyObject` already.

#### Type Declaration

##### sign()

```ts
sign(typ, claims): Promise<string>;
```

Signs `claims` and answers with one compact JWS: `header.payload.signature`, base64url.

`typ` is the caller's, and nothing is reserved, not even the Decision label. It goes into the
protected header, so the signature covers it and swapping it invalidates the artifact. That is
what keeps a receipt from being presented as a Decision.

Asynchronous because `jose` is. The only side effect is the log line: this Component stores
nothing, so nothing anywhere records that this was called.

###### Parameters

###### typ

`string`

What kind of thing the artifact is, up to 128 characters.

###### claims

[`SignedClaims`](#signedclaims)

The Statement, and whatever else the caller binds to it. Key order is byte order.

###### Returns

`Promise`\<`string`\>

One URL-safe string, verifiable against `GET /jwks.json`.

##### start()

```ts
start(): Promise<void>;
```

Does nothing. There is nothing here to start.

There is no pool, no timer and no connection. The key was handed over at construction, and the
routes went on the two servers there too.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Does nothing, for the reason `start` does not.

Stopping the Gateway is nevertheless what stops all signing. That is the point of the key
living here rather than inside the Agent Container. A leaked key signs forever and there is
nothing to revoke. A key held by a process that is not running signs nothing.

###### Returns

`Promise`\<`void`\>

***

### SignaturesOptions

```ts
type SignaturesOptions = {
  agentServer: {
     fastify: FastifyInstance;
  };
  logger?: Logger;
  publicServer: {
     fastify: FastifyInstance;
  };
  signingAlg?: string;
  signingKey: KeyObject;
  users: {
     requireUser: preHandlerAsyncHookHandler;
  };
};
```

Everything `createSignatures` needs: the signing key, both servers, and the Manager's hook.

#### Properties

##### agentServer

```ts
readonly agentServer: {
  fastify: FastifyInstance;
};
```

The Agent server, where the Shared Agent signs, at `POST /sign`.

Required, and it is why the key lives in this process rather than in the Agent Container.
Signing is a route the agent calls and never a key it holds. So a compromise of the container
mints nothing once the Gateway is stopped.

Structural, and asks for nothing but the Fastify instance, so what satisfies it is what
`serverComponent` returns.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to a `pino` instance on stdout, and is what the signing line is written to.

##### publicServer

```ts
readonly publicServer: {
  fastify: FastifyInstance;
};
```

The Public server, where the key set is served at `/jwks.json`.

Required, and unauthenticated, a public key being public. It is what makes verification
possible for the party this identity exists for. That party does not trust the Operator, and
would learn nothing from the Gateway's own opinion.

Structural, and asks for nothing but the Fastify instance, so what satisfies it is what
`serverComponent` returns.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### signingAlg?

```ts
readonly optional signingAlg?: string;
```

The JOSE algorithm the header declares, when the key does not settle it by itself.

Optional. Left out, it is derived from the key's JWK export. That export speaks JOSE's own
curve names, where `asymmetricKeyDetails` speaks OpenSSL's. The table is short. `EdDSA` for an
Ed25519 key, and `ES256`, `ES384` or `ES512` for an EC key on P-256, P-384 or P-521.

Every other key is refused at construction, in a sentence naming what to pass. Three kinds
reach that. An RSA key, for which six algorithms are valid and nothing says which was meant. An
`rsa-pss` key, which cannot be exported as a JWK at all. And any other curve, Ed448 and
secp256k1 included.

Given, it is passed to `jose` unexamined. There is no key/alg compatibility check of ours,
because there is one of the library's. That refusal is therefore not at construction. `jose`'s
check is asynchronous, so an algorithm this key cannot perform is refused at the first signing.

##### signingKey

```ts
readonly signingKey: KeyObject;
```

The Shared Agent's private key, as a `crypto.KeyObject`, and the whole of its identity.

Required, and the framework will not generate one. Copying this key copies the agent. There is
no second name for it anywhere. No key identifier sits on any record, and nothing identifies
the deployment inside what is signed.

##### users

```ts
readonly users: {
  requireUser: preHandlerAsyncHookHandler;
};
```

Where `POST /verify`'s authentication comes from: the User Manager's own hook.

Taken as one option on that route, and neither wrapped nor re-implemented. So this Component
authenticates nobody, and its one refusal is the Manager's single 401.

The hook and not a `Users`, which is the one option here shaped differently from Decisions'.
This Component reads no User and there is no second thing it could want off the Manager. What
that costs is that the assembly, rather than the type, makes this the real Manager's hook. That
is why `gateway.test.ts` proves the 401 is the same one.

###### requireUser

```ts
readonly requireUser: preHandlerAsyncHookHandler;
```

***

### SignedClaims

```ts
type SignedClaims = {
  statement: string;
} & Readonly<Record<string, unknown>>;
```

What a signature commits to: the Statement, and whatever else the caller is binding to it.

`statement` is required and named, because it is the domain term and the one claim this Component
reads for itself. It digests that claim into the log line rather than writing it there.

Everything else is the caller's. Decisions binds a `seq` and a `createdAt` beside it. The object
it hands over is the object that gets serialized, in the order its keys were written. That is the
whole reason this takes an object. The payload is signed as the exact bytes emitted. So a caller
that builds the claims is a caller that decides the bytes.

#### Type Declaration

##### statement

```ts
readonly statement: string;
```

## Functions

### createSignatures()

```ts
function createSignatures(options): Signatures;
```

Builds Signatures, derives the public key, and registers its three routes.

Nothing here connects or listens. Put the result in the Gateway's record under a key of your own,
ahead of the Signal Worker. Construct it before Decisions.

#### Parameters

##### options

[`SignaturesOptions`](#signaturesoptions)

#### Returns

[`Signatures`](#signatures)

#### Throws

If the key cannot be exported as a JWK, which is what an `rsa-pss` key does.

#### Throws

If the key is RSA, or on a curve this framework derives no algorithm for, and no
  `signingAlg` was passed.

#### Example

Built in `extend`, and then used from the Operator's own trusted code.
```ts
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGateway } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createSignatures } from "shared-agent-framework/signatures";
import { createUsers } from "shared-agent-framework/users";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer }) => {
    const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
    return {
      users,
      signatures: createSignatures({
        // An Ed25519 or EC key needs no `signingAlg`. An RSA key does.
        signingKey: createPrivateKey(readFileSync("./signing-key.pem")),
        agentServer,
        publicServer,
        users,
      }),
    };
  },
  handlers: () => ({}),
});

await gateway.start();

const jws = await gateway.components.signatures.sign("my-receipt+jws", {
  statement: "paid in full",
  invoice: "2026-0043",
});
console.log(jws);
```
