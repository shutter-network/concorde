# shared-agent-framework/signatures

Signatures, the component that holds the Shared Agent's signing identity. A Signed Statement is
one compact JWS: a string anybody can check against the agent's public key, offline, without
reaching this Gateway and without trusting the Operator.

[createSignatures](#createsignatures) makes one. [Signatures](#signatures) is what comes back, and its `sign` is the
whole of what trusted code gets. [SignedClaims](#signedclaims) is what goes into a payload.

The deployment brings the key. Nothing here parses a PEM, reads an environment variable or
generates a keypair, so construction without one throws rather than inventing an identity.

Build the User Manager first, whose `requireUser` this takes, and build this before Decisions,
which signs through it. Key it ahead of the Signal Worker in the Gateway's record: the Worker is
keyed last so it drains first, and a Signal Handler's post phase may still need to sign.

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
  // Not loopback: the agent reaches this server from a container of its own.
  agentListen: { host: "0.0.0.0", port: 8081 },
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

The signing identity as a Component: one in-process method, and nothing kept.

Nothing is stored. No tables, no route that lists what has been signed, and no record anywhere
that a signing happened beyond the one log line. The artifact `sign` answers with is the whole
of what happened, and losing it means signing again.

Verifying and handing out the public key are routes rather than methods here. Both answer
somebody outside, and a caller in this process holds the key already.

Stopping the Gateway is what stops all signing. The key lives in this process and nothing about
it can be revoked, so a key that outlived the process would sign forever.

`start` and `stop` do nothing.

#### Type Declaration

##### sign()

```ts
sign(typ, claims): Promise<string>;
```

Signs `claims` and answers with one compact JWS: `header.payload.signature`, base64url.

`typ` goes into the protected header, so the signature covers it and swapping it invalidates
the artifact. Nothing is reserved, `saf-decision+jws` included, and the label is this
identity's own claim about its artifact rather than a promise about the artifact's shape.

A `signingAlg` the key cannot perform is refused here, at the first call, rather than at
construction.

It stores nothing and numbers nothing. A commitment that has to be citable afterwards is a
Decision instead.

###### Parameters

###### typ

`string`

###### claims

[`SignedClaims`](#signedclaims)

###### Returns

`Promise`\<`string`\>

##### start()

```ts
start(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

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

#### Properties

##### agentServer

```ts
readonly agentServer: {
  fastify: FastifyInstance;
};
```

Where `POST /sign` is registered.

The key stays in this process, and the agent reaches it only over that route, so a compromised
Agent Container mints nothing once the Gateway is stopped.

Structural: anything carrying a Fastify instance satisfies it, including what
`serverComponent` returns.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to a `pino` instance on stdout.

One info line per signing, carrying the `typ` and a SHA-256 digest of the Statement. The
Statement itself is never written, so an aggregator collecting these lines holds no copy of
what the agent committed to.

##### publicServer

```ts
readonly publicServer: {
  fastify: FastifyInstance;
};
```

Where `POST /verify` and `GET /jwks.json` are registered.

`GET /jwks.json` asks for no Token. A public key is public, and the party this identity exists
for has nothing to log in with.

Structural, on the same terms as `agentServer`.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### signingAlg?

```ts
readonly optional signingAlg?: string;
```

The JOSE algorithm the protected header declares.

Derived from the key when absent: `EdDSA` for an Ed25519 key, and `ES256`, `ES384` or `ES512`
for an EC key on P-256, P-384 or P-521. Every other key is refused at construction in a
sentence naming what to pass. An RSA key is refused because six algorithms are valid for it
and nothing in the key says which was meant, an `rsa-pss` key because it exports to no JWK at
all, and any other curve including Ed448 and secp256k1.

A value given here reaches `jose` unexamined, and the compatibility check is the library's and
asynchronous. So an algorithm this key cannot perform is refused at the first `sign` rather
than at construction.

##### signingKey

```ts
readonly signingKey: KeyObject;
```

The Shared Agent's private key, and the whole of its identity.

The deployment loads it: nothing here parses a PEM, opens a file or generates a keypair, and
`createPrivateKey(readFileSync(path))` is the usual spelling. Copying this key copies the
agent. Nothing inside a signed artifact names the deployment that made it, so there is no
second thing a verifier could hold it against.

##### users

```ts
readonly users: {
  requireUser: preHandlerAsyncHookHandler;
};
```

Supplies the `requireUser` hook that `POST /verify` runs as one option on the route.

Taken and neither wrapped nor re-implemented, so this component authenticates nobody and an
unauthenticated check is refused with the same 401 the routes under `/auth` answer.

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

What a signature commits to: the Statement, and whatever else the caller binds to it.

`statement` is the one member this component reads for itself, and it reads it only to digest it
into the log line.

The object is serialized as it was written, so the order of its keys is the order of the signed
bytes. A caller that builds the claims decides the payload byte for byte.

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

Builds Signatures, derives the public key, and registers `POST /sign` on the Agent server and
`POST /verify` and `GET /jwks.json` on the Public one.

#### Parameters

##### options

[`SignaturesOptions`](#signaturesoptions)

#### Returns

[`Signatures`](#signatures)

#### Throws

If the key exports to no JWK, which is what an `rsa-pss` key does.

#### Throws

If no algorithm can be derived from the key and no `signingAlg` was passed.
