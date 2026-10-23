# Signed decisions example

Alice and Bob talk to one agent over HTTP. Each reads their own message log, and both can read
the same signed decisions. The agent can use prior messages and decisions when answering either
person; separate message logs do not enforce confidentiality.

## Run

You need Docker with Compose and an Anthropic API key. From this directory:

```sh
cp .env.example .env
```

Set `ANTHROPIC_API_KEY`, `ALICE_PASSWORD`, and `BOB_PASSWORD` in `.env`.

```sh
docker compose up -d --build
docker compose logs -f gateway
```

The log lists each user's id and name. Open the two clients in separate terminals:

```sh
docker compose run --rm tui-alice <alice-id>
docker compose run --rm tui-bob <bob-id>
```

Ask the agent to agree a meeting time or divide work between the two users. Its instructions
ask it to publish a decision for a shared commitment, then message both users with the decision
number. Publishing alone sends no notification.

Users and passwords are provisioned only when the database has no users. Editing the environment
passwords afterward does not change stored credentials. The example logs the environment values
on every boot, so those values can become stale.

## Read and verify decisions

The public API is at <http://127.0.0.1:8082/docs>. The following commands also require `curl` and
`jq` on your host. Replace the id and password with Alice's stored credentials:

```sh
TOKEN=$(curl -fsS http://127.0.0.1:8082/auth/tokens \
  -H 'content-type: application/json' \
  -d '{"user":"<alice-id>","password":"<alice-password>"}' | jq -r .token)

curl -fsS http://127.0.0.1:8082/decisions \
  -H "Authorization: Bearer $TOKEN" | jq
```

After a decision has been published, fetch its signed artifact and the public key:

```sh
KEYS=$(curl -fsS http://127.0.0.1:8082/jwks.json)
JWS=$(curl -fsS http://127.0.0.1:8082/decisions \
  -H "Authorization: Bearer $TOKEN" | jq -er '.decisions[-1].jws')
```

Verify locally using Node in the gateway container:

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
  if (!ok) throw new Error("Invalid signature");
  console.log(JSON.parse(Buffer.from(payload, "base64url").toString()));
' "$KEYS" "$JWS"
```

This verifier is specific to the example's Ed25519 signing key. The signed payload contains
`seq`, `createdAt`, and `statement`. A verifier must trust the public key independently; fetching
it from an untrusted gateway does not establish who signed the artifact. A signature does not
prove the agent followed its instructions.

## Customize

`main.ts` adds signatures and decisions to the minimal HTTP setup. Signatures creates JWS
artifacts; decisions stores and numbers them. The signing key stays in the gateway and is never
mounted into the agent instance.

The committed signing key is for demonstration only. Replace it before using this deployment
for real commitments. `schema.ts` includes decision tables; signatures has no tables.

See [the guide](../../site/guide.md) for the shared deployment setup. This example installs the
library from the npm registry, not this checkout.

Stop with `docker compose down`. Add `-v` to delete the database volume; local `state/` files remain.
