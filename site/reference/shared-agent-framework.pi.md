# shared-agent-framework/pi

The `pi` Agent Implementation, from `shared-agent-framework/pi`.

`createPiRuntime` is the whole of it for an Operator. Hand it an Agent Container, which comes
from the package root, because nothing about a container is `pi`'s. Then pass what comes back as
the Signal Worker's `runtime`. It contributes two overridable defaults and `piRun`, and nothing
else.

The other two exports are pure functions and are here to be read. `piRun` is what makes this `pi`
rather than any other agent. A Prompt goes in. The flags, the stdin and the outcome reader for
one Run come out. An author of a second Agent Implementation should read it, because it is the
entire size of the job. `interpretPiOutput` reads the JSONL event stream into a Run outcome. It
is where three traps live. The exit code says nothing, the terminal record is `agent_settled`
rather than `agent_end`, and the framing is LF-only.

There is no configuration type, no resolver and no invocation composer, because there is no
`pi`-shaped configuration left. The image, the mounts, the networks, the environment and the
flags describe a container and come from the package root. The model and the provider go in a
`settings.json` the Operator mounts. The working directory and the agent's own directory go in a
`Dockerfile` they build. The framework writes no file and names no path.

## Examples

A Gateway whose Runtime is `pi`, in a container the Operator declared.
```ts
import { createGateway, templateHandler } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({
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
  }),
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

A second Agent Implementation, written by copying `piRun`.
```ts
import type { RunPlan } from "shared-agent-framework";
import { createAgentContainerRuntime } from "shared-agent-framework";

// One function is the whole of what an Agent Implementation adds.
const runtime = createAgentContainerRuntime({
  container: { image: "my-other-agent:1", entrypoint: ["other-agent"] },
  run: (prompt): RunPlan => ({
    args: ["--json", "--session", prompt.session],
    // On stdin, never argv: a Prompt is arbitrary text and an agent reads argv its own way.
    stdin: prompt.text,
    outcome: async (stdout) => {
      for await (const _chunk of stdout) {
        // Read the whole stream, even once the outcome is known: a subprocess whose stdout
        // stops being read blocks as soon as the pipe fills.
      }
      return { ok: true };
    },
  }),
});
```

## Functions

### createPiRuntime()

```ts
function createPiRuntime(container): AgentContainerRuntime;
```

The `pi` Runtime: one fresh container per Run, of the image the Operator named.

Two defaults, spread beneath the Operator's own, which is the whole extension mechanism. There is
no registration, no base to extend and no lifecycle to implement. Both are conveniences rather
than rules, and an Operator who states either gets what they asked for:

 - `entrypoint: ["pi"]`, for an image that starts something else. A `pi` installed somewhere
   unusual is then a field rather than a workaround in `extraArgs`.
 - `PI_OFFLINE`, because a Gateway has no use for `pi`'s version check and its update
   telemetry. A Run must not depend on reaching `pi.dev`.

#### Parameters

##### container

[`AgentContainer`](shared-agent-framework.md#agentcontainer)

The container one Run happens in. Only `image` is required.

#### Returns

[`AgentContainerRuntime`](shared-agent-framework.md#agentcontainerruntime)

A Runtime to pass as `createGateway`'s `runtime`, plus `commandFor` for reading the
  composed command line without starting anything.

#### Throws

If the image is empty, or if the Mount Table cannot mean what it says.

#### Example

```ts
import { createGateway, templateHandler } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";

const runtime = createPiRuntime({
  image: "my-agent:1",
  networks: ["saf_default"],
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
});

// The command line, without starting a container: the one way to see the defaults applied.
console.log(runtime.commandFor({ session: "notes", text: "say hello" }).redactedArgs);

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime,
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

***

### interpretPiOutput()

```ts
function interpretPiOutput(source, session): Promise<RunOutcome>;
```

Reads one Run's `pi --mode json` output and reports how the Run ended.

Takes the raw bytes rather than decoded text. A chunk boundary falls wherever the operating
system puts it, including inside a multi-byte character. U+2028 is one. A subprocess's `stdout`
is exactly this, and taking text instead would move the decoding to the caller.

It also takes the Session, and names it in every failure. The Run's `error` column is the only
thing an Operator has to go on. `Session user_42 produced no output at all` says where to look.

The whole source is consumed even once the outcome is known. A subprocess whose stdout stops
being read blocks as soon as the pipe fills. That would turn a finished Run into a hang. There
are no timeouts anywhere.

#### Parameters

##### source

`AsyncIterable`\<`Uint8Array`\<`ArrayBufferLike`\>\>

The container's stdout, as raw chunks.

##### session

`string`

The Session this Run used. It is named in every failure message.

#### Returns

`Promise`\<[`RunOutcome`](shared-agent-framework.signals.md#runoutcome)\>

Whether the Run answered, and the reason if it did not. It never throws on bad output.

#### Example

```ts
import { interpretPiOutput } from "shared-agent-framework/pi";

const lines = [
  { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
  { type: "agent_settled" },
];
const stdout = (async function* () {
  yield new TextEncoder().encode(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
})();

console.log(await interpretPiOutput(stdout, "user_42")); // { ok: true }
```

***

### piRun()

```ts
function piRun(prompt): RunPlan;
```

One Run, as `pi` needs it performed: three flags and the Prompt.

The Prompt goes on stdin, never argv, and that is not a style choice. `pi` reads a leading
`@word` as a file to include. It refuses an argument starting with `-` as an unknown option. Both
are ordinary Handlebars output. Piped stdin becomes the initial message with neither treatment
applied.

Pure, and a total function of its Prompt. The Session is already a name by the time it gets here.
The Signal Worker resolved a Handler's request for a fresh one against the Run row it had just
written. There is nothing to generate and no naming convention of `pi`'s own.

Read this when writing a second Agent Implementation. It is the entire size of the job.

#### Parameters

##### prompt

[`RunPrompt`](shared-agent-framework.signals.md#runprompt)

The Prompt and the Session it belongs to.

#### Returns

[`RunPlan`](shared-agent-framework.md#runplan)

The agent's arguments, its stdin, and the reader for its stdout.

#### Throws

If the Prompt has no text. The agent drops an empty message rather than answering it.

#### Example

```ts
import { piRun } from "shared-agent-framework/pi";

const plan = piRun({ session: "user_42", text: "summarise the log" });
console.log(plan.args); // ["--mode", "json", "--session-id", "user_42", "--no-approve"]
console.log(plan.stdin); // "summarise the log"
```
