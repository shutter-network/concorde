FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY example/schema.ts example/drizzle.config.ts ./example/

WORKDIR /app/example

# --force is not "data loss is acceptable here", though on a volume you throw away it is.
# Without it, a push holding a statement drizzle-kit judges destructive stops to ask, finds
# no TTY, applies nothing at all — and exits 0. The gateway's
# service_completed_successfully would be satisfied by a migration that did not happen.
# A loud loss beats a silent skip; production runs `migrate` against a folder it reviewed,
# which asks nothing and takes no such flag.
CMD ["npx", "drizzle-kit", "push", "--force"]
