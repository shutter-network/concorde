# The reference deployment runs in a Compose stack

The Gateway of `example/` is a container in `example/compose.yml`, built from this
repository by `example/gateway/Dockerfile`, holding the host's Docker socket. `cd example &&
docker compose up -d --build` is the whole of running it, from a clean clone, with no host
toolchain.

```
gateway      this framework + docker-cli   saf_db, saf_agent   8080 published to loopback
postgres     postgres:17                   saf_db              nothing published
agent-image  builds saf-agent:0.83.0       saf_agent           exits 0
```

This reverses `compose.yml`'s own former header, which argued that the Gateway belonged on
the host. That argument is restated and answered below rather than deleted, because it was
correct about the hazard and wrong only about the alternative.

## The socket, which is the whole decision

The Gateway starts a container per Run. Containerising it means giving it a container
runtime socket, and the host's socket is root on the host: anything that can execute code in
the Gateway process can execute code as root outside it. The old header concluded that this
was "a far larger hole than the one it would close" and kept the Gateway on the host.

What that conclusion missed is that the Gateway holds container-creation authority
*wherever* it runs. On the host it holds the same socket, reached the same way, with the
same blast radius; being unconfined itself is not a smaller hole than being confined and
holding the key. The real question is only ever **whose** authority, and containerising does
not change the answer by itself.

The two ways to change the answer were both considered:

- **A socket proxy** allowlisting the endpoints `docker run` needs. It must allow the
  endpoint that starts a container with arbitrary bind mounts, which is sufficient on its own
  to mount `/` somewhere writable. It adds a service and an image and closes approximately
  nothing.
- **Rootless Docker, or Podman.** This genuinely shrinks the hole rather than relocating it,
  and the framework already supports it: `containerCommand` on the Agent Container takes
  `["podman"]`. It is rejected *for the reference deployment only*, because it makes the
  quickstart's first command fail on a stock Docker Desktop install, and the quickstart's
  entire claim is clone-to-Run.

So the demo stack takes the host's socket, and the quickstart says so before the first
command, next to the sentence telling you not to run it on a machine whose root you care
about. A deployment that is not a demo answers this differently, and rootless is the answer
it should reach for first.

**`example/` carries no comments**, and the socket is the one exception: a single line beside
that mount, pointing at the quickstart section. Everything the four files used to explain
about themselves now lives in the documentation, which is where a reader of a reference
deployment is going anyway, and the files are short enough to read whole. The cost is that a
reader who opens `compose.yml` alone learns nothing about why any of it is the way it is.

## `hostPaths` stops being hypothetical

[ADR-0028](./0028-the-mount-table-declares-mounts-and-verifies-nothing.md) introduced
`hostPaths` for exactly one case, a Gateway that is itself in a container, and nothing in the
repository was that case. Now the reference deployment is, and three consequences follow that
were previously only written down.

**The Gateway cannot discover its own host path.** ADR-0028 deferred automatic discovery and
set the bar for picking it up: an exact mechanism that fails loudly, or none. Nothing has
changed, so the path arrives as `HOST_DIR` in the environment, `${PWD}` in the
compose file, and `main.ts` refuses to start without it. That refusal is the one guard in the
entry point, and it is there because this is the deployment's one genuinely **silent**
failure: a wrong value resolves to a directory that may exist, and the agent then works in a
real directory that is not the one anybody is looking at.

**One prefix, not two.** The state directories are mounted inside the container at the same
place they sit relative to `example/` outside it, so `hostPaths` is a single entry keyed on
`import.meta.dirname`, and every Mount Table entry keeps the `path.join(import.meta.dirname,
…)` it had when the Gateway ran on the host. The cost is that `/app/example` is stated in
three places (the Dockerfile's `COPY` targets, the compose mount targets, and the container's
`WORKDIR`) and they have to agree.

**Two mounts name paths that do not exist in the Gateway's filesystem.** `AGENTS.md` and
`settings.json` are read by the *agent*, so they are not copied into the Gateway image; the
daemon resolves them on the host through `hostPaths`. This is legal because resolving a Mount
Table performs no I/O, which ADR-0028 chose for other reasons and which turns out to be what
makes a containerised Gateway expressible at all. Baking them into the *agent's* image was the
alternative and does not work: `/workspace` and the agent directory are bind-mounted, and a
bind mount shadows whatever the image had underneath it.

## The uid is root, and the drain meets a timeout

**Root.** The container process reaches `/var/run/docker.sock` as uid 0 or as a member of the
host's `docker` group, and that group's gid is machine-specific. So the Gateway container runs
as root, and since the Agent Container Runtime emits this process's own `uid:gid`
unconditionally (ADR-0028 removed the field), every agent container runs as root too, and
everything under `example/state/` is owned by root. On Docker Desktop the file sharing layer
remaps this and it is invisible; on Linux it is real, and `rm -rf example/state` wants `sudo`.
The alternative was a second machine-specific variable for the docker gid, which is the kind
that works on the author's machine.

**Five minutes.** Compose's default `stop_grace_period` is ten seconds, and
`gateway.stop()` drains without cancelling the Run in flight
([ADR-0017](./0017-failed-runs-are-not-retried.md)), which is an agent talking to a model.
Killed mid-drain, the `docker run` client dies while the container it started keeps running:
the outcome is read by nobody, the `runs` row stays `running` forever, and the Signal never
settles. The whole start-and-stop order in `src/default-gateway.ts` exists to protect that
drain, so a reference deployment that truncated it would be contradicting the thing it
demonstrates. `stop_grace_period: 300s` is a ceiling rather than a wait, and `docker compose
kill` is the escape.

## What the network gets, and what the example stops teaching

The Gateway joins both networks, the agent joins only `saf_agent`, and **PostgreSQL publishes
nothing**. Both Fastify servers bind `0.0.0.0`, which inside a container reaches the networks
joined and nothing else; 8080 is published to loopback and 7411 is published to nobody, so the
unauthenticated Agent server ([ADR-0010](./0010-the-agent-reaches-the-gateway-over-http.md))
is reachable from the agent's network and from no host on any other.

This closes something the quickstart previously had to confess. With the Gateway on the host,
PostgreSQL had to publish a port for it, and on Docker Desktop the agent could reach that port
through `host.docker.internal` no matter which network it was on, so the separation between
the agent and the Db was the password rather than the network. There is now no host port.

Three consequences accepted rather than solved:

- **The agent can reach the Public server**, since one bind covers both networks. It requires
  a Token, and the agent has none.
- **`postgres` can reach the Agent server**, for the same reason. Preventing it needs
  per-network binds, which Fastify does not express.
- **`0.0.0.0` is IPv4-only**, so `localhost` inside the Gateway container may resolve to `::1`
  and be refused. Anything reaching the Agent server from inside that container uses
  `127.0.0.1`. This is a trap for exactly one reader: the one creating the first User, since
  `POST /users` is on the Agent server and the Agent server is no longer published.

**Running the example on the host is no longer supported**, and that is a deliberate
subtraction. Supporting both would put three conditionals into the shortest honest
deployment we have (`hostPaths` present or absent, two bind addresses, two database hosts),
and the branch nobody ran would be the one nothing tested. `node example/main.ts` is gone
from CLAUDE.md with it. The inner loop pays for this: an edit to `src` is now `docker compose
up --build` rather than a `node` invocation, cached to the `tsc` layer but not instant.

## Consequences

- **`example/` is bound to the checkout it runs from.** `HOST_DIR` is `${PWD}`, so
  the stack must be brought up from `example/` and cannot be moved to a host that does not
  have the source. Compose resolves `./state` against the compose file's directory while
  `${PWD}` is the invocation's, and the two diverge under `-f example/compose.yml` from the
  repository root: a Workspace nobody is looking at, arrived at by running the documented
  command from the wrong directory. The mitigation is one line of instruction, which is
  weaker than a mechanism and is what ADR-0028's deferral costs.
- **Nothing creates a directory, still.** The two state directories are created by Compose,
  which creates a missing bind source, and the framework's promise to create nothing
  (ADR-0028) is unweakened. `main.ts` lost its `mkdir` without anything gaining one.
- **The Gateway image ships dev dependencies.** `drizzle-orm` and `fastify` are peer
  dependencies of the package and pinned devDependencies of this repository, so `npm ci
  --omit=dev` produces an image that dies on its first import. Copying the whole tree keeps
  every version stated once; naming the two peers again in the Dockerfile would put them
  somewhere that drifts silently.
- **`example/gateway/Dockerfile` builds from the repository root**, since it compiles the
  framework rather than installing it, so `example/` is no longer self-contained and a
  `.dockerignore` at the root is what keeps that context sane. When there is a published
  base image, the runtime stage's `FROM` is the one line that changes.
- **The address the agent is given is now assembled from three places** rather than two: the
  service name in `compose.yml`, the port in `main.ts`, and `AGENTS.md` which states the URL.
  It works because Compose gives a service its own name as a network alias and the daemon's
  DNS answers for that alias to any container on the network, including the agent containers
  the Gateway starts, which Compose knows nothing about. Verified, since nothing about it is
  guaranteed by the framework.
