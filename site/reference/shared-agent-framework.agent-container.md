# shared-agent-framework/agent-container

One Run in one fresh container, generic over which agent program runs in it. An Agent Container
is the declaration of that container: the image, what it reaches on disk, the networks, the
environment and the flags the framework does not model. It is inert, and creates nothing until a
Run starts.

[createAgentContainerRuntime](#createagentcontainerruntime) is the entry point. It takes an
[AgentContainerRuntimeSpec](#agentcontainerruntimespec), which is an [AgentContainer](#agentcontainer) beside one function that
answers each Run with a [RunPlan](#runplan): what to put after the image, what to write on stdin, and
how to read stdout. [AgentContainerRuntime](#agentcontainerruntime) comes back, a Runtime the Signal Worker
accepts, and `commandFor` on it composes one Run's [ComposedCommand](#composedcommand) and starts nothing.
[MountTable](#mounttable) is the disk half, one [Mount](#mount) per directory or file, and
[mountArguments](#mountarguments) turns a table into container arguments on its own.

Reach for this to drive an agent program this package does not adapt. For `pi`,
`shared-agent-framework/pi` supplies that one function and two defaults, and takes an
[AgentContainer](#agentcontainer) written exactly as it is written here. Nothing on this subpath names an
agent program or reads a value one of them defines, so what the agent finds in its image and on
its command line stays the author's to decide.

Nothing here reads the filesystem. [createAgentContainerRuntime](#createagentcontainerruntime) composes a command line
once, at construction, so a declaration that cannot mean anything is refused where the Operator
wrote it. Whether a path exists is the container runtime's answer, and it arrives at the first
Run as a Run that failed and will not be retried. This subpath has no Component and no route, it
does not use the Db, and it exports no schema.

## Example

A Runtime for an agent program of your own: it takes the Prompt on stdin and prints what it said
on stdout.
```ts
import { createAgentContainerRuntime } from "shared-agent-framework/agent-container";
import { createGateway } from "shared-agent-framework/gateway";

const runtime = createAgentContainerRuntime({
  container: {
    image: "my-own-agent:1",
    networks: ["saf_default"],
    // Only what is named here reaches the agent. None of the Gateway's own environment does.
    env: { MY_AGENT_KEY: process.env.MY_AGENT_KEY ?? "" },
    mounts: {
      entries: [
        { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
        { agentPath: "/workspace/AGENTS.md", gatewayPath: "/srv/saf/AGENTS.md", readOnly: true },
      ],
    },
  },
  // Called once per Run, and its result drives both the command line and the reading of stdout.
  run: (prompt) => ({
    args: ["--session", prompt.session],
    stdin: prompt.text,
    outcome: async (stdout) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stdout) chunks.push(chunk);
      const said = Buffer.concat(chunks).toString("utf8").trim();
      // A bad stream is a failed Run and never a throw, which would kill the container.
      return said === "" ? { ok: false, error: "the agent said nothing" } : { ok: true };
    },
  }),
});

// The whole command line, with the defaults applied and every environment value hidden.
console.log(runtime.commandFor({ session: "notes", text: "say hello" }).redactedArgs);

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime,
  // Not loopback: the agent reaches this server from a container of its own.
  agentListen: { host: "0.0.0.0", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  handlers: () => ({}),
});

await gateway.start();
```

## Type Aliases

### AgentContainer

```ts
type AgentContainer = {
  containerCommand?: readonly string[];
  entrypoint?: readonly string[];
  env?: Readonly<Record<string, string>>;
  extraArgs?: readonly string[];
  image: string;
  logger?: Logger;
  mounts?: MountTable;
  networks?: readonly string[];
};
```

The container one Run happens in, as an Operator declares it. Inert: it creates nothing, checks
no path and starts nothing.

Everything but `image` is a default worth overriding, or a fact about a deployment that most
deployments do not have.

The container is always run with `--rm`, with stdin open and no TTY, and as this process's own
uid and gid. None of the three is configurable: a TTY makes an agent decide it is being used
interactively, and a container running as root leaves files in a bind mount that a Signal
Handler can read and delete but cannot change.

#### Properties

##### containerCommand?

```ts
readonly optional containerCommand?: readonly string[];
```

How the container runtime is invoked. Defaults to `["docker"]`, and `["podman"]` works.

##### entrypoint?

```ts
readonly optional entrypoint?: readonly string[];
```

What to run inside the image, in place of its own `ENTRYPOINT`.

The first word becomes `--entrypoint`, which takes exactly one. Anything after it is the
container's command and lands after the image name, ahead of what the agent's own function
contributes.

##### env?

```ts
readonly optional env?: Readonly<Record<string, string>>;
```

Environment variables for the agent's container, such as a provider API key or a proxy.

Only what is named here reaches the agent, and none of the Gateway's own environment does,
which is most of why the agent runs in a container at all. Every **value** is hidden in the
loggable copy of the command line, with no exception for a name that looks harmless.

##### extraArgs?

```ts
readonly optional extraArgs?: readonly string[];
```

Container flags the framework does not model, spliced in last so that one here overrides one
the framework set.

The one escape hatch, and how to countermand `--user`, a later `--user` winning. It reaches
the container runtime only: there is still no way to pass the agent itself an unmodelled flag.

##### image

```ts
readonly image: string;
```

The container image, handed to the container runtime as written, so a tag or a digest pins what
runs.

##### logger?

```ts
readonly optional logger?: Logger;
```

Where this Runtime logs its two `debug` lines per Run, the composed command line and how the
container ended. Defaults to a `pino` instance on stdout, which drops both.

##### mounts?

```ts
readonly optional mounts?: MountTable;
```

What the container can reach on disk. Absent means nothing at all.

That is a real deployment: an image that bakes in its own configuration and keeps no state
mounts nothing. What it costs is silent, because nothing written survives the container. Every
Run is then a first Run, whatever Session it names, and no log line says so.

##### networks?

```ts
readonly optional networks?: readonly string[];
```

The container networks to join, one `--network` each.

Plural, a container being able to join several. There is no default and no good one: the
container runtime's own is the shared bridge, and no network at all breaks every Run, the
agent needing both its model and the Agent server.

***

### AgentContainerRuntime

```ts
type AgentContainerRuntime = Runtime & {
  commandFor: (prompt) => ComposedCommand;
};
```

A Runtime, plus one pure method the seam itself has no use for.

`commandFor` composes the command line for a Prompt without starting anything, which is the only
way to see this Runtime's own defaults applied to a declaration.

#### Type Declaration

##### commandFor()

```ts
commandFor(prompt): ComposedCommand;
```

###### Parameters

###### prompt

[`RunPrompt`](shared-agent-framework.signals.md#runprompt)

###### Returns

[`ComposedCommand`](#composedcommand)

***

### AgentContainerRuntimeSpec

```ts
type AgentContainerRuntimeSpec = {
  container: AgentContainer;
  run: (prompt) => RunPlan;
};
```

What one containerised agent is: the box an Operator declares, and the one function that drives
an agent inside it.

The two are separate fields rather than one flat object, so a field written in the wrong half is
a type error rather than a container flag nothing reads.

#### Properties

##### container

```ts
readonly container: AgentContainer;
```

#### Methods

##### run()

```ts
run(prompt): RunPlan;
```

The whole of what an Agent Implementation adds. Called once per Run, and its result drives both
the command line and the reading of stdout.

One function and not two, because `outcome` comes out of it per Run and can therefore close
over which Run this is and name the Session when it fails.

`prompt.session` is always a string here. A Signal Handler may ask for a fresh Session, and
the Signal Worker has already settled that and named it before anything reaches this.

###### Parameters

###### prompt

[`RunPrompt`](shared-agent-framework.signals.md#runprompt)

###### Returns

[`RunPlan`](#runplan)

***

### ComposedCommand

```ts
type ComposedCommand = {
  args: readonly string[];
  command: string;
  redactedArgs: readonly string[];
  stdin: string;
};
```

One Run's command line, and what to feed it.

#### Properties

##### args

```ts
readonly args: readonly string[];
```

Its arguments: the container's flags, then the image, then the agent's own.

##### command

```ts
readonly command: string;
```

The program: the container runtime.

##### redactedArgs

```ts
readonly redactedArgs: readonly string[];
```

The same arguments with every environment **value** replaced. Log this and never `args`.

Redacted here because this is the one place that knows which argument is a value and which is
a flag. A variable set to nothing stays visibly empty, there being nothing in it to hide.

##### stdin

```ts
readonly stdin: string;
```

The Prompt, or whatever else the agent's own function asked to have written to stdin.

***

### Mount

```ts
type Mount = {
  agentPath: string;
  gatewayPath: string;
  readOnly?: boolean;
};
```

One entry: a directory or a single file the agent's container can reach.

Nothing here says which of the two it is, and nothing needs to. Each path is named for the actor
that resolves it: `agentPath` for the agent's own container, `gatewayPath` for the Gateway
process.

#### Properties

##### agentPath

```ts
readonly agentPath: string;
```

The mount point the agent sees. Absolute, and POSIX whatever platform this is.

Two entries naming one `agentPath` are refused, a trailing slash making no difference.

##### gatewayPath

```ts
readonly gatewayPath: string;
```

Where the Gateway process resolves the same thing, on its own side. Absolute.

##### readOnly?

```ts
readonly optional readOnly?: boolean;
```

Whether the agent can write it. Defaults to `false`.

A read-only **file** nested inside a read-write **directory** works, the container runtime
sorting bind mounts by destination depth: the file is unwritable and unlinkable while every
operation on its siblings still succeeds. That is how a file the agent must not change becomes
one it cannot.

***

### MountTable

```ts
type MountTable = {
  entries: readonly Mount[];
  hostRoot?: {
     gatewayPath: string;
     hostPath: string;
  };
};
```

The whole of what the agent's container can reach on disk.

Everything else about the container belongs to the `AgentContainer` that carries this: the image,
the entry point, the networks and the environment.

#### Properties

##### entries

```ts
readonly entries: readonly Mount[];
```

The entries, in whatever order suits the reader.

Declaration order is preserved in the arguments and means nothing to the outcome. The daemon
sorts bind mounts by destination depth, so a nested entry nests under its parent however the
two were written.

An empty list is a deployment too and is not refused. Nothing the agent writes then outlives
the container, so every Run is a first Run.

##### hostRoot?

```ts
readonly optional hostRoot?: {
  gatewayPath: string;
  hostPath: string;
};
```

How this Gateway's own filesystem maps to the host's, for a Gateway that is itself in a
container.

Absent means the Gateway runs on the host, which is the common case: every entry's
`gatewayPath` is then its own bind source, the daemon resolving the same string this process
does. The two part company only for a containerised Gateway, and that is one fact about the
deployment rather than a property of each mount, which is why it is stated once here.

Present, it is exhaustive. A `gatewayPath` equal to the root resolves to `hostPath` whole, one
below it resolves to `hostPath` with the remainder appended, and one falling **outside** the
root is refused, naming the entry and the root. Nothing discovers either value, so state both
yourself. A shared tree spanning more than one host mount cannot be expressed through one
pair: write daemon-namespace paths into each `gatewayPath` and declare no root at all, at the
price of paths this process cannot itself list.

###### gatewayPath

```ts
readonly gatewayPath: string;
```

Where the shared tree sits inside this Gateway's own container. Absolute.

###### hostPath

```ts
readonly hostPath: string;
```

Where the daemon finds that same tree on the host. Absolute, and handed over unread.

***

### RunPlan

```ts
type RunPlan = {
  args: readonly string[];
  stdin: string;
  outcome: (stdout) => Promise<RunOutcome>;
};
```

How to perform one Run: the agent's arguments, its stdin, and how to read what comes back.

#### Properties

##### args

```ts
readonly args: readonly string[];
```

The agent's own arguments, placed after the image name.

##### stdin

```ts
readonly stdin: string;
```

Written to the container's stdin, which is then closed.

#### Methods

##### outcome()

```ts
outcome(stdout): Promise<RunOutcome>;
```

Reads the container's stdout into an outcome, and decides whether the Run succeeded.

Raw bytes rather than text, so a multi-byte character split across two chunks is this
function's to reassemble. Report a bad stream as a failed Run rather than throwing: a throw
kills the container and propagates, where a failure is recorded against the Run with the exit
status and stderr appended to the message.

The stream is what decides. A reader that answers success is believed even if the container
then exits non-zero, which is logged as the contradiction it is.

###### Parameters

###### stdout

`AsyncIterable`\<`Uint8Array`\<`ArrayBufferLike`\>\>

###### Returns

`Promise`\<[`RunOutcome`](shared-agent-framework.signals.md#runoutcome)\>

## Functions

### createAgentContainerRuntime()

```ts
function createAgentContainerRuntime(spec): AgentContainerRuntime;
```

Builds a Runtime that runs the agent as one fresh container per Run, discarding the container
afterwards.

A command line is composed once here and thrown away, so that a declaration which cannot work is
refused where the Operator wrote it. That is worth a startup failure because the alternative is
a Run that fails at the first Signal and is never retried.

#### Parameters

##### spec

[`AgentContainerRuntimeSpec`](#agentcontainerruntimespec)

#### Returns

[`AgentContainerRuntime`](#agentcontainerruntime)

#### Throws

If the image is empty, or if the Mount Table cannot mean what it says.

***

### mountArguments()

```ts
function mountArguments(table): readonly string[];
```

Turns a Mount Table into one `--mount` and its value per entry, in declaration order, or refuses
the table.

Pure and total. It applies `hostRoot`, and it refuses a relative path on either side, a `.` or
`..` segment in any path it resolves, an entry falling outside the root, and two entries naming
one target.

It performs no I/O, so it cannot say whether any of these paths exists. That answer comes from
the daemon at the first Run, as a Run that failed and will not be retried, which is why
`createAgentContainerRuntime` calls this at construction: the refusals it can make, it makes
where the Operator wrote the table.

#### Parameters

##### table

[`MountTable`](#mounttable)

#### Returns

readonly `string`[]

#### Throws

On any of those four.
