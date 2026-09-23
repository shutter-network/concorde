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

## The two services

This deployment is two containers that matter, and the Gateway is one of them. `gateway` serves
the people and decides what the agent is asked; `agent` is the **Agent Instance**, which the
Operator runs and the Gateway merely connects to. Nothing here mounts a container runtime
socket and no host path is written anywhere, so the Gateway cannot start a container and has no
name for a directory the Docker daemon would resolve. That is the whole arrangement: the
Gateway holds a TCP address and nothing else about the agent.

What `agent` starts is a listener rather than the agent:

```yaml
    command:
      - socat
      - TCP-LISTEN:4000,reuseaddr,fork
      - EXEC:pi --mode rpc --no-approve
```

`fork` means one `pi` process per TCP connection, and the Gateway opens one connection per Run
and closes it when the agent has settled. So a Run is still a process of its own, started for it
and gone with it; what carries over from one Run to the next is this container and the
directories mounted into it, which is the Operator's arrangement and nobody else's. Four things
in those three lines are load-bearing:

- **No commas may appear in the `EXEC:` argument.** Comma is `socat`'s own option separator, so
  a comma anywhere in it is read as an option rather than as part of the command, and what runs
  is quietly not what was written. The command is a list and not a string for the neighbouring
  reason: no shell is involved, and `socat` splits `EXEC:` on spaces itself.
- **`--no-approve` is the Operator's to pass**, and this line is the only place it now appears.
  It is the flag that stops a Run arranging for the next one to load configuration out of the
  writable Workspace, and the framework cannot fasten it to a command line it does not write.
- **`PI_OFFLINE` was a framework default** back when the framework started the container. It is
  an environment variable in this file now, and there is nowhere else left for it to be.
- **`socat`'s `stderr` option must never be added.** `EXEC` wires stdin and stdout to the
  socket, and `pi` writes its diagnostics to `socat`'s stderr; merging the two puts non-JSON
  into the record stream and fails every Run.

`Dockerfile.agent` is that container's image: `pi` at a pinned version, `socat` to listen with,
and `curl`, because `pi` ships no HTTP client and reaching the Agent server is the agent's own
shell tool plus `curl`. It declares no `ENTRYPOINT`, since the process this container starts is
the listener and the agent is what the listener starts.

**There is no healthcheck on `agent`, deliberately.** With `fork`, every connection starts a
`pi`, so a probe on an interval would boot and discard one for ever. A plain `depends_on` is
enough: an instance that is not listening is an ordinary failed Run carrying the address, not a
boot failure, and a Gateway that refused to start over it would take every other Party's access
down with the agent's.

**The agent's environment is the Operator's, whole.** The image, the model credential, the files
`pi` reads, the flags it is started with: every one of them is written on `agent` in
`compose.yml`, and the Gateway is given none of it. `ANTHROPIC_API_KEY` is set there and in no
other service. `AGENTS.md` and `settings.json` are mounted read-only out of this directory,
which is how the agent learns that the Agent server exists and which model to talk to, and
mounting them read-only is what keeps a Run from rewriting the instructions the next Run reads.

**The Gateway is told three things about the instance and nothing else:**

```yaml
      AGENT_INSTANCE_HOST: agent
      AGENT_INSTANCE_PORT: "4000"
      AGENT_SESSIONS_DIR: /sessions
```

`AGENT_SERVER_HOST` and `AGENT_SERVER_PORT` beside them point the other way entirely: they are
where the Gateway's own Agent server listens for the agent's `curl`. Two addresses cross on the
same network and the names are long so that neither can be read as the other.

`AGENT_SESSIONS_DIR` is **the path the Agent Instance sees**, and it is the same string as the
target of the `./state/sessions:/sessions` mount on `agent`. It is written twice because nothing
can check it once: one end is resolved by `pi` and the other by the Docker daemon, and neither
can see the other's filesystem. A Session named `user_abc` is `/sessions/user_abc.jsonl` inside that
container and `state/sessions/user_abc.jsonl` here, which is where to read a transcript.

## Look around

- `main.ts` is the whole deployment: the Runtime, six components, one Handler, the prompt that
  Handler renders, and the seeding block that creates both people in one transaction.
- `AGENTS.md` is mounted read-only into the Agent Instance's Workspace, and it is where the
  agent is told that a commitment is published as a Decision and then messaged to both parties.
  Publishing notifies nobody, so without that second step a Decision sits in a log nobody is
  watching. It is also what keeps the terminal client a client of two routes and nothing else.
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
