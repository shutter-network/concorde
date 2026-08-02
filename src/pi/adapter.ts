/**
 * The `pi` Runtime: one fresh container per Run.
 *
 * This is where the pieces around it are finally used, in the one order that works:
 * **compose, start, interpret.** Composing settles the Session name and the argv; the
 * container is started with it; and the outcome is read from the stream it produces.
 * There is no fourth step, and in particular nothing is written to a disk: what the
 * agent reads is what the Operator placed in the directories they mounted, and this
 * module opens no file at all (ADR-0025).
 *
 * A container rather than this process, and that is the load-bearing decision here
 * ([ADR-0025](../../docs/adr/0025-the-pi-adapter-spawns-one-confined-process-per-run.md)):
 * `pi`'s shell tool hands its child `{ ...process.env }`, so an in-process agent
 * would hold the Gateway's `DATABASE_URL` and could write to every table directly.
 * That would make [ADR-0010](../../docs/adr/0010-the-agent-reaches-the-gateway-over-http.md)
 * decorative and widen [ADR-0011](../../docs/adr/0011-the-agent-has-full-read-access.md)'s
 * blast radius from "what the read API exposes" to the whole Db, read and write.
 * Only what `env` names reaches the agent's container.
 *
 * Two things this module refuses to read as an outcome, both of which look like the
 * obvious thing to do:
 *
 *  - **the exit code.** `pi --mode json` exits 0 on model and API errors, so it says
 *    nothing about whether the Run succeeded. `interpretPiOutput` is not even given
 *    it. It appears in the message of a failure decided elsewhere, and nowhere else.
 *  - **stderr.** `pi` warns there about the Session it is creating, the first time a
 *    Session is used, and exits 0. Reading stderr as failure would fail every first
 *    Run of every named Session.
 */

import { runContainer } from "../container/process.ts";
import { defaultLogger, type Logger } from "../logging.ts";
import type { Prompt } from "../signals/handlers.ts";
import type { RunOutcome, Runtime } from "../signals/runtime.ts";
import { type PiConfiguration, resolvePiConfiguration } from "./configuration.ts";
import { composeInvocation } from "./invocation.ts";
import { interpretPiOutput } from "./output.ts";

/**
 * Everything the adapter is constructed with: the agent's configuration, plus the
 * framework's logging seam.
 *
 * One flat object rather than a configuration nested inside options, so that changing
 * the model is a one-line edit in an entry point and the fields an Operator varies are
 * all at the same depth. `logger` is the framework's and every other part takes it the
 * same way; the rest is `pi`-shaped on purpose (ADR-0016).
 */
export type PiAdapterOptions = PiConfiguration & {
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
};

/**
 * Builds the adapter, refusing a configuration that cannot work.
 *
 * A plain Runtime and nothing more: there is no second call to remember and no
 * adapter-specific type to hold it in. Nothing here touches a filesystem — not at
 * construction and not during a Run — and nothing starts a container before a Run does,
 * so whether the directories an Operator declared really reach the agent is not a
 * question this process asks
 * ([ADR-0028](../../docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)).
 *
 * What settles that is the container runtime, at the first Run: every entry is emitted
 * as `--mount type=bind`, and the daemon refuses a bind source that is not there, naming
 * the path. So a typo costs one permanently dead Signal with a readable message, rather
 * than a `root`-owned empty directory the agent reads happily.
 *
 * What *is* refused here is a configuration that cannot mean what it says — a relative
 * path, an empty Mount Table — and it is refused here rather than at the first Signal
 * because a Run that fails is never retried (ADR-0017): otherwise every Signal the
 * deployment ever receives becomes a permanently failed Run.
 */
export function createPiAdapter(options: PiAdapterOptions): Runtime {
  const log = options.logger ?? defaultLogger();
  // Called for its throwing, and the resolved value deliberately dropped: nothing here
  // holds one, because composing a Run's invocation resolves the options again. That
  // repetition is the point — it is pure and a handful of string checks, and one
  // resolution kept in a closure beside another computed per Run is how the two come to
  // disagree. What this call buys is the *when*: a bad deployment refused where the
  // Operator wrote it rather than at its first Signal.
  resolvePiConfiguration(options);

  return {
    async run(prompt: Prompt, runId: string): Promise<RunOutcome> {
      const invocation = composeInvocation(options, prompt, runId);

      log.debug(
        {
          runId,
          session: invocation.session,
          command: invocation.command,
          // `redactedArgs`, never `args`: the invocation carries whatever `env` holds,
          // which is where a provider API key goes. This is the log line story 50 asks
          // for — the one a mount or network problem is diagnosed from — so it must be
          // safe to have in a log file.
          args: invocation.redactedArgs,
        },
        "starting the agent's container",
      );

      const result = await runContainer(invocation, interpretPiOutput);
      // One line, carrying the two things nothing else records: the exit status, which
      // is not the outcome and is not otherwise written down anywhere, and stderr,
      // where the first Run of a named Session warns that it is creating the Session.
      const ended = { runId, exitCode: result.exitCode, signal: result.signal };
      log.debug(
        result.stderr === "" ? ended : { ...ended, stderr: result.stderr },
        "the agent's container is gone",
      );

      if (result.value.ok) {
        if (result.exitCode !== 0) {
          // Not a failure — the stream said the agent answered, and the stream is what
          // decides. Said out loud because it is a combination `pi` should not produce,
          // and the alternative is nobody ever knowing it happened.
          log.warn(
            ended,
            "the agent's container reported a successful Run and then exited non-zero",
          );
        }
        return result.value;
      }

      return { ok: false, error: [result.value.error, ...diagnosis(result)].join(" ") };
    },
  };
}

/**
 * What to add to a failure the stream already decided on.
 *
 * The exit code and stderr are diagnosis, and only ever reach a message that was
 * already going to say the Run failed. This is the difference between "the Agent
 * Implementation produced no output at all" and that plus "exit code 125: Unable to find
 * image", which is the whole of what an Operator needs to fix it — and the Run's
 * `error` column is the only place they will look.
 */
function diagnosis(result: {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}): string[] {
  const notes: string[] = [];
  if (result.signal !== null) {
    notes.push(`The container was killed by ${result.signal}.`);
  } else if (result.exitCode !== 0) {
    notes.push(`The container exited with code ${result.exitCode}.`);
  }
  if (result.stderr !== "") notes.push(`Its stderr said: ${result.stderr.trim()}`);
  return notes;
}
