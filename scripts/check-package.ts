/**
 * Verifies the packaging claims that only a real tarball can settle:
 *
 *  - every folder under `migrations/` ships, `.sql` files and
 *    `meta/_journal.json` alike. A missing `files` entry fails at an Operator's
 *    runtime rather than in our CI, and the migrator will not run on SQL alone
 *    (ADR-0022).
 *  - `dist` mirrors `src`, which is what makes a migration folder reached from
 *    `import.meta.url` the same folder in the repository and in the package.
 *  - the tarball installs into a fresh project.
 *  - the root and `/pi` subpaths resolve there, both to the type checker and to
 *    Node at runtime.
 *  - a shipped migration folder **applies to a real database from inside the
 *    installed package**, with a working directory that holds no `migrations`
 *    folder of its own. Resolving against `process.cwd()` passes every test in
 *    this repository and breaks for every consumer, so this is the one place the
 *    difference shows.
 *  - `/messenger` is reserved: it is declared and deliberately unresolvable,
 *    rather than absent by omission.
 *
 * Run with `npm run check:package`. Deliberately not part of `npm run check`: it
 * installs from the registry, so it is far slower than the inner loop should be,
 * and it would make the inner loop need the network.
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
import { createTestDatabase } from "../src/test-support/database.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsRoot = path.join(repoRoot, "migrations");

/** The consumer's imports, spelled once: the type checker and Node see the same two. */
const consumerImports = [
  'import { coreMigrations, createCore, defaultLogger, openStore } from "shared-agent-framework";',
  'import { piScaffoldCheck } from "shared-agent-framework/pi";',
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
    "dist/pi/index.js",
    "dist/pi/index.d.ts",
    // `dist` mirrors `src`, so `src/store/store.ts` becomes `dist/store/store.js`
    // and a folder reached from `import.meta.url` is the same relative path in
    // both. Migration folders resolve because of this and nothing else.
    "dist/store/store.js",
    "dist/store/store.d.ts",
    // The Core's descriptor resolves `../../migrations/core` from its own module,
    // so its position in `dist` is what makes the shipped folder reachable.
    "dist/core/migrations.js",
    "dist/core/core.js",
  ]) {
    assert.ok(entries.has(file), `the tarball should ship ${file}`);
  }

  // The fixtures under `src/test-support` are excluded from the build, so they
  // must not reach an Operator even though they sit inside `src`.
  assert.ok(
    ![...entries].some((entry) => entry.startsWith("dist/test-support/")),
    "test fixtures should not ship",
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

  // `pg` is the Store's alone (ADR-0022), so no shipped declaration may name it.
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

  const migrationFolders = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(
    migrationFolders.length > 0,
    "there should be at least one migration folder to check; without one this proves nothing",
  );
  for (const folder of migrationFolders) {
    const shipped = [...entries].filter((entry) => entry.startsWith(`migrations/${folder}/`));
    assert.ok(
      shipped.some((entry) => entry.endsWith(".sql")),
      `the tarball should ship the .sql files of migrations/${folder}`,
    );
    assert.ok(
      shipped.includes(`migrations/${folder}/meta/_journal.json`),
      `the tarball should ship migrations/${folder}/meta/_journal.json; the migrator will not run on SQL alone`,
    );
  }

  // A fresh project, as an Operator would start one.
  step("installing the tarball into a scratch project");
  const consumer = path.join(workDir, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "consumer", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`,
  );
  // `@types/node` alongside the tarball, because `MigrationDescriptor.folder` is
  // a `URL`, which is a Node global rather than a TypeScript one. Every consumer
  // of a Node-only ESM package has it; asserting that here keeps the requirement
  // from being discovered by an Operator.
  run("npm", ["install", "--no-audit", "--no-fund", tarball, "@types/node"], consumer);

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
      "import type {",
      "  ChannelListener,",
      "  Core,",
      "  CoreOptions,",
      "  Db,",
      "  EmittedSignal,",
      "  Listening,",
      "  LogFields,",
      "  Logger,",
      "  MigrationDescriptor,",
      "  PostOutcome,",
      "  Prompt,",
      "  RunOutcome,",
      "  RuntimeAdapter,",
      "  Signal,",
      "  SignalHandler,",
      "  SignalHandlers,",
      "  Store,",
      "  Transaction,",
      '} from "shared-agent-framework";',
      'import { pgSchema, text } from "drizzle-orm/pg-core";',
      "",
      "// Annotated throughout, so a declaration that resolved to `any` fails here.",
      'export const fromPi: "ok" = piScaffoldCheck();',
      "export const descriptor: MigrationDescriptor = coreMigrations;",
      'export const store: Store = openStore("postgres://nobody@example.invalid/none");',
      "",
      "// An Operator's own schema and tables, kept through the same call the",
      "// framework's own parts use.",
      'const own = pgSchema("consumer");',
      'const notes = own.table("notes", { body: text("body").notNull() });',
      "",
      "// The cross-part shape: widens the schema parameter, so a handle typed to",
      "// one schema and a transaction started on another both satisfy it.",
      "async function write<TSchema extends Record<string, unknown>>(db: Db<TSchema>) {",
      '  await db.insert(notes).values({ body: "written" });',
      "}",
      "",
      "// A Runtime Adapter is an object with one method: no class to extend and no",
      "// framework base type to import.",
      "const runtime: RuntimeAdapter = {",
      "  async run(prompt: Prompt, runId: string): Promise<RunOutcome> {",
      '    return prompt.text === "" ? { ok: false, error: "nothing to say in " + runId } : { ok: true };',
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
      "const options: CoreOptions = { store, runtime, logger: log, sweepIntervalMs: 500 };",
      "export const core: Core = createCore(options);",
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
      "// A Producer of the Operator's own, told when something arrives on a channel",
      "// it shares with whoever notifies it. The connection is the Store's, so `pg`",
      "// is not an import an Operator ever needs.",
      "const watcher: ChannelListener = {",
      '  notified: (payload: string) => log.debug({ payload }, "notified"),',
      '  connected: () => log.debug({}, "listening"),',
      '  lost: (err: unknown) => log.warn({ err }, "the listening connection dropped"),',
      "};",
      "",
      "export async function useEverything(): Promise<void> {",
      "  await store.migrate(descriptor);",
      "  await write(store.handle({ notes }));",
      "  await store.tx(async (tx: Transaction) => write(tx));",
      '  const listening: Listening = store.listen("consumer_channel", watcher);',
      "  await listening.close();",
      '  const handlers: SignalHandlers = { "message.received": greeter("hello") };',
      "  core.start(handlers);",
      "  await store.tx(async (tx: Transaction) => {",
      '    const emitted: EmittedSignal = { kind: "message.received", payload: { userId: "u1" } };',
      "    const id: string = await core.emit(tx, emitted);",
      '    shipped.info({ signalId: id }, "emitted");',
      "  });",
      "  await core.stop();",
      "  await store.close();",
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
        "process.stdout.write(typeof openStore + ':' + piScaffoldCheck());",
      ].join("\n"),
    ],
    consumer,
  );
  assert.equal(imported, "function:ok", "both subpaths should resolve at runtime");

  step("applying a shipped migration folder from inside the installed package");
  // The working directory this runs from holds no `migrations` folder, so a
  // descriptor resolved against `process.cwd()` cannot work here at all.
  assert.ok(
    !existsSync(path.join(consumer, "migrations")),
    "the scratch project must not have a migrations folder of its own, or this proves nothing",
  );
  assert.ok(
    existsSync(path.join(consumer, "node_modules", "shared-agent-framework", "migrations")),
    "the installed package should carry the migrations folder",
  );
  writeFileSync(
    path.join(consumer, "migrate.ts"),
    [
      'import { coreMigrations, createCore, openStore } from "shared-agent-framework";',
      "",
      "const store = openStore(process.argv[2]);",
      "const core = createCore({ store, runtime: { run: async () => ({ ok: true }) } });",
      "try {",
      "  await store.migrate(coreMigrations);",
      "  // Emitting is what proves the folder resolved and its statements actually",
      "  // ran: the Signal has nowhere to go otherwise. The worker is never started,",
      "  // so nothing processes it.",
      '  const id = await store.tx((tx) => core.emit(tx, { kind: "probe", payload: {} }));',
      '  process.stdout.write(id.length === 36 ? "applied" : "unexpected Signal id " + id);',
      "} finally {",
      "  await store.close();",
      "}",
      "",
    ].join("\n"),
  );
  const scratchDatabase = await createTestDatabase("packaged_migrations");
  try {
    const applied = run(process.execPath, ["migrate.ts", scratchDatabase.url], consumer);
    assert.equal(applied, "applied", "the shipped migration folder should apply from the package");
  } finally {
    await scratchDatabase.drop();
  }

  step("checking /messenger is reserved rather than resolvable");
  const messengerResolved = exitsZero(
    process.execPath,
    ["--input-type=module", "-e", 'await import("shared-agent-framework/messenger");'],
    consumer,
  );
  assert.equal(messengerResolved, false, "/messenger is reserved and must not resolve yet");

  step("package check passed");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
