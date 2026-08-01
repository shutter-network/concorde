# The Mount Table declares mounts and verifies nothing

The directories an agent's container sees are declared in a **Mount Table**: a list of entries, a translation table for a containerised Gateway, and the user the container runs as. It resolves to container arguments and nothing else. It creates no directories, writes no files, starts no containers and performs no checks. Nothing in it knows about `pi`, and a second Runtime Adapter would use the same one.

```
entries    [{ containerPath, gatewayPath, readOnly? }]   a directory or a single file
hostPaths  {}                                            empty means the Gateway is on the host
user                                                     defaults to this process's uid:gid

resolve    apply hostPaths (longest prefix), default the user, refuse an unmatched entry
emit       --mount type=bind,source=…,target=…[,readonly]  ×N   and   --user uid:gid
lookup     gatewayPathFor(containerPath)
```

This replaces the three-name `Mount` and the startup mount check that [ADR-0025](./0025-the-pi-adapter-spawns-one-confined-process-per-run.md) recorded. That document argued at length for a check; a reader who finds none should read the rest of this one, because the argument was sound and the premises it rested on were removed one at a time.

## One translation table, not a third name per mount

Three processes name the same directory, each resolving it in its own filesystem namespace: the Gateway process, which opens it with `fs`; the container runtime's daemon, which resolves the left half of a bind mount **on the host**; and the agent's container, which sees a mount point. When the Gateway runs on the host the first two are the same string, which is why the old shorthand worked and why the third name was almost always a default.

They diverge only when the Gateway is itself in a container. That is **one fact about the deployment**, and the old model spread it across every mount as a per-mount field. An Operator who containerises has to remember it three times, and getting two right and one wrong is a deployment that starts, serves, and has one silently empty directory in it.

`hostPaths` states it once, in the place where it is true. Absent, the mapping is identity and every entry's `gatewayPath` is its own source. Present, an entry whose `gatewayPath` falls under no prefix is **refused at resolution**, before anything is spawned: a containerised Gateway that declared two mappings and needed three fails as a pure function with a message naming the path, rather than as an empty directory discovered weeks later. Named volumes fit as exact-match entries rather than prefixes, which keeps [ADR-0025](./0025-the-pi-adapter-spawns-one-confined-process-per-run.md)'s position that a volume is never a framework concept, only a value.

Discovering `hostPaths` automatically was considered and deferred, not rejected. Two mechanisms work: `/proc/self/mountinfo`, whose fourth field is the mount's root within its source filesystem, and `docker inspect` on the Gateway's own container, which is authoritative and returns named volumes as names. The constraint recorded here for whoever picks this up: it must be the **exact** mechanism. The earlier argument that a heuristic was affordable rested on a round trip catching a bad guess, and there is no longer one. `mountinfo` returns a confident wrong path whenever the directory sits on a separate filesystem, a btrfs subvolume, or a Docker Desktop VM; `docker inspect` fails loudly or not at all.

## `--mount`, never `-v`

Verified against Docker 29.4.0:

| | `-v` | `--mount type=bind` |
| --- | --- | --- |
| missing directory source | creates it, uid 0 inside the container | refuses: `bind source path does not exist: /…` |
| missing **file** source | creates a **directory** with that name | refuses, same message |
| read-only | `:ro` suffix | `readonly` option |
| `:` in a path | `invalid mode: /x` | fine |
| `,` in a path | fine | needs CSV quoting, `"source=/a,b"`, which works |

The first row is the whole reason the old mount check existed, and the second is what would have happened to single-file entries under the old syntax. `--mount` turns both into a daemon refusal that names the path, so the framework needs no create-versus-require policy, no set of roles it is allowed to `mkdir`, and no defence against the daemon inventing a directory as `root` before the agent's container can write in it. The daemon never invents anything.

The colon guard the old `resolveMount` carried is gone with it, traded for a comma hazard that CSV quoting handles.

## Read-only entries, and entries that are files

An entry may name a single file, and may be read-only. Docker sorts bind mounts by destination depth, so a `readonly` **file** mount nests inside a read-write **directory** mount. Verified: the container reads the Gateway's content, an overwrite is denied with `EROFS`, an unlink is denied with `EBUSY`, and every sibling operation still succeeds, including creating the `proper-lockfile` lock directory that `pi` needs beside `settings.json` even to read it.

This is what lets a file the agent must not change be a file the agent **cannot** change. [ADR-0025](./0025-the-pi-adapter-spawns-one-confined-process-per-run.md) held that property by procedure: it rewrote the agent's configuration before every single Run, forever, so that a successful prompt injection could not durably reconfigure the agent. A read-only entry holds the same property by construction, and then the rewrite is redundant. Being denied is also survivable: `pi` records a failed settings write rather than throwing (`enqueueWrite` in `dist/core/settings-manager.js` catches into `recordError`), and its startup migration's write sits inside a `try`/`catch` that skips on error.

## The user is the Mount Table's

`--user` lives here rather than with the Runtime Adapter, and defaults to this process's `uid:gid`. Every reason it exists is a filesystem reason: with bind mounts the files the agent writes are owned by the container's user, so a mismatch leaves Signal Handlers unable to read what the agent wrote in the shared Workspace and the agent unable to read theirs. Ownership is a property of a shared filesystem, and *who is sharing it* is half of what this table describes.

`network`, `workdir`, `extraArgs` and the container command deliberately stay with the Runtime Adapter. The line is not "every container flag"; it is "the shared filesystem and who shares it". A tidier split that moved all of them would leave the adapter holding `image` and a container command anyway, producing two objects both partly about the container instead of one about the filesystem and one about the agent.

## Nothing is checked

ADR-0025 recorded four failures that were silent, and started a throwaway container at boot to catch them. Three no longer exist and the fourth is out of reach:

- **A source that is not there.** The daemon refuses it, naming the path.
- **A missing instructions file, which `--append-system-prompt` resolves to its own literal argument.** The framework no longer writes that file or passes that flag; an Operator-placed file is its own entry, so a missing source refuses the container.
- **A wrong `sessionRoot`, which makes every named Session start empty.** Survives only when the source exists *and is a different directory*, which requires a second namespace to be wrong in. Under identity mapping there is none: the daemon resolves the same string this process does, so a source that exists **is** the directory the Gateway sees. It returns only for a containerised Gateway with a populated `hostPaths` pointing somewhere real and wrong, which is the case deferred above.
- **A uid mismatch.** The Mount Table owns `--user` and defaults it to this process's own, so the containers it describes run as the right user unless an Operator overrode it deliberately. Where that is not decisive it was never observable anyway: Docker Desktop remaps ownership through its file sharing, and the old check admitted it could not see through that.

A pure pre-flight `stat` of every `gatewayPath` was considered, as the cheap remnant: no container, no image, roughly ten lines, and it would report every missing source at once and catch a file declared where a directory was meant. Rejected to keep the abstraction inert. A Mount Table that performs no I/O at all is a value and a pure function, and that is the property worth more than the check.

## Consequences

- **A typo'd path is discovered by the daemon at the first Run.** Under [ADR-0017](./0017-failed-runs-are-not-retried.md) nothing is retried, so this costs a **permanently dead Signal** rather than a startup error, and fixing the path and restarting does not bring it back. This is the price of the paragraph above, and it is the one consequence here that an Operator will actually meet.
- **The Operator creates every directory a mount needs.** The framework creates none, including the Session root and the agent's own directory, which it used to create. Forgetting one is the daemon refusal above.
- **The Runtime Adapter stops knowing that anything is mounted.** It holds container paths, which is all it needs to write `--workdir`, `PI_CODING_AGENT_DIR` and `--session-dir`. Where those paths come from, whether they are bind mounts, and what they are called on the host are not facts it can reach. `gatewayPathFor` exists so that one thing can still be recovered: the Gateway-side path of a Session's transcript, which ADR-0025 records as the question the forgetful-agent failure is diagnosed from.
- **A single-file entry is the only way to hand the container a file the agent cannot change**, and it is the recommended shape for anything the Operator wants to survive a prompt injection intact.
- **The container's own writable layer is still discarded every Run** by `--rm`, and is not modelled here. Anything outside the entries is gone when the Run ends; anything inside them persists forever, and nothing prunes.
