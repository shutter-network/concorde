# An Agent Implementation is a container and one function

Everything about running an agent as a container is **generic and lives in one place**, and what an Agent Implementation adds to it is **one function**: given a Prompt, what to put after the image, what to write on stdin, and how to read what comes back. The generic half is declared as an **Agent Container** and run by an **Agent Container Runtime**; `createPiRuntime` is that one function plus two defaults, and is eleven lines.

The `pi` adapter had ten configuration fields, and only two of them were about `pi`. The other eight described a container, and a second Agent Implementation would have needed all eight, unchanged, plus a re-implementation of the argument assembly, the confinement flags, the process handling and the environment redaction that went with them. [ADR-0028](./0028-the-mount-table-declares-mounts-and-verifies-nothing.md) had already pulled the filesystem out on exactly this argument; this finishes it, and the part it finishes is the part that was left behind because there was nowhere for it to go.

```
Agent Container         image, mounts?, entrypoint?, networks?, env?, extraArgs?,
                        containerCommand?, logger?          (only the image is required)

Runtime                 run(prompt) -> RunOutcome           (the seam the Signal Worker drives)

Agent Container Runtime a Runtime that runs one fresh container per Run, plus commandFor
                        constructed from { container, run }

run(prompt)             -> { args, stdin, outcome(stdout) } (the whole of what an agent adds)
```

## What moved, and what that cost

Six things left the `pi` adapter's configuration, and none of them went into the framework: they went into files the Operator already places in a directory they already mount, which is [ADR-0016](./0016-agent-configuration-is-opaque-to-the-framework.md) applied to the last places it had not reached. The model and provider are `settings.json`; the credential can be `auth.json`; the agent's own directory and its working directory are declared by the image; the Session root is gone entirely; the container's user stopped being configuration at all. [ADR-0025](./0025-the-pi-adapter-spawns-one-confined-process-per-run.md) records each of those individually, including the two that cost something real.

The price of the whole exercise is stated once here, because it is one price paid six times: **the framework can no longer refuse a deployment that cannot work.** It still refuses a missing image, a relative container path and a `hostPaths` gap, all at construction. It cannot refuse a missing model, a mounted directory `pi` will not look in, or an image whose entry point is not there, because it no longer knows any of those things. A Run that fails is never retried ([ADR-0017](./0017-failed-runs-are-not-retried.md)), so each of those is a permanently failed first Run rather than a startup error, and one of them, a Session root nobody mounted, is not even a failure: the agent simply forgets.

That is a worse failure mode than the one it replaces, and it is accepted for a reason that is not convenience. Every check the framework could perform here is a check on a file it does not read, for a program it does not depend on, at a path it was told about rather than chose. The previous design bought its checks by carrying `pi`'s configuration through the framework, and the cost of *that* was a `pi` adapter nobody could hold in their head and a second Agent Implementation nobody could write.

## Considered and rejected

**A type only, with each Runtime keeping its own orchestration.** The generic half would have been a shared parameter shape and nothing more. Rejected: the reusable part is not the eight fields, it is the four hundred lines that turn them into a running container, and a second Runtime would have copied all of it.

**Two holes rather than one**, an `invocation(prompt)` and a separately-supplied `outcome(stdout)`. Rejected once it was built. Producing the reader **per Run** lets it close over what that Run is, which is why a failed Run can now say `Session run_x produced no output at all` where before it could only say that something produced no output. A reader supplied once at construction cannot know which Session it is reading.

**`run` returning only `{ run }`.** The Agent Container Runtime also exposes `commandFor(prompt)`, a pure method giving the composed command line without starting anything. Without it the only way to see the argv is to start a container, and the argument-composition tests, which are the bulk of what is tested here and run with no Docker at all, would have had to restate the Runtime's own defaults in order to check them.

**`Sandbox` as the name.** Rejected as it has been before: `CONTEXT.md` lists it under **Shielded**, because it claims a guarantee [ADR-0004](./0004-runtime-confinement-is-the-deployments-responsibility.md) explicitly declines to make.

## Consequences

- **`runId` leaves the seam, and the Signal Worker names fresh Sessions.** It existed so that `pi` could turn it into `run_<id>` for a Prompt asking for a fresh Session. The Worker owns the Run row and is better placed to do it, so `Prompt.session` reaching a Runtime is always a string, and `run(prompt)` takes one argument. Two things improve: a Run's `session` column stops being `null` for exactly the case where the name was interesting, which ADR-0025 records as a wart, and the convention is one convention rather than one per Runtime. The Runtime's own log lines lose the id, which is affordable only because the Worker is serial: one Signal at a time, globally ([ADR-0012](./0012-the-gateway-is-a-serial-signal-worker.md)), so there is one Run in flight and the Worker's own lines bracket it.
- **An Agent Implementation contributes defaults by spreading them under the Operator's.** `pi` sets `entrypoint: ["pi"]` and `PI_OFFLINE`, both overridable, and that is the whole mechanism: there is no registration, no base to extend and no lifecycle to implement.
- **`entrypoint` is now modelled**, so an image whose `ENTRYPOINT` is not the agent no longer needs a workaround in `extraArgs`, and the reference Dockerfile's first requirement is retired. What ADR-0025 called half an escape hatch is still half: there is still no way to pass the agent itself a flag the framework does not model.
- **`networks` is plural and has no default.** There is no good one. The container runtime's own default is the shared bridge that ADR-0025 argues against, and `none` breaks every Run, since the agent needs both its model and the Agent server. A deployment that says nothing gets the bridge.
- **Every environment value is redacted from the logged command line, with no exceptions.** An exceptions list would have to be right about every provider's key name forever, and it would have to name `pi`'s own variables inside a module that must not know them. The cost is that `PI_CODING_AGENT_DIR` is no longer visible in a log line, where it was one of two values a mount problem was diagnosed from.
- **The Agent Container is exported from the package root, not from `./pi`.** Nothing in it knows about an Agent Implementation, and the whole point is that the next one needs it unchanged (ADR-0026).
- **"Runtime" now means one thing.** It had been three: the Agent Implementation, the part driving it, and `docker`. The seam takes the word, matching the Signal Worker's field, which was already called `runtime`; `pi` and `openclaw` become **Agent Implementations**; and `docker` keeps "container runtime", which is the industry's word and not ours to reassign.
