# An image with `pi` in it, for the one opt-in end-to-end test.
#
# Not the reference deployment's Dockerfile — that is a deliverable of its own, and
# an Operator's image is theirs to build. This one exists so the test has something
# real to start, and it says out loud what a `pi` deployment needs of any image:
#
#  - a POSIX shell, which the agent's own `bash` tool needs. Nothing of the Gateway's
#    does: it starts no container but the Run's.
#  - `curl`, because `pi` ships no HTTP client and reaching the Agent server is the
#    agent's own `bash` plus `curl` (ADR-0010).
#  - nothing about a user: the container is run with `--user <the Gateway's uid:gid>`,
#    which is an id the image knows nothing about, so nothing may depend on a home
#    directory or a passwd entry existing for it.
#  - the **two paths below**. The framework passes neither and knows neither, so an
#    image that omits them is one every Run fails in — or worse, for the second one,
#    an agent that forgets every Session and says nothing (ADR-0025, ADR-0033).
#
# `pi` is the entry point here, and no longer has to be: the Runtime passes one, so
# this line is what the test's image happens to do rather than a requirement.
FROM node:24-alpine

RUN apk add --no-cache curl

# Pinned to the version every fact in ADR-0025 and `src/pi/` was verified against.
RUN npm install -g @earendil-works/pi-coding-agent@0.83.0

# Where `pi` runs, which is therefore where it looks for an `AGENTS.md` — in this
# directory and its ancestors — and where the Workspace is mounted. There is no
# `--workdir` any more, and nothing checks that this agrees with a mount.
WORKDIR /workspace

# Where `pi` keeps everything it writes, transcripts included. Stated because it must
# be: `pi`'s own default joins `.pi/agent` onto the home directory, and a container
# running as a uid with no passwd entry gets `HOME=/`, so the default resolves to
# `/.pi/agent`, which the agent cannot create.
ENV PI_CODING_AGENT_DIR=/home/agent/.pi/agent

ENTRYPOINT ["pi"]
