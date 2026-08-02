# The agent image: `pi` and nothing else.
#
# There is no published `pi` image, so every deployment builds one. This is the
# reference: four requirements, and everything else is yours.
#
#  1. **A POSIX shell.** The agent's own shell tool needs one. Nothing of the
#     Gateway's does: it starts no container but the Run's.
#  2. **`curl`.** `pi` ships no HTTP client, so the agent reaching the Gateway's Agent
#     server is its shell tool plus `curl`. Without it the agent is told about an API
#     it cannot call.
#  3. **Nothing that depends on a passwd entry.** The container is started with
#     `--user <the Gateway process's uid:gid>`, an id this image has never heard of,
#     so nothing may need `/etc/passwd` to name it or `$HOME` to exist.
#  4. **The two paths below**, which is the requirement that replaced needing `pi` to
#     be the entry point: the Runtime passes an entry point now, so an image that
#     starts something else is a field rather than a workaround. See the two lines.
#
# Deliberately not here: the model, the API key, the Workspace, the instructions. The
# first two are passed in per Run and the last two are mounted, so a change to any of
# them is an edit to the entry point, or to a file beside it, rather than an image
# rebuild. Nothing writes into this image or into a mount; a mount is how the
# instructions can be read-only and can change without a rebuild.
FROM node:24-alpine

RUN apk add --no-cache curl

# Pinned, and worth keeping pinned. Every fact the Runtime relies on — the
# flag names, the JSONL record types, the terminal record, what the exit code does and
# does not mean — was read out of this exact version.
RUN npm install -g @earendil-works/pi-coding-agent@0.83.0

# The two paths the framework used to carry and hand back per Run, declared where an
# image already declares such things. Neither is a convenience:
#
#  - **`WORKDIR`** is where `pi` runs, and therefore where it looks for an `AGENTS.md`,
#    in this directory and its ancestors. It is also the path the Mount Table points the
#    Workspace at, and the two agreeing is the Operator's business and nothing else's.
#  - **`PI_CODING_AGENT_DIR`** is where `pi` keeps everything it writes: `auth.json`,
#    `trust.json`, `bin/`, and the Session transcripts. Something must state it, because
#    `pi`'s own default joins `.pi/agent` onto the home directory and a container running
#    as a uid with no passwd entry gets `HOME=/` — so the default resolves to `/.pi/agent`,
#    which the agent cannot create. It is a default that never works rather than one that
#    usually does (ADR-0025).
#
# Nothing checks either of them, or that they agree with the mounts: they are paths inside
# a program the framework does not depend on. Getting one wrong is a Run that fails, or —
# for the second — an agent that quietly forgets every Session.
WORKDIR /workspace
ENV PI_CODING_AGENT_DIR=/home/agent/.pi/agent

ENTRYPOINT ["pi"]
