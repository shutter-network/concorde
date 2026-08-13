/**
 * Verifies the packaging claims that only a real tarball can settle:
 *
 *  - `dist` mirrors `src`, so nothing ships whose source is gone.
 *  - the tarball installs into a fresh project.
 *
 * What it no longer proves is that migration folders ship and that the shipped SQL
 * applies to a real database from inside the installed package. There is no SQL: the
 * framework applies nothing and the Operator generates their own DDL from the tables the
 * component subpaths below export
 * ([ADR-0046](../docs/adr/0046-the-operator-owns-migrations.md)). That is
 * a recorded cost of that ADR and not an oversight — we no longer author the bytes
 * applied to anybody's production database, so no check here can vouch for them.
 *  - **all twenty-three** entries resolve there, both to the type checker and to Node at
 *    runtime, and twenty-three is the whole map. Fifteen are the subpath a Developer imports a
 *    part from: `/gateway`, `/logging`, `/db`, `/agent-container`, `/signals`, `/pi`, `/users`,
 *    `/password-auth`, `/nostr-auth`, `/messenger`, `/http-channel`, `/nostr-channel`,
 *    `/signatures`, `/decisions` and `/scheduler`. The other **eight are `/schema`**, one per
 *    component that owns tables, because `drizzle-kit`'s config takes file paths and an export
 *    entry is the only supported way to hand an Operator one
 *    ([ADR-0055](../docs/adr/0055-a-components-tables-are-a-subpath-of-their-own.md)). A
 *    component's tables are on exactly one of the two, and the runtime step below is what proves
 *    the component subpath carries none of them. `/messenger` was reserved and unreachable until
 *    the log was taken out of the HTTP Messenger and the qualifier became a Channel's
 *    ([ADR-0048](../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)); it
 *    is a real specifier now, and `/nostr-channel` is the second Channel and the one Channel
 *    that owns tables
 *    ([ADR-0049](../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)).
 *  - **two of the fifteen are Auths**, so the whole of what a deployment accepts is which of them
 *    it constructs. `main.ts` below constructs Password Auth and Nostr Auth and writes an Auth of
 *    the consumer's own beside them, and all three register themselves with the Public server
 *    ([ADR-0052](../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md),
 *    [ADR-0053](../docs/adr/0053-nostr-auth-verifies-nip-98-per-request.md)). The second of them
 *    registers **no route**, so its whole surface here is one construction, one method and the
 *    two tables on its specifier.
 *  - **there is no `.` in that map, and the last step below reads Node saying so.** Every value
 *    the root used to carry now sits on `/gateway`, `/logging`, `/db` or `/agent-container`, and
 *    a bare `shared-agent-framework` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. What that buys
 *    is that nothing lands on the root by accident: a re-export written there resolves to
 *    nowhere, so adding a root export back is a deliberate edit to `exports` and not a slip.
 *  - a component's tables arrive on its `/schema` specifier as **top-level named exports**.
 *    That shape is the whole contract
 *    ([ADR-0046](../docs/adr/0046-the-operator-owns-migrations.md)): `drizzle-kit`'s
 *    exporter takes `Object.values` of a module and keeps what passes `is(x, PgTable)`,
 *    never descending into a plain object, so a table reachable only through a wrapper
 *    is dropped in silence and generates an **empty** migration. The runtime step below
 *    reproduces that collection **per module**, which is what `drizzle-kit` does with a list of
 *    file paths, and resolves each specifier to the file path an Operator's `drizzle.config.ts`
 *    hands it.
 *  - **the `bin` runs there**, which no import above can reach: `http-client-tui` is a command and
 *    not a specifier, so what an installed package owes is an executable file on the consumer's
 *    `PATH` and the last step below runs it rather than looking for it.
 *  - **the eight `/schema` modules yield eight distinct schema objects and thirteen tables, and
 *    the eight component subpaths yield none of either.** That is the assertion the split exists
 *    for, and it is the one nothing else in the repository makes: a `schema.ts` re-exported from
 *    both places would put every table behind two specifiers, and a `/schema` module that stopped
 *    re-exporting one would leave the table queryable and absent from the DDL.
 *
 * Run with `npm run check:package`. Deliberately not part of `npm run check`: it
 * installs from the registry, so it is far slower than the inner loop should be,
 * and it would make the inner loop need the network. It needs no database: nothing
 * here applies DDL any more, so nothing here connects.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The consumer's imports, spelled once: the type checker and Node see the same twenty-three.
 *
 * **Twenty-three lines, one per entry point, and a component's tables are on a line of their
 * own.** That is the whole of ADR-0055: `drizzle-kit`'s config takes file paths, so the tables
 * need an export entry of their own, and having one they are on it and on nothing else. No line
 * names the bare package, because there is no `.` export left: the four infrastructure specifiers
 * at the top carry what the root used to, and the last step in this script is what proves the root
 * itself resolves to nothing.
 *
 * **No `/schema` line aliases anything, and the absence is the assertion.** Every name off every
 * `/schema` specifier lands in this one module scope under the name the package gives it, which is
 * what a deployment's own `schema.ts` barrel does with `export *`. Two components declaring one
 * name is therefore a `Duplicate identifier` from `tsc` and an `Identifier has already been
 * declared` from Node, naming both import lines — the only place anything in this repository
 * checks that (ADR-0055). The two names every schema module declares carry a component prefix so
 * that they cannot collide; the thirteen table names carry none, and this file is what holds them
 * apart. **An alias added to a line below removes the check for that name.** Reach for a rename in
 * the package instead.
 *
 * The four infrastructure lines own no tables. `/gateway` carries the two assembly constructors
 * and the server adapter, `/logging` the default Logger, `/db` the one call that opens a pool, and
 * `/agent-container` what `docker run` takes: nothing under it has heard of an Agent
 * Implementation, so a second one needs all of it unchanged (ADR-0033).
 *
 * The HTTP Channel's line carries a constructor
 * and nothing beside it, and it has no `/schema` line at all, because it owns no tables: the log is
 * the Messenger's, whichever medium a Message travelled by (ADR-0048). `/signatures` and `/pi` are
 * the other two with no `/schema` beside them. The Nostr Channel has one carrying three tables,
 * because the three things only it can know — which public key is which User, which envelopes it
 * has read, and which replies the Relay has not taken yet — are nobody else's (ADR-0049). Its
 * component line is also the one carrying error classes: five refusals an Operator branches on
 * with `instanceof`, two from a send and three from recording a key, and `main.ts` below catches
 * every one. The Scheduler's `ScheduleSpecError` is the only other class the package exports, and
 * it is caught there too, so every exported error class is now reached through an `instanceof`
 * rather than only imported.
 * Every table is named individually rather than pulled in as a namespace, because naming them is
 * what proves the module flat-exports them: a table that had retreated into `<component>Tables`
 * would fail to import here, where an `import * as` would resolve and say nothing (ADR-0046). The
 * wrappers themselves are named too, which is what proves each resolves on its own specifier.
 *
 * **The state unions and the arrays behind them are on both subpaths**, and they are the only
 * names in the package that are. They live in `schema.ts` because the columns' check constraints
 * are compiled from the arrays, and a `SignalRecord`, a `RunRecord`, a `MessageRecord` and a
 * `ScheduleRecord` are declared with the unions and go out on the wire, so a reader of a record
 * reaches them off the component. No table is on both, which is the property that matters
 * (ADR-0055).
 *
 * `createSignalWorker` and `templateHandler` both come off `/signals`: the Worker owns tables, so
 * it is a component with a subpath of its own, and the template Handler is written in that
 * component's vocabulary and belongs beside it.
 */
const consumerImports = [
  'import { createAgentContainerRuntime, mountArguments } from "shared-agent-framework/agent-container";',
  'import { openDb } from "shared-agent-framework/db";',
  'import { createBareGateway, createGateway, NoAuthRegisteredError, serverComponent } from "shared-agent-framework/gateway";',
  'import { defaultLogger } from "shared-agent-framework/logging";',
  'import { createSignalWorker, runStates, signalStates, templateHandler } from "shared-agent-framework/signals";',
  'import { runs, signals, signalsSchema, signalsTables } from "shared-agent-framework/signals/schema";',
  'import { createPiRuntime, interpretPiOutput, piRun } from "shared-agent-framework/pi";',
  'import { createUsers } from "shared-agent-framework/users";',
  'import { users, usersSchema, usersTables } from "shared-agent-framework/users/schema";',
  'import { createPasswordAuth } from "shared-agent-framework/password-auth";',
  'import { passwordAuthSchema, passwordAuthTables, passwords, tokens } from "shared-agent-framework/password-auth/schema";',
  'import { createNostrAuth } from "shared-agent-framework/nostr-auth";',
  'import { admitted, grants, nostrAuthSchema, nostrAuthTables } from "shared-agent-framework/nostr-auth/schema";',
  'import { createMessenger, messageDirections, messageReceivedKind } from "shared-agent-framework/messenger";',
  'import { messages, messengerSchema, messengerTables } from "shared-agent-framework/messenger/schema";',
  'import { createHttpChannel } from "shared-agent-framework/http-channel";',
  'import { createNostrChannel, MalformedPublicKeyError, MessageTooLargeError, NoSuchUserError, PublicKeyConflictError, UnrecordedPublicKeyError } from "shared-agent-framework/nostr-channel";',
  'import { nostrChannelSchema, nostrChannelTables, outbox, pubkeys, received } from "shared-agent-framework/nostr-channel/schema";',
  'import { createSignatures } from "shared-agent-framework/signatures";',
  'import { createDecisions } from "shared-agent-framework/decisions";',
  'import { decisions, decisionsSchema, decisionsTables } from "shared-agent-framework/decisions/schema";',
  'import { createScheduler, scheduleFiredKind, scheduleKinds, ScheduleSpecError } from "shared-agent-framework/scheduler";',
  'import { schedulerSchema, schedulerTables, schedules } from "shared-agent-framework/scheduler/schema";',
];

function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (error) {
    // `tsc` and `npm` report diagnostics on stdout, which is captured here so
    // it can be asserted on. Surface it, or a failure arrives unexplained.
    const captured = (error as { stdout?: unknown }).stdout;
    if (typeof captured === "string" && captured.length > 0) {
      process.stderr.write(captured);
    }
    throw error;
  }
}

/**
 * Like `run`, but for a command expected to **fail**: it answers with what the command wrote to
 * stderr, and with the empty string if the command succeeded. The caller reads that text rather
 * than only the exit status, so a refusal can be asserted by the code Node names for it.
 */
function refusalFrom(command: string, args: string[], cwd: string): string {
  try {
    execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: unknown }).stderr ?? "");
  }
}

function step(message: string): void {
  process.stdout.write(`${message}\n`);
}

const workDir = mkdtempSync(path.join(tmpdir(), "saf-package-check-"));
try {
  step("building");
  run("npm", ["run", "build"], repoRoot);

  step("packing");
  const packed: unknown = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", workDir], repoRoot),
  );
  assert.ok(Array.isArray(packed) && packed.length === 1, "npm pack should report one tarball");
  const filename = (packed[0] as { filename?: unknown }).filename;
  assert.equal(typeof filename, "string", "npm pack should report a tarball filename");
  const tarball = path.join(workDir, path.basename(filename as string));

  // Inspect what was actually packed, rather than trusting `files`.
  step("inspecting the tarball");
  const entries = new Set(
    run("tar", ["-tzf", tarball], workDir)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^package\//, "").replace(/\/$/, "")),
  );

  for (const file of [
    // The assembly subpath, and the one interface the framework defines: every Gateway is
    // assembled from it (ADR-0031). Named rather than left to the mirror check below, which only
    // reads the other way: it catches a shipped module whose source is gone, not a public module
    // that failed to ship.
    "dist/gateway/index.js",
    "dist/gateway/index.d.ts",
    "dist/gateway/components.js",
    "dist/gateway/components.d.ts",
    // The authentication seam beside it: the `Auth` a deployment writes, the outcome it answers,
    // and the walk a server composes them into (ADR-0052). It ships because `index.js` re-exports
    // it and because `components.js` calls into it, so a consumer resolving `/gateway` needs it.
    "dist/gateway/auth.js",
    "dist/gateway/auth.d.ts",
    // The infrastructure constructor, beside it under the same specifier: it is the canonical
    // path an Operator's entry point takes, and it is the one shipped module that imports a
    // value from `fastify` (ADR-0045).
    "dist/gateway/gateway.js",
    "dist/gateway/gateway.d.ts",
    // The logging seam and the default behind it, on a specifier of their own: a Logger is
    // passed to nearly every part, so it is neither one part's nor an Operator's to re-declare.
    "dist/logging/index.js",
    "dist/logging/index.d.ts",
    "dist/logging/logging.js",
    "dist/logging/logging.d.ts",
    "dist/pi/index.js",
    "dist/pi/index.d.ts",
    // The `pi` Agent Implementation's own modules, which are now two. `dist/pi/`
    // mirroring `src/pi/` is what makes the subpath resolve to the same relative imports
    // in the repository and in the package, and the fixtures beside them must not come
    // along.
    "dist/pi/runtime.js",
    "dist/pi/runtime.d.ts",
    "dist/pi/output.js",
    // The Agent Container and its Runtime, which belong to no Agent Implementation: they
    // ship under their own directory and are reachable on `/agent-container`, because
    // nothing in them knows about one and the next one needs them unchanged (ADR-0028,
    // ADR-0033). `process.js` is here rather than under `dist/pi/` for the same reason,
    // and it moved rather than being rewritten.
    "dist/agent-container/index.js",
    "dist/agent-container/index.d.ts",
    "dist/agent-container/agent-container.js",
    "dist/agent-container/agent-container.d.ts",
    "dist/agent-container/mount-table.js",
    "dist/agent-container/mount-table.d.ts",
    "dist/agent-container/process.js",
    "dist/agent-container/process.d.ts",
    // `dist` mirrors `src`, so `src/db/db.ts` becomes `dist/db/db.js`. Nothing is
    // resolved from `import.meta.url` any more — that trick existed only to reach a
    // shipped migration folder, and there is none (ADR-0046).
    "dist/db/index.js",
    "dist/db/index.d.ts",
    "dist/db/db.js",
    "dist/db/db.d.ts",
    // The Signal Worker, under its own subpath: it is a component and a component is a
    // specifier, with a second one under it for its tables (ADR-0055).
    "dist/signals/index.js",
    "dist/signals/index.d.ts",
    "dist/signals/worker.js",
    // The template Handler, beside the Worker whose vocabulary it is written in, and the only
    // module that reaches for `handlebars` — so a missing `dependencies` entry surfaces when the
    // scratch project imports it below rather than at an Operator's first Signal.
    "dist/signals/template-handler.js",
    "dist/signals/template-handler.d.ts",
    // Every component that owns tables ships two things for them: the declarations, which the
    // component's own modules import, and the `schema/index.js` that re-exports them, which is
    // what `./<component>/schema` in the export map names (ADR-0055). Both have to resolve, for
    // Node and for an Operator's type checker (ADR-0046).
    "dist/signals/schema.js",
    "dist/signals/schema.d.ts",
    "dist/signals/schema/index.js",
    "dist/signals/schema/index.d.ts",
    // The Signal Worker's Agent server routes: a Fastify plugin, and the only shipped
    // module that names Fastify at all. Fastify is public API rather than an internal
    // (ADR-0021), so the consumer brings the instance and registers this on it.
    "dist/signals/routes.js",
    "dist/signals/routes.d.ts",
    // Users, under its own subpath, with the declarations beside it and the `/schema` door
    // below it: the tables are what an Operator points a config at now (ADR-0029, ADR-0046).
    "dist/users/index.js",
    "dist/users/index.d.ts",
    "dist/users/routes.js",
    "dist/users/routes.d.ts",
    "dist/users/schema.js",
    "dist/users/schema.d.ts",
    "dist/users/schema/index.js",
    "dist/users/schema/index.d.ts",
    "dist/users/users.js",
    "dist/users/users.d.ts",
    // Password Auth, under its own subpath, with a `schema.js` beside it: the third module in the
    // framework whose schema imports the Users component's, because both of its columns
    // reference `saf_users.users.id` (ADR-0036, ADR-0049, ADR-0052). `secrets.js` is the only
    // scrypt and Token hashing in the package now, the Users component's copy having gone with
    // the credential, and it ships because `password-auth.js` imports it.
    "dist/password-auth/index.js",
    "dist/password-auth/index.d.ts",
    "dist/password-auth/password-auth.js",
    "dist/password-auth/password-auth.d.ts",
    "dist/password-auth/routes.js",
    "dist/password-auth/routes.d.ts",
    "dist/password-auth/schema.js",
    "dist/password-auth/schema.d.ts",
    "dist/password-auth/schema/index.js",
    "dist/password-auth/schema/index.d.ts",
    "dist/password-auth/secrets.js",
    // Nostr Auth, under its own subpath, with a `schema.js` beside it: the fourth module in the
    // framework whose schema imports the Users component's, because `grants.user_id` references
    // `saf_users.users.id` (ADR-0053). `nip98.js` is the security core, and the reason it is a
    // module of its own is the reason `nostr-channel/envelope.js` is: the library's own validator
    // checks the freshness window in one direction only, so an event dated in the future passes it
    // forever, and every check above `verifyEvent` is written here instead.
    "dist/nostr-auth/index.js",
    "dist/nostr-auth/index.d.ts",
    "dist/nostr-auth/nostr-auth.js",
    "dist/nostr-auth/nostr-auth.d.ts",
    "dist/nostr-auth/nip98.js",
    "dist/nostr-auth/nip98.d.ts",
    "dist/nostr-auth/grants.js",
    "dist/nostr-auth/grants.d.ts",
    "dist/nostr-auth/schema.js",
    "dist/nostr-auth/schema.d.ts",
    "dist/nostr-auth/schema/index.js",
    "dist/nostr-auth/schema/index.d.ts",
    // The Messenger, under its own subpath. Its `schema.js` is where the foreign key
    // onto `saf_users.users.id` is declared now, so an Operator's generation writes the
    // constraint that used to be hand-edited into a shipped folder (ADR-0034, ADR-0036,
    // ADR-0046). Its `routes.js` carries the agent's route group *and* the serializer the
    // HTTP Channel's own routes render a `MessageRecord` through, which is why that module
    // ships even for a deployment whose Channel is not HTTP.
    "dist/messenger/index.js",
    "dist/messenger/index.d.ts",
    "dist/messenger/messenger.js",
    "dist/messenger/messenger.d.ts",
    "dist/messenger/messages.js",
    "dist/messenger/messages.d.ts",
    "dist/messenger/routes.js",
    "dist/messenger/routes.d.ts",
    "dist/messenger/schema.js",
    "dist/messenger/schema.d.ts",
    "dist/messenger/schema/index.js",
    "dist/messenger/schema/index.d.ts",
    // The HTTP Channel, under its own subpath and with **no schema module and no `/schema`
    // entry**: it owns no tables, so there is nothing for an Operator to list. The second
    // component of which that is true, after Signatures (ADR-0048).
    "dist/http-channel/index.js",
    "dist/http-channel/index.d.ts",
    "dist/http-channel/http-channel.js",
    "dist/http-channel/http-channel.d.ts",
    "dist/http-channel/routes.js",
    "dist/http-channel/routes.d.ts",
    // The Nostr Channel, under its own subpath, with a `schema.js` beside it — the second module
    // in the framework whose schema imports the Users component's, because `pubkeys.user_id`
    // references `saf_users.users.id` too (ADR-0036, ADR-0049). `envelope.js` is the security
    // core: the NIP-59 unwrap written by hand, because the library's convenience function
    // discards the layer that carries the only authentication in the envelope.
    "dist/nostr-channel/index.js",
    "dist/nostr-channel/index.d.ts",
    "dist/nostr-channel/nostr-channel.js",
    "dist/nostr-channel/nostr-channel.d.ts",
    "dist/nostr-channel/envelope.js",
    "dist/nostr-channel/envelope.d.ts",
    "dist/nostr-channel/identities.js",
    "dist/nostr-channel/identities.d.ts",
    // The outbound queue's own statements, which are the half of a send that survives a commit:
    // a publish cannot be rolled back and a transaction can, so the wrap is built and stored
    // inside the caller's transaction and the network act happens after it (ADR-0049).
    "dist/nostr-channel/outbound.js",
    "dist/nostr-channel/outbound.d.ts",
    "dist/nostr-channel/schema.js",
    "dist/nostr-channel/schema.d.ts",
    "dist/nostr-channel/schema/index.js",
    "dist/nostr-channel/schema/index.d.ts",
    // Signatures, under its own subpath and with **no schema module and no `/schema` entry**:
    // it is the one part of the framework that stores nothing, so there is nothing for an
    // Operator to list (ADR-0042). It is also the only module that
    // imports `jose`, which the runtime step below is what proves is declared rather than
    // merely present in our own tree.
    "dist/signatures/index.js",
    "dist/signatures/index.d.ts",
    "dist/signatures/signatures.js",
    "dist/signatures/signatures.d.ts",
    "dist/signatures/routes.js",
    "dist/signatures/routes.d.ts",
    // Decisions, under its own subpath, with its table exported from the `/schema` subpath
    // below it (ADR-0043, ADR-0055).
    "dist/decisions/index.js",
    "dist/decisions/index.d.ts",
    "dist/decisions/decisions.js",
    "dist/decisions/decisions.d.ts",
    "dist/decisions/routes.js",
    "dist/decisions/routes.d.ts",
    "dist/decisions/schema.js",
    "dist/decisions/schema.d.ts",
    "dist/decisions/schema/index.js",
    "dist/decisions/schema/index.d.ts",
    // The Scheduler, under its own subpath. It is the second Producer and the one part that
    // reaches for `cron-parser` and `luxon`, which the runtime step below is what proves are
    // declared rather than merely present in our own tree (ADR-0018).
    "dist/scheduler/index.js",
    "dist/scheduler/index.d.ts",
    "dist/scheduler/scheduler.js",
    "dist/scheduler/scheduler.d.ts",
    "dist/scheduler/schedules.js",
    "dist/scheduler/schedules.d.ts",
    "dist/scheduler/routes.js",
    "dist/scheduler/routes.d.ts",
    "dist/scheduler/schema.js",
    "dist/scheduler/schema.d.ts",
    "dist/scheduler/schema/index.js",
    "dist/scheduler/schema/index.d.ts",
    // The `bin`, which is the one shipped module that is neither a subpath nor reached from one.
    // `package.json` names this exact path, so a rename that missed the manifest ships a broken
    // command; the last step below is what runs it.
    "dist/http-client-tui/main.js",
  ]) {
    assert.ok(entries.has(file), `the tarball should ship ${file}`);
  }

  // The modules whose subject was writing or carrying the agent's configuration. Named
  // rather than left to the mirror check below, because "it is gone" is the claim: the
  // framework writes no files and carries no `pi`-shaped configuration, and a module that
  // still shipped would be one an Operator could still import and call (ADR-0025,
  // ADR-0028, ADR-0033).
  // Along with the process module's old home: it moved out of the adapter, and a copy
  // left behind under `dist/pi/` would be a second spawner an Operator could import.
  // And the whole of the old package root, which is the other claim: there is no `.` export any
  // more, so `dist/index.js` would be a file nothing can reach, and the modules that sat beside it
  // moved into directories of their own rather than being copied there. The mirror check below
  // catches `dist/index.js` on its own, there being no `src/index.ts` behind it. It catches none
  // of the others, whose sources still exist one directory down, so they are named here.
  for (const gone of [
    "dist/pi/run-files.js",
    "dist/pi/run-files.d.ts",
    "dist/pi/process.js",
    "dist/pi/adapter.js",
    "dist/pi/adapter.d.ts",
    "dist/pi/configuration.js",
    "dist/pi/configuration.d.ts",
    "dist/pi/invocation.js",
    "dist/pi/invocation.d.ts",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/components.js",
    "dist/components.d.ts",
    "dist/gateway.js",
    "dist/gateway.d.ts",
    "dist/logging.js",
    "dist/logging.d.ts",
    "dist/template-handler.js",
    "dist/template-handler.d.ts",
    "dist/container/index.js",
    "dist/container/agent-container.js",
    "dist/container/mount-table.js",
    "dist/container/process.js",
  ]) {
    assert.ok(!entries.has(gone), `the tarball should no longer ship ${gone}`);
  }

  // The fixtures under `src/test-support` are excluded from the build, so they
  // must not reach an Operator even though they sit inside `src`.
  assert.ok(
    ![...entries].some((entry) => entry.startsWith("dist/test-support/")),
    "test fixtures should not ship",
  );

  // Neither do the captured Agent Implementation streams beside the `pi` adapter, which
  // are a test's input and not part of anything an Operator installs.
  assert.ok(
    ![...entries].some((entry) => entry.endsWith(".jsonl")),
    "the captured output fixtures should not ship",
  );

  // Nothing ships that no longer exists. `tsc` writes into `outDir` and never
  // prunes it, so a deleted or renamed module leaves its old output behind and
  // every later tarball carries it — which is how a placeholder outlives the
  // ticket that removed it. `npm run build` empties `dist` first; this is what
  // proves it did.
  step("checking dist mirrors src, with nothing left over");
  for (const entry of entries) {
    if (!entry.startsWith("dist/")) continue;
    const source = entry.replace(/^dist\//, "src/").replace(/\.d\.ts$|\.js$/, ".ts");
    assert.ok(
      existsSync(path.join(repoRoot, source)),
      `the tarball ships ${entry}, which no longer has a source at ${source}`,
    );
  }

  // `pg` is the Db's alone (ADR-0022), so no shipped declaration may name it.
  // The Biome override catches an import in our sources; this catches the subtler
  // case, where a `pg` type reaches the public API through an inferred return
  // type and `tsc` writes the import into a `.d.ts` we never read. It would only
  // surface for a consumer without `@types/pg`, which is all of them.
  step("checking no shipped declaration reaches for pg");
  for (const declaration of readdirSync(path.join(repoRoot, "dist"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!declaration.isFile() || !declaration.name.endsWith(".d.ts")) continue;
    const file = path.join(declaration.parentPath, declaration.name);
    assert.ok(
      !/from ["']pg["']/.test(readFileSync(file, "utf8")),
      `${path.relative(repoRoot, file)} imports from pg; keep the pool out of the public API`,
    );
  }

  // `fastify` is a peer dependency, and **one** shipped module runs an import of it. That
  // module is `dist/gateway/gateway.js`, which constructs the two servers the infrastructure
  // constructor builds and cannot do it any other way (ADR-0045); everywhere else the framework names
  // Fastify's types and never its runtime, which is what keeps `serverComponent`
  // structural and the peer dependency honest (ADR-0031). So the check is not dropped but
  // narrowed to an exact list: a `FastifyListenOptions` written without `import type` still
  // emits one of these, and nothing else would notice, because the consumer below installs
  // Fastify and it would resolve.
  //
  // Comment lines are skipped, because `tsc` emits doc comments and an `@example` that shows an
  // Operator building their own server has to say `import Fastify from "fastify"` to be copyable.
  // That is documentation and not an import, so a scan of the raw text fails on
  // `dist/gateway/components.js` and `dist/users/users.js` and says nothing true. Skipped per line rather
  // than by stripping `/** */` blocks, so a string literal holding those four characters cannot
  // swallow the code after it and turn a real import invisible.
  step("checking only the infrastructure constructor imports a value from fastify");
  const manifest: unknown = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(
    !Object.hasOwn((manifest as { dependencies?: object }).dependencies ?? {}, "fastify"),
    "fastify should stay a peer dependency; a `dependencies` entry brings a second copy into every consumer's tree, and instances the framework built would then not be instances of the Fastify a consumer's own plugins were written against",
  );
  const mayConstructAServer = new Set(["dist/gateway/gateway.js"]);
  const importsFastify: string[] = [];
  for (const emitted of readdirSync(path.join(repoRoot, "dist"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!emitted.isFile() || !emitted.name.endsWith(".js")) continue;
    const file = path.join(emitted.parentPath, emitted.name);
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line));
    if (code.some((line) => /from ["']fastify["']/.test(line))) {
      importsFastify.push(path.relative(repoRoot, file).replaceAll(path.sep, "/"));
    }
  }
  assert.deepEqual(
    importsFastify.sort(),
    [...mayConstructAServer].sort(),
    "only the infrastructure constructor may import a value from fastify; everywhere else the framework names its types and nothing else",
  );

  // A fresh project, as an Operator would start one.
  step("installing the tarball into a scratch project");
  const consumer = path.join(workDir, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "consumer", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`,
  );
  // `@types/node` alongside the tarball, because the public declarations name Node
  // globals — `URL` in `TemplateHandlerOptions.template`, `Buffer` and `KeyObject`
  // around the signing path — which are not TypeScript's. Every consumer of a
  // Node-only ESM package has it; asserting that here keeps the requirement from
  // being discovered by an Operator.
  //
  // `fastify` too, installed here rather than arriving through us: the package
  // declares it as a *peer* dependency, so the instance the framework types
  // against is the one the consumer chose. Fastify is public API (ADR-0021), and
  // this is the arrangement an Operator will have: their own `fastify`, ours a
  // `^5` range they satisfy rather than a copy we bring. What it proves is that
  // the two agree; two *major* versions in one tree is the breaking change
  // ADR-0026 already accepts, and is not what this checks.
  run("npm", ["install", "--no-audit", "--no-fund", tarball, "@types/node", "fastify"], consumer);

  step("type-checking the scratch project against the installed package");
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "es2024",
          lib: ["es2024"],
          module: "nodenext",
          moduleResolution: "nodenext",
          types: ["node"],
          strict: true,
          // `skipLibCheck: false` would be the stronger check and cannot be
          // used: drizzle-orm 0.45.2's own declarations do not survive it, and
          // hundreds of errors arrive from its MySQL and SingleStore builders,
          // none of which we import. What proves our declarations instead is
          // `main.ts` below, which exercises the whole public surface with
          // annotations, so a type that resolved to `any` or went missing fails.
          skipLibCheck: true,
          noEmit: true,
        },
        // One file. The barrel an Operator used to write is gone with the `/schema` subpaths
        // (ADR-0055): a `drizzle.config.ts` names those specifiers as **paths** now, resolved
        // with `import.meta.resolve`, and there is no module of the consumer's own in between
        // for a type checker to read. What replaced it is the annotated table and schema lists
        // in `main.ts` and, at runtime below, the resolution of all eight specifiers to files.
        include: ["main.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(consumer, "main.ts"),
    [
      ...consumerImports,
      // Every type the package exports. `main.ts` is what replaced
      // `skipLibCheck: false` here, so an export it does not mention is an export
      // nothing checks: a declaration that resolved to `any`, or went missing
      // altogether, would type-check in this project without it.
      // The Agent Container's own types, on the specifier that carries what `docker run` takes.
      // Nothing under it has heard of an Agent Implementation, so `/pi` names none of these and
      // an author of a second Implementation reaches for exactly this set (ADR-0033).
      "import type {",
      "  AgentContainer,",
      "  AgentContainerRuntime,",
      "  AgentContainerRuntimeSpec,",
      "  ComposedCommand,",
      "  Mount,",
      "  MountTable,",
      "  RunPlan,",
      '} from "shared-agent-framework/agent-container";',
      // The Db's own types: the handle, the transaction it hands a callback, the `LISTEN`
      // registration and the listener it calls back. `pg` is nowhere among them, which is what
      // keeps the pool out of the public API (ADR-0022).
      "import type {",
      "  ChannelListener,",
      "  Db,",
      "  Handle,",
      "  Listening,",
      "  Transaction,",
      '} from "shared-agent-framework/db";',
      // The assembly vocabulary, on its own specifier: the Component two methods, what a Gateway
      // is, the structural server it listens through, and the options both constructors take
      // (ADR-0031, ADR-0045). `Auth` and `AuthOutcome` are here rather than on a subpath of their
      // own because the aggregate that walks them is on a server, and a server is this subpath's
      // (ADR-0052). `ServerComponent` is what `serverComponent` answers with now that it carries
      // that aggregate, and the consumer below writes an Auth against the one member and
      // registers it.
      "import type {",
      "  Auth,",
      "  AuthOutcome,",
      "  Component,",
      "  Gateway,",
      "  GatewayExtension,",
      "  GatewayOptions,",
      "  InfraComponents,",
      "  ListeningServer,",
      "  ServerComponent,",
      "  ServerComponentOptions,",
      '} from "shared-agent-framework/gateway";',
      // The logging seam, on its own specifier: nearly every part takes one, so it belongs to no
      // single part and an Operator satisfies it structurally.
      "import type {",
      "  LogFields,",
      "  Logger,",
      '} from "shared-agent-framework/logging";',
      // The Signal Worker's own types, from its own subpath: the Worker and its options, the
      // two record shapes the Agent server answers with and their states, the Prompt the
      // Handler returns and the Run prompt the Runtime is given, the Runtime seam itself, the
      // Signal a Producer emits, and the template Handler's options (ADR-0047). Every one of
      // them was at the root until that decision, and no block above names any of them, so a
      // symbol that failed to move fails here rather than passing on two specifiers.
      "import type {",
      "  EmittedSignal,",
      "  PostOutcome,",
      "  Prompt,",
      "  RunOutcome,",
      "  RunPrompt,",
      "  RunRecord,",
      "  RunState,",
      "  Runtime,",
      "  Signal,",
      "  SignalHandler,",
      "  SignalHandlers,",
      "  SignalRecord,",
      "  SignalState,",
      "  SignalWorker,",
      "  SignalWorkerOptions,",
      "  TemplateHandlerOptions,",
      '} from "shared-agent-framework/signals";',
      // The `pi` subpath exports **no type at all**, which is the shape ADR-0033 leaves
      // it in: there is no configuration to name, and everything the Runtime it returns
      // is made of — the Agent Container, the Run plan, the composed command line — comes
      // from `/agent-container`, because none of it is `pi`-shaped. The three values it
      // does export are in `consumerImports` above.
      // The Users component's own types, from its own subpath, for the same reason:
      // a deployment with no identity in it imports nothing from there (ADR-0029). There is no
      // `IssuedToken` and no `ScryptParameters` among them any more: a credential is an Auth's,
      // and both names moved to the specifier below with it (ADR-0052).
      "import type {",
      "  UserRecord,",
      "  Users,",
      "  UsersOptions,",
      '} from "shared-agent-framework/users";',
      // Password Auth's own types, from the eighth specifier, and no alias among them: the two
      // names it took off Users resolve to one binding each now.
      "import type {",
      "  IssuedToken,",
      "  PasswordAuth,",
      "  PasswordAuthOptions,",
      "  ScryptParameters,",
      '} from "shared-agent-framework/password-auth";',
      // And the second Auth's, from its own specifier. Two names and no credential type among
      // them, because this scheme issues nothing: what a deployment names is the constructor's
      // options and what it answers with (ADR-0053).
      "import type {",
      "  NostrAuth,",
      "  NostrAuthOptions,",
      '} from "shared-agent-framework/nostr-auth";',
      // The Messenger's own types, from its own subpath, for the same reason: a
      // deployment with no messaging in it imports nothing from there, and one that does is
      // stating that it accepts this part's declined freedoms (ADR-0034). No route plugin
      // type is among them, because none is exported. `Channel` and `MessengerHandle` are
      // here because they are the seam a second medium plugs into: the Channel a deployment
      // writes itself is annotated against the first, and what `register` answers with —
      // the only way an inbound Message can be written — is the second (ADR-0048).
      "import type {",
      "  Channel,",
      "  MessageDirection,",
      "  MessageRecord,",
      "  Messenger,",
      "  MessengerHandle,",
      "  MessengerOptions,",
      '} from "shared-agent-framework/messenger";',
      // And the HTTP Channel's, from the ninth specifier. Two names and no table among them:
      // this component owns nothing to migrate, so its subpath carries a constructor and the
      // types naming it (ADR-0047, ADR-0048).
      "import type {",
      "  HttpChannel,",
      "  HttpChannelOptions,",
      '} from "shared-agent-framework/http-channel";',
      // And the Nostr Channel's, from the tenth specifier. Two names, like the HTTP Channel's,
      // even though this one owns tables: what a deployment names is the constructor's options
      // and what it answers with (ADR-0047, ADR-0049).
      "import type {",
      "  NostrChannel,",
      "  NostrChannelOptions,",
      '} from "shared-agent-framework/nostr-channel";',
      // Signatures' own types, from its own subpath. `SignedClaims` is among them because the
      // caller builds the payload and therefore decides the bytes that get signed: the claims
      // are serialized in the order they were written, and nothing re-serializes them
      // (ADR-0042).
      "import type {",
      "  Signatures,",
      "  SignaturesOptions,",
      "  SignedClaims,",
      '} from "shared-agent-framework/signatures";',
      // And Decisions', whose `DecisionRecord` is the one shape every surface of that part
      // answers with. No route plugin type is among either set, because neither part exports
      // one (ADR-0034).
      "import type {",
      "  DecisionRecord,",
      "  Decisions,",
      "  DecisionsOptions,",
      '} from "shared-agent-framework/decisions";',
      // The Scheduler's own types, from its own subpath, for the same reason: a deployment with no
      // time-based behaviour imports nothing from there, and one that does is opting the second
      // Producer in and wiring it like the Messenger (ADR-0018). No route plugin type is among
      // them, because the part registers its routes itself and exports none.
      "import type {",
      "  ScheduleFiredRecord,",
      "  ScheduleInput,",
      "  ScheduleOutcome,",
      "  ScheduleKind,",
      "  ScheduleRecord,",
      "  ScheduleSpec,",
      "  Scheduler,",
      "  SchedulerOptions,",
      '} from "shared-agent-framework/scheduler";',
      'import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";',
      'import { pgSchema, text } from "drizzle-orm/pg-core";',
      // The two types the tables and schemas are annotated against below. They come from
      // `drizzle-orm`, which is a *peer* dependency this project never asked npm for — so
      // resolving them at all is the same proof the peer arrangement gets everywhere else.
      'import type { PgSchema, PgTable } from "drizzle-orm/pg-core";',
      // Fastify is public API (ADR-0021) and the consumer's own dependency: the
      // framework constructs no server, so the instance comes from this call.
      // Importing the types here is also what proves they resolve from the installed
      // package: `skipLibCheck` would swallow an unresolved import inside our own
      // declarations and quietly leave the Signal Worker's route plugin `any`.
      'import Fastify from "fastify";',
      'import type { FastifyInstance, FastifyPluginAsync } from "fastify";',
      // The two plugins the default assembly registers on both servers. They are the
      // framework's own `dependencies` rather than the consumer's, and this project asked
      // npm for the tarball, `@types/node` and `fastify` and nothing else, so an import
      // resolving here at all is what proves the two entries are declared rather than
      // merely present in our own tree (ADR-0040).
      'import fastifySwagger from "@fastify/swagger";',
      'import fastifySwaggerUi from "@fastify/swagger-ui";',
      "",
      "// Annotated throughout, so a declaration that resolved to `any` fails here.",
      'export const db: Db = openDb("postgres://nobody@example.invalid/none");',
      "",
      "// An Operator's own schema and tables, kept through the same call the",
      "// framework's own parts use.",
      'const own = pgSchema("consumer");',
      'const notes = own.table("notes", { body: text("body").notNull() });',
      "",
      "// And the framework's own, off the eight `/schema` subpaths, which is the door ADR-0046",
      "// opens and ADR-0055 puts one level below the component so that a config can name it as a",
      "// path. Each table is imported by name at the top of this file rather than as a namespace,",
      "// which is what states the shape: `drizzle-kit` reads `Object.values` of a module and keeps",
      "// what passes `is(x, PgTable)`, so a table that had retreated into a `<component>Tables`",
      "// wrapper would be dropped in silence and generate an empty migration. Annotated as the two",
      "// Drizzle types the exporter actually filters on, so a component that stopped exporting a",
      "// table fails here rather than at an Operator's first `generate`. Nothing here is aliased:",
      "// thirteen table names in one scope is a deployment's own barrel, and a fourteenth colliding",
      "// with one of them is a compile error rather than a table missing from the DDL.",
      "export const partTables: readonly PgTable[] = [",
      "  signals, runs, users, passwords, tokens,",
      "  grants, admitted,",
      "  messages, pubkeys, received, outbox, decisions, schedules,",
      "];",
      "export const partSchemas: readonly PgSchema[] = [",
      "  signalsSchema, usersSchema, passwordAuthSchema, nostrAuthSchema, messengerSchema,",
      "  nostrChannelSchema, decisionsSchema, schedulerSchema,",
      "];",
      "",
      "// The wrappers `db.handle` takes, named so that each is proven to resolve on its own",
      "// specifier. Not a `PgTable[]`: `drizzle-kit` never looks inside a plain object, which is why",
      "// the flat exports above are the migratable surface and these are a convenience for a caller.",
      "export const partTableWrappers: readonly Record<string, PgTable>[] = [",
      "  signalsTables, usersTables, passwordAuthTables, nostrAuthTables, messengerTables,",
      "  nostrChannelTables, decisionsTables, schedulerTables,",
      "];",
      "",
      "// The consequence the ADR records rather than mitigates: an exported table object is",
      "// both migratable and queryable, so the same `db.handle` that takes the Operator's own",
      "// tables above takes a framework part's. Written as a real projection, so a column",
      "// renamed out from under an Operator fails here.",
      "export async function readMessages(): Promise<{ seq: number; text: string }[]> {",
      "  return db",
      "    .handle({ messages })",
      "    .select({ seq: messages.seq, text: messages.text })",
      "    .from(messages);",
      "}",
      "",
      "// The cross-part shape: widens the schema parameter, so a handle typed to",
      "// one schema and a transaction started on another both satisfy it.",
      "async function write<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>) {",
      '  await tx.insert(notes).values({ body: "written" });',
      "}",
      "",
      "// A Runtime is an object with one method: no class to extend and no",
      "// framework base type to import. It takes a `RunPrompt` and not a `Prompt`,",
      "// which is the seam's own type and the reason `prompt.session` is a string",
      "// here with nothing to check: the Signal Worker settled it (ADR-0033).",
      "const runtime: Runtime = {",
      "  async run(prompt: RunPrompt): Promise<RunOutcome> {",
      '    return prompt.text === "" ? { ok: false, error: "nothing to say in " + prompt.session } : { ok: true };',
      "  },",
      "};",
      "",
      "// The logging seam, satisfied structurally, and the default the framework",
      "// falls back to when an Operator passes none.",
      "const log: Logger = {",
      "  debug: (fields: LogFields, message: string) => void [fields, message],",
      "  info: (fields: LogFields, message: string) => void [fields, message],",
      "  warn: (fields: LogFields, message: string) => void [fields, message],",
      "  error: (fields: LogFields, message: string) => void [fields, message],",
      "};",
      "export const shipped: Logger = defaultLogger();",
      "",
      "// The two servers: two bare Fastify instances the consumer constructs, because",
      "// the framework ships none and holds no opinion about either bind address. What",
      "// separates them is what gets registered on each and where each one listens.",
      "export const publicServer: FastifyInstance = Fastify({ bodyLimit: 1048576 });",
      "export const agentServer: FastifyInstance = Fastify();",
      "",
      "// Each server's place in the start order. `serverComponent` constructs nothing and",
      "// defaults nothing: the instances above are the consumer's own, only `listen` and",
      "// `close` come through the framework, and both bind addresses are stated here",
      "// because no default of ours is behind either — every interface for the Public",
      "// server, loopback for the unauthenticated Agent server (ADR-0004, ADR-0010,",
      "// ADR-0031). Annotated with the instance type each was handed, which is what proves",
      "// the parameter is passed through rather than widened to a bare instance.",
      "// The Public one is annotated with the type the wrapper answers with, which carries the",
      "// authentication aggregate beside the instance, and it is told where a refused request's",
      "// detail goes. The Agent one keeps the annotation it had before there were Auths, which is",
      "// what proves the two members are additive: an entry point written against the old shape",
      "// still compiles (ADR-0052).",
      "const refusalLog: ServerComponentOptions = { logger: log };",
      "export const publicComponent: ServerComponent<FastifyInstance> =",
      '  serverComponent(publicServer, { port: 8080, host: "0.0.0.0" }, refusalLog);',
      "export const agentComponent: Component & { readonly fastify: FastifyInstance } =",
      '  serverComponent(agentServer, { port: 7411, host: "localhost" });',
      "",
      "// And what the by-hand path has to do for itself that the default assembly does for",
      "// you: register the description **before** any route plugin, since discovery is an",
      "// `onRoute` hook and a route queued before it is invisible to it (ADR-0040). Nothing",
      "// in this file runs, so what these two lines prove is that the plugins' declarations",
      "// resolve and accept these options; that they can be *called* is the runtime step's.",
      'agentServer.register(fastifySwagger, { openapi: { openapi: "3.0.3", info: { title: "by hand", version: "0.0.0" } } });',
      'agentServer.register(fastifySwaggerUi, { routePrefix: "/docs" });',
      "",
      "// `ListeningServer` is structural, and this is the whole of what the framework asks",
      "// of a server: a real Fastify instance satisfies it by having the two methods, which",
      "// is why the package imports no runtime value from `fastify` and it stays a peer",
      "// dependency (ADR-0031).",
      "export function serveOn(server: ListeningServer): Component {",
      "  return serverComponent(server, { port: 0 });",
      "}",
      "export const ephemeral: Component = serveOn(publicServer);",
      "",
      "// A background loop of the consumer's own, in the same record as the framework's own",
      "// parts: a Component is two methods, with no base type to extend, nothing to register",
      "// it with, and no name of its own — the key it is filed under is what names it, and",
      "// what an error would name (ADR-0037).",
      "const ownLoop: Component = {",
      '  start: async () => log.info({}, "the loop is running"),',
      '  stop: async () => log.info({}, "the loop has stopped"),',
      "};",
      "",
      "// Users: constructed from the same Db, contributing one plugin to the Agent server under a",
      "// prefix the Operator chooses and one route to the Public server (ADR-0029). It takes no",
      "// `tokenTtl` and no `scrypt`: it holds nothing a person presents, so there is no cost to",
      "// name and no lifetime to choose (ADR-0052).",
      "const usersOptions: UsersOptions = { db, publicServer: publicComponent };",
      "export const usersComponent: Users = createUsers(usersOptions);",
      "const userRoutes: FastifyPluginAsync = usersComponent.agentRoutes;",
      "// There is no matching plugin for `GET /users/me`: that route takes the Public server's own",
      "// composed hook, so a plugin built without a server would have nothing to authenticate with.",
      "",
      "// Password Auth: the credential this framework ships, as an Auth. It takes Users for the",
      "// record every outcome carries, and the Public server for both of its acts of wiring: the",
      "// route group at `/auth`, and the registration that makes the server accept this scheme",
      "// (ADR-0052). On the same server as everything else, because the Users component registers",
      "// nothing at `/auth` any more.",
      "// The cost of a password derivation, named rather than defaulted, because a digest carries",
      "// the parameters it was written under and this one is only what new ones get.",
      "const passwordCost: ScryptParameters = { logN: 15, blockSize: 8, parallelism: 3 };",
      "const passwordAuthOptions: PasswordAuthOptions = {",
      "  db, users: usersComponent, publicServer: publicComponent,",
      "  tokenTtl: 30 * 24 * 60 * 60 * 1000, scrypt: passwordCost,",
      "};",
      "export const passwordAuth: PasswordAuth = createPasswordAuth(passwordAuthOptions);",
      "// An Auth like any other, so it satisfies the one member a server walks and goes in a",
      "// Gateway's record beside every other part.",
      "export const passwordAsAuth: Auth = passwordAuth;",
      "",
      "// The second scheme, on the same server: a person signs every request with a Nostr key and",
      "// logs in nowhere. It registers itself and **registers no route at all**, so there is no",
      "// plugin to hold and nothing under a prefix (ADR-0053). The base URL is what a client typed",
      "// rather than what a proxy forwarded, which is why it is stated here and never inferred.",
      "const nostrAuthOptions: NostrAuthOptions = {",
      "  db, users: usersComponent, publicServer: publicComponent,",
      '  externalBaseUrl: "https://agent.example.invalid", windowMs: 60_000,',
      "};",
      "export const nostrAuth: NostrAuth = createNostrAuth(nostrAuthOptions);",
      "export const nostrAsAuth: Auth = nostrAuth;",
      "",
      "// An Operator's own routes, on Fastify's mechanism and no contract of ours —",
      "// including one that requires a User. This is the whole integration surface and",
      "// the reason the augmentation is shipped: `request.safUser` is read with **no",
      "// cast** here, in a consumer project that declares nothing of its own, which is",
      '// what proves the `declare module "fastify"` block reaches an installed',
      "// consumer rather than only this repository (ADR-0030).",
      "const ownRoutes: FastifyPluginAsync = async (fastify) => {",
      '  fastify.get("/healthz", async () => ({ ok: true }));',
      '  fastify.post<{ Body: { text: string } }>("/ask", { preHandler: publicComponent.requireUser }, async (request) => {',
      "    const who: UserRecord = request.safUser;",
      "    return { by: who.id, attributes: who.attributes, said: request.body.text };",
      "  });",
      "};",
      "",
      "// A scheme of the consumer's own, written against one member and registered with the",
      "// server the way a component registers its routes: nothing in an entry point wires it,",
      "// and which schemes this deployment accepts is which Auths it constructed. The whole",
      "// request is given, so a credential in a header, in a body field or anywhere else is",
      "// expressible, and the three outcomes are the closed union the framework defines: not",
      "// this scheme's, this scheme's and failed, or this scheme's and this User (ADR-0052).",
      "const ownAuth: Auth = {",
      '  scheme: "Bearer",',
      "  async authenticate(request): Promise<AuthOutcome> {",
      "    const presented: string | undefined = request.headers.authorization;",
      '    if (presented === undefined) return { kind: "absent" };',
      "    const who: UserRecord | undefined = await usersComponent.get(presented);",
      "    return who === undefined",
      '      ? { kind: "refused", code: "invalid_token", detail: "the id named no User" }',
      '      : { kind: "authenticated", user: who };',
      "  },",
      "  start: async () => {},",
      "  stop: async () => {},",
      "};",
      "publicComponent.registerAuth(ownAuth);",
      "",
      "// And a protected route of the consumer's own behind the server's composed hook rather",
      "// than one component's, which is what every protected route takes from here on. The",
      "// property is read with no cast here too, and no route names a scheme.",
      "const authenticatedRoutes: FastifyPluginAsync = async (fastify) => {",
      '  fastify.get("/mine", { preHandler: publicComponent.requireUser }, async (request) => ({',
      "    id: request.safUser.id,",
      "  }));",
      "};",
      "",
      "// The one error class this subpath exports, caught rather than only imported. A protected",
      "// route on a server that no Auth registered with throws it, so an error handler of the",
      "// consumer's own can tell a wiring mistake from a credential that failed.",
      "publicServer.setErrorHandler(async (failure: Error, _request, reply) =>",
      "  reply",
      "    .code(failure instanceof NoAuthRegisteredError ? 500 : 401)",
      "    .send({ message: failure.message }),",
      ");",
      "",
      "// What the Agent server answers with, annotated so a field that went missing",
      "// from the declaration fails here.",
      "const readSignal: SignalRecord = {",
      '  id: "6f1d2c3b-4a59-4e6f-8a1b-2c3d4e5f6a7b",',
      "  kind: messageReceivedKind,",
      '  payload: { userId: "u1" },',
      "  emittedAt: new Date().toISOString(),",
      '  state: "done",',
      "  error: null,",
      "};",
      "const readRun: RunRecord = {",
      '  id: "7a2e3d4c-5b6a-4f70-9b2c-3d4e5f6a7b8c",',
      "  signalId: readSignal.id,",
      '  session: "user_u1",',
      '  prompt: "hello",',
      '  state: "failed",',
      '  error: "the agent gave up",',
      "  startedAt: new Date().toISOString(),",
      "  endedAt: null,",
      "};",
      'const states: [SignalState, RunState] = ["processing", "running"];',
      "",
      "// A Handler declaring the payload shape its Producer writes, closing over",
      "// everything else it needs (ADR-0024).",
      "function greeter(greeting: string): SignalHandler<{ userId: string }> {",
      "  return {",
      "    handle: (signal: Signal<{ userId: string }>): Prompt[] => [",
      '      { session: "user_" + signal.payload.userId, text: greeting + ", " + signal.id },',
      "    ],",
      "    post: (_signal: Signal<{ userId: string }>, outcome: PostOutcome) => {",
      '      if (outcome.failed) log.warn({}, "a Run failed");',
      "    },",
      "  };",
      "}",
      "",
      "// The predefined Handler that renders its Prompt from Handlebars source, written",
      "// against the Messenger's own **exported payload type**: a submitted Message is",
      "// a `MessageRecord`, so the template's data function type-checks against the record",
      "// every surface of that part answers with rather than against one re-declared here",
      "// (ADR-0034). The options are annotated separately, so a field that went missing from",
      "// the declaration fails here rather than being silently ignored (ADR-0027). What is",
      "// being checked is that the declaration accepts template source, a Session-naming",
      "// function, a data function, helpers and partials.",
      "const promptOptions: TemplateHandlerOptions<MessageRecord> = {",
      '  template: "You were told: {{said}}\\n{{> footer}}",',
      '  session: (signal: Signal<MessageRecord>) => "user_" + signal.payload.userId,',
      "  data: (signal: Signal<MessageRecord>) => ({ said: signal.payload.text }),",
      "  helpers: { shout: (value: string) => value.toUpperCase() },",
      '  partials: { footer: "-- sent by the Gateway" },',
      "};",
      "const fromTemplate: SignalHandler<MessageRecord> = templateHandler(promptOptions);",
      "",
      "// The Signal Worker, constructed with everything it needs and wiring itself to the",
      "// rest: the Handler map is a construction option, so a Worker with no Handlers is",
      "// unconstructable rather than merely unstartable (ADR-0021, ADR-0024), and the Agent",
      "// server is one too, so the Signal and Run routes are registered on it at no prefix",
      "// by the constructor (ADR-0032). The server",
      "// option is satisfied by what `serverComponent` returned, which is what proves it",
      "// does not narrow the instance type back to a bare one.",
      "const handlers: SignalHandlers = {",
      "  // The Messenger's own `kind`, as the constant it exports rather than a string",
      "  // literal of the same words: a Handler map is one of the two places that constant",
      "  // exists to keep from drifting (ADR-0034).",
      "  [messageReceivedKind]: fromTemplate,",
      '  "user.greeted": greeter("hello"),',
      "};",
      "const options: SignalWorkerOptions = {",
      "  db, runtime, handlers, logger: log, sweepIntervalMs: 500, agentServer: agentComponent,",
      "};",
      "// A Component like the Db and the two servers, so it goes in the same list and has",
      "// no lifecycle of its own to remember (ADR-0031).",
      "export const worker: SignalWorker = createSignalWorker(options);",
      "export const workerComponent: Component = worker;",
      "",
      "// The Signal and Run routes stay exported as a plugin even though the Agent server",
      "// already has them: passing the server is the easy path, and holding the plugin is",
      "// the door out — a prefix of the consumer's own, or their own encapsulated scope",
      "// (ADR-0032).",
      "const workerRoutes: FastifyPluginAsync = worker.agentRoutes;",
      "",
      "// The Messenger: the Db, the Users component its `user_id` references with a",
      "// foreign key, the Signal Worker an inbound Message wakes, and the **Agent** server —",
      "// all four required, because a Messenger the agent cannot answer through is broken",
      "// rather than smaller (ADR-0034). There is no Public server option on it any more: what",
      "// a User reaches is a Channel's, and a Channel that is not HTTP has no route on that",
      "// server at all (ADR-0048). Its construction order against Users no",
      "// longer matters — the framework applies no DDL — but an Operator's config",
      "// must list both `/schema` subpaths, or generation references a table it never creates",
      "// (ADR-0036, ADR-0046). The server option is satisfied by what `serverComponent`",
      "// returned, as every other part's is.",
      "const messengerOptions: MessengerOptions = {",
      "  db, users: usersComponent, worker, agentServer: agentComponent,",
      "};",
      "// Annotated, and what it carries is three methods and no route plugin: the departure from",
      "// ADR-0032's door-out pattern that ADR-0034 states. `send` and `history` are used in",
      "// `useEverything` below, which is where the transaction split is visible.",
      "export const messenger: Messenger = createMessenger(messengerOptions);",
      "// And the HTTP Channel, which is what reaches a person: the Messenger it registers itself",
      "// with, the Db for the transaction a submission runs in, and the Public server its two",
      "// routes go on and whose composed hook authenticates them. It takes no Users at all: a",
      "// component that authenticates nobody depends on nothing that does (ADR-0052). A second",
      "// Channel on this Messenger would be refused at that registration, which is why a",
      "// deployment runs one medium (ADR-0048).",
      "const httpChannelOptions: HttpChannelOptions = {",
      "  db, messenger, publicServer: publicComponent,",
      "};",
      "export const httpChannel: HttpChannel = createHttpChannel(httpChannelOptions);",
      "// And the second Channel, on a **second Messenger** — which is not a deployment shape but the",
      "// only way one project can name both specifiers: one Channel per Messenger is refused at",
      "// registration, so a deployment runs Nostr or HTTP and not both (ADR-0048). It takes no server",
      "// at all, because what a User reaches over this medium is a Relay; and the identity is 32 raw",
      "// bytes the consumer produced, because the framework parses no key material and generates none",
      "// (ADR-0049, ADR-0050).",
      "export const nostrAgentServer: FastifyInstance = Fastify();",
      "const nostrAgentComponent: Component & { readonly fastify: FastifyInstance } =",
      '  serverComponent(nostrAgentServer, { port: 7412, host: "localhost" });',
      "export const nostrMessenger: Messenger = createMessenger({",
      "  db, users: usersComponent, worker, agentServer: nostrAgentComponent,",
      "});",
      "const nostrChannelOptions: NostrChannelOptions = {",
      "  db, messenger: nostrMessenger, users: usersComponent,",
      "  secretKey: new Uint8Array(32).fill(1),",
      '  relayUrl: "wss://relay.example.invalid",',
      "  logger: log,",
      "};",
      "export const nostrChannel: NostrChannel = createNostrChannel(nostrChannelOptions);",
      "// The seam a second medium plugs into, written the way a deployment writes one: a Channel",
      "// is an ordinary Component with a name and a `send` that takes the transaction the Message",
      "// is being written in, and what it gets back from `register` is the only way an inbound",
      "// Message can be written (ADR-0048). Annotated so a member that drifted fails here.",
      "export function ownChannel(log: Messenger): [Channel, MessengerHandle] {",
      "  const channel: Channel = {",
      '    name: "own",',
      "    send: async (tx, message) => {",
      "      // A Channel's own durable work, in the transaction the Message is being written in:",
      "      // both land or neither does, and the network act waits for the commit (ADR-0048).",
      '      shipped.info({ seq: message.seq }, "carrying a Message");',
      "      await write(tx);",
      "    },",
      "    start: async () => {},",
      "    stop: async () => {},",
      "  };",
      "  return [channel, log.register(channel)];",
      "}",
      "// The one shape every messaging surface answers with — the POST response, both reads,",
      "// the trusted-code methods and the Signal payload — annotated so a field that went",
      "// missing from the declaration fails here.",
      "const said: MessageRecord = {",
      '  id: "8b3f4e5d-6c7b-4a81-9c3d-4e5f6a7b8c9d",',
      '  userId: "9c4a5b6d-7e8f-4a92-8b3c-4d5e6f7a8b9c",',
      '  direction: "outbound",',
      "  seq: 7,",
      '  text: "the deploy finished",',
      "  createdAt: new Date().toISOString(),",
      "};",
      "",
      "// Signatures: a key, both servers, whose Public one's composed hook is what refuses an",
      "// unauthenticated check, and **no Db at all**: the one part of the framework that",
      "// stores nothing, so there is no descriptor beside it and nothing to migrate",
      "// (ADR-0042). The key is a `KeyObject` the consumer loaded however they like, because",
      "// the framework parses no PEM, reads no environment and generates nothing (ADR-0041).",
      "// Generated here rather than read off disk only because this file has no disk;",
      "// `createPrivateKey` is annotated below to show the shape an Operator actually writes.",
      "const { privateKey } = generateKeyPairSync('ed25519');",
      "export const loaded: (pem: string) => KeyObject = (pem) => createPrivateKey(pem);",
      "const signaturesOptions: SignaturesOptions = {",
      "  signingKey: privateKey, logger: log,",
      "  publicServer: publicComponent, agentServer: agentComponent,",
      "};",
      "export const signatures: Signatures = createSignatures(signaturesOptions);",
      "// The one method it carries, and the claims the caller builds: `statement` is required",
      "// and everything beside it is the caller's, in the order they wrote it, because that",
      "// order is the order of the signed bytes (ADR-0042).",
      "const claims: SignedClaims = { seq: 7, createdAt: new Date().toISOString(), statement: 'we will ship on Friday' };",
      "",
      "// Decisions: the Db, Signatures it signs through in process, and both servers, whose",
      "// Public one's composed hook is what refuses an unauthenticated read. Written after",
      "// Signatures because it holds it: a Decision that was not signed is not a Decision. It",
      "// names Users nowhere at all, in code or in its schema (ADR-0043, ADR-0052).",
      "const decisionsOptions: DecisionsOptions = {",
      "  db, signatures, publicServer: publicComponent, agentServer: agentComponent,",
      "};",
      "export const decisionsComponent: Decisions = createDecisions(decisionsOptions);",
      "// The one shape every surface of that part answers with, annotated so a field that went",
      "// missing from the declaration fails here. `jws` is not optional and never will be: the",
      "// number is drawn before the signature precisely so that the column can be NOT NULL.",
      "const committed: DecisionRecord = {",
      "  seq: 7,",
      '  statement: "we will honour the terms as written",',
      '  jws: "eyJhbGciOiJFZERTQSJ9.e30.AA",',
      "  createdAt: new Date().toISOString(),",
      "};",
      "",
      "// The Scheduler: the second Producer, constructed from the Db, the Signal Worker it emits",
      "// into, and the Agent server so its routes register — omit the server and the whole",
      "// agent-facing surface is off, the programmatic interface staying available regardless",
      "// (ADR-0018). It imposes no construction-order constraint of its own, a Schedule referencing",
      "// nobody. The options are annotated separately, so a field that went missing from the",
      "// declaration fails here.",
      "const schedulerOptions: SchedulerOptions = {",
      "  db, worker, agentServer: agentComponent, maxSleepMs: 60_000,",
      "};",
      "export const scheduler: Scheduler = createScheduler(schedulerOptions);",
      "// The one shape every read of a Schedule answers with, annotated so a field that went",
      "// missing from the declaration fails here. `nextFireAt` is a plain string and not nullable: a",
      "// read answers only live Schedules, and a create is refused unless it resolves to a fire.",
      "const arranged: ScheduleRecord = {",
      '  name: "daily-digest",',
      '  spec: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },',
      '  data: { digest: "daily" },',
      "  until: null,",
      "  nextFireAt: new Date().toISOString(),",
      "};",
      "// The upsert's own answer — whether it created and the resulting record — and the input it",
      "// takes: a name, a spec that is the extensible tagged union, opaque data, and a cron's",
      "// optional end instant. Annotated so a member that drifted fails here.",
      'const onceSpec: ScheduleSpec = { kind: "once", at: new Date().toISOString() };',
      'const scheduleInput: ScheduleInput = { name: "a-reminder", spec: onceSpec, data: { note: 1 } };',
      "const upserted: ScheduleOutcome = { created: true, schedule: arranged };",
      "// A Handler for the Scheduler's fixed `kind`, written against its exported payload type the",
      "// way an Operator writes it — the reason `ScheduleFiredRecord` and `scheduleFiredKind` are",
      "// exported, so a Handler map is neither a string literal that drifts nor a shape re-declared",
      "// by hand (ADR-0018).",
      "const whenFired: SignalHandler<ScheduleFiredRecord> = {",
      "  handle: (signal: Signal<ScheduleFiredRecord>): Prompt[] => [",
      '    { session: "schedule_" + signal.payload.scheduleName, text: String(signal.payload.scheduledFor) },',
      "  ],",
      "};",
      "",
      "// A Handler factory of the consumer's own, and the shape the construction cycle takes",
      "// in their code: it closes over the Db, the Messenger and Decisions, and its post",
      "// phase is the only path by which a failed Run reaches the person waiting (ADR-0017,",
      "// ADR-0024). All three objects are constructed *after* the Signal Worker that dispatches",
      "// to this Handler, which is why `handlers` below is a callback rather than a map",
      "// (ADR-0038). The post phase is also where both trusted writes take the **same**",
      "// transaction: the notice and the commitment either both land or neither does, which is",
      "// what taking the transaction first is for (ADR-0023).",
      "function notifier(db: Db, messenger: Messenger, decisions: Decisions): SignalHandler<MessageRecord> {",
      "  return {",
      "    handle: (signal: Signal<MessageRecord>): Prompt[] => [",
      '      { session: "user_" + signal.payload.userId, text: signal.payload.text },',
      "    ],",
      "    post: async (signal: Signal<MessageRecord>, outcome: PostOutcome) => {",
      "      if (!outcome.failed) return;",
      "      await db.tx(async (tx: Transaction) => {",
      '        await messenger.send(tx, signal.payload.userId, "Something went wrong.");',
      '        await decisions.publish(tx, "a Run for " + signal.payload.userId + " failed and was reported");',
      "      });",
      "    },",
      "  };",
      "}",
      "",
      "// A Producer of the consumer's own, emitting into a Signal Worker the same call built —",
      "// which is the reason `extend` is a callback rather than a record: there is no way to",
      "// hold that Worker beforehand. It is also the case `extend` is *right* for: appended",
      "// Components stop first, so this stops producing before the drain begins, while the",
      "// worker still has everything it needs to finish what is in flight (ADR-0038).",
      "function heartbeat(db: Db, worker: SignalWorker): Component {",
      "  let ticking: ReturnType<typeof setInterval> | undefined;",
      "  return {",
      "    start: async () => {",
      "      ticking = setInterval(() => {",
      '        void db.tx((tx: Transaction) => worker.emit(tx, { kind: "loop.ticked", payload: {} }));',
      "      }, 60_000);",
      "    },",
      "    stop: async () => {",
      "      if (ticking !== undefined) clearInterval(ticking);",
      "    },",
      "  };",
      "}",
      "",
      "// What `extend` may return, named: Components under keys of the consumer's own and none",
      "// of the four infrastructure keys. A `db` or a `worker` in here is a **type error**, which",
      "// is what keeps an infrastructure Component from being replaced silently — a spread",
      "// overwrites the value and keeps the original key's position, so the substitute would start",
      "// where ours would have and nothing would say so (ADR-0037, ADR-0045).",
      "export const ownExtension: GatewayExtension = { ownLoop };",
      "",
      "// The infrastructure constructor: the Db, both servers and the Signal Worker from one call,",
      "// and the four opinionated parts built by hand in `extend` from that infrastructure — the",
      "// canonical path, with `createBareGateway` as the escape one layer down (ADR-0045). The",
      "// Runtime is an option rather than a spec, which is why the one declared at the top of this",
      "// file goes straight in and `/gateway` imports no Agent Implementation of its own. The",
      "// options are annotated separately, so a field that went missing from the declaration fails",
      "// here rather than being silently ignored.",
      "type Assembled = {",
      "  users: Users;",
      "  passwordAuth: PasswordAuth;",
      "  signatures: Signatures;",
      "  decisions: Decisions;",
      "  messenger: Messenger;",
      "  httpChannel: HttpChannel;",
      "  scheduler: Scheduler;",
      "  ownLoop: Component;",
      "};",
      "const assembly: GatewayOptions<Assembled> = {",
      '  databaseUrl: "postgres://nobody@example.invalid/none",',
      "  runtime,",
      '  agentListen: { port: 7411, host: "localhost" },',
      '  publicListen: { port: 8080, host: "0.0.0.0" },',
      "  // The five parts built from the infrastructure the callback is handed, and a Producer of",
      "  // the consumer's own beside them — Users before the Messenger for the",
      "  // foreign key (ADR-0036), Signatures before Decisions which holds it (ADR-0043). No",
      "  // `signingKey` or `tokenTtl` on the options any more: those belong to the parts, which are",
      "  // the consumer's now, so the key goes to `createSignatures` and the lifetime to",
      "  // `createPasswordAuth` (ADR-0045, ADR-0052). Everything `extend` returns is keyed ahead of",
      "  // the Worker, so",
      "  // the Producer stops after the drain rather than before it — the answer to a Producer that",
      "  // must stop first is `createBareGateway`.",
      "  extend: (infra: InfraComponents): Assembled => {",
      "    const gatewayUsers = createUsers({",
      "      db: infra.db,",
      "      agentServer: infra.agentServer, publicServer: infra.publicServer,",
      "    });",
      "    // The one scheme this deployment accepts, registering itself with the Public server in",
      "    // its own constructor: without it, every protected route below throws rather than",
      "    // refusing, because a server with no Auth can authenticate nobody (ADR-0052).",
      "    const gatewayPasswordAuth = createPasswordAuth({",
      "      db: infra.db, users: gatewayUsers, publicServer: infra.publicServer,",
      "      tokenTtl: 30 * 24 * 60 * 60 * 1000,",
      "    });",
      "    const gatewaySignatures = createSignatures({",
      "      signingKey: privateKey, logger: log,",
      "      agentServer: infra.agentServer, publicServer: infra.publicServer,",
      "    });",
      "    const gatewayDecisions = createDecisions({",
      "      db: infra.db, signatures: gatewaySignatures,",
      "      agentServer: infra.agentServer, publicServer: infra.publicServer,",
      "    });",
      "    const gatewayMessenger = createMessenger({",
      "      db: infra.db, users: gatewayUsers, worker: infra.worker, agentServer: infra.agentServer,",
      "    });",
      "    // And the Channel that reaches a person, registering itself with the Messenger above:",
      "    // there is no wiring line here, because the constructor is the wiring (ADR-0032, ADR-0048).",
      "    const gatewayChannel = createHttpChannel({",
      "      db: infra.db, messenger: gatewayMessenger,",
      "      publicServer: infra.publicServer,",
      "    });",
      "    // The Scheduler wired like the Messenger: the Db, the Worker it emits into, and the Agent",
      "    // server for its routes. Keyed ahead of the Worker like every `extend` part, so its stop —",
      "    // which cancels the firing timer — runs after the drain, a fire landing during it a pending",
      "    // Signal the next boot handles (ADR-0018, ADR-0045).",
      "    const gatewayScheduler = createScheduler({",
      "      db: infra.db, worker: infra.worker, agentServer: infra.agentServer,",
      "    });",
      "    return {",
      "      users: gatewayUsers, passwordAuth: gatewayPasswordAuth,",
      "      signatures: gatewaySignatures, decisions: gatewayDecisions,",
      "      messenger: gatewayMessenger, httpChannel: gatewayChannel, scheduler: gatewayScheduler,",
      "      ownLoop: heartbeat(infra.db, infra.worker),",
      "    };",
      "  },",
      "  // Given the four infrastructure Components *and* the extension, and this is where the cycle",
      "  // is broken: the map is written into the Signal Worker after the Messenger the Handler",
      "  // needs was built. The second entry is the extension's own Producer answered, which is only",
      "  // expressible because `handlers` runs after `extend` (ADR-0045).",
      "  handlers: (all) => ({",
      "    [messageReceivedKind]: notifier(all.db, all.messenger, all.decisions),",
      '    "loop.ticked": greeter("the loop ticked in " + typeof all.ownLoop),',
      "    // The Scheduler's fixed `kind`, routed to a Handler written against its exported payload",
      "    // type — the second Producer's matured Schedule flowing through the same dispatch as any",
      "    // other Signal, registering none of which would leave it permanently failed (ADR-0018).",
      "    [scheduleFiredKind]: whenFired,",
      "  }),",
      "  logger: log,",
      "};",
      "export const assembled: Gateway<InfraComponents & Assembled> = createGateway(assembly);",
      "// The record comes back with its types intact and each part reachable by the key the",
      "// framework filed it under — which is what proves the intersection behind",
      "// `InfraComponents & E` survived being written to a declaration file and installed. The",
      "// consumer's own Components — the four parts and the Producer — are in the same record and",
      "// reached the same way.",
      "export const assembledDb: Db = assembled.components.db;",
      "export const assembledUsers: Users = assembled.components.users;",
      "export const assembledPasswordAuth: PasswordAuth = assembled.components.passwordAuth;",
      "export const assembledMessenger: Messenger = assembled.components.messenger;",
      "export const assembledChannel: HttpChannel = assembled.components.httpChannel;",
      "export const assembledSignatures: Signatures = assembled.components.signatures;",
      "export const assembledDecisions: Decisions = assembled.components.decisions;",
      "export const assembledScheduler: Scheduler = assembled.components.scheduler;",
      "export const assembledWorker: SignalWorker = assembled.components.worker;",
      "export const assembledLoop: Component = assembled.components.ownLoop;",
      "// The two servers the framework constructed, reachable so that the consumer's own",
      "// routes, plugins and hooks go on the same instances ours did. Only their construction",
      "// is ours, and `Fastify()`'s own options are what the default path puts out of reach.",
      "export const assembledPublic: FastifyInstance = assembled.components.publicServer.fastify;",
      "export const assembledAgent: FastifyInstance = assembled.components.agentServer.fastify;",
      "",
      "// What a `pi` deployment declares, which is an Agent Container and nothing else.",
      "// There is no configuration type on the `/pi` subpath any more: no model, no",
      "// provider and no container path, because the agent reads all of those out of a",
      "// `settings.json` the Operator mounts and a `Dockerfile` they build (ADR-0033).",
      "// The Mount Table comes from `/agent-container`, not from `/pi`: it knows nothing",
      "// about an Agent Implementation, and an entry may name a directory or a single",
      "// file and may be read-only — which is how the `AGENTS.md` below, and the",
      "// `settings.json` beside it, are protected from the agent that reads them",
      "// (ADR-0028).",
      'const workspace: Mount = { agentPath: "/workspace", path: "workspace" };',
      "const mounts: MountTable = {",
      "  entries: [",
      "    workspace,",
      '    { agentPath: "/home/agent/.pi/agent", path: "agent" },',
      '    { agentPath: "/workspace/AGENTS.md", path: "AGENTS.md", readOnly: true },',
      '    { agentPath: "/home/agent/.pi/agent/settings.json", path: "settings.json", readOnly: true },',
      "  ],",
      "  // The one namespace the table has: the host's path to the Runtime Directory, which",
      "  // is what the daemon resolves a bind source in. Every entry above is written",
      "  // relative to it, and a leading `/` on one is refused (ADR-0054).",
      '  runtimeDir: "/srv/saf",',
      "};",
      "// One exported function and no resolved layer beside it: what a consumer holds is",
      "// the `--mount` argument list itself. Type-annotated, so a declaration that resolved",
      "// to `any` or went missing fails here (ADR-0028).",
      "export const piMountArguments: readonly string[] = mountArguments(mounts);",
      "",
      "// The Agent Container and the generic Runtime built from it, from `/agent-container`",
      "// rather than from `/pi`, because nothing in either has heard of an Agent",
      "// Implementation and the next one needs both unchanged (ADR-0033). Only `image` is",
      "// required; everything else here is a field an Operator may leave out. What an Agent",
      "// Implementation adds is the one function below, whose outcome reader is produced",
      "// per Run so it can name the Session in a failure.",
      "const container: AgentContainer = {",
      '  image: "saf/agent:latest",',
      "  mounts,",
      '  entrypoint: ["agent"],',
      '  networks: ["saf-agent", "saf-models"],',
      '  env: { ANTHROPIC_API_KEY: "sk-not-a-key" },',
      '  extraArgs: ["--memory", "2g"],',
      '  containerCommand: ["docker"],',
      "  logger: log,",
      "};",
      "function agentRun(asked: RunPrompt): RunPlan {",
      "  return {",
      '    args: ["--session-id", asked.session],',
      "    stdin: asked.text,",
      "    async outcome(stdout: AsyncIterable<Uint8Array>): Promise<RunOutcome> {",
      "      for await (const chunk of stdout) void chunk;",
      "      return { ok: true };",
      "    },",
      "  };",
      "}",
      "const containerSpec: AgentContainerRuntimeSpec = { container, run: agentRun };",
      "export const containerRuntime: AgentContainerRuntime =",
      "  createAgentContainerRuntime(containerSpec);",
      "// A Runtime like any other, so it goes straight into the Signal Worker's option —",
      "// and one that can also show its command line without starting anything, which is",
      "// what makes an author's argument tests pure.",
      "export const asRuntime: Runtime = containerRuntime;",
      "export const composed: ComposedCommand = containerRuntime.commandFor({",
      '  session: "user_42",',
      '  text: "what happened?",',
      "});",
      "// The `pi` Runtime itself, which is what an Operator actually passes to the Signal",
      "// Worker: one call taking one value, with no second call to remember and no type of",
      "// its own to hold one. It contributes two defaults to the container — the entry",
      "// point and `PI_OFFLINE` — and `piRun`, and nothing else (ADR-0033).",
      "export const pi: AgentContainerRuntime = createPiRuntime({",
      '  image: "saf/pi:latest",',
      "  mounts,",
      '  networks: ["saf-agent"],',
      '  env: { ANTHROPIC_API_KEY: "sk-not-a-key" },',
      '  extraArgs: ["--memory", "2g"],',
      "  logger: log,",
      "});",
      "// Annotated as a Runtime because that is the seam the Signal Worker is given, and a",
      "// `pi` Runtime is one like any other.",
      "export const piAsRuntime: Runtime = pi;",
      "export const piCommand: ComposedCommand = pi.commandFor({",
      '  session: "user_42",',
      '  text: "what happened?",',
      "});",
      "",
      "// The two pure functions the subpath ships beside it, which are the whole of what",
      "// `pi` adds to a container. An Operator could spawn the container themselves out of",
      "// these, and an author of a second Agent Implementation writes the equivalent of the",
      "// first one and nothing else — which is what this pair is exported to demonstrate.",
      "export const piByHand: Runtime = {",
      "  async run(prompt: RunPrompt): Promise<RunOutcome> {",
      "    const plan: RunPlan = piRun(prompt);",
      "    const stdout: AsyncIterable<Uint8Array> = (async function* () {",
      '      yield new TextEncoder().encode(plan.args.join(" ") + plan.stdin);',
      "    })();",
      "    return plan.outcome(stdout);",
      "  },",
      "};",
      "// The reader on its own, which takes the Session so a failure can name it.",
      "export const piOutcome: Promise<RunOutcome> = interpretPiOutput(",
      "  (async function* () {})(),",
      '  "user_42",',
      ");",
      "",
      "// A Producer of the Operator's own, told when something arrives on a channel",
      "// it shares with whoever notifies it. The connection is the Db's, so `pg`",
      "// is not an import an Operator ever needs.",
      "const watcher: ChannelListener = {",
      '  notified: (payload: string) => log.debug({ payload }, "notified"),',
      '  connected: () => log.debug({}, "listening"),',
      '  lost: (err: unknown) => log.warn({ err }, "the listening connection dropped"),',
      "};",
      "",
      "export async function useEverything(): Promise<void> {",
      "  // Nothing migrates: the Db opens a pool, hands out handles and runs transactions,",
      "  // and the tables these calls need were applied by the Operator's own drizzle-kit",
      "  // against the `/schema` subpaths this file imports from (ADR-0046, ADR-0055).",
      "  await write(db.handle({ notes }));",
      "  await db.tx(async (tx: Transaction) => write(tx));",
      '  const listening: Listening = db.listen("consumer_channel", watcher);',
      "  await listening.close();",
      "  await db.tx(async (tx: Transaction) => {",
      '    const emitted: EmittedSignal = { kind: messageReceivedKind, payload: { ...said, direction: "inbound" } };',
      "    const id: string = await worker.emit(tx, emitted);",
      '    shipped.info({ signalId: id }, "emitted");',
      "  });",
      "  // The Worker's own routes are already on the Agent server, put there at",
      "  // construction; the same plugin goes up again under a prefix of the consumer's",
      "  // own, which is the escape hatch holding it is for.",
      '  await agentServer.register(workerRoutes, { prefix: "/v1/worker" });',
      '  await agentServer.register(userRoutes, { prefix: "/users" });',
      '  await publicServer.register(ownRoutes, { prefix: "/ops" });',
      '  await publicServer.register(authenticatedRoutes, { prefix: "/me" });',
      "  // A User admitted from trusted code, in a transaction of the consumer's own:",
      "  // the write takes it first, and the reads take none (ADR-0023).",
      "  const admitted: UserRecord = await db.tx((tx: Transaction) => usersComponent.create(tx));",
      "  const sameUser: UserRecord | undefined = await usersComponent.get(admitted.id);",
      "  const everyone: UserRecord[] = await usersComponent.list({ limit: 10 });",
      "  // Where authorization is written. It is a method and not a route, reachable from a Signal",
      "  // Handler and from an entry point, both of them trusted code (ADR-0009, ADR-0020), and",
      "  // nothing an injected prompt can call (ADR-0029). It takes the transaction first, so a",
      "  // grant and whatever the consumer records about it commit together or not at all.",
      "  await db.tx(async (tx: Transaction) => {",
      '    await usersComponent.setAttributes(tx, admitted.id, { role: "operator", groups: ["support"] });',
      "  });",
      "  // Password Auth's three trusted-code methods, and the same split for the same reason: each",
      "  // takes the caller's transaction, so creating a User and giving them a credential cannot",
      "  // come apart. `setPassword` proves nothing and is the whole of account recovery here;",
      "  // `issueToken` mints for a User who presented nothing; `revoke` is the only way a credential",
      "  // stops working before it expires. None of the three has a route (ADR-0052).",
      "  const credentialled: IssuedToken = await db.tx(async (tx: Transaction) => {",
      "    const person: UserRecord = await usersComponent.create(tx);",
      '    await passwordAuth.setPassword(tx, person.id, "chosen by the Operator, proving nothing");',
      "    return passwordAuth.issueToken(tx, person.id);",
      "  });",
      "  await db.tx((tx: Transaction) => passwordAuth.revoke(tx, credentialled.user.id));",
      "  // And the second Auth's one trusted-code method, which is the whole of admission to that",
      "  // scheme: no route anywhere writes a grant, so an injected prompt cannot claim a User's",
      "  // identity, and a User holds as many keys as they have signers (ADR-0053). The key is 64",
      "  // lowercase hex characters, which is what the wire uses.",
      "  await db.tx(async (tx: Transaction) => {",
      '    await nostrAuth.recordPublicKey(tx, admitted.id, "cd".repeat(32));',
      '    await nostrAuth.recordPublicKey(tx, admitted.id, "ce".repeat(32));',
      "  });",
      '  shipped.info({ scheme: nostrAuth.scheme }, "a Nostr key may act as a User");',
      '  shipped.info({ scheme: passwordAuth.scheme, expiresAt: credentialled.expiresAt }, "a password bought a Token");',
      '  shipped.info({ admitted, sameUser, everyone: everyone.length }, "a User exists");',
      "  // The Messenger's two write-and-read methods, which are what trusted code has and no request",
      "  // does. `send` takes the consumer's own transaction, so telling somebody something and",
      "  // recording why commit together or not at all (ADR-0023); `history` takes none, and",
      "  // therefore cannot see that write until it commits, which is why `send` answers with",
      "  // the record rather than leaving a read-back to be attempted. The `limit` below is past",
      "  // the routes' cap on purpose: that cap bounds a response body, and a Handler building a",
      "  // Prompt from a long history is not one.",
      "  const answered: MessageRecord = await db.tx((tx: Transaction) =>",
      '    messenger.send(tx, admitted.id, "the deploy finished"),',
      "  );",
      "  // The window both logs are paged by, written once and handed to both methods that take",
      "  // one. There is **no type to import** for it: neither component owns the shape, and the",
      "  // root that used to carry it is gone, so both `history` signatures spell the three fields",
      "  // inline and a Developer writes an object literal. Declared here as one, and handed to two",
      "  // components' methods, so a field renamed on either signature fails here rather than",
      "  // leaving a caller unable to satisfy an argument they cannot name.",
      "  const page: { after: number; limit: number } = { after: 0, limit: 1000 };",
      "  const whole: MessageRecord[] = await messenger.history(admitted.id, page);",
      "  const since: MessageRecord[] = await messenger.history(admitted.id, { after: answered.seq });",
      '  shipped.info({ said, answered, log: whole.length, since: since.length }, "a Message has one shape on every surface");',
      "  // The Nostr Channel's one trusted-code method, and the whole of admission over that medium:",
      "  // it takes the consumer's transaction like every other write, and there is no route anywhere",
      "  // that does the same thing, which is what stops an injected prompt claiming a User's key",
      "  // (ADR-0049). The key is 64 lowercase hex characters, which is what the wire uses.",
      '  await db.tx((tx: Transaction) => nostrChannel.recordPublicKey(tx, admitted.id, "ab".repeat(32)));',
      '  shipped.info({ npub: nostrChannel.publicKey, via: nostrChannel.name }, "the agent has a Nostr identity");',
      "  // And the other half of that Channel's send, which is the half a transaction cannot hold: a",
      "  // publish cannot be rolled back, so `messenger.send` queues a finished wrap inside the",
      "  // consumer's transaction and this is what puts it on the wire afterwards. It is named here",
      "  // because it is public surface an Operator can reach, even though nothing in a running",
      "  // deployment calls it: the queue row's own notification does (ADR-0049).",
      "  await nostrChannel.drain();",
      "  // And every error class that subpath exports, caught rather than only imported. Each one is",
      "  // a refusal an Operator branches on: two from `send`, thrown inside the transaction writing",
      "  // the Message so that nothing is recorded as sent, and three from recording a key. A class",
      "  // that stopped being exported would otherwise fail at their first `instanceof` and not here.",
      "  try {",
      '    await db.tx((tx: Transaction) => nostrMessenger.send(tx, admitted.id, "over Nostr"));',
      "  } catch (refused) {",
      "    const named: boolean =",
      "      refused instanceof UnrecordedPublicKeyError ||",
      "      refused instanceof MessageTooLargeError ||",
      "      refused instanceof MalformedPublicKeyError ||",
      "      refused instanceof PublicKeyConflictError ||",
      "      refused instanceof NoSuchUserError;",
      '    shipped.warn({ named }, "a send was refused before anything was recorded");',
      "  }",
      "  // The one method Signatures carries, called rather than only named: signing is in",
      "  // process and never an HTTP request, which is what lets a Handler publish inside a",
      "  // transaction. It is also what proves `jose` is a declared dependency rather than one",
      "  // merely present in our own node_modules, since nothing else in this project installs it.",
      "  const artifact: string = await signatures.sign('saf-decision+jws', claims);",
      "  shipped.info({ committed, segments: artifact.split('.').length }, \"a Statement was signed\");",
      "  // And Decisions' two, which are the same split for the same reason: `publish` takes the",
      "  // consumer's transaction so that a commitment and their record of why cannot come apart",
      "  // (ADR-0023), and answers with the record because a read on another connection cannot",
      "  // see it yet. Neither takes a User id, this log having no owner, and there is no",
      "  // parameter for the artifact anywhere: the signature is the write path's (ADR-0043).",
      "  // The same `page` the Messenger was read with, which is the point of one window type: two",
      "  // components' logs are asked the same question, and its `limit` is past the routes' cap",
      "  // on purpose here for the same reason it was there.",
      "  const decided: DecisionRecord = await db.tx((tx: Transaction) =>",
      '    decisionsComponent.publish(tx, "we will honour the terms as written"),',
      "  );",
      "  const everything: DecisionRecord[] = await decisionsComponent.history(page);",
      "  const newest: DecisionRecord[] = await decisionsComponent.history();",
      '  shipped.info({ decided: decided.seq, log: everything.length, page: newest.length }, "a Decision is on the record");',
      "  // The Scheduler's three management methods, and the one error class it exports. A spec that",
      "  // resolves to no fire is refused before anything is persisted, and an Operator branches on",
      "  // that with `instanceof` — so the class is caught here rather than only imported, which is",
      "  // what would notice it going missing from the subpath.",
      "  try {",
      "    const outcome: ScheduleOutcome = await scheduler.schedule(scheduleInput);",
      "    const standing: ScheduleRecord[] = await scheduler.list();",
      "    await scheduler.cancel(outcome.schedule.name);",
      '    shipped.info({ created: outcome.created, standing: standing.length }, "a Schedule is declared");',
      "  } catch (refused) {",
      "    const named: boolean = refused instanceof ScheduleSpecError;",
      '    shipped.warn({ named }, "a Schedule spec was refused before anything was persisted");',
      "  }",
      "  // One record, under the consumer's own words for its parts, that starts in key",
      "  // order and stops in the reverse of it. **Every** part is in it, Users, the",
      "  // Messenger and its HTTP Channel, Signatures and Decisions included, and those five come",
      "  // off subpaths of their own — so this",
      "  // record is also what proves the installed `.d.ts` files agree with `/gateway`'s",
      "  // `Component` (ADR-0037). The order is the consumer's own and comes from one rule: the",
      "  // Signal Worker's `stop` is the only one that does work, so it is keyed after every part",
      "  // its drain uses (the Db, both servers, and the Messenger and Decisions its post phase",
      "  // reaches), and the Db is keyed first so that it is closed last (ADR-0038). `ownLoop`",
      "  // is keyed after the worker deliberately: a Producer of the consumer's own should stop",
      "  // producing before the drain, and last in the record is what buys that. Nothing in the",
      "  // framework checks any of it.",
      "  const gateway = createBareGateway({",
      "    db, agentServer: agentComponent, publicServer: publicComponent, users: usersComponent, passwordAuth,",
      "    nostrAuth, signatures, decisions: decisionsComponent, messenger, httpChannel, nostrMessenger, nostrChannel,",
      "    worker: workerComponent, ownLoop,",
      "  });",
      "  // The record comes back with its types intact, so a part is reached by the key it was",
      "  // filed under and is still what was put there — and the Gateway is itself a Component,",
      "  // which is a claim about its shape rather than a nesting anything does.",
      "  const reached: Db = gateway.components.db;",
      "  const nested: Gateway<{ db: Db }> = createBareGateway({ db: reached });",
      "  const asComponent: Component = nested;",
      "  // And the same nine from one call, which is the path an Operator's entry point actually",
      "  // takes. There is no migration step between construction and `start` any more: the",
      "  // Operator applied their schema before this process ran, and nothing here checks that",
      "  // they did (ADR-0038, ADR-0046).",
      "  await assembled.start();",
      "  await assembled.stop();",
      "  await gateway.start();",
      "  shipped.info(",
      "    { started: Object.keys(gateway.components), readSignal, readRun, states },",
      '    "the Gateway is up",',
      "  );",
      "  await gateway.stop();",
      "  await asComponent.stop();",
      "}",
      "",
    ].join("\n"),
  );
  run(
    process.execPath,
    [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    consumer,
  );

  step("importing from the scratch project at runtime");
  const imported = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        ...consumerImports,
        // Fastify, the consumer's own: the Messenger requires the Agent server and the HTTP
        // Channel the Public one, so constructing both needs two instances and there is no
        // default of ours behind either (ADR-0031, ADR-0034, ADR-0048).
        'import Fastify from "fastify";',
        // The two description plugins, imported directly and called below. They arrive in
        // this project only because the framework declares them, so the import is half the
        // proof and the registration is the other half (ADR-0040).
        'import fastifySwagger from "@fastify/swagger";',
        'import fastifySwaggerUi from "@fastify/swagger-ui";',
        // `cron-parser` and its `luxon` dependency, imported directly and called below. Like the two
        // swagger plugins above, they arrive in this project only because the framework declares
        // them — this project asked npm for the tarball, `@types/node` and `fastify` and nothing
        // else — so the import is half the proof that the Scheduler's dependency is declared rather
        // than merely present in our own tree, and the call is the other half (ADR-0018). `luxon`
        // proves less on its own, being reachable transitively through `cron-parser`; it is
        // exercised because the framework reaches for it directly to validate a zone name.
        'import { CronExpressionParser } from "cron-parser";',
        'import { IANAZone } from "luxon";',
        // The two things the exporter filters on, from the peer this project never
        // installed directly.
        'import { is } from "drizzle-orm";',
        'import { getTableConfig, PgSchema, PgTable } from "drizzle-orm/pg-core";',
        // The three built-ins the signing path needs: one to make a keypair, and two to check
        // the artifact the way a third party does — with `node:crypto` and not with `jose`,
        // since `jose` is what signed it (ADR-0042).
        'import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";',
        // `templateHandler` is here because importing it loads `handlebars`: an
        // installed package resolves it only if it is declared as a dependency, and
        // our own `node_modules` would hide a missing entry in every other check.
        //
        // The `/pi` subpath, actually run rather than only resolved: `createPiRuntime`
        // reaches across to `../agent-container/index.ts` for the generic half and down to
        // `./output.ts` for the reader, so this is what proves a relative `.ts` import
        // *inside and out of* the subpath survives being compiled and installed — the
        // thing the deleted placeholder used to stand for.
        // The Mount Table, constructed and resolved from `/agent-container` the way an
        // Operator meets it: this is what proves `--mount type=bind` arguments come out
        // of an installed package rather than only out of this repository.
        "const mounts = { runtimeDir: '/srv/saf', entries: [",
        "  { agentPath: '/workspace', path: 'workspace' },",
        "  { agentPath: '/srv/saf/agent', path: 'agent' },",
        "  { agentPath: '/workspace/AGENTS.md', path: 'AGENTS.md', readOnly: true },",
        "] };",
        "const mountArgs = mountArguments(mounts);",
        // And the generic Runtime, constructed and asked for a command line from
        // `/agent-container`. `commandFor` is pure, so this proves the whole of the argument
        // assembly runs out of an installed package with no Docker anywhere near it —
        // the image, the mounts, the user, the networks, the entry point and the agent's
        // own arguments, in that order (ADR-0033).
        "const generic = createAgentContainerRuntime({",
        "  container: { image: 'saf/agent:latest', mounts, networks: ['saf-agent'], entrypoint: ['agent'], env: { ANTHROPIC_API_KEY: 'sk-not-a-key' } },",
        "  run: (asked) => ({ args: ['--session-id', asked.session], stdin: asked.text, outcome: async () => ({ ok: true }) }),",
        "});",
        "const composed = generic.commandFor({ session: 'user_42', text: 'what happened?' });",
        // And the `pi` Runtime itself, constructed the way an Operator constructs it:
        // an image and what the container sees, with no model, no provider and no
        // container path anywhere. It refuses a container it cannot work with at
        // construction, so this also proves that check runs from the installed package.
        "const pi = createPiRuntime({ image: 'saf/pi:latest', mounts, networks: ['saf-agent'], env: { ANTHROPIC_API_KEY: 'sk-not-a-key' } });",
        "const piCommand = pi.commandFor({ session: 'user_42', text: 'what happened?' });",
        // The one function `pi` adds, on its own, which is what an author of a second
        // Agent Implementation writes the equivalent of.
        "const plan = piRun({ session: 'user_42', text: 'what happened?' });",
        // Users, constructed as an Operator constructs it. `openDb`
        // connects lazily, so this reaches the database not at all: what it proves is
        // that the subpath resolves at runtime and that construction is free of side
        // effects, like every other part's.
        "const scratch = openDb('postgres://nobody@example.invalid/none');",
        "const directory = createUsers({ db: scratch });",
        // And Password Auth off the eighth subpath, constructed the way an Operator constructs
        // it: the Db, the Users component whose record every outcome carries, and the Public
        // server it puts four routes on and registers itself with. Nothing connects and nothing
        // listens. What this proves is that the specifier resolves at runtime, that an Auth
        // wires itself with no line in an entry point, and that the object it answers with is a
        // scheme, the one member a server walks, and three trusted-code methods (ADR-0052).
        "const passwordComponent = serverComponent(Fastify(), { port: 0 });",
        "const passwordAuth = createPasswordAuth({ db: scratch, users: directory, publicServer: passwordComponent, tokenTtl: 60000 });",
        // And the second Auth on the same server, constructed the way an Operator constructs it:
        // the Db, Users, the server it registers itself with, and the external base URL the `u`
        // tag of every request is compared against. What this proves is that the specifier
        // resolves at runtime, that an Auth with **no route at all** still wires itself, and that
        // the object it answers with is a scheme, the one member a server walks and the one
        // trusted-code method that grants a key (ADR-0053).
        "const nostrAuth = createNostrAuth({ db: scratch, users: directory, publicServer: passwordComponent, externalBaseUrl: 'https://agent.example.invalid' });",
        // And the Messenger, constructed after it and the way an Operator constructs
        // it: all four arguments required, the Agent server among them, and the two nominal
        // types satisfied by the objects the two calls above returned. Nothing connects and
        // nothing listens — what this proves is that the subpath resolves at runtime, that
        // construction is free of side effects beyond the one registration it makes, and
        // that the object it answers with carries the **three** trusted-code methods and no
        // route plugin, because every other capability it has is a route it registered
        // itself (ADR-0034). Beside them, on this part and on Users both, the
        // `start` and `stop` that do nothing: what an installed package has to carry for the
        // two of them to be in a Gateway's record at all (ADR-0037).
        "const messengerWorker = createSignalWorker({ db: scratch, runtime: { run: async () => ({ ok: true }) }, handlers: {} });",
        "const messenger = createMessenger({ db: scratch, users: directory, worker: messengerWorker, agentServer: { fastify: Fastify() } });",
        // And the HTTP Channel from the ninth subpath, registering itself with that Messenger:
        // what this proves is that the specifier resolves at runtime, that a Channel wires itself
        // with no line in an entry point, and that the object it answers with is a name and the
        // three methods a Channel is — with no trusted-code method at all, because everything it
        // does it does for a request or for the Messenger (ADR-0048). That registration is also
        // why a second Channel here would throw.
        "const httpChannel = createHttpChannel({ db: scratch, messenger, publicServer: serverComponent(Fastify(), { port: 0 }) });",
        // Signatures and Decisions, constructed the way an Operator constructs them and in the
        // order they must be: Signatures takes the hook of Users and Decisions holds
        // Signatures. Signatures takes **no Db**, being the one part with nothing to store, and
        // the key is a `KeyObject` this project generated itself, because the framework parses
        // no PEM and generates nothing (ADR-0041).
        "const signaturesServer = Fastify();",
        // A logger that says nothing, because stdout is this step's assertion channel and a
        // signing line written to it would be part of what is compared. What that line carries
        // is `src/signatures/signatures.test.ts`'s subject.
        "const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };",
        // And the Nostr Channel from the tenth subpath, on a **second Messenger**, because one
        // Channel per Messenger is refused at registration and a project naming both specifiers
        // therefore needs two logs (ADR-0048). It is handed no server at all — what a User reaches
        // over this medium is a Relay — and 32 raw bytes for an identity, which is the whole of
        // what the framework accepts: no `nsec` decoder is shipped and nothing is generated
        // (ADR-0050). Nothing connects here, because the connection is `start`'s; what this proves
        // is that the specifier resolves at runtime, that the public key is derived from those
        // bytes inside the installed package, and that the object it answers with carries the one
        // trusted-code method and no route plugin (ADR-0049).
        "const nostrMessenger = createMessenger({ db: scratch, users: directory, worker: messengerWorker, agentServer: { fastify: Fastify() } });",
        "const nostrChannel = createNostrChannel({ db: scratch, messenger: nostrMessenger, users: directory, secretKey: new Uint8Array(32).fill(1), relayUrl: 'wss://relay.example.invalid', logger: quiet });",
        "const signaturesComponent = serverComponent(signaturesServer, { port: 0 });",
        "const signatures = createSignatures({ signingKey: generateKeyPairSync('ed25519').privateKey, publicServer: signaturesComponent, agentServer: { fastify: Fastify() }, logger: quiet });",
        "const decisionsComponent = createDecisions({ db: scratch, signatures, publicServer: signaturesComponent, agentServer: { fastify: Fastify() } });",
        // The Scheduler, constructed the way an Operator constructs it: the Db, the Signal Worker it
        // emits into, and an Agent server for its routes. Nothing connects and nothing listens — what
        // this proves is that the `/scheduler` subpath resolves at runtime from the installed package,
        // that construction is free of side effects beyond registering its routes,
        // and that the object it answers with carries its management surface plus the Component
        // lifecycle (ADR-0018). `cron-parser` and `luxon` are the part's own dependencies, and the
        // proof they resolve and are declared is `cronNext`/`zoneKnown` below, which call them
        // directly rather than through a Schedule driven here.
        "const scheduler = createScheduler({ db: scratch, worker: messengerWorker, agentServer: { fastify: Fastify() } });",
        // And the artifact actually produced, in process, from the installed package. This is
        // the whole proof that `jose` is a **declared** dependency rather than one merely
        // present in our own tree: this project asked npm for the tarball, `@types/node` and
        // `fastify` and nothing else, so a missing `dependencies` entry fails right here
        // (ADR-0042). Verified with `node:crypto` against the key set the route serves, which
        // is also what proves that route answers from an installed package.
        "const jws = await signatures.sign('saf-decision+jws', { seq: 7, createdAt: new Date().toISOString(), statement: 'we will ship on Friday' });",
        "await signaturesServer.ready();",
        "const keySet = (await signaturesServer.inject({ method: 'GET', url: '/jwks.json' })).json();",
        "const [jwsHeader, jwsPayload, jwsSignature] = jws.split('.');",
        "const checked = verify(null, Buffer.from(jwsHeader + '.' + jwsPayload, 'utf8'), createPublicKey({ key: keySet.keys[0], format: 'jwk' }), Buffer.from(jwsSignature, 'base64url'));",
        // And the whole stack from one `createGateway` call, which is the path an Operator's
        // entry point takes: the infrastructure the framework builds, and the four parts built by
        // hand in `extend` from it (ADR-0045). This is the one place anything proves the **value**
        // import of `fastify` survives installation: `dist/gateway/gateway.js` constructs the two servers
        // itself, and a peer dependency that failed to resolve would throw right here rather than
        // at an Operator's first deploy. Nothing connects and nothing listens — `openDb` is lazy
        // and `Fastify()` binds nothing — so what comes back is the record, in the order the
        // framework keyed it, with the Worker last and the consumer's own Components ahead of it.
        "const assembled = createGateway({",
        "  databaseUrl: 'postgres://nobody@example.invalid/none',",
        "  runtime: { run: async () => ({ ok: true }) },",
        "  agentListen: { port: 7411, host: 'localhost' },",
        "  publicListen: { port: 8080, host: '0.0.0.0' },",
        "  extend: (infra) => {",
        "    const u = createUsers({ db: infra.db, agentServer: infra.agentServer, publicServer: infra.publicServer });",
        "    const p = createPasswordAuth({ db: infra.db, users: u, publicServer: infra.publicServer, tokenTtl: 60000 });",
        "    const s = createSignatures({ signingKey: generateKeyPairSync('ed25519').privateKey, agentServer: infra.agentServer, publicServer: infra.publicServer, logger: quiet });",
        "    const d = createDecisions({ db: infra.db, signatures: s, agentServer: infra.agentServer, publicServer: infra.publicServer });",
        "    const m = createMessenger({ db: infra.db, users: u, worker: infra.worker, agentServer: infra.agentServer });",
        "    const c = createHttpChannel({ db: infra.db, messenger: m, publicServer: infra.publicServer });",
        "    return { users: u, passwordAuth: p, signatures: s, decisions: d, messenger: m, httpChannel: c, ownLoop: { start: async () => {}, stop: async () => infra.worker.stop() } };",
        "  },",
        "  handlers: (all) => ({ 'message.received': { handle: () => [{ session: 'user_1', text: typeof all.messenger.send }] } }),",
        "});",
        // The Agent server's own description, generated inside the installed package and
        // fetched the way an Agent Implementation fetches it. `ready` boots the plugins and
        // binds nothing, so this reaches no database and no socket; what it proves is that
        // the two plugins resolve from a consumer's tree, that the assembly registered them
        // ahead of all five parts, and that the ten paths the framework's own routes make
        // are in the document rather than an empty `paths` (ADR-0040).
        "await assembled.components.agentServer.fastify.ready();",
        "const description = (await assembled.components.agentServer.fastify.inject({ method: 'GET', url: '/openapi.json' })).json();",
        // And both plugins called directly, which is the by-hand path and the rule for a new
        // runtime dependency: imported *and* called. `/docs/json` is the UI package's own
        // route, so reading the document back through it exercises the second one rather
        // than only the first.
        "const byHand = Fastify();",
        "byHand.register(fastifySwagger, { openapi: { openapi: '3.0.3', info: { title: 'by hand', version: '0.0.0' } } });",
        "byHand.register(fastifySwaggerUi, { routePrefix: '/docs' });",
        "byHand.register(async (f) => { f.get('/healthz', async () => ({ ok: true })); });",
        "await byHand.ready();",
        "const byHandDocument = (await byHand.inject({ method: 'GET', url: '/docs/json' })).json();",
        "const encoder = new TextEncoder();",
        "const settled = await plan.outcome((async function* () {",
        "  yield encoder.encode(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }) + '\\n');",
        "  yield encoder.encode(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
        "})());",
        // And the reader on its own, on a stream that says nothing, because naming the
        // Session in the failure is what the per-Run reader is for (ADR-0033).
        "const silent = await interpretPiOutput((async function* () {})(), 'user_7');",
        // The Scheduler's calendar arithmetic, run from the installed package's own dependency: the
        // next 09:00 UTC strictly after noon on 2030-06-01 is the following day, and the zone checks
        // hold — which is what proves `cron-parser` and `luxon` are declared and resolve here.
        "const cronNext = CronExpressionParser.parse('0 9 * * *', { currentDate: new Date('2030-06-01T12:00:00.000Z'), tz: 'UTC' }).next().toDate().toISOString();",
        "const zoneKnown = IANAZone.isValidZone('Europe/Berlin') && !IANAZone.isValidZone('Mars/Phobos');",
        // `drizzle-kit`'s `prepareFromPgImports`, reproduced: it requires **each listed file on
        // its own** and concatenates what comes back, and what it keeps out of one is
        // `Object.values` filtered by `is(x, PgTable)` and `is(x, PgSchema)`, with **no recursion
        // into a plain object**. There is no merge in that pipeline, but there is one upstream of
        // it: a deployment's own `schema.ts` `export *`s these modules into a single namespace, and
        // that is what the schema objects and the wrappers carry a component prefix for (ADR-0055).
        // The un-aliased imports at the top of this file are where the collision is caught, since a
        // name declared twice never reaches this loop. `drizzle-kit` itself is not
        // installed here and should not be — it is a development tool, and this is a consumer's
        // runtime tree — so what runs is the collection rule rather than the tool, against the
        // very modules an Operator's `drizzle.config.ts` names (ADR-0046).
        //
        // The component subpath is read in the same loop and asked the opposite question. A
        // `schema.ts` re-exported from both places is the mistake this catches, and it is a quiet
        // one: everything keeps working, every table is simply reachable two ways.
        "const owners = ['signals', 'users', 'password-auth', 'nostr-auth', 'messenger', 'nostr-channel', 'decisions', 'scheduler'];",
        "const wrapperNames = { signals: 'signalsTables', users: 'usersTables', 'password-auth': 'passwordAuthTables', 'nostr-auth': 'nostrAuthTables', messenger: 'messengerTables', 'nostr-channel': 'nostrChannelTables', decisions: 'decisionsTables', scheduler: 'schedulerTables' };",
        "const collectedTables = [];",
        "const collectedSchemas = [];",
        "const wrappersSeen = [];",
        "const wrappersPresent = [];",
        "const stillOnTheComponent = [];",
        "for (const owner of owners) {",
        "  const onSchema = await import('shared-agent-framework/' + owner + '/schema');",
        "  for (const value of Object.values(onSchema)) {",
        "    if (is(value, PgTable)) collectedTables.push(getTableConfig(value).schema + '.' + getTableConfig(value).name);",
        "    if (is(value, PgSchema)) collectedSchemas.push(value);",
        "  }",
        // And the failure the flat shape exists to avoid, demonstrated rather than argued: the
        // `<component>Tables` wrapper `db.handle` takes rides along in every one of these modules
        // and the exporter sees none of them. A schema module that exported only its wrapper would
        // collect zero tables and generate an empty migration in silence. Presence is asked
        // separately, because a wrapper that stopped being exported is invisible to a rule whose
        // whole point is that it ignores wrappers.
        "  const wrapper = onSchema[wrapperNames[owner]];",
        "  if (wrapper !== undefined && Object.values(wrapper).every((value) => is(value, PgTable))) wrappersPresent.push(owner);",
        "  if (is(wrapper, PgTable) || is(wrapper, PgSchema)) wrappersSeen.push(owner);",
        "  const onComponent = await import('shared-agent-framework/' + owner);",
        "  for (const value of Object.values(onComponent)) {",
        "    if (is(value, PgTable) || is(value, PgSchema)) stillOnTheComponent.push(owner);",
        "  }",
        "}",
        // Eight distinct schema objects, one per module, under eight distinct names. The names
        // matter again: a deployment `export *`s these modules into one `schema.ts`, and eight
        // exports called `schema` left one survivor and seven schemas with no `CREATE` behind them
        // (ADR-0055).
        "const distinctSchemas = new Set(collectedSchemas).size + ' of ' + collectedSchemas.length + ' distinct';",
        "const schemaNames = collectedSchemas.map((value) => value.schemaName).sort();",
        // And the property the export entries exist for at all: each specifier resolves to a
        // **file path** inside the installed package, which is what an Operator's
        // `drizzle.config.ts` hands `drizzle-kit` as its `schema` (ADR-0055). Nothing else here
        // asks that question, every other check being an import.
        "const resolvesToFiles = owners.every((owner) => { const url = import.meta.resolve('shared-agent-framework/' + owner + '/schema'); return url.startsWith('file:') && url.endsWith('/dist/' + owner + '/schema/index.js'); });",
        // Nothing writes anything: there is no call between composing and interpreting,
        // because the module that used to hold one is gone from the package, and the
        // composed command line names no file for the agent to read either — the
        // Operator's `AGENTS.md` above is a mount and `pi` discovers it (ADR-0025).
        "const built = [typeof openDb, typeof templateHandler, piCommand.command + ' ' + piCommand.args.slice(-6).join(' '), plan.args.join(' '), String(settled.ok), mountArgs[1], composed.command + ' ' + composed.args.slice(-5).join(' '), composed.redactedArgs.join(' ').includes('sk-not-a-key') ? 'leaked' : 'redacted', piCommand.redactedArgs.join(' ').includes('sk-not-a-key') ? 'leaked' : 'redacted', String(['--model', '--provider', '--workdir', '--session-dir', '--append-system-prompt'].some((flag) => piCommand.args.includes(flag))), silent.error.split(' ').slice(0, 2).join(' '), String(Object.keys(pi).sort()), usersSchema.schemaName, String(Object.keys(directory).sort()), 'password auth ' + passwordAuth.scheme + ' ' + String(Object.keys(passwordAuth).sort()) + ' in ' + passwordAuthSchema.schemaName, 'nostr auth ' + nostrAuth.scheme + ' ' + String(Object.keys(nostrAuth).sort()) + ' in ' + nostrAuthSchema.schemaName, messengerSchema.schemaName, String(Object.keys(messenger).sort()), 'channel ' + httpChannel.name + ' ' + String(Object.keys(httpChannel).sort()), 'channel ' + nostrChannel.name + ' ' + String(Object.keys(nostrChannel).sort()) + ' as ' + nostrChannel.publicKey + ' in ' + nostrChannelSchema.schemaName, messageReceivedKind, decisionsSchema.schemaName, String(Object.keys(signatures).sort()), String(Object.keys(decisionsComponent).sort()), jws.split('.').length + ' segments, ' + Buffer.from(jwsSignature, 'base64url').length + ' signature bytes, verified ' + checked + ', private member ' + Object.hasOwn(keySet.keys[0], 'd'), String(Object.keys(assembled.components)), description.info.title + ' describes ' + Object.keys(description.paths).length + ' paths', 'by hand ' + Object.keys(byHandDocument.paths).join(','), 'cron ' + cronNext + ' zone ' + zoneKnown, 'scheduler ' + String(Object.keys(scheduler).sort()) + ' fires ' + scheduleFiredKind + ' in ' + schedulerSchema.schemaName, 'tables ' + collectedTables.sort().join(' ') + ' in ' + schemaNames.join(' ') + ', wrappers seen ' + wrappersSeen.length + ', wrappers present ' + wrappersPresent.length, 'schemas ' + distinctSchemas + ', on a component subpath ' + stillOnTheComponent.length + ', resolving to files ' + resolvesToFiles];",
        "process.stdout.write(built.join(':'));",
      ].join("\n"),
    ],
    consumer,
  );
  assert.equal(
    imported,
    "function:function:docker saf/pi:latest --mode json --session-id user_42 --no-approve:--mode json --session-id user_42 --no-approve:true:type=bind,source=/srv/saf/workspace,target=/workspace:docker --entrypoint agent saf/agent:latest --session-id user_42:redacted:redacted:false:Session user_7:commandFor,run:saf_users:agentRoutes,create,get,list,setAttributes,start,stop:password auth Bearer authenticate,issueToken,revoke,scheme,setPassword,start,stop in saf_password_auth:nostr auth Nostr authenticate,recordPublicKey,scheme,start,stop in saf_nostr_auth:saf_messenger:history,register,send,start,stop:channel http name,send,start,stop:channel nostr drain,name,publicKey,recordPublicKey,send,start,stop as 1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f in saf_nostr_channel:message.received:saf_decisions:sign,start,stop:history,publish,start,stop:3 segments, 64 signature bytes, verified true, private member false:db,agentServer,publicServer,users,passwordAuth,signatures,decisions,messenger,httpChannel,ownLoop,worker:Shared Agent Gateway: Agent server describes 10 paths:by hand /healthz:cron 2030-06-02T09:00:00.000Z zone true:scheduler cancel,list,schedule,start,stop,tick fires saf_schedule_fired in saf_scheduler:tables saf_decisions.decisions saf_messenger.messages saf_nostr_auth.admitted saf_nostr_auth.grants saf_nostr_channel.outbox saf_nostr_channel.pubkeys saf_nostr_channel.received saf_password_auth.passwords saf_password_auth.tokens saf_scheduler.schedules saf_signals.runs saf_signals.signals saf_users.users in saf_decisions saf_messenger saf_nostr_auth saf_nostr_channel saf_password_auth saf_scheduler saf_signals saf_users, wrappers seen 0, wrappers present 8:schemas 8 of 8 distinct, on a component subpath 0, resolving to files true",
    "all twenty-three entries should resolve at runtime and none of them is the bare package, the Signal Worker's constructor and the template Handler both arriving off `/signals`, the template Handler should load handlebars, the Mount Table should emit a bind mount, the Agent Container Runtime should compose a whole command line from `/agent-container` without starting anything — the entry point before the image and the agent's own arguments after it — and hide every environment value in the loggable copy, the pi Runtime should construct from an image and its mounts alone and compose a line carrying its own three flags and no model, provider or container path, its one function should produce that plan and read an outcome from it, its reader should name the Session in a failure, and Users should construct into its own schema with its read plugin and its four operations — the two writes the agent's surface has no route for included, and no credential of any kind among them — and Password Auth should construct off the eighth subpath into a schema of its own from the Users component and a Public server, register its four routes and itself as an Auth with that server in its own constructor, and answer with the scheme a challenge names, the one member the server walks and its three trusted-code methods and no route plugin, and Nostr Auth should construct off its own subpath into a schema of its own, register itself with that same server and **no route anywhere**, and answer with the scheme a challenge names, the one member the server walks and the one trusted-code method that grants a public key, and the Messenger should construct into a schema of its own from all four of its required arguments and answer with an object carrying exactly its three trusted-code methods, because every other capability it has is a route it registered itself, and the HTTP Channel should construct off the ninth subpath, register itself with that Messenger and answer with a name fixed by its type and the three methods a Channel is and no trusted-code method at all, and the Nostr Channel should construct off the tenth from 32 raw bytes and a Relay address with no server anywhere, register itself with a second Messenger because one Channel per Messenger is refused at registration, derive the agent's public key from those bytes inside the installed package, and answer with the one trusted-code method that records a public key, the drain that is the half of a send a transaction cannot hold, and no route plugin beside them, and all of them should carry the `start` and `stop` that do nothing and put them in the Gateway's record, and Signatures should construct with no Db anywhere, sign in process, and serve a key set with no private member in it that `node:crypto` checks the artifact against, and Decisions should construct into a schema of its own from the Signatures it holds and answer with an object carrying exactly its own two trusted-code methods, a publish that takes the caller's transaction and a read that takes none, and one `createGateway` call should assemble the infrastructure and the five parts built in `extend` from an installed package — which is also the only proof that the value import of fastify the two servers need survives installation — in the order the framework keyed them, with the Worker last and the consumer's own Components ahead of it, and that assembly's Agent server should answer a description of its own ten paths, generated by two plugins that reached this project only because the framework declares them and that a consumer can also register by hand, and `cron-parser` and its `luxon` dependency should resolve here — reached only because the framework declares them for the Scheduler — and compute the next occurrence and validate a zone, and the Scheduler itself should construct from the installed `/scheduler` subpath and carry its management surface and its Component lifecycle, filing its table under a schema of its own, and each of the eight `/schema` subpaths, which is what ADR-0046 asks an Operator to list and where ADR-0055 puts the tables, should hand `drizzle-kit`'s own per-module collection rule its own tables and its own schema, thirteen tables and eight schemas between them — the HTTP Channel absent because that Channel owns no log and no tables, and the Nostr Channel present because the three things only it can know are its own —, and none of the `<component>Tables` wrappers, because a table reachable only through a wrapper object is dropped in silence and generates an empty migration, while all eight wrappers should nevertheless resolve on their own specifiers, and those eight schema objects should be eight distinct values, and the eight **component** subpaths should carry no table and no schema object at all, because a component's tables are on exactly one specifier, and every one of the eight should resolve to a file inside the installed package, that path being the only thing `drizzle-kit`'s config takes and the whole reason the entries exist",
  );

  // And the claim nothing above can see, because everything above imports a subpath: **the bare
  // specifier resolves to nothing.** `exports` has twenty-three entries and no `.`, so Node refuses
  // `import "shared-agent-framework"` before it reads a byte of any module, and names the refusal
  // `ERR_PACKAGE_PATH_NOT_EXPORTED`. The code is read rather than the exit status, because a
  // module that threw on load would also exit non-zero and would prove the opposite of this.
  //
  // What it buys: nothing lands on the root by accident. A re-export written into a new `index.ts`
  // is unreachable, a second door onto a component cannot open there, and the only way anything
  // gets a root again is an edit to `exports` in `package.json` that a reviewer sees. That is a
  // stronger claim than the one this step used to make, which was about one constructor
  // (ADR-0047) and left every other root name unchecked.
  step("checking the bare specifier resolves to nothing");
  const rootRefusal = refusalFrom(
    process.execPath,
    ["--input-type=module", "-e", 'import "shared-agent-framework";'],
    consumer,
  );
  assert.match(
    rootRefusal,
    /ERR_PACKAGE_PATH_NOT_EXPORTED/,
    "the package has no `.` export and Node should say so; a root that resolves is a door onto the framework that nobody declared",
  );

  // The reserved `/messenger` specifier is gone from the manifest and there is no check where one
  // used to be: `"./messenger": null` retired when the log became the Messenger's (ADR-0048), and
  // an undeclared specifier does not resolve for the same reason a misspelt one does not. Asserting
  // that would be asserting Node's own behaviour.

  // And the `bin`, which nothing above reaches: it is on no specifier, so every import in this
  // script is blind to it. What an installed package owes a consumer here is a **command**, and
  // three separate things have to have gone right for one to exist — the manifest names a path
  // that shipped, `npm` linked it into `node_modules/.bin` and made it executable, and the shebang
  // survived compilation. A file test would see none of them, so the command is run.
  //
  // Run twice, because the two paths prove different halves. `--help` proves the module graph
  // loads: it is the whole of it, every module being imported statically, so a relative import
  // that failed to resolve from the installed tree fails here. No arguments at all proves the
  // refusal path answers on stderr with the exit code a shell script can branch on.
  //
  // Nothing here asserts that the export map still has twenty-three entries and no twenty-fourth
  // for this command. A `bin` is not importable, so ADR-0051 is untouched, and `check:docs` already
  // fails a subpath that no generator documents.
  step("checking the bin runs from the installed package");
  const command = path.join(consumer, "node_modules", ".bin", "http-client-tui");
  const help = run(command, ["--help"], consumer);
  assert.match(
    help,
    /^Usage: http-client-tui <user-id>/,
    "the installed command should answer its own usage; a command that cannot start is a command a consumer cannot run",
  );
  assert.match(
    help,
    /SAF_GATEWAY_URL/,
    "the usage should name the variables the command reads, there being nowhere else a reader can find them",
  );
  const missingUser = refusalFrom(command, [], consumer);
  assert.match(
    missingUser,
    /no User id was written/,
    "the installed command should refuse an empty argument list on stderr and exit non-zero",
  );

  step("package check passed");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
