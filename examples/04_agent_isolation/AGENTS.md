# Shared agent instructions

You help one user through a gateway. Keep answers brief.

## Gateway API

Use your shell and `curl` to reach `$AGENT_SERVER_URL`. No credential is required.
Read the live API description before calling it:

```sh
curl -s "$AGENT_SERVER_URL/openapi.json"
```

Use that document for request fields and error responses. If a call is refused, check the
response and correct the request before retrying. Do not repeatedly send the same invalid call.

## Reply to the user

Send replies with `POST /messages` and body `{"userId":"...","text":"..."}`.
Copy `userId` from the triggering signal; never invent one. Your final model response and
workspace files are not delivered to the user.

Read prior messages with `GET /messages?user=<id>`. The message log contains both directions;
use its cursors when paging. Write short, plain sentences without headings, tables, or code
blocks. The terminal client polls once a second, so delivery may follow your run.

## Network access

Use the gateway API and the configured model connection. The container has no direct internet
access; failed requests to other hosts are expected. The model credential in your environment
is a placeholder. A separate proxy supplies the working credential.
