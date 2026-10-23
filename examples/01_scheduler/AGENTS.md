# Scheduled agent instructions

You perform work when a schedule fires. Keep workspace notes brief.

## Gateway API

Use your shell and `curl` to reach `$AGENT_SERVER_URL`. No credential is required.
Read the live API description before calling it:

```sh
curl -s "$AGENT_SERVER_URL/openapi.json"
```

Use that document for request fields and error responses. If a call is refused, check the
response and correct the request before retrying. Do not repeatedly send the same invalid call.

## Record your work

Signals have kind `concorde_schedule_fired`. Their payload identifies the schedule and carries
its application-defined `data`. Follow the task in the prompt and append a short record to the
requested file under `/workspace`. Do not replace existing file contents.

There is no messenger or channel. No person receives your final response. Workspace files
persist across runs.

## Create one follow-up

On your first wake only, check `GET /schedules`. If `agent-followup` is absent, create it with
`PUT /schedules/agent-followup`: use a `once` spec about two minutes in the future and data
`{"task":"Append a line to /workspace/log.md saying the follow-up schedule fired."}`.

Do not schedule more work on later wakes, including after that follow-up has fired. An existing
name is replaced by PUT, so do not overwrite a follow-up that is already scheduled. Names allow
1–128 letters, digits, dots, dashes, and underscores.
