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
 *  - the root, `/pi`, `/users` and `/http-messenger` subpaths resolve there, both to
 *    the type checker and to Node at runtime.
 *  - the shipped migration folders **apply to a real database from inside the
 *    installed package**, with a working directory that holds no `migrations`
 *    folder of its own. Resolving against `process.cwd()` passes every test in
 *    this repository and breaks for every consumer, so this is the one place the
 *    difference shows. Every folder's *later* migrations count too, so the check
 *    logs a User in and then presents the Token: a Token has nowhere to be written
 *    unless the second one ran, and `request.safUser` only carries a User if the
 *    shipped preHandler runs from the installed package. The HTTP Messenger's folder
 *    is checked the same way and one step further: a Message sent to a well-formed
 *    uuid naming no User must be a 404, which is the **hand-edited foreign key**
 *    doing its job and the only proof that the constraint shipped (ADR-0036).
 *  - `/messenger` is reserved: it is declared and deliberately unresolvable,
 *    rather than absent by omission — and now says that *the* Messenger is not what
 *    shipped, since `/http-messenger` is.
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

/** The consumer's imports, spelled once: the type checker and Node see the same four. */
const consumerImports = [
  'import { components, createAgentContainerRuntime, createSignalWorker, defaultLogger, openDb, resolveMountTable, serverComponent, signalsMigrations, templateHandler } from "shared-agent-framework";',
  'import { createPiRuntime, interpretPiOutput, piRun } from "shared-agent-framework/pi";',
  'import { createUsers, usersMigrations } from "shared-agent-framework/users";',
  'import { createHttpMessenger, httpMessagesMigrations, messageReceivedKind } from "shared-agent-framework/http-messenger";',
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
    // `dist` mirrors `src`, so `src/db/db.ts` becomes `dist/db/db.js`
    // and a folder reached from `import.meta.url` is the same relative path in
    // both. Migration folders resolve because of this and nothing else.
    "dist/db/db.js",
    "dist/db/db.d.ts",
    // The Signal Worker's descriptor resolves `../../migrations/signals` from its own
    // module, so its position in `dist` is what makes the shipped folder reachable.
    "dist/signals/migrations.js",
    "dist/signals/worker.js",
    // The Signal Worker's Agent server routes: a Fastify plugin, and the only shipped
    // module that names Fastify at all. Fastify is public API rather than an internal
    // (ADR-0021), so the consumer brings the instance and registers this on it.
    "dist/signals/routes.js",
    "dist/signals/routes.d.ts",
    // The User Directory, under its own subpath and with its own migration
    // descriptor: `dist/users/migrations.js` resolves `../../migrations/users` from
    // its own module, so its position in `dist` is what makes that folder reachable
    // (ADR-0029).
    "dist/users/index.js",
    "dist/users/index.d.ts",
    "dist/users/migrations.js",
    "dist/users/routes.js",
    "dist/users/routes.d.ts",
    "dist/users/schema.js",
    "dist/users/secrets.js",
    "dist/users/users.js",
    "dist/users/users.d.ts",
    // The HTTP Messenger, under its own subpath and with its own migration descriptor:
    // `dist/http-messenger/migrations.js` resolves `../../migrations/http-messages` from
    // its own module, so its position in `dist` is what makes that folder — and the
    // hand-edited foreign key in it — reachable (ADR-0034, ADR-0036).
    "dist/http-messenger/index.js",
    "dist/http-messenger/index.d.ts",
    "dist/http-messenger/http-messenger.js",
    "dist/http-messenger/http-messenger.d.ts",
    "dist/http-messenger/messages.js",
    "dist/http-messenger/messages.d.ts",
    "dist/http-messenger/migrations.js",
    "dist/http-messenger/routes.js",
    "dist/http-messenger/routes.d.ts",
    "dist/http-messenger/schema.js",
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

  // `fastify` is a peer dependency, so nothing shipped may *run* an import of it:
  // types are erased, and a value import would resolve out of a consumer's own tree
  // or fail there outright. This is the `serverComponent` constraint held in place
  // (ADR-0031) — a `FastifyListenOptions` written without `import type` would emit
  // one of these and nothing else would notice, because the consumer below installs
  // Fastify and it would resolve.
  step("checking no shipped module imports a value from fastify");
  const manifest: unknown = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(
    !Object.hasOwn((manifest as { dependencies?: object }).dependencies ?? {}, "fastify"),
    "fastify should stay a peer dependency; a `dependencies` entry brings a second copy into every consumer's tree",
  );
  for (const emitted of readdirSync(path.join(repoRoot, "dist"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!emitted.isFile() || !emitted.name.endsWith(".js")) continue;
    const file = path.join(emitted.parentPath, emitted.name);
    assert.ok(
      !/from ["']fastify["']/.test(readFileSync(file, "utf8")),
      `${path.relative(repoRoot, file)} imports a value from fastify; the framework may name its types and nothing else`,
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
      "  AgentContainer,",
      "  AgentContainerRuntime,",
      "  AgentContainerRuntimeSpec,",
      "  ChannelListener,",
      "  Component,",
      "  ComposedCommand,",
      "  Db,",
      "  EmittedSignal,",
      "  Handle,",
      "  Listening,",
      "  ListeningServer,",
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
      "  RunPlan,",
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
      "  Transaction,",
      '} from "shared-agent-framework";',
      // The `pi` subpath exports **no type at all**, which is the shape ADR-0033 leaves
      // it in: there is no configuration to name, and everything the Runtime it returns
      // is made of — the Agent Container, the Run plan, the composed command line — comes
      // from the package root, because none of it is `pi`-shaped. The three values it
      // does export are in `consumerImports` above.
      // The User Directory's own types, from its own subpath, for the same reason:
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
      'import { pgSchema, text } from "drizzle-orm/pg-core";',
      // Fastify is public API (ADR-0021) and the consumer's own dependency: the
      // framework constructs no server, so the instance comes from this call.
      // Importing the types here is also what proves they resolve from the installed
      // package: `skipLibCheck` would swallow an unresolved import inside our own
      // declarations and quietly leave the Signal Worker's route plugin `any`.
      'import Fastify from "fastify";',
      'import type { FastifyInstance, FastifyPluginAsync } from "fastify";',
      "",
      "// Annotated throughout, so a declaration that resolved to `any` fails here.",
      "export const descriptor: MigrationDescriptor = signalsMigrations;",
      'export const db: Db = openDb("postgres://nobody@example.invalid/none");',
      "",
      "// An Operator's own schema and tables, kept through the same call the",
      "// framework's own parts use.",
      'const own = pgSchema("consumer");',
      'const notes = own.table("notes", { body: text("body").notNull() });',
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
      '  serverComponent("public server", publicServer, { port: 8080, host: "0.0.0.0" });',
      "export const agentComponent: Component & { readonly fastify: FastifyInstance } =",
      '  serverComponent("agent server", agentServer, { port: 7411, host: "localhost" });',
      "",
      "// `ListeningServer` is structural, and this is the whole of what the framework asks",
      "// of a server: a real Fastify instance satisfies it by having the two methods, which",
      "// is why the package imports no runtime value from `fastify` and it stays a peer",
      "// dependency (ADR-0031).",
      "export function serveOn(name: string, server: ListeningServer): Component {",
      "  return serverComponent(name, server, { port: 0 });",
      "}",
      'export const ephemeral: Component = serveOn("a server on any port", publicServer);',
      "",
      "// A background loop of the consumer's own, in the same list as the framework's own",
      "// parts: a Component is two methods and a name, with no base type to extend and",
      "// nothing to register it with.",
      "const ownLoop: Component = {",
      '  name: "own loop",',
      '  start: async () => log.info({}, "the loop is running"),',
      '  stop: async () => log.info({}, "the loop has stopped"),',
      "};",
      "",
      "// The User Directory: constructed from the same Db, contributing one more",
      "// migration descriptor to the one call and one more plugin to the Agent server,",
      "// under a prefix the Operator chooses (ADR-0029).",
      "// The cost of a password derivation, named rather than defaulted, because a",
      "// digest carries the parameters it was written under and this one is only what",
      "// new ones get.",
      "const cost: ScryptParameters = { logN: 15, blockSize: 8, parallelism: 3 };",
      "const usersOptions: UsersOptions = { db, tokenTtl: 30 * 24 * 60 * 60 * 1000, scrypt: cost };",
      "export const users: Users = createUsers(usersOptions);",
      "export const usersDescriptor: MigrationDescriptor = usersMigrations;",
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
      "// by the constructor along with the migration descriptor (ADR-0032). The server",
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
      "// The HTTP Messenger: the Db, the User Directory its `user_id` references with a",
      "// foreign key, the Signal Worker a submission wakes, and **both** servers — all five",
      "// required, because a Messenger nobody can reach or nobody can answer through is",
      "// broken rather than smaller (ADR-0034). Written after the Directory because",
      "// construction order is registration order and this part's first migration references",
      "// the Directory's table (ADR-0036). The two server options are satisfied by what",
      "// `serverComponent` returned, as every other part's are.",
      "const messengerOptions: HttpMessengerOptions = {",
      "  db, users, worker, publicServer: publicComponent, agentServer: agentComponent,",
      "};",
      "// Annotated, and what it carries is two methods and no route plugin: the departure from",
      "// ADR-0032's door-out pattern that ADR-0034 states. `send` and `history` are used in",
      "// `useEverything` below, which is where the transaction split is visible.",
      "export const messenger: HttpMessenger = createHttpMessenger(messengerOptions);",
      "export const messagesDescriptor: MigrationDescriptor = httpMessagesMigrations;",
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
      "// What a `pi` deployment declares, which is an Agent Container and nothing else.",
      "// There is no configuration type on the `/pi` subpath any more: no model, no",
      "// provider and no container path, because the agent reads all of those out of a",
      "// `settings.json` the Operator mounts and a `Dockerfile` they build (ADR-0033).",
      "// The Mount Table comes from the package root, not from `/pi`: it knows nothing",
      "// about an Agent Implementation, and an entry may name a directory or a single",
      "// file and may be read-only — which is how the `AGENTS.md` below, and the",
      "// `settings.json` beside it, are protected from the agent that reads them",
      "// (ADR-0028).",
      'const workspace: Mount = { containerPath: "/workspace", gatewayPath: "/srv/saf/workspace" };',
      "const mounts: MountTable = {",
      "  entries: [",
      "    workspace,",
      '    { containerPath: "/home/agent/.pi/agent", gatewayPath: "/srv/saf/agent" },',
      '    { containerPath: "/workspace/AGENTS.md", gatewayPath: "/srv/saf/AGENTS.md", readOnly: true },',
      '    { containerPath: "/home/agent/.pi/agent/settings.json", gatewayPath: "/srv/saf/settings.json", readOnly: true },',
      "  ],",
      "};",
      "export const piMounts: ResolvedMountTable = resolveMountTable(mounts);",
      "export const piWorkspace: ResolvedMount | undefined = piMounts.entries[0];",
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
      "  // The descriptors registered here as well as by the parts that export them: this",
      "  // is what the pre-deploy migration entry point does, and the identical descriptor",
      "  // twice is one registration (ADR-0032).",
      "  db.registerMigrations(descriptor, usersDescriptor, messagesDescriptor);",
      "  await db.migrate();",
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
      "  // One call that starts every part that has something to run, and one that stops",
      "  // them in the reverse of the order given. The order is the consumer's own: the Db",
      "  // is first so that it stops last, the Agent server is before the Signal Worker",
      "  // because the agent calls it mid-Run, and the Public server is last so that",
      "  // submissions stop being accepted first. Nothing in the framework can know any of",
      "  // it (ADR-0031). The Signal Worker is in the list like everything else, so it has",
      "  // no lifecycle of the consumer's to remember.",
      "  const gateway = components([db, agentComponent, workerComponent, publicComponent, ownLoop]);",
      "  await gateway.start();",
      "  shipped.info(",
      "    { started: [db.name, agentComponent.name, worker.name, publicComponent.name, ephemeral.name], readSignal, readRun, states },",
      '    "the Gateway is up",',
      "  );",
      "  await gateway.stop();",
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
        "  { containerPath: '/workspace', gatewayPath: '/srv/saf/workspace' },",
        "  { containerPath: '/srv/saf/agent', gatewayPath: '/srv/saf/agent' },",
        "  { containerPath: '/workspace/AGENTS.md', gatewayPath: '/srv/saf/AGENTS.md', readOnly: true },",
        "] };",
        "const resolvedMounts = resolveMountTable(mounts);",
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
        // The User Directory, constructed as an Operator constructs it. `openDb`
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
        // itself (ADR-0034).
        "const messengerWorker = createSignalWorker({ db: scratch, runtime: { run: async () => ({ ok: true }) }, handlers: {} });",
        "const messenger = createHttpMessenger({ db: scratch, users: directory, worker: messengerWorker, publicServer: { fastify: Fastify() }, agentServer: { fastify: Fastify() } });",
        "const encoder = new TextEncoder();",
        "const settled = await plan.outcome((async function* () {",
        "  yield encoder.encode(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }) + '\\n');",
        "  yield encoder.encode(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
        "})());",
        // And the reader on its own, on a stream that says nothing, because naming the
        // Session in the failure is what the per-Run reader is for (ADR-0033).
        "const silent = await interpretPiOutput((async function* () {})(), 'user_7');",
        // Nothing writes anything: there is no call between composing and interpreting,
        // because the module that used to hold one is gone from the package, and the
        // composed command line names no file for the agent to read either — the
        // Operator's `AGENTS.md` above is a mount and `pi` discovers it (ADR-0025).
        "const built = [typeof openDb, typeof templateHandler, piCommand.command + ' ' + piCommand.args.slice(-6).join(' '), plan.args.join(' '), String(settled.ok), resolvedMounts.containerArguments()[1], composed.command + ' ' + composed.args.slice(-5).join(' '), composed.redactedArgs.join(' ').includes('sk-not-a-key') ? 'leaked' : 'redacted', piCommand.redactedArgs.join(' ').includes('sk-not-a-key') ? 'leaked' : 'redacted', String(['--model', '--provider', '--workdir', '--session-dir', '--append-system-prompt'].some((flag) => piCommand.args.includes(flag))), silent.error.split(' ').slice(0, 2).join(' '), String(Object.keys(pi).sort()), usersMigrations.schema, String(Object.keys(directory).sort()), httpMessagesMigrations.schema, String(Object.keys(messenger).sort()), messageReceivedKind];",
        "process.stdout.write(built.join(':'));",
      ].join("\n"),
    ],
    consumer,
  );
  assert.equal(
    imported,
    "function:function:docker saf/pi:latest --mode json --session-id user_42 --no-approve:--mode json --session-id user_42 --no-approve:true:type=bind,source=/srv/saf/workspace,target=/workspace:docker --entrypoint agent saf/agent:latest --session-id user_42:redacted:redacted:false:Session user_7:commandFor,run:saf_users:agentRoutes,create,get,issueToken,list,publicRoutes,requireUser,revoke,setAttributes,setPassword:saf_http_messages:history,send:message.received",
    "all four subpaths should resolve at runtime, the template Handler should load handlebars, the Mount Table should emit a bind mount, the Agent Container Runtime should compose a whole command line from the package root without starting anything — the entry point before the image and the agent's own arguments after it — and hide every environment value in the loggable copy, the pi Runtime should construct from an image and its mounts alone and compose a line carrying its own three flags and no model, provider or container path, its one function should produce that plan and read an outcome from it, its reader should name the Session in a failure, and the User Directory should construct into its own schema with its routes, its preHandler and its seven operations — the three of them the agent's surface has no route for included — and the HTTP Messenger should construct into a schema of its own from all five of its required arguments and answer with an object carrying exactly its two trusted-code methods, because every other capability it has is a route it registered itself",
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
      'import { createSignalWorker, openDb, signalsMigrations } from "shared-agent-framework";',
      'import { createUsers, usersMigrations } from "shared-agent-framework/users";',
      'import { createHttpMessenger, httpMessagesMigrations } from "shared-agent-framework/http-messenger";',
      'import Fastify from "fastify";',
      "",
      "const db = openDb(process.argv[2]);",
      "// Both servers, constructed before the parts because the HTTP Messenger requires them",
      "// at construction and registers itself on them there (ADR-0032, ADR-0034). The User",
      "// Directory's own two plugins go up by hand further down, which is what proves those",
      "// stay exported and that its server options are defaults rather than policy.",
      "const agentServer = Fastify();",
      "const publicServer = Fastify();",
      "// Never started, so the empty Handler map is honest: nothing here processes a",
      "// Signal. Constructing it is what registers the Signal Worker's own migration",
      "// descriptor with the Db.",
      "const worker = createSignalWorker({ db, runtime: { run: async () => ({ ok: true }) }, handlers: {} });",
      "// A cost no deployment should use, because this proves the folder applied and",
      "// not that scrypt is slow. Constructed with no servers at all, which is how a",
      "// deployment switches both route groups off, and its two plugins are registered",
      "// by hand below instead.",
      "const users = createUsers({ db, tokenTtl: 60_000, scrypt: { logN: 12, blockSize: 8, parallelism: 1 } });",
      "// The HTTP Messenger, constructed **after** the Directory, which is what makes its",
      "// folder apply after `migrations/users`: registration order is construction order, and",
      "// its first migration references `saf_users.users` (ADR-0036). Nothing is held: it",
      "// exports no plugin, and it put its own routes at `/messages` on both servers above.",
      "createHttpMessenger({ db, users, worker, publicServer: { fastify: publicServer }, agentServer: { fastify: agentServer } });",
      "try {",
      "  // Both descriptors registered explicitly, as a pre-deploy migration entry point",
      "  // does — each for the second time, since constructing a part is what registers",
      "  // its own, and an identical descriptor twice is one registration and not two.",
      "  // The exported descriptors are why that entry point need construct nothing at",
      "  // all (ADR-0032).",
      "  db.registerMigrations(signalsMigrations, usersMigrations, httpMessagesMigrations);",
      "  await db.migrate();",
      "  // And started, which is what proves each shipped folder's `meta/_journal.json`",
      "  // resolves from inside the installed package: `start` reads one per registered",
      "  // descriptor and refuses to start against a schema behind it.",
      "  await db.start();",
      "  // Emitting and admitting are what prove both folders resolved and their",
      "  // statements actually ran: neither row has anywhere to go otherwise. The",
      "  // worker is never started, so nothing processes the Signal.",
      '  const id = await db.tx((tx) => worker.emit(tx, { kind: "probe", payload: {} }));',
      "  const user = await db.tx((tx) => users.create(tx));",
      "  // And a login, which is what proves the User Directory's *second* migration",
      "  // applied: a Token has nowhere to be written otherwise. It goes over the two",
      "  // plugins on two servers, registered by hand under the same prefixes the",
      "  // constructor would have used — which is what proves both stay exported and",
      "  // that the default is a default rather than a policy (ADR-0032).",
      '  await agentServer.register(users.agentRoutes, { prefix: "/users" });',
      '  await publicServer.register(users.publicRoutes, { prefix: "/auth" });',
      '  const admitted = await agentServer.inject({ method: "POST", url: "/users", payload: { password: "a long enough password" } });',
      '  const issued = await publicServer.inject({ method: "POST", url: "/auth/tokens", payload: { user: admitted.json().id, password: "a long enough password" } });',
      '  const refused = await publicServer.inject({ method: "POST", url: "/auth/tokens", payload: { user: admitted.json().id, password: "not it" } });',
      "  // And the Token presented back, which is the shipped preHandler running from",
      "  // the installed package: it reads the header, looks the Token up, and puts the",
      "  // User on the request for `GET /me` to answer with.",
      '  const me = await publicServer.inject({ method: "GET", url: "/auth/me", headers: { authorization: "Bearer " + issued.json().token } });',
      '  const anonymous = await publicServer.inject({ method: "GET", url: "/auth/me" });',
      "  // And the Token revoked, which is the only mechanism by which a credential",
      "  // stops working before it expires: nothing removes a User (ADR-0029). The row",
      "  // is deleted, so the statement reaching the shipped table is what makes the",
      "  // next `GET /me` a 401.",
      '  const out = await publicServer.inject({ method: "DELETE", url: "/auth/tokens/current", headers: { authorization: "Bearer " + issued.json().token } });',
      '  const afterwards = await publicServer.inject({ method: "GET", url: "/auth/me", headers: { authorization: "Bearer " + issued.json().token } });',
      "  // And the OIDC path, which is the substitute for a pluggable Authenticator",
      "  // (ADR-0030), run from inside the installed package: a User with no password at",
      "  // all is refused every login, and a Token minted for them by trusted code",
      "  // authenticates a request anyway. Their Attributes come from trusted code too,",
      "  // which is the one thing the Agent server has no route for.",
      "  const oidcUser = await db.tx((tx) => users.create(tx));",
      '  await db.tx((tx) => users.setAttributes(tx, oidcUser.id, { via: "oidc" }));',
      '  const noPassword = await publicServer.inject({ method: "POST", url: "/auth/tokens", payload: { user: oidcUser.id, password: "anything at all" } });',
      "  const minted = await db.tx((tx) => users.issueToken(tx, oidcUser.id));",
      '  const asOidc = await publicServer.inject({ method: "GET", url: "/auth/me", headers: { authorization: "Bearer " + minted.token } });',
      "  // And the HTTP Messenger's folder, which is the one this check exists twice over for:",
      "  // the agent sends a Message to the User admitted above and gets 201 with `seq` 1, and",
      "  // sends one to a well-formed uuid naming nobody and gets **404**. That 404 is the",
      "  // hand-edited foreign key onto `saf_users.users` doing its job, and it is the only",
      "  // proof anywhere that the constraint actually shipped: `drizzle-kit` cannot generate",
      "  // it, so a regeneration that dropped it would leave every other check passing",
      "  // (ADR-0036). The read back over the same plugin is what proves the row was written",
      "  // into the shipped table rather than only accepted.",
      '  const said = await agentServer.inject({ method: "POST", url: "/messages", payload: { userId: admitted.json().id, text: "the deploy finished" } });',
      '  const misaddressed = await agentServer.inject({ method: "POST", url: "/messages", payload: { userId: "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21", text: "nobody would ever read this" } });',
      '  const conversation = await agentServer.inject({ method: "GET", url: "/messages?user=" + admitted.json().id });',
      "  const applied =",
      "    id.length === 36 &&",
      "    user.id.length === 36 &&",
      '    JSON.stringify(user.attributes) === "{}" &&',
      "    admitted.statusCode === 201 &&",
      "    issued.statusCode === 201 &&",
      '    issued.json().token.startsWith("saf_") &&',
      "    Date.parse(issued.json().expiresAt) > Date.now() &&",
      "    refused.statusCode === 401 &&",
      "    me.statusCode === 200 &&",
      "    me.json().id === admitted.json().id &&",
      "    anonymous.statusCode === 401 &&",
      "    out.statusCode === 204 &&",
      "    afterwards.statusCode === 401 &&",
      "    noPassword.statusCode === 401 &&",
      '    minted.token.startsWith("saf_") &&',
      "    asOidc.statusCode === 200 &&",
      "    asOidc.json().id === oidcUser.id &&",
      '    JSON.stringify(asOidc.json().attributes) === JSON.stringify({ via: "oidc" }) &&',
      "    said.statusCode === 201 &&",
      "    said.json().seq === 1 &&",
      '    said.json().direction === "outbound" &&',
      '    said.json().text === "the deploy finished" &&',
      "    misaddressed.statusCode === 404 &&",
      "    conversation.statusCode === 200 &&",
      "    conversation.json().messages.length === 1 &&",
      "    conversation.json().messages[0].id === said.json().id;",
      '  process.stdout.write(applied ? "applied" : "unexpected " + id + " " + JSON.stringify(user) + " " + issued.statusCode + " " + issued.body + " " + refused.statusCode + " " + me.statusCode + " " + me.body + " " + anonymous.statusCode + " " + out.statusCode + " " + afterwards.statusCode + " " + noPassword.statusCode + " " + asOidc.statusCode + " " + asOidc.body + " " + said.statusCode + " " + said.body + " " + misaddressed.statusCode + " " + conversation.body);',
      "} finally {",
      "  await db.stop();",
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
