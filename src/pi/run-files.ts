/**
 * Writing the agent's configuration, before every Run.
 *
 * Rewritten rather than persisted, with ordinary file writes, because the agent's
 * directory is a plain directory. Combined with prompt injection being an accepted
 * risk ([ADR-0003](../../docs/adr/0003-prompt-injection-is-an-accepted-risk.md)) this
 * is what makes a successful injection unable to *durably* reconfigure the agent:
 * every Run restores the configuration from the Operator's entry point, which is the
 * artifact under version control. The cost, accepted rather than overlooked, is that
 * the agent cannot keep its own settings changes — a `/model` switch lasts one Run
 * (ADR-0025).
 *
 * Only these three files are touched. Everything else in the directory is the agent's
 * and survives: `auth.json` with the OAuth tokens it refreshes mid-Run, `trust.json`,
 * whatever it installed under `bin/`.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type OpaqueJson,
  type PiConfiguration,
  type ResolvedPiConfiguration,
  resolvePiConfiguration,
} from "./configuration.ts";
import { instructionsFileName } from "./invocation.ts";

/**
 * Writes the agent's configuration for the Run that is about to start.
 *
 * Every file is written whole, so a key the Operator removed from their configuration
 * is gone rather than merged forward from last time — the same reason the files are
 * written at all.
 *
 * No directory is created here, or anywhere else in the framework: every directory a
 * mount points at is the Operator's to create
 * ([ADR-0028](../../docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)),
 * and this write is one of the places a missing one surfaces, as `ENOENT` on the file.
 * Nothing about a Session is prepared either — the Agent Runtime creates each Session's
 * own directory itself, inside the container and into the mounted Session root, as the
 * Gateway's own uid
 * ([ADR-0025](../../docs/adr/0025-the-pi-adapter-spawns-one-confined-process-per-run.md)).
 */
export async function writeRunConfiguration(config: PiConfiguration): Promise<void> {
  const resolved = resolvePiConfiguration(config);
  const agentDir = resolved.agentDir.localPath;

  await Promise.all([
    writeJson(path.join(agentDir, "settings.json"), resolved.settings),
    writeJson(path.join(agentDir, "models.json"), resolved.models),
    writeFile(path.join(agentDir, instructionsFileName), instructionsFor(resolved), "utf8"),
  ]);
}

async function writeJson(file: string, value: OpaqueJson): Promise<void> {
  // Indented, because an Operator diagnosing a Run reads this file, and `pi` does not
  // care either way. Written as given: the framework does not interpret it (ADR-0016).
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * The instructions file: the Operator's own words, then how to reach the Gateway.
 *
 * The second half is the framework's and not the Operator's to remember.
 * [ADR-0010](../../docs/adr/0010-the-agent-reaches-the-gateway-over-http.md) has the
 * agent reach the Gateway over HTTP rather than through injected tools, and `pi` ships
 * no HTTP client — so this text, plus its `bash` tool and `curl`, *is* the binding.
 * Described here rather than left to each deployment because the routes are the
 * Core's, and an agent told nothing about them cannot ask.
 */
function instructionsFor(config: ResolvedPiConfiguration): string {
  const base = config.agentServerUrl;
  return `${config.instructions === undefined ? "" : `${config.instructions.replace(/\n*$/, "")}\n\n`}\
# The Gateway's Agent server

You are running inside a Gateway that mediates every interaction into and out of you.
It exposes an HTTP API to you and to nothing else, at \`${base}\`. Reach it with
\`curl\` from your shell tool. It takes **no credential**: reaching it is access.

| Request | Answers |
| --- | --- |
| \`GET ${base}/signals?limit=&kind=\` | \`{ "signals": [...] }\`, newest first |
| \`GET ${base}/signals/<id>\` | one Signal, or 404 |
| \`GET ${base}/runs?limit=&signalId=\` | \`{ "runs": [...] }\`, newest first |
| \`GET ${base}/runs/<id>\` | one Run, or 404 |

A **Signal** is something that arrived from outside and may cause you to act:
\`{ id, kind, payload, emittedAt, state, error }\`, where \`payload\` is whatever the
part that emitted it wrote. A **Run** is one execution of you:
\`{ id, signalId, session, prompt, state, error, startedAt, endedAt }\`. The Run you
are executing right now is among them, and so is its Signal.

These reads are **not scoped**: you see every Signal and every Run, not only the ones
belonging to this conversation. \`limit\` has a default and a maximum, and asking for
more than the maximum is refused rather than quietly reduced. An unknown query
parameter is refused too — there is no parameter that narrows a read to one Session or
one user.

You can read this API and nothing else of the Gateway's. You cannot reach the Store —
the Gateway's own persistent state — and there is no route here that writes anything.

For example, to see what has arrived recently:

\`\`\`sh
curl -s "${base}/signals?limit=5"
\`\`\`
`;
}
