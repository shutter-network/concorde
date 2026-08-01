/**
 * The agent's configuration on disk, written before every Run.
 *
 * Real files in a temporary directory rather than a mocked filesystem: the claim being
 * tested is what a directory contains afterwards, and the agent's directory is an
 * ordinary directory precisely so that ordinary writes are all this takes.
 *
 * The load-bearing assertion in here is the one that looks least interesting: that a
 * file which already existed is *replaced* rather than merged. A merge would leave a
 * setting the agent changed in place, and rewriting the configuration every Run is
 * what makes a successful prompt injection unable to reconfigure the agent durably
 * (ADR-0003, ADR-0025). Nothing about a merge looks wrong in a log.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { PiConfiguration } from "./configuration.ts";
import { composeInvocation, instructionsFileName } from "./invocation.ts";
import { writeRunConfiguration } from "./run-files.ts";

type Directories = {
  readonly config: PiConfiguration;
  readonly agentDir: string;
  readonly sessionRoot: string;
};

/** A configuration over three fresh directories, cleaned up with the test. */
async function directories(
  t: TestContext,
  extra: Partial<PiConfiguration> = {},
): Promise<Directories> {
  const root = await mkdtemp(path.join(tmpdir(), "saf-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const sessionRoot = path.join(root, "sessions");
  return {
    agentDir,
    sessionRoot,
    config: {
      image: "saf/pi:latest",
      model: "anthropic/claude-sonnet-4-5",
      workspace: path.join(root, "workspace"),
      agentDir: { localPath: agentDir, agentPath: "/home/agent/.pi/agent" },
      sessionRoot: { localPath: sessionRoot, agentPath: "/sessions" },
      agentServerUrl: "http://host.docker.internal:7411",
      ...extra,
    },
  };
}

/**
 * Writes the configuration for a Run in `session`.
 *
 * Through `composeInvocation`, because that is the only way to obtain an invocation and
 * the ordering the adapter uses: compose, write, start.
 */
async function writeFor(config: PiConfiguration, session: string): Promise<void> {
  const invocation = composeInvocation(config, { session, text: "what happened?" }, "r1");
  await writeRunConfiguration(config, invocation);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

async function isDirectory(at: string): Promise<boolean> {
  return (await stat(at)).isDirectory();
}

describe("the configuration written before a Run", () => {
  it("writes the settings, the custom models, and the instructions", async (t) => {
    const { config, agentDir } = await directories(t, {
      settings: { defaultProjectTrust: "never", compaction: { enabled: true } },
      models: { providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } },
    });

    await writeFor(config, "user_42");

    assert.deepEqual(await readJson(path.join(agentDir, "settings.json")), {
      defaultProjectTrust: "never",
      compaction: { enabled: true },
    });
    assert.deepEqual(await readJson(path.join(agentDir, "models.json")), {
      providers: { ollama: { baseUrl: "http://localhost:11434/v1" } },
    });
    assert.ok((await readFile(path.join(agentDir, instructionsFileName), "utf8")).length > 0);
  });

  it("writes them even when the Operator configured none, so nothing carries over", async (t) => {
    const { config, agentDir } = await directories(t);

    await writeFor(config, "user_42");

    assert.deepEqual(await readJson(path.join(agentDir, "settings.json")), {});
    assert.deepEqual(await readJson(path.join(agentDir, "models.json")), {});
  });

  it("creates the agent's directory if it is not there yet", async (t) => {
    const { config, agentDir } = await directories(t);

    await writeFor(config, "user_42");

    assert.ok(await isDirectory(agentDir));
  });

  it("replaces what is already there rather than merging into it", async (t) => {
    const { config, agentDir } = await directories(t, { settings: { theme: "dark" } });
    await mkdir(agentDir, { recursive: true });
    // What the agent left behind: a `/model` switch it made last Run, and a provider it
    // added to the models file.
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ theme: "light", defaultModel: "something-cheaper" }),
      "utf8",
    );
    await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }), "utf8");
    await writeFile(path.join(agentDir, instructionsFileName), "instructions of its own", "utf8");

    await writeFor(config, "user_42");

    assert.deepEqual(
      await readJson(path.join(agentDir, "settings.json")),
      { theme: "dark" },
      "a key the Operator never wrote must not survive the Run that follows",
    );
    assert.deepEqual(await readJson(path.join(agentDir, "models.json")), {});
    assert.ok(
      !(await readFile(path.join(agentDir, instructionsFileName), "utf8")).includes(
        "instructions of its own",
      ),
    );
  });

  it("leaves everything else in the agent's directory alone", async (t) => {
    const { config, agentDir } = await directories(t);
    await mkdir(path.join(agentDir, "bin"), { recursive: true });
    // The credentials, whose OAuth tokens refresh during a Run, and the trust
    // decisions. Both are the agent's and must survive (ADR-0025).
    await writeFile(path.join(agentDir, "auth.json"), '{"anthropic":{"refresh":"kept"}}', "utf8");
    await writeFile(path.join(agentDir, "trust.json"), '{"/workspace":"never"}', "utf8");
    await writeFile(path.join(agentDir, "bin", "rg"), "a binary it installed", "utf8");

    await writeFor(config, "user_42");

    assert.equal(
      await readFile(path.join(agentDir, "auth.json"), "utf8"),
      '{"anthropic":{"refresh":"kept"}}',
    );
    assert.equal(
      await readFile(path.join(agentDir, "trust.json"), "utf8"),
      '{"/workspace":"never"}',
    );
    assert.equal(await readFile(path.join(agentDir, "bin", "rg"), "utf8"), "a binary it installed");
    assert.deepEqual((await readdir(agentDir)).toSorted(), [
      "auth.json",
      "bin",
      instructionsFileName,
      "models.json",
      "settings.json",
      "trust.json",
    ]);
  });

  it("does not create the Workspace, which is the Operator's", async (t) => {
    const { config } = await directories(t);

    await writeFor(config, "user_42");

    // A Gateway that conjured the Workspace would hide a wrong mount rather than let
    // the startup check find it (ADR-0025).
    await assert.rejects(() => stat(String(config.workspace)), /ENOENT/);
  });
});

describe("the Session's directory", () => {
  it("is created under the Session root, one per Session", async (t) => {
    const { config, sessionRoot } = await directories(t);

    await writeFor(config, "user_42");
    await writeFor(config, "user_7");

    assert.ok(await isDirectory(path.join(sessionRoot, "user_42")));
    assert.ok(await isDirectory(path.join(sessionRoot, "user_7")));
    assert.deepEqual((await readdir(sessionRoot)).toSorted(), ["user_42", "user_7"]);
  });

  it("is left alone when it already holds a Session, so a named Session resumes", async (t) => {
    const { config, sessionRoot } = await directories(t);
    const directory = path.join(sessionRoot, "user_42");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "2026-01-01_user_42.jsonl"), "the first Run\n", "utf8");

    await writeFor(config, "user_42");

    assert.equal(
      await readFile(path.join(directory, "2026-01-01_user_42.jsonl"), "utf8"),
      "the first Run\n",
    );
  });
});

/**
 * What the agent is told about the Gateway.
 *
 * ADR-0010 has the agent reach the Gateway over HTTP rather than through injected
 * tools, and `pi` ships no HTTP client — so this file plus `curl` *is* the binding.
 * An agent that is not told the base URL cannot ask, and there is nowhere else the
 * framework could say it.
 */
describe("the instructions file", () => {
  async function instructions(
    t: TestContext,
    extra: Partial<PiConfiguration> = {},
  ): Promise<string> {
    const { config, agentDir } = await directories(t, extra);
    await writeFor(config, "user_42");
    return readFile(path.join(agentDir, instructionsFileName), "utf8");
  }

  it("carries the Operator's own instructions first, unaltered", async (t) => {
    const own = "You are the shared assistant of a book club.\nBe brief. Use *emphasis* & <tags>.";
    const text = await instructions(t, { instructions: own });

    assert.ok(text.startsWith(own), `the Operator's instructions should come first: ${text}`);
  });

  it("describes the Agent server's read API against the URL the agent can reach", async (t) => {
    const text = await instructions(t, { agentServerUrl: "http://gateway:7411/" });

    for (const line of [
      "GET http://gateway:7411/signals",
      "GET http://gateway:7411/runs",
      'curl -s "http://gateway:7411/signals?limit=5"',
    ]) {
      assert.ok(
        text.includes(line),
        `the instructions should describe ${line}; they were:\n${text}`,
      );
    }
    assert.ok(!text.includes("7411//"), "the base URL should have had its trailing slash dropped");
  });

  it("says the read is unauthenticated and unscoped, which are both true and both surprising", async (t) => {
    const text = await instructions(t);

    // ADR-0010: reaching the port is access. ADR-0011: the agent may read every Signal
    // and every Run, so an agent told otherwise would decline to look.
    assert.match(text, /no credential/i);
    assert.match(text, /not scoped/i);
  });

  it("is written even when the Operator supplied no instructions of their own", async (t) => {
    const text = await instructions(t);

    assert.ok(text.includes("/signals"), "the Agent server is the framework's to describe");
  });
});
