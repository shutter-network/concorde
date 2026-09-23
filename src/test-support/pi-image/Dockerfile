# An image with `pi` and a listener in it, for the one opt-in end-to-end test.
#
# Not an example's Dockerfile: each of those is a deliverable of its own, and an
# Operator's image is theirs to build. This one exists so the test has a real Agent
# Instance to talk to, and it says out loud what such an image needs:
#
#  - a POSIX shell, which the agent's own `bash` tool needs.
#  - `curl`, because `pi` ships no HTTP client and reaching the Agent server is the
#    agent's own `bash` plus `curl`. The agent runs in a container and reaches the
#    Gateway over HTTP and by no other route, which is the trust boundary
#    `site/architecture.md` describes under "The two servers".
#  - `socat`, which is what turns one `pi` into something a Gateway can connect to:
#    `TCP-LISTEN:4000,reuseaddr,fork` with `EXEC:pi --mode rpc` starts one `pi` per
#    connection, and a connection is one Run. **No commas may appear in that `EXEC:`
#    argument**, comma being `socat`'s own option separator, and **`socat`'s `stderr`
#    option must never be added**: `pi` writes its diagnostics there, and merging them
#    into stdout puts non-JSON into the record stream and fails every Run.
#  - nothing about a user: the container is run with `--user <the test's uid:gid>`,
#    which is an id the image knows nothing about, so nothing may depend on a home
#    directory or a passwd entry existing for it.
#  - the **two paths below**, and a third the container is started with. The framework
#    passes none of them and knows none of them.
#
# There is no `ENTRYPOINT`: what this image runs is given on the command line, because
# the process an Operator starts is a listener and the agent is what it starts.
FROM node:24-alpine

RUN apk add --no-cache curl socat

# Pinned to the version every fact in `src/pi/` was verified against.
RUN npm install -g @earendil-works/pi-coding-agent@0.85.1

# Where `pi` runs, which is therefore where it looks for an `AGENTS.md` — in this
# directory and its ancestors — and where the Workspace is mounted. `socat` inherits it
# and so does every `pi` it starts.
WORKDIR /workspace

# Where `pi` keeps everything it writes that is not a Session. Stated because it must
# be: `pi`'s own default joins `.pi/agent` onto the home directory, and a container
# running as a uid with no passwd entry gets `HOME=/`, so the default resolves to
# `/.pi/agent`, which the agent cannot create.
#
# Sessions are not under it any more. The Gateway names a path per Run, so where they go
# is the directory the Operator mounts and tells the Gateway about, and `pi` resolves
# nothing.
ENV PI_CODING_AGENT_DIR=/home/agent/.pi/agent
