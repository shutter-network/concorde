# The agent image: `pi` and nothing else.
#
# There is no published `pi` image, so every deployment builds one. This is the
# reference: four requirements, and everything else is yours.
#
#  1. **`pi` is the entry point.** The Runtime Adapter appends `pi`'s own flags after
#     the image name, so an image whose entry point is something else needs
#     `--entrypoint pi` in the adapter's `extraArgs`.
#  2. **A POSIX shell.** The agent's own shell tool needs one. Nothing of the
#     Gateway's does: it starts no container but the Run's.
#  3. **`curl`.** `pi` ships no HTTP client, so the agent reaching the Gateway's Agent
#     server is its shell tool plus `curl`. Without it the agent is told about an API
#     it cannot call.
#  4. **Nothing that depends on a passwd entry.** The container is started with
#     `--user <the Gateway process's uid:gid>`, an id this image has never heard of,
#     so nothing may need `/etc/passwd` to name it or `$HOME` to exist. `pi` is
#     pointed at the mounted agent directory by an environment variable the adapter
#     sets, which is where it keeps everything it writes.
#
# Deliberately not here: the model, the API key, the Workspace, the instructions. The
# first two are passed in per Run and the last two are mounted, so a change to any of
# them is an edit to the entry point, or to a file beside it, rather than an image
# rebuild. Nothing writes into this image or into a mount; a mount is how the
# instructions can be read-only and can change without a rebuild.
FROM node:24-alpine

RUN apk add --no-cache curl

# Pinned, and worth keeping pinned. Every fact the Runtime Adapter relies on — the
# flag names, the JSONL record types, the terminal record, what the exit code does and
# does not mean — was read out of this exact version.
RUN npm install -g @earendil-works/pi-coding-agent@0.83.0

ENTRYPOINT ["pi"]
