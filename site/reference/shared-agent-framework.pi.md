# shared-agent-framework/pi

The `pi` Agent Implementation drives the `pi` coding agent as the Signal Worker's Runtime. An
Agent Implementation is the interchangeable agent program a Run happens in, and `pi` is the one
this package adapts.

[createPiRuntime](#createpiruntime) is the whole of it for an Operator: hand it an Agent Container, and pass
what comes back as the Signal Worker's `runtime`. [piRun](#pirun) and [interpretPiOutput](#interpretpioutput) are
pure functions, exported to be called from a test and to be read. `piRun` holds everything
specific to `pi` and nothing else does, so it is the entire size of the job for an author writing
a second Agent Implementation.

Nothing about a container is here. The Agent Container, the Mount Table, the argument assembly,
the confinement flags, the process handling and the diagnosis appended to a failure all come from
the package root, generic over which agent runs, so a second Agent Implementation takes them
unchanged.

Nothing `pi`-shaped is here either, and there is no configuration type at all. The model and the
provider are `defaultModel` and `defaultProvider` in a `settings.json` the Operator mounts. The
working directory and the agent's own directory are `WORKDIR` and `PI_CODING_AGENT_DIR` in an
image the Operator builds, no `pi` image being published. The Session directory is `pi`'s own to
resolve. Nothing here writes a file or names a path, and so nothing here can refuse a deployment
that is missing one: that deployment is a Gateway which starts, serves, and then fails its first
Run permanently.

## Example

A Gateway whose Runtime is `pi`, in a container the Operator declared.
```ts
import { createGateway, templateHandler } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";

const runtime = createPiRuntime({
  image: "my-agent:1",
  networks: ["saf_default"],
  // Only what is named here reaches the agent. None of the Gateway's own environment does.
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  mounts: {
    entries: [
      { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
      { agentPath: "/workspace/AGENTS.md", gatewayPath: "/srv/saf/AGENTS.md", readOnly: true },
    ],
  },
});

// The command line, without starting a container: the one way to see the defaults applied.
console.log(runtime.commandFor({ session: "notes", text: "say hello" }).redactedArgs);

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime,
  // Not loopback: the agent reaches this server from a container of its own.
  agentListen: { host: "0.0.0.0", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  handlers: () => ({
    "note.written": templateHandler({
      template: new URL("./prompts/note-written.hbs", import.meta.url),
      session: () => "notes",
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.start();
```

## Functions

### createPiRuntime()

```ts
function createPiRuntime(container): AgentContainerRuntime;
```

Builds a Runtime that runs `pi` as one fresh container per Run, of the image the container names.

Two defaults sit beneath the Operator's own, and a container stating either one gets what it
asked for. `entrypoint` is `["pi"]`, so an image that starts something else, or a `pi` installed
somewhere unusual, is a field rather than a workaround. `PI_OFFLINE` is set, because a Gateway has
no use for `pi`'s version check and its update telemetry, and a Run must not depend on reaching
`pi.dev`.

#### Parameters

##### container

[`AgentContainer`](shared-agent-framework.md#agentcontainer)

#### Returns

[`AgentContainerRuntime`](shared-agent-framework.md#agentcontainerruntime)

#### Throws

If the container names no image, or if its Mount Table cannot mean what it says.

***

### interpretPiOutput()

```ts
function interpretPiOutput(source, session): Promise<RunOutcome>;
```

Reads one Run's `pi --mode json` output and reports how the Run ended.

No exit code is read and none is taken, because `--mode json` exits 0 on a model error and on an
API error. What decides the outcome is the stop reason on the last assistant message before the
agent settled. An `agent_end` record is not that settle: it fires per low-level agent run, and a
retry or a compaction can follow it and continue the same Run, so a stream ending after one is a
Run that did not finish.

The `source` is the container's stdout as raw chunks rather than as decoded text, a chunk boundary
falling wherever the operating system puts it, including inside a multi-byte character.

Bad output never throws. A stream that stopped early, ended mid-record, or carried a line that is
not a record is a failed Run with a reason, and never a success inferred from the records that did
parse. Every reason names the `session`, because a Run's `error` column is the only thing an
Operator has to go on, and `Session user_42 produced no output at all` says where to look.

The whole source is consumed even once the outcome is known, a subprocess whose stdout stops being
read blocking as soon as the pipe fills, which would turn a finished Run into a hang. There is no
timeout here or anywhere else, so a stream that never ends never returns.

#### Parameters

##### source

`AsyncIterable`\<`Uint8Array`\<`ArrayBufferLike`\>\>

##### session

`string`

#### Returns

`Promise`\<[`RunOutcome`](shared-agent-framework.signals.md#runoutcome)\>

***

### piRun()

```ts
function piRun(prompt): RunPlan;
```

Plans one Run as `pi` needs it performed: three flags, the Prompt on stdin, and a reader for the
JSONL that comes back. The flags are `--mode json`, `--session-id <session>` and `--no-approve`,
and nothing else is passed.

The Prompt goes on stdin, never argv, and that is not a style choice. `pi` reads a leading `@word`
on argv as a file to include, and refuses an argument starting with `-` as an unknown option. Both
are ordinary Handlebars output. Piped stdin becomes the initial message with neither treatment
applied.

Pure, and a total function of its Prompt. Nothing is started, nothing is written, and no Session
name is invented: the Session is already a name by the time it arrives here, the Signal Worker
having answered a Handler's request for a fresh one against the Run row it had just written. The
reader is [interpretPiOutput](#interpretpioutput), closed over that Session, so a failure says which Session it
was.

#### Parameters

##### prompt

[`RunPrompt`](shared-agent-framework.signals.md#runprompt)

#### Returns

[`RunPlan`](shared-agent-framework.md#runplan)

#### Throws

If the Prompt has no text. The agent drops an empty message rather than answering it, so
  the Run would settle having said nothing.
