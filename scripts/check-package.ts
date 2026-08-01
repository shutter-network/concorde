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
  'import { coreMigrations, createCore, defaultLogger, openStore, resolveMountTable, templateHandler } from "shared-agent-framework";',
  'import { composeInvocation, createPiAdapter, interpretPiOutput, resolvePiConfiguration } from "shared-agent-framework/pi";',
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
    // The `pi` adapter's own modules. `dist/pi/` mirroring `src/pi/` is what makes the
    // subpath resolve to the same relative imports in the repository and in the
    // package, and the fixtures beside them must not come along.
    "dist/pi/adapter.js",
    "dist/pi/configuration.js",
    "dist/pi/invocation.js",
    "dist/pi/output.js",
    "dist/pi/process.js",
    // The Mount Table, which is not the `pi` adapter's: it ships under its own directory
    // and is reachable from the package root, because nothing in it knows about an Agent
    // Runtime (ADR-0028).
    "dist/container/index.js",
    "dist/container/index.d.ts",
    "dist/container/mount-table.js",
    "dist/container/mount-table.d.ts",
    // `dist` mirrors `src`, so `src/store/store.ts` becomes `dist/store/store.js`
    // and a folder reached from `import.meta.url` is the same relative path in
    // both. Migration folders resolve because of this and nothing else.
    "dist/store/store.js",
    "dist/store/store.d.ts",
    // The Core's descriptor resolves `../../migrations/core` from its own module,
    // so its position in `dist` is what makes the shipped folder reachable.
    "dist/core/migrations.js",
    "dist/core/core.js",
    // The Core's Agent server routes: a Fastify plugin, and the only shipped module
    // that names Fastify at all. Fastify is public API rather than an internal
    // (ADR-0021), so the consumer brings the instance and registers this on it.
    "dist/core/routes.js",
    "dist/core/routes.d.ts",
    // The template Handler is public surface of its own, and the only module that
    // reaches for `handlebars` — so a missing `dependencies` entry surfaces when the
    // scratch project imports it below rather than at an Operator's first Signal.
    "dist/template-handler.js",
    "dist/template-handler.d.ts",
  ]) {
    assert.ok(entries.has(file), `the tarball should ship ${file}`);
  }

  // The modules whose subject was writing the agent's configuration. Named rather than
  // left to the mirror check below, because "it is gone" is the claim: the framework
  // writes no files, and a module that still shipped would be one an Operator could
  // still import and call (ADR-0025, ADR-0028).
  for (const gone of ["dist/pi/run-files.js", "dist/pi/run-files.d.ts"]) {
    assert.ok(!entries.has(gone), `the tarball should no longer ship ${gone}`);
  }

  // The fixtures under `src/test-support` are excluded from the build, so they
  // must not reach an Operator even though they sit inside `src`.
  assert.ok(
    ![...entries].some((entry) => entry.startsWith("dist/test-support/")),
    "test fixtures should not ship",
  );

  // Neither do the captured Agent Runtime streams beside the `pi` adapter, which are
  // a test's input and not part of anything an Operator installs.
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
      "  Mount,",
      "  MountTable,",
      "  PostOutcome,",
      "  Prompt,",
      "  ResolvedMount,",
      "  ResolvedMountTable,",
      "  RunOutcome,",
      "  RunRecord,",
      "  RunState,",
      "  RuntimeAdapter,",
      "  Signal,",
      "  SignalHandler,",
      "  SignalHandlers,",
      "  SignalRecord,",
      "  SignalState,",
      "  Store,",
      "  TemplateHandlerOptions,",
      "  Transaction,",
      '} from "shared-agent-framework";',
      // The `pi` adapter's own types, from its own subpath. Named separately because
      // that is the point of the subpath: what a deployment depends on is legible from
      // its imports, and nothing `pi`-shaped is reachable from the package root.
      "import type {",
      "  PiAdapterOptions,",
      "  PiConfiguration,",
      "  PiInvocation,",
      "  ResolvedPiConfiguration,",
      '} from "shared-agent-framework/pi";',
      'import { pgSchema, text } from "drizzle-orm/pg-core";',
      // Fastify is public API (ADR-0021) and the consumer's own dependency: the
      // framework constructs no server, so the instance comes from this call.
      // Importing the types here is also what proves they resolve from the installed
      // package: `skipLibCheck` would swallow an unresolved import inside our own
      // declarations and quietly leave the Core's route plugin `any`.
      'import Fastify from "fastify";',
      'import type { FastifyInstance, FastifyPluginAsync } from "fastify";',
      "",
      "// Annotated throughout, so a declaration that resolved to `any` fails here.",
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
      "// The two servers: two bare Fastify instances the consumer constructs, because",
      "// the framework ships none and holds no opinion about either bind address. What",
      "// separates them is what gets registered on each and where each one listens.",
      "export const publicServer: FastifyInstance = Fastify({ bodyLimit: 1048576 });",
      "export const agentServer: FastifyInstance = Fastify();",
      "",
      "// The Core contributes its Signal and Run routes as a Fastify plugin, which the",
      "// Operator registers — and not registering it is how an endpoint group is",
      "// switched off (ADR-0010, ADR-0021).",
      "const coreRoutes: FastifyPluginAsync = core.agentRoutes;",
      "",
      "// An Operator's own routes, on Fastify's mechanism and no contract of ours.",
      "const ownRoutes: FastifyPluginAsync = async (fastify) => {",
      '  fastify.get("/healthz", async () => ({ ok: true }));',
      "};",
      "",
      "// What the Agent server answers with, annotated so a field that went missing",
      "// from the declaration fails here.",
      "const readSignal: SignalRecord = {",
      '  id: "6f1d2c3b-4a59-4e6f-8a1b-2c3d4e5f6a7b",',
      '  kind: "message.received",',
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
      "// The predefined Handler that renders its Prompt from a Handlebars file. The",
      "// options are annotated separately, so a field that went missing from the",
      "// declaration fails here rather than being silently ignored (ADR-0027). Nothing",
      "// in this project runs, so the template it names need not exist; what is being",
      "// checked is that the declaration accepts a URL, a Session-naming function, a",
      "// data function, helpers and partials.",
      "const promptOptions: TemplateHandlerOptions<{ userId: string }> = {",
      '  template: new URL("./prompts/message.hbs", import.meta.url),',
      '  session: (signal: Signal<{ userId: string }>) => "user_" + signal.payload.userId,',
      "  data: (signal: Signal<{ userId: string }>) => ({ said: signal.id }),",
      "  helpers: { shout: (value: string) => value.toUpperCase() },",
      '  partials: { footer: "-- sent by the Gateway" },',
      "};",
      "const fromTemplate: SignalHandler<{ userId: string }> = templateHandler(promptOptions);",
      "",
      "// The `pi` Runtime Adapter's configuration, every field of it, so a field that",
      "// went missing from the declaration fails here rather than being ignored at the",
      "// Operator's first Run. There is no field for the agent's own configuration and",
      "// none for the Agent server's address: the framework writes no files, so what the",
      "// agent reads is placed by the Operator in a directory they mount (ADR-0025).",
      "// The Mount Table comes from the package root, not from `/pi`: it knows nothing",
      "// about an Agent Runtime, and an entry may name a directory or a single file and",
      "// may be read-only — which is how the `AGENTS.md` below is protected from the",
      "// agent that reads it (ADR-0028).",
      'const workspace: Mount = { containerPath: "/workspace", gatewayPath: "/srv/saf/workspace" };',
      "const mounts: MountTable = {",
      "  entries: [",
      "    workspace,",
      '    { containerPath: "/home/agent/.pi/agent", gatewayPath: "/srv/saf/agent" },',
      '    { containerPath: "/sessions", gatewayPath: "/srv/saf/sessions" },',
      '    { containerPath: "/workspace/AGENTS.md", gatewayPath: "/srv/saf/AGENTS.md", readOnly: true },',
      "  ],",
      '  user: "1000:1000",',
      "};",
      "const piConfig: PiConfiguration = {",
      '  image: "saf/pi:latest",',
      '  model: "claude-sonnet-4-5",',
      '  provider: "anthropic",',
      '  workspacePath: "/workspace",',
      '  agentDirPath: "/home/agent/.pi/agent",',
      '  sessionRootPath: "/sessions",',
      "  mounts,",
      '  env: { ANTHROPIC_API_KEY: "sk-not-a-key" },',
      '  network: "saf-agent",',
      '  extraArgs: ["--memory", "2g"],',
      '  containerCommand: ["docker"],',
      "};",
      "export const piMounts: ResolvedMountTable = resolveMountTable(mounts);",
      "export const piWorkspace: ResolvedMount | undefined = piMounts.entries[0];",
      "export const piResolved: ResolvedPiConfiguration = resolvePiConfiguration(piConfig);",
      "export const piInvocation: PiInvocation = composeInvocation(",
      "  piConfig,",
      '  { session: "user_42", text: "what happened?" },',
      '  "6f1d2c3b-4a59-4e6f-8a1b-2c3d4e5f6a7b",',
      ");",
      "",
      "// The adapter itself, which is what an Operator actually passes to the Core: a",
      "// plain Runtime Adapter, with no second call to remember and no type of its own",
      "// to hold one (ADR-0028). Annotated as a RuntimeAdapter because that is the seam",
      "// the Core is given and the whole of what construction returns.",
      "const piAdapterOptions: PiAdapterOptions = { ...piConfig, logger: log };",
      "export const piAdapter: RuntimeAdapter = createPiAdapter(piAdapterOptions);",
      "",
      "// A Runtime Adapter an Operator could write out of the pieces the subpath ships:",
      "// compose the invocation, start the container, read the outcome out of the JSONL.",
      "// Three steps and not four — there is nothing to write. The spawning is theirs",
      "// here, which is what proves these compose.",
      "export const piRuntime: RuntimeAdapter = {",
      "  async run(prompt: Prompt, id: string): Promise<RunOutcome> {",
      "    const invocation: PiInvocation = composeInvocation(piConfig, prompt, id);",
      "    const stdout: AsyncIterable<Uint8Array> = (async function* () {",
      '      yield new TextEncoder().encode(invocation.redactedArgs.join(" "));',
      "    })();",
      "    return interpretPiOutput(stdout);",
      "  },",
      "};",
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
      "  const handlers: SignalHandlers = {",
      '    "message.received": greeter("hello"),',
      '    "prompt.render": fromTemplate,',
      "  };",
      "  core.start(handlers);",
      "  await store.tx(async (tx: Transaction) => {",
      '    const emitted: EmittedSignal = { kind: "message.received", payload: { userId: "u1" } };',
      "    const id: string = await core.emit(tx, emitted);",
      '    shipped.info({ signalId: id }, "emitted");',
      "  });",
      "  await agentServer.register(coreRoutes);",
      '  await publicServer.register(ownRoutes, { prefix: "/ops" });',
      "  // Both bind addresses stated by the consumer, because no default of ours is",
      "  // behind either: every interface for the Public server, loopback for the",
      "  // unauthenticated Agent server (ADR-0004, ADR-0010).",
      '  const publicAddress: string = await publicServer.listen({ port: 8080, host: "0.0.0.0" });',
      '  const agentAddress: string = await agentServer.listen({ port: 7411, host: "localhost" });',
      "  shipped.info(",
      "    { publicAddress, agentAddress, readSignal, readRun, states },",
      '    "the Gateway is up",',
      "  );",
      "  await publicServer.close();",
      "  await agentServer.close();",
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
        // `templateHandler` is here because importing it loads `handlebars`: an
        // installed package resolves it only if it is declared as a dependency, and
        // our own `node_modules` would hide a missing entry in every other check.
        //
        // The `/pi` subpath, actually run rather than only resolved: `composeInvocation`
        // reaches for `./configuration.ts` to settle the Session name and the mounts, so
        // this is what proves a relative `.ts` import *inside* the subpath survives being
        // compiled and installed — the thing the deleted placeholder used to stand for.
        // The Mount Table, constructed and resolved from the package root the way an
        // Operator meets it: this is what proves `--mount type=bind` arguments come out
        // of an installed package rather than only out of this repository.
        "const mounts = { entries: [",
        "  { containerPath: '/workspace', gatewayPath: '/srv/saf/workspace' },",
        "  { containerPath: '/srv/saf/agent', gatewayPath: '/srv/saf/agent' },",
        "  { containerPath: '/sessions', gatewayPath: '/srv/saf/sessions' },",
        "  { containerPath: '/workspace/AGENTS.md', gatewayPath: '/srv/saf/AGENTS.md', readOnly: true },",
        "] };",
        "const resolvedMounts = resolveMountTable(mounts);",
        "const piConfig = {",
        "  image: 'saf/pi:latest', model: 'sonnet', workspacePath: '/workspace',",
        "  agentDirPath: '/srv/saf/agent', sessionRootPath: '/sessions', mounts,",
        "};",
        "const invocation = composeInvocation(piConfig, { session: null, text: 'what happened?' }, 'r1');",
        // And the adapter itself, constructed as an Operator constructs it. It refuses a
        // configuration it cannot work with at construction, so this also proves the
        // check inside it runs from the installed package rather than only here.
        "const adapter = createPiAdapter(piConfig);",
        "const encoder = new TextEncoder();",
        "const settled = await interpretPiOutput((async function* () {",
        "  yield encoder.encode(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }) + '\\n');",
        "  yield encoder.encode(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
        "})());",
        // Nothing writes anything: there is no call between composing and interpreting,
        // because the module that used to hold one is gone from the package, and the
        // composed invocation names no file for the agent to read either — the Operator's
        // `AGENTS.md` above is a mount and `pi` discovers it (ADR-0025).
        "const built = [typeof openStore, typeof templateHandler, invocation.command, invocation.session, String(settled.ok), resolvedMounts.containerArguments()[1], resolvedMounts.gatewayPathFor('/sessions/user_42'), resolvePiConfiguration(piConfig).containerCommand.join(' '), String(invocation.args.includes('--append-system-prompt')), typeof adapter.run, String(Object.keys(adapter))];",
        "process.stdout.write(built.join(':'));",
      ].join("\n"),
    ],
    consumer,
  );
  assert.equal(
    imported,
    "function:function:docker:run_r1:true:type=bind,source=/srv/saf/workspace,target=/workspace:/srv/saf/sessions/user_42:docker:false:function:run",
    "both subpaths should resolve at runtime, the template Handler should load handlebars, the Mount Table should emit a bind mount and answer where a container path is on the Operator's disk, and the pi adapter should construct as a plain Runtime Adapter — `run` and nothing else — settle its defaults, compose an invocation that passes no system-prompt flag, and read an outcome",
  );

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
