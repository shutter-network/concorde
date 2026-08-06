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
 *  - **all eight** entry points resolve there, both to the type checker and to Node at
 *    runtime, and eight is the whole map: the root, `/signals`, `/pi`, `/users`,
 *    `/http-messenger`, `/signatures`, `/decisions` and `/scheduler`. A component is one
 *    subpath, carrying its constructor, its types **and its tables**
 *    ([ADR-0047](../docs/adr/0047-a-component-is-one-subpath.md)), so there is no `/schema`
 *    specifier to resolve any more and no reserved `/messenger` either. The root import below
 *    is what proves the Signal Worker moved: it names every value the root still has, so a
 *    symbol that stayed behind on both specifiers would go unnoticed, but one still *only* at
 *    the root fails on the `/signals` import instead.
 *  - a component's tables arrive on that same specifier as **top-level named exports**.
 *    That shape is the whole contract
 *    ([ADR-0046](../docs/adr/0046-the-operator-owns-migrations.md)): `drizzle-kit`'s
 *    exporter takes `Object.values` of a module and keeps what passes `is(x, PgTable)`,
 *    never descending into a plain object, so a table reachable only through a wrapper
 *    is dropped in silence and generates an **empty** migration. The runtime step below
 *    reproduces that collection against a barrel the consumer wrote with `export *`,
 *    which is what an Operator's `drizzle.config.ts` points at.
 *  - **that barrel yields one distinct schema object per component**, which is the assertion
 *    ADR-0047's prefixed names exist for. `export *` drops a name that resolves to more than
 *    one binding, so a component whose schema object were renamed to a bare `schema` would be
 *    missing from the barrel, an Operator's derived `schemaFilter` would be short or empty, and
 *    `push` would create nothing and exit 0. Nothing else in the repository notices that.
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
 * The consumer's imports, spelled once: the type checker and Node see the same eight.
 *
 * **Eight lines, one per entry point, and a component's tables ride on the same line as its
 * constructor** — which is the whole of ADR-0047. Every table is named individually rather
 * than pulled in as a namespace, because naming them is what proves the module flat-exports
 * them: a table that had retreated into `usersTables` would fail to import here, where an
 * `import * as` would resolve and say nothing (ADR-0046). Every schema object is named with its
 * component prefix, because a bare `schema` on each component is a barrel that exports none.
 *
 * `createSignalWorker` comes off `/signals` and not the root, which is what ADR-0047 moved
 * first: the Worker owns tables, so it is a component with a subpath of its own.
 */
const consumerImports = [
  'import { createAgentContainerRuntime, createBareGateway, createGateway, defaultLogger, mountArguments, openDb, serverComponent, templateHandler } from "shared-agent-framework";',
  'import { createSignalWorker, runs as runsTable, signals as signalsTable, workerSchema } from "shared-agent-framework/signals";',
  'import { createPiRuntime, interpretPiOutput, piRun } from "shared-agent-framework/pi";',
  'import { createUsers, tokens as tokensTable, users as usersTable, usersSchema } from "shared-agent-framework/users";',
  'import { createHttpMessenger, httpMessagesSchema, messageReceivedKind, messages as messagesTable } from "shared-agent-framework/http-messenger";',
  'import { createSignatures } from "shared-agent-framework/signatures";',
  'import { createDecisions, decisions as decisionsTable, decisionsSchema } from "shared-agent-framework/decisions";',
  'import { createScheduler, scheduleFiredKind, schedulerSchema, schedules as schedulesTable } from "shared-agent-framework/scheduler";',
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

/** Like `run`, but reports the exit status instead of throwing, and stays quiet. */
function exitsZero(command: string, args: string[], cwd: string): boolean {
  try {
    execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
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
    "dist/index.js",
    "dist/index.d.ts",
    // The one interface the framework defines, at the package root because every
    // Gateway is assembled from it (ADR-0031). Named rather than left to the mirror
    // check below, which only reads the other way: it catches a shipped module whose
    // source is gone, not a public module that failed to ship.
    "dist/components.js",
    "dist/components.d.ts",
    // The infrastructure constructor, also at the package root and also named rather than left to
    // the mirror check: it is the canonical path an Operator's entry point takes, and it is the
    // one shipped module that imports a value from `fastify` (ADR-0045).
    "dist/gateway.js",
    "dist/gateway.d.ts",
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
    // ship under their own directory and are reachable from the package root, because
    // nothing in them knows about one and the next one needs them unchanged (ADR-0028,
    // ADR-0033). `process.js` is here rather than under `dist/pi/` for the same reason,
    // and it moved rather than being rewritten.
    "dist/container/index.js",
    "dist/container/index.d.ts",
    "dist/container/agent-container.js",
    "dist/container/agent-container.d.ts",
    "dist/container/mount-table.js",
    "dist/container/mount-table.d.ts",
    "dist/container/process.js",
    "dist/container/process.d.ts",
    // `dist` mirrors `src`, so `src/db/db.ts` becomes `dist/db/db.js`. Nothing is
    // resolved from `import.meta.url` any more — that trick existed only to reach a
    // shipped migration folder, and there is none (ADR-0046).
    "dist/db/db.js",
    "dist/db/db.d.ts",
    // The Signal Worker, under its own subpath: it owns tables, and a component that owns
    // tables has a specifier (ADR-0047). It is no longer the odd one out with a constructor at
    // the root and nothing but tables of its own.
    "dist/signals/index.js",
    "dist/signals/index.d.ts",
    "dist/signals/worker.js",
    // Every component's schema module, `.d.ts` beside `.js`. It has no subpath of its own any
    // more — the component's `index.js` re-exports it (ADR-0047) — so it ships because that
    // re-export has to resolve, for Node and for an Operator's type checker both (ADR-0046).
    "dist/signals/schema.js",
    "dist/signals/schema.d.ts",
    // The Signal Worker's Agent server routes: a Fastify plugin, and the only shipped
    // module that names Fastify at all. Fastify is public API rather than an internal
    // (ADR-0021), so the consumer brings the instance and registers this on it.
    "dist/signals/routes.js",
    "dist/signals/routes.d.ts",
    // The User Manager, under its own subpath, and with a `schema.js` beside it: the
    // tables are what an Operator barrels now (ADR-0029, ADR-0046).
    "dist/users/index.js",
    "dist/users/index.d.ts",
    "dist/users/routes.js",
    "dist/users/routes.d.ts",
    "dist/users/schema.js",
    "dist/users/schema.d.ts",
    "dist/users/secrets.js",
    "dist/users/users.js",
    "dist/users/users.d.ts",
    // The HTTP Messenger, under its own subpath. Its `schema.js` is where the foreign key
    // onto `saf_users.users.id` is declared now, so an Operator's generation writes the
    // constraint that used to be hand-edited into a shipped folder (ADR-0034, ADR-0036,
    // ADR-0046).
    "dist/http-messenger/index.js",
    "dist/http-messenger/index.d.ts",
    "dist/http-messenger/http-messenger.js",
    "dist/http-messenger/http-messenger.d.ts",
    "dist/http-messenger/messages.js",
    "dist/http-messenger/messages.d.ts",
    "dist/http-messenger/routes.js",
    "dist/http-messenger/routes.d.ts",
    "dist/http-messenger/schema.js",
    "dist/http-messenger/schema.d.ts",
    // Signatures, under its own subpath and with **no schema module**: it is the one part of
    // the framework that stores nothing, so there is no `schema.js` beside these and nothing
    // on its subpath for an Operator to barrel (ADR-0042). It is also the only module that
    // imports `jose`, which the runtime step below is what proves is declared rather than
    // merely present in our own tree.
    "dist/signatures/index.js",
    "dist/signatures/index.d.ts",
    "dist/signatures/signatures.js",
    "dist/signatures/signatures.d.ts",
    "dist/signatures/routes.js",
    "dist/signatures/routes.d.ts",
    // Decisions, under its own subpath, with its table exported from that same subpath
    // (ADR-0043, ADR-0047).
    "dist/decisions/index.js",
    "dist/decisions/index.d.ts",
    "dist/decisions/decisions.js",
    "dist/decisions/decisions.d.ts",
    "dist/decisions/routes.js",
    "dist/decisions/routes.d.ts",
    "dist/decisions/schema.js",
    "dist/decisions/schema.d.ts",
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
    // The template Handler is public surface of its own, and the only module that
    // reaches for `handlebars` — so a missing `dependencies` entry surfaces when the
    // scratch project imports it below rather than at an Operator's first Signal.
    "dist/template-handler.js",
    "dist/template-handler.d.ts",
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
  // module is `dist/gateway.js`, which constructs the two servers the infrastructure constructor
  // builds and cannot do it any other way (ADR-0045); everywhere else the framework names
  // Fastify's types and never its runtime, which is what keeps `serverComponent`
  // structural and the peer dependency honest (ADR-0031). So the check is not dropped but
  // narrowed to an exact list: a `FastifyListenOptions` written without `import type` still
  // emits one of these, and nothing else would notice, because the consumer below installs
  // Fastify and it would resolve.
  //
  // Comment lines are skipped, because `tsc` emits doc comments and an `@example` that shows an
  // Operator building their own server has to say `import Fastify from "fastify"` to be copyable.
  // That is documentation and not an import, so a scan of the raw text fails on
  // `dist/components.js` and `dist/users/users.js` and says nothing true. Skipped per line rather
  // than by stripping `/** */` blocks, so a string literal holding those four characters cannot
  // swallow the code after it and turn a real import invisible.
  step("checking only the infrastructure constructor imports a value from fastify");
  const manifest: unknown = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(
    !Object.hasOwn((manifest as { dependencies?: object }).dependencies ?? {}, "fastify"),
    "fastify should stay a peer dependency; a `dependencies` entry brings a second copy into every consumer's tree, and instances the framework built would then not be instances of the Fastify a consumer's own plugins were written against",
  );
  const mayConstructAServer = new Set(["dist/gateway.js"]);
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
        include: ["main.ts", "schema.ts"],
      },
      null,
      2,
    )}\n`,
  );
  // The Operator's migration barrel, which is the whole of what ADR-0046 asks them to
  // write: `export *` of the components they run, with a `drizzle.config.ts` pointing at it.
  // Five **component** specifiers now, not five `/schema` ones, because a component is one
  // subpath (ADR-0047). It is a file of its own rather than lines in `main.ts` because that is
  // the shape — and because `export *` carries names without unwrapping objects, which is the
  // second half of why the schema modules flat-export their tables. The User Manager is here
  // beside the HTTP Messenger deliberately: `messages.user_id` references
  // `saf_users.users.id`, so a barrel with one and not the other generates a foreign key
  // onto a table it never creates.
  writeFileSync(
    path.join(consumer, "schema.ts"),
    [
      'export * from "shared-agent-framework/signals";',
      'export * from "shared-agent-framework/users";',
      'export * from "shared-agent-framework/http-messenger";',
      'export * from "shared-agent-framework/decisions";',
      'export * from "shared-agent-framework/scheduler";',
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumer, "main.ts"),
    [
      ...consumerImports,
      // Every type the package exports. `main.ts` is what replaced
      // `skipLibCheck: false` here, so an export it does not mention is an export
      // nothing checks: a declaration that resolved to `any`, or went missing
      // altogether, would type-check in this project without it.
      "import type {",
      "  AgentContainer,",
      "  AgentContainerRuntime,",
      "  AgentContainerRuntimeSpec,",
      "  ChannelListener,",
      "  Component,",
      "  ComposedCommand,",
      "  Db,",
      "  Gateway,",
      "  GatewayExtension,",
      "  GatewayOptions,",
      "  Handle,",
      "  InfraComponents,",
      "  Listening,",
      "  ListeningServer,",
      "  LogFields,",
      "  Logger,",
      "  Mount,",
      "  MountTable,",
      "  RunPlan,",
      "  TemplateHandlerOptions,",
      "  Transaction,",
      '} from "shared-agent-framework";',
      // The Signal Worker's own types, from its own subpath: the Worker and its options, the
      // two record shapes the Agent server answers with and their states, the Prompt the
      // Handler returns and the Run prompt the Runtime is given, the Runtime seam itself, and
      // the Signal a Producer emits (ADR-0047). Every one of them was at the root until that
      // decision, and the root import above no longer names any of them, so a symbol that
      // failed to move fails on this block rather than passing on both.
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
      '} from "shared-agent-framework/signals";',
      // The `pi` subpath exports **no type at all**, which is the shape ADR-0033 leaves
      // it in: there is no configuration to name, and everything the Runtime it returns
      // is made of — the Agent Container, the Run plan, the composed command line — comes
      // from the package root, because none of it is `pi`-shaped. The three values it
      // does export are in `consumerImports` above.
      // The User Manager's own types, from its own subpath, for the same reason:
      // a deployment with no identity in it imports nothing from there (ADR-0029).
      "import type {",
      "  IssuedToken,",
      "  ScryptParameters,",
      "  UserRecord,",
      "  Users,",
      "  UsersOptions,",
      '} from "shared-agent-framework/users";',
      // The HTTP Messenger's own types, from its own subpath, for the same reason: a
      // deployment with no messaging in it imports nothing from there, and one that does is
      // stating that it accepts this part's declined freedoms (ADR-0034). No route plugin
      // type is among them, because none is exported.
      "import type {",
      "  HttpMessenger,",
      "  HttpMessengerOptions,",
      "  MessageRecord,",
      '} from "shared-agent-framework/http-messenger";',
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
      // Producer in and wiring it like the HTTP Messenger (ADR-0018). No route plugin type is among
      // them, because the part registers its routes itself and exports none.
      "import type {",
      "  ScheduleFiredRecord,",
      "  ScheduleInput,",
      "  ScheduleOutcome,",
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
      "// And the framework's own, off the five component subpaths — the door ADR-0046 opens and",
      "// ADR-0047 moves onto the component itself, so that an Operator can generate DDL for the",
      "// components they run. Each table is imported by name at the top of this file rather than",
      "// as a namespace, which is what states the shape: `drizzle-kit` reads `Object.values` of a",
      "// module and keeps what passes `is(x, PgTable)`, so a table that had retreated into a",
      "// wrapper object would be dropped in silence and generate an empty migration. Annotated as",
      "// the two Drizzle types the exporter actually filters on, so a component that stopped",
      "// exporting a table fails here rather than at an Operator's first `generate`.",
      "export const partTables: readonly PgTable[] = [",
      "  signalsTable, runsTable, usersTable, tokensTable, messagesTable, decisionsTable, schedulesTable,",
      "];",
      "export const partSchemas: readonly PgSchema[] = [",
      "  workerSchema, usersSchema, httpMessagesSchema, decisionsSchema, schedulerSchema,",
      "];",
      "",
      "// The consequence the ADR records rather than mitigates: an exported table object is",
      "// both migratable and queryable, so the same `db.handle` that takes the Operator's own",
      "// tables above takes a framework part's. Written as a real projection, so a column",
      "// renamed out from under an Operator fails here.",
      "export async function readMessages(): Promise<{ seq: number; text: string }[]> {",
      "  return db",
      "    .handle({ messages: messagesTable })",
      "    .select({ seq: messagesTable.seq, text: messagesTable.text })",
      "    .from(messagesTable);",
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
      "export const publicComponent: Component & { readonly fastify: FastifyInstance } =",
      '  serverComponent(publicServer, { port: 8080, host: "0.0.0.0" });',
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
      "// The User Manager: constructed from the same Db, contributing one more plugin to",
      "// the Agent server, under a prefix the Operator chooses (ADR-0029).",
      "// The cost of a password derivation, named rather than defaulted, because a",
      "// digest carries the parameters it was written under and this one is only what",
      "// new ones get.",
      "const cost: ScryptParameters = { logN: 15, blockSize: 8, parallelism: 3 };",
      "const usersOptions: UsersOptions = { db, tokenTtl: 30 * 24 * 60 * 60 * 1000, scrypt: cost };",
      "export const users: Users = createUsers(usersOptions);",
      "const userRoutes: FastifyPluginAsync = users.agentRoutes;",
      "// And one plugin per server: the Public one is what makes `POST /auth/tokens`",
      "// exist, and not registering it is how a deployment replaces our authentication",
      "// with its own (ADR-0030).",
      "const loginRoutes: FastifyPluginAsync = users.publicRoutes;",
      "",
      "// An Operator's own routes, on Fastify's mechanism and no contract of ours —",
      "// including one that requires a User. This is the whole integration surface and",
      "// the reason the augmentation is shipped: `request.safUser` is read with **no",
      "// cast** here, in a consumer project that declares nothing of its own, which is",
      '// what proves the `declare module "fastify"` block reaches an installed',
      "// consumer rather than only this repository (ADR-0030).",
      "const ownRoutes: FastifyPluginAsync = async (fastify) => {",
      '  fastify.get("/healthz", async () => ({ ok: true }));',
      '  fastify.post<{ Body: { text: string } }>("/ask", { preHandler: users.requireUser }, async (request) => {',
      "    const who: UserRecord = request.safUser;",
      "    return { by: who.id, attributes: who.attributes, said: request.body.text };",
      "  });",
      "};",
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
      "// The predefined Handler that renders its Prompt from a Handlebars file, written",
      "// against the HTTP Messenger's own **exported payload type**: a submitted Message is",
      "// a `MessageRecord`, so the template's data function type-checks against the record",
      "// every surface of that part answers with rather than against one re-declared here",
      "// (ADR-0034). The options are annotated separately, so a field that went missing from",
      "// the declaration fails here rather than being silently ignored (ADR-0027). Nothing in",
      "// this project runs, so the template it names need not exist; what is being checked is",
      "// that the declaration accepts a URL, a Session-naming function, a data function,",
      "// helpers and partials.",
      "const promptOptions: TemplateHandlerOptions<MessageRecord> = {",
      '  template: new URL("./prompts/message.hbs", import.meta.url),',
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
      "  // The HTTP Messenger's own `kind`, as the constant it exports rather than a string",
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
      "// The HTTP Messenger: the Db, the User Manager its `user_id` references with a",
      "// foreign key, the Signal Worker a submission wakes, and **both** servers — all five",
      "// required, because a Messenger nobody can reach or nobody can answer through is",
      "// broken rather than smaller (ADR-0034). Its construction order against the User",
      "// Manager no longer matters — the framework applies no DDL — but the **barrel** above",
      "// must carry both schemas, or generation references a table it never creates",
      "// (ADR-0036, ADR-0046). The two server options are satisfied by what `serverComponent`",
      "// returned, as every other part's are.",
      "const messengerOptions: HttpMessengerOptions = {",
      "  db, users, worker, publicServer: publicComponent, agentServer: agentComponent,",
      "};",
      "// Annotated, and what it carries is two methods and no route plugin: the departure from",
      "// ADR-0032's door-out pattern that ADR-0034 states. `send` and `history` are used in",
      "// `useEverything` below, which is where the transaction split is visible.",
      "export const messenger: HttpMessenger = createHttpMessenger(messengerOptions);",
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
      "// Signatures: a key, both servers, the User Manager whose hook refuses an",
      "// unauthenticated check, and **no Db at all** — the one part of the framework that",
      "// stores nothing, so there is no descriptor beside it and nothing to migrate",
      "// (ADR-0042). The key is a `KeyObject` the consumer loaded however they like, because",
      "// the framework parses no PEM, reads no environment and generates nothing (ADR-0041).",
      "// Generated here rather than read off disk only because this file has no disk;",
      "// `createPrivateKey` is annotated below to show the shape an Operator actually writes.",
      "const { privateKey } = generateKeyPairSync('ed25519');",
      "export const loaded: (pem: string) => KeyObject = (pem) => createPrivateKey(pem);",
      "const signaturesOptions: SignaturesOptions = {",
      "  signingKey: privateKey, users, logger: log,",
      "  publicServer: publicComponent, agentServer: agentComponent,",
      "};",
      "export const signatures: Signatures = createSignatures(signaturesOptions);",
      "// The one method it carries, and the claims the caller builds: `statement` is required",
      "// and everything beside it is the caller's, in the order they wrote it, because that",
      "// order is the order of the signed bytes (ADR-0042).",
      "const claims: SignedClaims = { seq: 7, createdAt: new Date().toISOString(), statement: 'we will ship on Friday' };",
      "",
      "// Decisions: the Db, Signatures it signs through in process, the User Manager whose hook",
      "// refuses an unauthenticated read, and both servers. Written after Signatures because it",
      "// holds it — a Decision that was not signed is not a Decision — and in **no** particular",
      "// order relative to the User Manager, since there is no foreign key here (ADR-0043).",
      "const decisionsOptions: DecisionsOptions = {",
      "  db, signatures, users, publicServer: publicComponent, agentServer: agentComponent,",
      "};",
      "export const decisions: Decisions = createDecisions(decisionsOptions);",
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
      "// in their code: it closes over the Db, the HTTP Messenger and Decisions, and its post",
      "// phase is the only path by which a failed Run reaches the person waiting (ADR-0017,",
      "// ADR-0024). All three objects are constructed *after* the Signal Worker that dispatches",
      "// to this Handler, which is why `handlers` below is a callback rather than a map",
      "// (ADR-0038). The post phase is also where both trusted writes take the **same**",
      "// transaction: the notice and the commitment either both land or neither does, which is",
      "// what taking the transaction first is for (ADR-0023).",
      "function notifier(db: Db, messenger: HttpMessenger, decisions: Decisions): SignalHandler<MessageRecord> {",
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
      "// file goes straight in and the package root imports no Agent Implementation of its own. The",
      "// options are annotated separately, so a field that went missing from the declaration fails",
      "// here rather than being silently ignored.",
      "type Assembled = {",
      "  users: Users;",
      "  signatures: Signatures;",
      "  decisions: Decisions;",
      "  messenger: HttpMessenger;",
      "  scheduler: Scheduler;",
      "  ownLoop: Component;",
      "};",
      "const assembly: GatewayOptions<Assembled> = {",
      '  databaseUrl: "postgres://nobody@example.invalid/none",',
      "  runtime,",
      '  agentListen: { port: 7411, host: "localhost" },',
      '  publicListen: { port: 8080, host: "0.0.0.0" },',
      "  // The four parts built from the infrastructure the callback is handed, and a Producer of",
      "  // the consumer's own beside them — the User Manager before the HTTP Messenger for the",
      "  // foreign key (ADR-0036), Signatures before Decisions which holds it (ADR-0043). No",
      "  // `signingKey` or `tokenTtl` on the options any more: those belong to the parts, which are",
      "  // the consumer's now, so the key goes to `createSignatures` and the lifetime to",
      "  // `createUsers` (ADR-0045). Everything `extend` returns is keyed ahead of the Worker, so",
      "  // the Producer stops after the drain rather than before it — the answer to a Producer that",
      "  // must stop first is `createBareGateway`.",
      "  extend: (infra: InfraComponents): Assembled => {",
      "    const gatewayUsers = createUsers({",
      "      db: infra.db, tokenTtl: 30 * 24 * 60 * 60 * 1000,",
      "      agentServer: infra.agentServer, publicServer: infra.publicServer,",
      "    });",
      "    const gatewaySignatures = createSignatures({",
      "      signingKey: privateKey, users: gatewayUsers, logger: log,",
      "      agentServer: infra.agentServer, publicServer: infra.publicServer,",
      "    });",
      "    const gatewayDecisions = createDecisions({",
      "      db: infra.db, signatures: gatewaySignatures, users: gatewayUsers,",
      "      agentServer: infra.agentServer, publicServer: infra.publicServer,",
      "    });",
      "    const gatewayMessenger = createHttpMessenger({",
      "      db: infra.db, users: gatewayUsers, worker: infra.worker,",
      "      publicServer: infra.publicServer, agentServer: infra.agentServer,",
      "    });",
      "    // The Scheduler wired like the Messenger: the Db, the Worker it emits into, and the Agent",
      "    // server for its routes. Keyed ahead of the Worker like every `extend` part, so its stop —",
      "    // which cancels the firing timer — runs after the drain, a fire landing during it a pending",
      "    // Signal the next boot handles (ADR-0018, ADR-0045).",
      "    const gatewayScheduler = createScheduler({",
      "      db: infra.db, worker: infra.worker, agentServer: infra.agentServer,",
      "    });",
      "    return {",
      "      users: gatewayUsers, signatures: gatewaySignatures, decisions: gatewayDecisions,",
      "      messenger: gatewayMessenger, scheduler: gatewayScheduler,",
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
      "export const assembledMessenger: HttpMessenger = assembled.components.messenger;",
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
      "// The Mount Table comes from the package root, not from `/pi`: it knows nothing",
      "// about an Agent Implementation, and an entry may name a directory or a single",
      "// file and may be read-only — which is how the `AGENTS.md` below, and the",
      "// `settings.json` beside it, are protected from the agent that reads them",
      "// (ADR-0028).",
      'const workspace: Mount = { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" };',
      "const mounts: MountTable = {",
      "  entries: [",
      "    workspace,",
      '    { agentPath: "/home/agent/.pi/agent", gatewayPath: "/srv/saf/agent" },',
      '    { agentPath: "/workspace/AGENTS.md", gatewayPath: "/srv/saf/AGENTS.md", readOnly: true },',
      '    { agentPath: "/home/agent/.pi/agent/settings.json", gatewayPath: "/srv/saf/settings.json", readOnly: true },',
      "  ],",
      "  // The translation, for a Gateway that is itself in a container: one pair, not a",
      "  // map — where the shared tree sits inside this container, and where the daemon finds",
      "  // it on the host. Every `gatewayPath` above falls under it, so none is refused",
      "  // (ADR-0028).",
      '  hostRoot: { gatewayPath: "/srv/saf", hostPath: "/host/saf" },',
      "};",
      "// One exported function and no resolved layer beside it: what a consumer holds is",
      "// the `--mount` argument list itself. Type-annotated, so a declaration that resolved",
      "// to `any` or went missing fails here (ADR-0028).",
      "export const piMountArguments: readonly string[] = mountArguments(mounts);",
      "",
      "// The Agent Container and the generic Runtime built from it, from the package root",
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
      "  // against the barrel above (ADR-0046).",
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
      '  await publicServer.register(loginRoutes, { prefix: "/auth" });',
      '  await publicServer.register(ownRoutes, { prefix: "/ops" });',
      "  // A User admitted from trusted code, in a transaction of the consumer's own:",
      "  // the write takes it first, and the reads take none (ADR-0023).",
      "  const admitted: UserRecord = await db.tx((tx: Transaction) => users.create(tx));",
      "  const sameUser: UserRecord | undefined = await users.get(admitted.id);",
      "  const everyone: UserRecord[] = await users.list({ limit: 10 });",
      "  // The three capabilities the agent is denied. They are methods and not routes,",
      "  // reachable from a Signal Handler and from an entry point — both trusted code",
      "  // (ADR-0009, ADR-0020) — and from nothing an injected prompt can call (ADR-0029).",
      "  // Each takes the transaction first, so a grant and whatever the consumer records",
      "  // about it commit together or not at all.",
      "  await db.tx(async (tx: Transaction) => {",
      '    await users.setAttributes(tx, admitted.id, { role: "operator", groups: ["support"] });',
      '    await users.setPassword(tx, admitted.id, "chosen by the Operator, proving nothing");',
      "  });",
      "  // Issuance is the extension point that replaced the Authenticator: a consumer's",
      "  // own OIDC route establishes identity however it likes and answers with exactly",
      "  // this object, which is what `POST /auth/tokens` answers with too (ADR-0030).",
      "  const minted: IssuedToken = await db.tx((tx: Transaction) =>",
      "    users.issueToken(tx, admitted.id),",
      "  );",
      "  // Revoking is a write too, so it takes the transaction first — and it is the",
      "  // only mechanism by which a credential stops working before it expires, since",
      "  // nothing removes a User (ADR-0029).",
      "  await db.tx((tx: Transaction) => users.revoke(tx, admitted.id));",
      '  shipped.info({ expiresAt: minted.expiresAt, of: minted.user.id }, "a Token was issued");',
      '  shipped.info({ admitted, sameUser, everyone: everyone.length }, "a User exists");',
      "  // The HTTP Messenger's two methods, which are what trusted code has and no request",
      "  // does. `send` takes the consumer's own transaction, so telling somebody something and",
      "  // recording why commit together or not at all (ADR-0023); `history` takes none, and",
      "  // therefore cannot see that write until it commits, which is why `send` answers with",
      "  // the record rather than leaving a read-back to be attempted. The `limit` below is past",
      "  // the routes' cap on purpose: that cap bounds a response body, and a Handler building a",
      "  // Prompt from a long history is not one.",
      "  const answered: MessageRecord = await db.tx((tx: Transaction) =>",
      '    messenger.send(tx, admitted.id, "the deploy finished"),',
      "  );",
      "  const whole: MessageRecord[] = await messenger.history(admitted.id, { limit: 1000 });",
      "  const since: MessageRecord[] = await messenger.history(admitted.id, { after: answered.seq });",
      '  shipped.info({ said, answered, log: whole.length, since: since.length }, "a Message has one shape on every surface");',
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
      "  // The `limit` below is past the routes' cap on purpose, as the Messenger's was.",
      "  const decided: DecisionRecord = await db.tx((tx: Transaction) =>",
      '    decisions.publish(tx, "we will honour the terms as written"),',
      "  );",
      "  const everything: DecisionRecord[] = await decisions.history({ after: 0, limit: 1000 });",
      "  const newest: DecisionRecord[] = await decisions.history();",
      '  shipped.info({ decided: decided.seq, log: everything.length, page: newest.length }, "a Decision is on the record");',
      "  // One record, under the consumer's own words for its parts, that starts in key",
      "  // order and stops in the reverse of it. **Every** part is in it, the User Manager and",
      "  // the HTTP Messenger, Signatures and Decisions included, and those four come off subpaths",
      "  // of their own — so this",
      "  // record is also what proves the installed `.d.ts` files agree with the root's",
      "  // `Component` (ADR-0037). The order is the consumer's own and comes from one rule: the",
      "  // Signal Worker's `stop` is the only one that does work, so it is keyed after every part",
      "  // its drain uses (the Db, both servers, and the Messenger and Decisions its post phase",
      "  // reaches), and the Db is keyed first so that it is closed last (ADR-0038). `ownLoop`",
      "  // is keyed after the worker deliberately: a Producer of the consumer's own should stop",
      "  // producing before the drain, and last in the record is what buys that. Nothing in the",
      "  // framework checks any of it.",
      "  const gateway = createBareGateway({",
      "    db, agentServer: agentComponent, publicServer: publicComponent, users, signatures,",
      "    decisions, messenger, worker: workerComponent, ownLoop,",
      "  });",
      "  // The record comes back with its types intact, so a part is reached by the key it was",
      "  // filed under and is still what was put there — and the Gateway is itself a Component,",
      "  // which is a claim about its shape rather than a nesting anything does.",
      "  const reached: Db = gateway.components.db;",
      "  const nested: Gateway<{ db: Db }> = createBareGateway({ db: reached });",
      "  const asComponent: Component = nested;",
      "  // And the same eight from one call, which is the path an Operator's entry point actually",
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
        // Fastify, the consumer's own: the HTTP Messenger requires both servers, so
        // constructing it at all needs two instances and there is no default of ours behind
        // either (ADR-0031, ADR-0034).
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
        // The Operator's barrel, imported as a namespace so that the collection below sees
        // exactly what `drizzle-kit` would: the module's own values, after `export *` has
        // carried five parts' names into one place.
        'import * as barrel from "./schema.ts";',
        // And the two things the exporter filters on, from the peer this project never
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
        // reaches across to `../container/index.ts` for the generic half and down to
        // `./output.ts` for the reader, so this is what proves a relative `.ts` import
        // *inside and out of* the subpath survives being compiled and installed — the
        // thing the deleted placeholder used to stand for.
        // The Mount Table, constructed and resolved from the package root the way an
        // Operator meets it: this is what proves `--mount type=bind` arguments come out
        // of an installed package rather than only out of this repository.
        "const mounts = { entries: [",
        "  { agentPath: '/workspace', gatewayPath: '/srv/saf/workspace' },",
        "  { agentPath: '/srv/saf/agent', gatewayPath: '/srv/saf/agent' },",
        "  { agentPath: '/workspace/AGENTS.md', gatewayPath: '/srv/saf/AGENTS.md', readOnly: true },",
        "] };",
        "const mountArgs = mountArguments(mounts);",
        // And the generic Runtime, constructed and asked for a command line from the
        // package root. `commandFor` is pure, so this proves the whole of the argument
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
        // The User Manager, constructed as an Operator constructs it. `openDb`
        // connects lazily, so this reaches the database not at all: what it proves is
        // that the subpath resolves at runtime and that construction is free of side
        // effects, like every other part's.
        "const scratch = openDb('postgres://nobody@example.invalid/none');",
        "const directory = createUsers({ db: scratch, tokenTtl: 60000 });",
        // And the HTTP Messenger, constructed after it and the way an Operator constructs
        // it: all five arguments required, both servers among them, and the two nominal
        // types satisfied by the objects the two calls above returned. Nothing connects and
        // nothing listens — what this proves is that the subpath resolves at runtime, that
        // construction is free of side effects beyond the two registrations it makes, and
        // that the object it answers with carries the **two** trusted-code methods and no
        // route plugin, because every other capability it has is a route it registered
        // itself (ADR-0034). Beside them, on this part and on the User Manager both, the
        // `start` and `stop` that do nothing: what an installed package has to carry for the
        // two of them to be in a Gateway's record at all (ADR-0037).
        "const messengerWorker = createSignalWorker({ db: scratch, runtime: { run: async () => ({ ok: true }) }, handlers: {} });",
        "const messenger = createHttpMessenger({ db: scratch, users: directory, worker: messengerWorker, publicServer: { fastify: Fastify() }, agentServer: { fastify: Fastify() } });",
        // Signatures and Decisions, constructed the way an Operator constructs them and in the
        // order they must be: Signatures takes the Manager's hook and Decisions holds
        // Signatures. Signatures takes **no Db**, being the one part with nothing to store, and
        // the key is a `KeyObject` this project generated itself, because the framework parses
        // no PEM and generates nothing (ADR-0041).
        "const signaturesServer = Fastify();",
        // A logger that says nothing, because stdout is this step's assertion channel and a
        // signing line written to it would be part of what is compared. What that line carries
        // is `src/signatures/signatures.test.ts`'s subject.
        "const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };",
        "const signatures = createSignatures({ signingKey: generateKeyPairSync('ed25519').privateKey, publicServer: { fastify: signaturesServer }, agentServer: { fastify: Fastify() }, users: directory, logger: quiet });",
        "const decisions = createDecisions({ db: scratch, signatures, users: directory, publicServer: { fastify: signaturesServer }, agentServer: { fastify: Fastify() } });",
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
        // import of `fastify` survives installation: `dist/gateway.js` constructs the two servers
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
        "    const u = createUsers({ db: infra.db, tokenTtl: 60000, agentServer: infra.agentServer, publicServer: infra.publicServer });",
        "    const s = createSignatures({ signingKey: generateKeyPairSync('ed25519').privateKey, users: u, agentServer: infra.agentServer, publicServer: infra.publicServer, logger: quiet });",
        "    const d = createDecisions({ db: infra.db, signatures: s, users: u, agentServer: infra.agentServer, publicServer: infra.publicServer });",
        "    const m = createHttpMessenger({ db: infra.db, users: u, worker: infra.worker, publicServer: infra.publicServer, agentServer: infra.agentServer });",
        "    return { users: u, signatures: s, decisions: d, messenger: m, ownLoop: { start: async () => {}, stop: async () => infra.worker.stop() } };",
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
        // `drizzle-kit`'s `prepareFromExports`, reproduced line for line against the barrel:
        // `Object.values`, filtered by `is(x, PgTable)` and `is(x, PgSchema)`, with **no
        // recursion into a plain object**. `drizzle-kit` itself is not installed here and
        // should not be — it is a development tool, and this is a consumer's runtime tree —
        // so what runs is the collection rule rather than the tool, against the very
        // module an Operator's `drizzle.config.ts` names (ADR-0046).
        "const barrelled = Object.values(barrel).filter((value) => is(value, PgTable)).map((table) => getTableConfig(table).schema + '.' + getTableConfig(table).name).sort();",
        "const barrelledSchemas = Object.values(barrel).filter((value) => is(value, PgSchema)).map((schema) => schema.schemaName).sort();",
        // And the assertion the prefixed names exist for, which nothing else in this repository
        // makes: **one distinct schema object per component, surviving `export *`** (ADR-0047).
        // `export *` drops a name that resolves to more than one binding, so if the five names
        // below were shortened to a bare `schema`, this barrel would carry none of them: the
        // collected set would be empty, `schemaFilter` would be empty, and `drizzle-kit push`
        // would compare nothing against nothing, print `No changes detected`, create not one
        // table and exit 0. Asked two ways, because the two halves fail on different mistakes.
        // The identity half is what catches a shortened name: shorten one component's and its
        // prefixed name is `undefined` on the barrel, while the bare `schema` it became is still
        // collected, so the counts stay `5 of 5` and only `every one collected` turns false.
        // Shorten all five and they become ambiguous, so `export *` drops every one and both
        // halves fail. The counting half catches the other mistake — two components sharing one
        // schema object, which is five names over four distinct values, so both counts read `4`.
        "const collectedSchemas = new Set(Object.values(barrel).filter((value) => is(value, PgSchema)));",
        "const namedSchemas = [barrel.workerSchema, barrel.usersSchema, barrel.httpMessagesSchema, barrel.decisionsSchema, barrel.schedulerSchema];",
        "const distinctSchemas = new Set(namedSchemas).size + ' of ' + collectedSchemas.size + ' distinct, every one collected ' + namedSchemas.every((value) => collectedSchemas.has(value));",
        // And the failure the flat shape exists to avoid, demonstrated rather than argued:
        // the `*Tables` wrappers `db.handle` takes ride along in every one of these modules
        // and the exporter sees **none** of them. A schema module that exported only its
        // wrapper would collect zero tables and generate an empty migration in silence.
        "const wrappersSeen = [barrel.workerTables, barrel.usersTables, barrel.httpMessagesTables, barrel.decisionsTables, barrel.schedulerTables].filter((wrapper) => is(wrapper, PgTable) || is(wrapper, PgSchema)).length;",
        // Nothing writes anything: there is no call between composing and interpreting,
        // because the module that used to hold one is gone from the package, and the
        // composed command line names no file for the agent to read either — the
        // Operator's `AGENTS.md` above is a mount and `pi` discovers it (ADR-0025).
        "const built = [typeof openDb, typeof templateHandler, piCommand.command + ' ' + piCommand.args.slice(-6).join(' '), plan.args.join(' '), String(settled.ok), mountArgs[1], composed.command + ' ' + composed.args.slice(-5).join(' '), composed.redactedArgs.join(' ').includes('sk-not-a-key') ? 'leaked' : 'redacted', piCommand.redactedArgs.join(' ').includes('sk-not-a-key') ? 'leaked' : 'redacted', String(['--model', '--provider', '--workdir', '--session-dir', '--append-system-prompt'].some((flag) => piCommand.args.includes(flag))), silent.error.split(' ').slice(0, 2).join(' '), String(Object.keys(pi).sort()), usersSchema.schemaName, String(Object.keys(directory).sort()), httpMessagesSchema.schemaName, String(Object.keys(messenger).sort()), messageReceivedKind, decisionsSchema.schemaName, String(Object.keys(signatures).sort()), String(Object.keys(decisions).sort()), jws.split('.').length + ' segments, ' + Buffer.from(jwsSignature, 'base64url').length + ' signature bytes, verified ' + checked + ', private member ' + Object.hasOwn(keySet.keys[0], 'd'), String(Object.keys(assembled.components)), description.info.title + ' describes ' + Object.keys(description.paths).length + ' paths', 'by hand ' + Object.keys(byHandDocument.paths).join(','), 'cron ' + cronNext + ' zone ' + zoneKnown, 'scheduler ' + String(Object.keys(scheduler).sort()) + ' fires ' + scheduleFiredKind + ' in ' + schedulerSchema.schemaName, 'barrel ' + barrelled.join(' ') + ' in ' + barrelledSchemas.join(' ') + ', wrappers seen ' + wrappersSeen, 'schemas ' + distinctSchemas];",
        "process.stdout.write(built.join(':'));",
      ].join("\n"),
    ],
    consumer,
  );
  assert.equal(
    imported,
    "function:function:docker saf/pi:latest --mode json --session-id user_42 --no-approve:--mode json --session-id user_42 --no-approve:true:type=bind,source=/srv/saf/workspace,target=/workspace:docker --entrypoint agent saf/agent:latest --session-id user_42:redacted:redacted:false:Session user_7:commandFor,run:saf_users:agentRoutes,create,get,issueToken,list,publicRoutes,requireUser,revoke,setAttributes,setPassword,start,stop:saf_http_messages:history,send,start,stop:message.received:saf_decisions:sign,start,stop:history,publish,start,stop:3 segments, 64 signature bytes, verified true, private member false:db,agentServer,publicServer,users,signatures,decisions,messenger,ownLoop,worker:Shared Agent Gateway: Agent server describes 10 paths:by hand /healthz:cron 2030-06-02T09:00:00.000Z zone true:scheduler cancel,list,schedule,start,stop,tick fires saf_schedule_fired in saf_scheduler:barrel saf_decisions.decisions saf_http_messages.messages saf_scheduler.schedules saf_signals.runs saf_signals.signals saf_users.tokens saf_users.users in saf_decisions saf_http_messages saf_scheduler saf_signals saf_users, wrappers seen 0:schemas 5 of 5 distinct, every one collected true",
    "all eight subpaths should resolve at runtime, the Signal Worker's constructor arriving off `/signals` and not the root, the template Handler should load handlebars, the Mount Table should emit a bind mount, the Agent Container Runtime should compose a whole command line from the package root without starting anything — the entry point before the image and the agent's own arguments after it — and hide every environment value in the loggable copy, the pi Runtime should construct from an image and its mounts alone and compose a line carrying its own three flags and no model, provider or container path, its one function should produce that plan and read an outcome from it, its reader should name the Session in a failure, and the User Manager should construct into its own schema with its routes, its preHandler and its seven operations — the three of them the agent's surface has no route for included — and the HTTP Messenger should construct into a schema of its own from all five of its required arguments and answer with an object carrying exactly its two trusted-code methods, because every other capability it has is a route it registered itself, and both of them should carry the `start` and `stop` that do nothing and put them in the Gateway's record, and Signatures should construct with no Db anywhere, sign in process, and serve a key set with no private member in it that `node:crypto` checks the artifact against, and Decisions should construct into a schema of its own from the Signatures it holds and answer with an object carrying exactly its own two trusted-code methods, a publish that takes the caller's transaction and a read that takes none, and one `createGateway` call should assemble the infrastructure and the four parts built in `extend` from an installed package — which is also the only proof that the value import of fastify the two servers need survives installation — in the order the framework keyed them, with the Worker last and the consumer's own Components ahead of it, and that assembly's Agent server should answer a description of its own ten paths, generated by two plugins that reached this project only because the framework declares them and that a consumer can also register by hand, and `cron-parser` and its `luxon` dependency should resolve here — reached only because the framework declares them for the Scheduler — and compute the next occurrence and validate a zone, and the Scheduler itself should construct from the installed `/scheduler` subpath and carry its management surface and its Component lifecycle, filing its table under a schema of its own, and an Operator's barrel — `export *` of all five **component** subpaths, which is the whole of what ADR-0046 asks them to write and where ADR-0047 puts the tables — should hand `drizzle-kit`'s own collection rule every one of the seven tables and all five schemas, and none of the `*Tables` wrappers, because a table reachable only through a wrapper object is dropped in silence and generates an empty migration, and those five schema objects should be five distinct values that the barrel carries under five distinct prefixed names, because a bare `schema` on each component is a name `export *` drops for ambiguity and an Operator whose `schemaFilter` comes back empty gets a push that creates nothing and exits 0",
  );

  // The other half of ADR-0047's first move, which nothing above can see: `main.ts` imports the
  // Worker off `/signals` and would type-check just as happily if the root still exported it too.
  // A named import of an absent export is a link-time error in ESM, so this is the one thing that
  // notices a root re-export creeping back and leaving two doors onto one component.
  step("checking the Signal Worker is no longer reachable from the root");
  const workerAtRoot = exitsZero(
    process.execPath,
    ["--input-type=module", "-e", 'import { createSignalWorker } from "shared-agent-framework";'],
    consumer,
  );
  assert.equal(
    workerAtRoot,
    false,
    "the Signal Worker belongs to `/signals` alone; a component with two specifiers is the split ADR-0047 closed",
  );

  // The reserved `/messenger` specifier is gone from the manifest and there is no check where
  // one used to be: `"./messenger": null` retired with the `/schema` subpaths (ADR-0047), and an
  // undeclared specifier does not resolve for the same reason a misspelt one does not. Asserting
  // that would be asserting Node's own behaviour.
  step("package check passed");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
