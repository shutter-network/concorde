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
import { instructionsFileName } from "./invocation.ts";
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
  // The Operator's job now, not the framework's (ADR-0028). Only this one: the
  // assertions below are that nothing here conjures the Workspace or the Session root.
  await mkdir(agentDir, { recursive: true });
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

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

describe("the configuration written before a Run", () => {
  it("writes the settings, the custom models, and the instructions", async (t) => {
    const { config, agentDir } = await directories(t, {
      settings: { defaultProjectTrust: "never", compaction: { enabled: true } },
      models: { providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } },
    });

    await writeRunConfiguration(config);

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

    await writeRunConfiguration(config);

    assert.deepEqual(await readJson(path.join(agentDir, "settings.json")), {});
    assert.deepEqual(await readJson(path.join(agentDir, "models.json")), {});
  });

  it("creates no directory, so a missing agent directory fails rather than appearing", async (t) => {
    // The framework creates nothing on disk (ADR-0028). An Operator who declared a
    // directory they never made meets that here rather than in an empty mount.
    const { config, agentDir } = await directories(t);
    await rm(agentDir, { recursive: true, force: true });

    await assert.rejects(() => writeRunConfiguration(config), /ENOENT/);
    await assert.rejects(() => stat(agentDir), /ENOENT/);
  });

  it("replaces what is already there rather than merging into it", async (t) => {
    const { config, agentDir } = await directories(t, { settings: { theme: "dark" } });
    // What the agent left behind: a `/model` switch it made last Run, and a provider it
    // added to the models file.
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ theme: "light", defaultModel: "something-cheaper" }),
      "utf8",
    );
    await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }), "utf8");
    await writeFile(path.join(agentDir, instructionsFileName), "instructions of its own", "utf8");

    await writeRunConfiguration(config);

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

    await writeRunConfiguration(config);

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

    await writeRunConfiguration(config);

    // The Workspace is the Operator's, and so now is every other directory a mount
    // points at: the framework creates none of them (ADR-0028).
    await assert.rejects(() => stat(String(config.workspace)), /ENOENT/);
  });
});

describe("the Session's directory", () => {
  it("is not created here: the Agent Runtime makes it, inside the container", async (t) => {
    const { config, sessionRoot } = await directories(t);

    await writeRunConfiguration(config);

    // Not the Session root either, which is the Operator's to create (ADR-0028).
    // Asserting on the root rather than on the Session's own directory inside it,
    // because a `recursive` mkdir of the second is what used to create the first, and
    // that side effect is the part worth being sure has gone.
    await assert.rejects(() => stat(sessionRoot), /ENOENT/);
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
    await writeRunConfiguration(config);
    return readFile(path.join(agentDir, instructionsFileName), "utf8");
  }

  it("carries the Operator's own instructions first, unaltered", async (t) => {
    const own = "You are the shared assistant of a book club.\nBe brief. Use *emphasis* & <tags>.";
    const text = await instructions(t, { instructions: own });

    assert.ok(text.startsWith(own), `the Operator's instructions should come first: ${text}`);
  });

  it("describes the Agent server's read API against the URL the agent can reach", async (t) => {
    const text = await instructions(t, { agentServerUrl: "http://gateway:7411" });

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
  });

  it("writes that URL byte for byte, trailing slash and all", async (t) => {
    // Deliberately not normalised. The framework does not interpret the agent's
    // configuration (ADR-0016), and this value is configuration like any other, so it
    // reaches the agent exactly as the Operator wrote it. The cost is accepted and worth
    // stating: a trailing slash produces the double-slashed paths asserted here, which
    // the router will not match, so the agent's reads 404 and — since nothing is retried
    // (ADR-0017) — each affected Run fails permanently. What the Operator sees is the
    // agent saying it cannot reach the Gateway, which points at the value they wrote.
    const text = await instructions(t, { agentServerUrl: "http://gateway:7411/" });

    // Every occurrence, not one: the base is interpolated into the prose, the four table
    // rows and the worked example, and a normalisation anywhere is a normalisation.
    assert.ok(
      !text.includes("http://gateway:7411/signals") && !text.includes("http://gateway:7411/runs"),
      `no occurrence should have lost the trailing slash; the instructions were:\n${text}`,
    );
    for (const line of [
      "GET http://gateway:7411//signals",
      "GET http://gateway:7411//runs",
      'curl -s "http://gateway:7411//signals?limit=5"',
    ]) {
      assert.ok(text.includes(line), `the trailing slash should survive into ${line}`);
    }
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
