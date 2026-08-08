# shared-agent-framework/signatures

The Signatures component holds the Shared Agent's signing identity. A Signed Statement is one
compact JWS: a string anybody can check against the agent's public key, offline, without reaching
this Gateway and without trusting the Operator.

[createSignatures](#createsignatures) makes one. [Signatures](#signatures) is what comes back, and its programmatic
API is the single `sign`. [SignedClaims](#signedclaims) is what goes into a payload.

The deployment brings the key. Nothing here parses a PEM, reads an environment variable or
generates a keypair, so construction without one throws rather than inventing an identity.

Construct Users first, whose `requireUser` this takes, and construct this before Decisions, which
signs through it.

It does not use the Db and exports no schema. A Signed Statement is never kept, so an Operator's
migrations have nothing of this component to create.

## Example

A Gateway with Signatures, and a Statement signed from the Operator's own code.
```ts
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGateway } from "shared-agent-framework/gateway";
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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Signatures</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.gateway.html#component" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Component</span></a><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> &#x26;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  sign</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">typ</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">claims</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signedclaims" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignedClaims</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  start</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  stop</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

The signing identity as a Component: one in-process method, and nothing kept.

Nothing is stored. No route lists what has been signed, and no record anywhere says that a
signing happened beyond the one log line. The artifact `sign` answers with is the whole of what
happened, and losing it means signing again.

Checking an artifact and serving the public key are routes rather than part of the programmatic
API. Both answer somebody outside, and a caller in this process holds the key already.

Stopping the Gateway is what stops all signing. The key lives in this process and nothing about
it can be revoked, so a key that outlived the process would sign forever.

`start` and `stop` do nothing.

#### Type Declaration

##### sign()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">sign</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">typ</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">claims</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signedclaims" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignedClaims</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">start</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

###### Returns

`Promise`\<`void`\>

##### stop()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">stop</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

###### Returns

`Promise`\<`void`\>

***

### SignaturesOptions

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> SignaturesOptions</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> agentServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">    readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">  };</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> logger</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.logging.html#logger" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Logger</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> publicServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">    readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">  };</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> signingAlg</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> signingKey</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> KeyObject</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> users</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">    readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> requireUser</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> preHandlerAsyncHookHandler</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">  };</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Properties

##### agentServer

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> agentServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

Where `POST /sign` is registered.

The key stays in this process, and the agent reaches it only over that route, so a compromised
Agent Container mints nothing once the Gateway is stopped.

Structural: anything carrying a Fastify instance satisfies it.

###### fastify

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### logger?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> logger</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.logging.html#logger" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Logger</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

Defaults to a `pino` instance on stdout.

One info line per signing, carrying the `typ` and a SHA-256 digest of the Statement. The
Statement itself is never written, so an aggregator collecting these lines holds no copy of
what the agent committed to.

##### publicServer

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> publicServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

Where `POST /verify` and `GET /jwks.json` are registered.

`GET /jwks.json` asks for no Token. A public key is public, and the party this identity exists
for has nothing to log in with.

Structural, on the same terms as `agentServer`.

###### fastify

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### signingAlg?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> signingAlg</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> signingKey</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> KeyObject</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The Shared Agent's private key, and the whole of its identity.

The deployment loads it: nothing here parses a PEM, opens a file or generates a keypair, and
`createPrivateKey(readFileSync(path))` is the usual spelling. Copying this key copies the
agent. Nothing inside a signed artifact names the deployment that made it, so there is no
second thing a verifier could hold it against.

##### users

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> users</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> requireUser</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> preHandlerAsyncHookHandler</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

Supplies the `requireUser` hook that `POST /verify` runs as one option on the route.

Taken and neither wrapped nor re-implemented, so this component authenticates nobody and an
unauthenticated check is refused with the same 401 the routes under `/auth` answer.

###### requireUser

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> requireUser</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> preHandlerAsyncHookHandler</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### SignedClaims

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> SignedClaims</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> statement</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">} </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">&#x26;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Readonly</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Record</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>>;</span></span></code></pre></div>

What a signature commits to: the Statement, and whatever else the caller binds to it.

`statement` is the one member this component reads for itself, and it reads it only to digest it
into the log line.

The object is serialized as it was written, so the order of its keys is the order of the signed
bytes. A caller that builds the claims decides the payload byte for byte.

#### Type Declaration

##### statement

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> statement</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

## Functions

### createSignatures()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">function</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> createSignatures</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">options</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signaturesoptions" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignaturesOptions</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signatures" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signatures</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

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
