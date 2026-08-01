# An image with `pi` in it, for the one opt-in end-to-end test.
#
# Not the reference deployment's Dockerfile — that is a deliverable of its own, and
# an Operator's image is theirs to build. This one exists so the test has something
# real to start, and it says out loud what the adapter needs of any image:
#
#  - `pi` is the **entry point**, because the adapter appends `pi`'s own flags after
#    the image name. An image whose entry point is something else needs
#    `--entrypoint pi` in `extraArgs`.
#  - a POSIX shell, which the agent's own `bash` tool needs. Nothing of the Gateway's
#    does: it starts no container but the Run's.
#  - `curl`, because `pi` ships no HTTP client and reaching the Agent server is the
#    agent's own `bash` plus `curl` (ADR-0010).
#  - nothing about a user: the container is run with `--user <the Gateway's uid:gid>`,
#    which is an id the image knows nothing about, so nothing may depend on a home
#    directory or a passwd entry existing for it. `PI_CODING_AGENT_DIR` points `pi` at
#    the mounted agent directory, which is where it keeps everything.
FROM node:24-alpine

RUN apk add --no-cache curl

# Pinned to the version every fact in ADR-0025 and `src/pi/` was verified against.
RUN npm install -g @earendil-works/pi-coding-agent@0.83.0

ENTRYPOINT ["pi"]
