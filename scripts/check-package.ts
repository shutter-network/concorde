/**
 * Verifies the packaging claims that only a real tarball can settle:
 *
 *  - every folder under `migrations/` ships, `.sql` files and
 *    `meta/_journal.json` alike. A missing `files` entry fails at an Operator's
 *    runtime rather than in our CI, and the migrator will not run on SQL alone
 *    (ADR-0022).
 *  - the tarball installs into a fresh project.
 *  - the root and `/pi` subpaths resolve there, both to the type checker and to
 *    Node at runtime.
 *  - `/messenger` is reserved: it is declared and deliberately unresolvable,
 *    rather than absent by omission.
 *
 * Run with `npm run check:package`. Deliberately not part of `npm run check`:
 * it installs from the registry, so it is far slower than the inner loop should
 * be, and it would make the inner loop need the network.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsRoot = path.join(repoRoot, "migrations");

/** The consumer's imports, spelled once: the type checker and Node see the same two. */
const consumerImports = [
  'import { scaffoldCheck } from "shared-agent-framework";',
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
  ]) {
    assert.ok(entries.has(file), `the tarball should ship ${file}`);
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
  run("npm", ["install", "--no-audit", "--no-fund", tarball], consumer);

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
          types: [],
          strict: true,
          // The shipped declarations are the thing under test, so they are
          // checked rather than skipped.
          skipLibCheck: false,
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
      "",
      "// Annotated, so a declaration that resolved to `any` would fail here.",
      'export const fromRoot: "ok" = scaffoldCheck();',
      'export const fromPi: "ok" = piScaffoldCheck();',
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
      [...consumerImports, 'process.stdout.write(scaffoldCheck() + ":" + piScaffoldCheck());'].join(
        "\n",
      ),
    ],
    consumer,
  );
  assert.equal(imported, "ok:ok", "both subpaths should resolve at runtime");

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
