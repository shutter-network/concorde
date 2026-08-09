# The Mount Table takes one required Runtime Directory

Amends [ADR-0028](./0028-the-mount-table-declares-mounts-and-verifies-nothing.md). The Mount Table
stops having a Gateway-side namespace. It takes one required host path, the **Runtime Directory**,
and every entry is written relative to it.

```
entries      [{ agentPath, path, readOnly? }]              a directory or a single file
runtimeDir   string                                        required; the host's path, unread

resolve      path.posix.join(runtimeDir, entry.path)
emit         --mount type=bind,source=…,target=…[,readonly]  ×N
```

`Mount.gatewayPath` is gone and `Mount.path` replaces it. `hostRoot` and its pair are gone.
`agentPath` is unchanged and stays absolute.

## Nothing ever read the Gateway side

ADR-0028 named each path for the actor that resolves it, and there were three actors: the Gateway
process, which was said to open a mount with `fs`; the daemon, which resolves a bind source on the
host; and the agent's container, which sees a mount point. The middle claim is the one this ADR
subtracts, and it was already false when ADR-0028 recorded it. The same document forbids this module
every kind of I/O, so the Gateway process never opened any of these paths; a `gatewayPath` reached
exactly one function, which either returned it unchanged or translated it into a host path. A
`ResolvedEntry` carries `agentPath`, `hostPath` and `readOnly`, and `mountArgument` emits `source=`
and `target=`. There is no third consumer to be found, because the two names were always one value
the framework carried under two spellings.

So the pair collapses into the half that is read. `runtimeDir` is the host's path and the daemon's
to resolve, handed over unread exactly as `hostRoot.hostPath` was, and an entry says where it sits
inside that directory rather than where some other process would find it.

That also removes the prefix an Operator had to write and the framework then checked they had
written. Under ADR-0028 a declared root made every `gatewayPath` restate it, sixteen `path.join`
calls across the four examples reconstructing a value the resolver already held, and the check that
each one fell under the root carried no information once the root was declared. Now the containment
is a property of the type: there is no way to write an entry outside the Runtime Directory, so
"falls outside the root" is not a refusal that got cheaper but a sentence with nothing left to say.

## Two refusals change places, and the count is the same

The "not absolute" refusal on `gatewayPath` and the "falls outside the hostRoot" refusal both go.
One refusal arrives: **a leading `/` on an entry's path**, naming the entry and the Runtime
Directory.

It is there because the old spelling does not fail, it succeeds wrongly.
`path.posix.join("/srv/saf", "/state/workspace")` is `/srv/saf/state/workspace`, and an Operator
copying an absolute path from the old shape into the new field gets a source under the root a second
time: a plausible path, no exception, and a daemon refusal at the **first Run**, which under
[ADR-0017](./0017-failed-runs-are-not-retried.md) is a permanently dead Signal rather than a startup
error.

`refuseDotSegment` is unchanged in mechanism and its reason is new. It covered `.` and `..` because
prefix matching over unnormalized paths is unsound, and there is no prefix matching left. It covers
them now because `join` would resolve a `..` away silently: `../secrets` under a Runtime Directory
of `/srv/saf` is `/srv/secrets`, outside the one directory this table describes, with nothing in the
value left to show that it left. It applies to an entry's `path` and to `runtimeDir`, and there is
no third path for it to apply to.

Refused, then, and each decidable from the value alone: a missing image, a relative `agentPath`, a
leading `/` on an entry's path, a `.` or `..` segment in `agentPath`, in an entry's `path` or in
`runtimeDir`, and a duplicate `agentPath`. Everything ADR-0028 declined to check it still declines
to check, and this module still performs no I/O.

## `runtimeDir: "/"` is the escape, spelled as an ordinary value

ADR-0028 granted a shared tree spanning more than one host mount an accommodation: declare no
`hostRoot` and write daemon-namespace paths into every `gatewayPath`. A required field removes that
accommodation, and `"/"` replaces it. The host root is a directory like any other, an entry under it
reads `mnt/b/thing`, and it resolves to `/mnt/b/thing`. Same reach, same paths, and no branch in the
type or in the resolver: it is the general rule evaluated at a particular value, which is what makes
it one fewer thing to document rather than one more.

## Costs

Recorded as costs. None of them is answered here.

- **An on-host Gateway loses zero-config identity mapping and must name its root.** Absent
  `hostRoot` used to mean "the Gateway is on the host", and the common deployment declared nothing.
  It now states `runtimeDir` like every other, and a value nothing discovers is a value that can be
  wrong: an Operator who moves the tree and forgets it gets a Gateway that starts, serves, and
  refuses at the first Run.
- **ADR-0028's "three actors, three names" rationale drops to two actors, and is rewritten rather
  than dropped.** That argument was the reason the shape had a `gatewayPath` at all, and it read
  well. What is left of it is that the agent's container and the daemon are still two namespaces and
  still need two names, which is a smaller and duller statement than the one it replaces. It is
  written out above rather than deleted, because a repository that keeps its own superseded
  reasoning is one where a later reader can see which premise moved.
- **The Gateway process can no longer address the Runtime Directory at all.** One namespace is left
  and it is the daemon's. A containerised Gateway wanting to read something in that tree has no path
  to it from this value, and there is no second field to ask. Anything the Gateway itself reads must
  come from its own image or from a path stated separately, which is what `02_decisions` already
  does with its signing key: a `SIGNING_KEY_FILE` its own process opens, nothing to do with the
  Mount Table. The framework does no I/O on these paths, so nothing inside it notices; a deployment
  that wanted one path for both purposes now writes two and keeps them agreeing by hand.
- **Everything the agent mounts must live under one directory on the host.** ADR-0028's model let an
  on-host Gateway mount `/etc/ssl/certs` beside `/srv/saf/workspace` without saying anything, and a
  containerised one had the daemon-namespace escape. Now a second tree means either moving it under
  the Runtime Directory or setting `runtimeDir: "/"` and writing every entry from the host root,
  which costs the whole deployment its short paths for the sake of one entry.

## Consequences

- **A Mount Table with no entries still names a Runtime Directory**, which nothing reads. The
  Runtime therefore falls back on an absent table rather than an empty one: no deployment is made to
  invent a directory it has no entries under.
- **A relative `runtimeDir` is not refused**, though it is decidable from the value. The list of
  refusals stayed the length ADR-0028 left it, and this is the one that was not added: a relative
  host path is the daemon's to reject at the first Run, with the same permanently dead Signal every
  other unresolvable path costs.
- **A double slash inside an entry's path is normalized rather than refused**, because `join` does
  it. ADR-0028 allowed empty segments on the grounds that the daemon collapses them, and they are
  now collapsed one step earlier. Nothing about a `.` or a `..` changes: those are refused before
  the join can see them.
- **The environment variable is `RUNTIME_DIR_HOST`**, and `BASE_DIR_GATEWAY` goes. The base names
  the referent and the suffix names whose path to it, which is the scheme `BASE_DIR_HOST` already
  used, and keeping `HOST` in the name is what stops an Operator writing their own container's view
  of the tree into it.
- **Two other ADRs name a field that no longer exists**, and neither is amended here.
  [ADR-0033](./0033-an-agent-is-a-container-and-one-function.md) lists "a `hostRoot` gap" among what
  the framework still refuses at construction, and
  [ADR-0039](./0039-the-reference-deployment-runs-in-a-compose-stack.md) has a section on `hostRoot`
  describing a deployment that has since been retired. Both are historical records of decisions that
  were correct when taken; the banner on ADR-0028 is where a reader arriving at any of them is sent.
- **Every deployment declaring mounts is a compile error until it is rewritten.** Both fields
  changed name, so nothing is silently reinterpreted: an entry keeping `gatewayPath` fails the type
  check, and a table with no `runtimeDir` fails it too. The four examples under `examples/` pin the
  published package and are unaffected until they are moved to a version carrying this.
