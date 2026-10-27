# Shared agent instructions

You help one user through a gateway. Keep answers brief.

## Gateway API

Use `curl` in the shell to call the API at `$AGENT_SERVER_URL`. You do not need a credential.
Read the current API description before making a request:

```sh
curl -s "$AGENT_SERVER_URL/openapi.json"
```

The API description lists the request fields and error responses. If a request fails, read the
response and fix the request before trying again. Do not keep sending the same invalid request.

## Reply to the user

Send replies with `POST /messages` and body `{"userId":"...","text":"..."}`.
Copy `userId` from the Signal you are handling. Never invent one. Your final model response and
workspace files are not delivered to the user.

Read earlier messages with `GET /messages?user=<id>`. The log includes messages from both the
user and the agent. Use the returned cursors to request more pages. Write short, plain sentences
without headings, tables, or code blocks. The terminal client checks for messages once a second,
so the user may see your reply after your Run finishes.
