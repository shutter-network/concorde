# The Gateway image: this framework, built from source, plus a Docker CLI.
#
# Its build context is the **repository root**, not this directory, because it compiles
# the framework rather than installing it. `compose.yml` says so in its `build` block, and
# `.dockerignore` at the root is what keeps that context from carrying `node_modules`,
# `dist` and the state directory into the daemon.
#
# There is no published package yet, so building is the only option. When there is a
# published base image, the second stage's `FROM` is the line that changes and nothing
# else here does.
FROM node:24-alpine AS build

WORKDIR /app

# The lockfile alone first, so a change to `src` reuses the install layer. `npm ci`
# installs devDependencies too, and that is not laziness: `drizzle-orm` and `fastify` are
# peer dependencies of this package and pinned devDependencies of this repository, which
# is how it builds and tests against them. `--omit=dev` would produce an image whose
# Gateway dies on its first import.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine

# The framework spawns the container runtime as a **process**, not through an API client:
# `src/container/process.ts` runs `docker` from PATH, and `containerCommand` is the field
# that names something else. So the CLI is a requirement of the image, and the daemon it
# talks to is the host's, over the socket `compose.yml` mounts.
RUN apk add --no-cache docker-cli

WORKDIR /app

# The whole tree from the build stage, dev dependencies included, for the reason above.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# `package.json` is not decoration here. `example/main.ts` imports this package **by
# name**, which Node resolves by self-reference through the `exports` map, so the manifest
# is what makes `shared-agent-framework` resolvable from inside the package itself, with
# no `node_modules` entry of its own.
COPY package.json ./

# The shipped migration folders. `dist/users/migrations.js` resolves its own folder as
# `../../migrations/users` from `import.meta.url`, so these have to sit beside `dist`
# exactly as they sit beside `src`, or `db.migrate()` fails on a folder that is not there.
COPY migrations ./migrations

# The deployment's own two files, and deliberately **not** `AGENTS.md` or `settings.json`.
# Those two are read by the *agent*, which gets them as bind mounts that the host's daemon
# resolves on the host, so a copy in this image could never be the copy anybody reads. The
# Mount Table names them anyway, at paths that do not exist in this filesystem, and that is
# legal precisely because resolving a Mount Table performs no I/O (ADR-0028). `main.ts`
# says the same thing where it declares them.
COPY example/main.ts ./example/main.ts
COPY example/prompts ./example/prompts

# Node is PID 1 and gets the SIGTERM from `docker compose down` directly, which is what
# `main.ts`'s shutdown loop is waiting for. How long it is then given to drain is
# `stop_grace_period` in `compose.yml`, and it is not the default.
CMD ["node", "example/main.ts"]
