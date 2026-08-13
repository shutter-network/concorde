# 02_decisions

Two people talking to one agent, each with a private Message log, and one global Decision log
that both of them read. It shows:

- **What a Decision is, against what a Message is.** A Message goes to one person and can be
  denied later. A Decision is addressed to nobody, numbered from 1, and signed, so neither
  person can dispute afterwards what the agent committed to.
- **Verification without the Gateway.** `GET /jwks.json` serves the public key, and the
  snippet below checks a Decision with `node:crypto` and no JOSE library. A Gateway that lied
  about what the agent committed to is caught by anybody who kept the key.
- **Two people, two logs.** Alice and Bob each read their own Messages and nothing of the
  other's. The Decision log is the one thing they share.
- **Signatures and Decisions are two components.** Signatures holds the key and signs
  anything; Decisions is the numbered, stored log that signs through it. An agent that only
  needs a receipt builds the first and not the second.
- **Which components own tables.** `schema.ts` re-exports five components' `/schema` subpaths
  for six components. Signatures owns none, because a Signed Statement is never kept. The HTTP
  Channel owns none, because HTTP delivery is the User asking.

## Run it

```sh
cp .env.example .env   # then put your Anthropic API key in it
docker compose up -d --build
docker compose logs -f gateway
```

The Gateway prints both ids and both passwords on every boot:

```
user 52c1a214-... {"name":"bob"}
user f4c12f7f-... {"name":"alice"}
alice logs in with the password correct horse battery staple
bob logs in with the password chased by a dog on a bicycle
```

Then talk to it as each person, in two more terminals, with the ids it printed:

```sh
docker compose run --rm tui-alice f4c12f7f-...
docker compose run --rm tui-bob 52c1a214-...
```

Type a line and press enter. Each client logs in, prints that person's log, and asks for more
once a second. Ctrl-C leaves. Ask both of them about the same thing and watch neither see the
other's conversation.

## Read the Decision log

Every authenticated User reads the same log, so this is one route and not one per person. Log
in for a Token first, and use either person's:

```sh
TOKEN=$(curl -s -X POST localhost:8082/auth/tokens \
  -H 'content-type: application/json' \
  -d '{"user":"f4c12f7f-...","password":"correct horse battery staple"}' | jq -r .token)

curl -s localhost:8082/decisions -H "Authorization: Bearer $TOKEN" | jq
```

```json
{
  "decisions": [
    {
      "seq": 1,
      "statement": "The kickoff is Thursday 14:00 Europe/Berlin, and alice writes the agenda.",
      "jws": "eyJhbGciOiJFZERTQSIsInR5cCI6InNhZi1kZWNpc2lvbitqd3MifQ.eyJzZXEiOjEs...",
      "createdAt": "2026-08-08T09:09:25.600Z"
    }
  ]
}
```

## Verify one offline

The `jws` is the Decision. The other three fields can be read back out of it by anybody holding
the public key, which is why handing a third party this one string is the whole point.

Take the key set and one artifact, in full:

```sh
KEYS=$(curl -s localhost:8082/jwks.json)
JWS=eyJhbGciOiJFZERTQSIsInR5cCI6InNhZi1kZWNpc2lvbitqd3MifQ.eyJzZXEiOjEs...   # the jws above, in full
```

`GET /jwks.json` asks for no Token, a public key being public. It answers one key in RFC 7517's
JWK Set container, with no `d` member: this is the public half.

```json
{"keys":[{"kty":"OKP","crv":"Ed25519","x":"ekP0MB9-k1vZBrtIZYCtWjPX8QfHNXJsWi5uqhY4iH8"}]}
```

Then check the signature yourself. This uses `node:crypto` and no JOSE library: split the
artifact on `.`, and verify that the key signed the `header.payload` bytes exactly as they were
emitted. The Gateway's image has Node, so you need none of your own:

```sh
docker compose exec gateway node -e '
  const { createPublicKey, verify } = require("node:crypto");
  const jwk = JSON.parse(process.argv[1]).keys[0];
  const [header, payload, signature] = process.argv[2].split(".");
  const ok = verify(
    null,
    Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
  console.log(ok ? "verified" : "FORGED");
  console.log(Buffer.from(payload, "base64url").toString());
' "$KEYS" "$JWS"
```

```
verified
{"seq":1,"createdAt":"2026-08-08T09:09:25.600Z","statement":"The kickoff is Thursday 14:00 Europe/Berlin, and alice writes the agenda."}
```

Now tamper with it. Flip one character of the payload and run the very same check:

```sh
docker compose exec gateway node -e '
  const { createPublicKey, verify } = require("node:crypto");
  const jwk = JSON.parse(process.argv[1]).keys[0];
  const [header, payload, signature] = process.argv[2].split(".");
  const flipped = payload.slice(0, -1) + (payload.slice(-1) === "A" ? "B" : "A");
  const ok = verify(
    null,
    Buffer.from(`${header}.${flipped}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
  console.log(ok ? "verified" : "FORGED");
' "$KEYS" "$JWS"
```

```
FORGED
```

The header is signed too, so swapping the `typ` to pass a receipt off as a Decision fails the
same way. There is a shortcut, `POST /verify` on the Public server, and it is a convenience
rather than the point: to the third party this identity exists for, a Gateway-supplied verdict
is worthless, because a dishonest Gateway says `true` to anything.

Be exact about what a valid signature proves: that this identity put its name to this exact
string, and nothing about the agent's conduct. An agent that was talked into publishing
something obtains a perfectly valid Decision. What it rules out is denial.

```sh
docker compose down -v
```

## Look around

- `main.ts` is the whole deployment: the Runtime, six components, one Handler, the prompt that
  Handler renders, and the seeding block that creates both people in one transaction.
- `AGENTS.md` is mounted read-only into the agent's Workspace, and it is where the agent is told
  that a commitment is published as a Decision and then messaged to both parties. Publishing
  notifies nobody, so without that second step a Decision sits in a log nobody is watching. It
  is also what keeps the terminal client a client of two routes and nothing else.
- The Gateway describes its own HTTP API, and the Public server is published at
  <http://127.0.0.1:8082/docs>. That is 8082 and not 8080, so this stack and the other examples
  can run at the same time.

## The signing key is worthless

`insecure-example-only-signing-key.pem` is a throwaway Ed25519 keypair committed to this
repository, so everyone who has read it can forge this agent's signature. It is there so that
`docker compose up` is the whole setup, and it is a file rather than a value in `.env` because
multi-line values in `.env` are miserable, which is the one place this example differs from
`03_nostr` and its hex secrets.

Generate your own before any of this signs something you would defend, and never commit it:

```sh
openssl genpkey -algorithm ED25519 -out signing-key.pem
```

Nothing generates one for you, on purpose. A fresh key at every boot would leave every Decision
already published unverifiable, with nothing anywhere saying so.
