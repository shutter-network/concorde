# One ESM-only package, built with tsc

The framework ships as a **single npm package** with subpath exports — the root for the Core and the Store, `/messenger` for the Messenger, `/pi` for the `pi` adapter. It is **ESM-only**, built with plain `tsc`, and tested with `node:test`.

We considered a monorepo of separate packages so a deployment would install only what it uses. The reason evaporated when the `pi` adapter stopped depending on `pi`: `pi` is a container image ([ADR-0025](./0025-the-pi-adapter-spawns-one-confined-process-per-run.md)), so the adapter is a few hundred lines with no dependencies of its own. Everything else — `fastify`, `drizzle-orm`, `pg`, `handlebars` — is needed by parts every deployment uses. Splitting would buy a dependency-graph benefit that does not exist, and charge cross-package version coordination on every release.

**ESM-only is a consequence of a decision elsewhere, not a preference.** [ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md) requires resolving the shipped migration folders relative to `import.meta.url`, which does not exist in CommonJS. A dual build would need a separate `__dirname` path for its CJS half, and consumers — who are writing a fresh entry point — have no reason to be on CJS.

## Consequences

- **No bundler.** The migrator reads `.sql` files off disk, so bundling the framework into a single file breaks migrations. `tsc` emitting ESM plus declarations is sufficient and adds no build dependency.
- **`files` must include the migration folders**, or they will not ship. Verified by packing and installing a test package: the `.sql` files *and* `meta/_journal.json` are both required — the migrator will not run on SQL alone.
- **`drizzle-orm` is a peer dependency**, since two copies in one tree produce structurally incompatible branded types in Operator code. `fastify` is effectively public API too ([ADR-0021](./0021-the-framework-has-no-plugin-system.md)), so its major version is a breaking change for us.
- **`node:test` rather than a test-runner dependency**, with a `docker compose` Postgres and each test file taking its own database. Docker is already required for the agent, so this adds no new prerequisite.
- **Node `>=24`**, the active LTS. Nothing in the stack requires it — `pi`'s own Node version is now the container image's business — so lowering it to 22 is a one-line change if a deployment needs that.
