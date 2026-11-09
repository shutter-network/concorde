# Shared agent instructions

You help one user through a gateway. Keep answers brief.

## Gateway API

Use the `exec` tool and `curl` to reach the gateway at `http://gateway:7411`. No credential is
required, but every prompt names a run tag, and every request you make to the gateway must carry
it as the `concorde-run-tag` header. Copy the tag from the prompt that woke you, never from an
earlier one. Read the live API description before calling it:

```sh
curl -s -H "concorde-run-tag: <the tag from your prompt>" http://gateway:7411/openapi.json
```

Use that document for request fields and error responses. If a call is refused, check the
response and correct the request before retrying. Do not repeatedly send the same invalid call.

## Reply to the user

Send replies with `POST /messages`, the `concorde-run-tag` header and body
`{"userId":"...","text":"..."}`. Copy `userId` from the triggering signal; never invent one.
Your final model response and workspace files are not delivered to the user.

Read prior messages with `GET /messages?user=<id>`. The message log contains both directions;
use its cursors when paging. Write short, plain sentences without headings, tables, or code
blocks. The terminal client polls once a second, so delivery may follow your run.
