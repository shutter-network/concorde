/**
 * Everything the client learns before it makes a request, read out of one argument and two
 * environment variables.
 *
 * The User id is the argument and not a variable, because it is the one thing that changes per
 * invocation: one container is one person, and two terminals against one Gateway are two people.
 * The password is a variable and not a second argument, because an argument is in the process list
 * of every other process on the host.
 *
 * A refusal is a value rather than a thrown error, so the caller decides the exit code and the
 * stream. Nothing here reads `process`: both sources arrive as parameters, which is what lets a
 * test state an environment instead of mutating the one it runs in.
 */

/** Where the Public server listens. */
export const gatewayUrlVariable = "CONCORDE_GATEWAY_URL";

/** The password of the User named by the argument. */
export const passwordVariable = "CONCORDE_PASSWORD";

/**
 * Where a Gateway started from the framework's own examples listens.
 *
 * A default for the URL and none for the password: a wrong URL answers nothing and is obvious,
 * and a default password would be a credential this client invented.
 */
export const defaultGatewayUrl = "http://localhost:8080";

/** What a run needs: where to talk, who to be, and what proves it. */
export type ClientConfig = {
  readonly baseUrl: string;
  readonly user: string;
  readonly password: string;
};

/** What the command line asked for: a session, the usage text, or a refusal that names the fault. */
export type Invocation =
  | { readonly kind: "run"; readonly config: ClientConfig }
  | { readonly kind: "help" }
  | { readonly kind: "refused"; readonly reason: string };

export const usage = `Usage: http-client-tui <user-id>

A line-oriented client for the HTTP Channel of a Concorde Gateway. It logs in as the
User whose id is given, prints that User's Message log, and asks for more once a second.
A line you type is submitted as a Message, and the agent's answer arrives on the log.

Arguments:
  <user-id>  The User to be. Whoever admitted that User was told the id.

Environment:
  ${gatewayUrlVariable}  Where the Public server listens. Defaults to ${defaultGatewayUrl}.
  ${passwordVariable}     The password of that User. There is no default and no prompt.

It reads and writes one User's own Message log and nothing else. Decisions, Schedules and
every other surface of a Gateway are reached with another tool.`;

function refused(reason: string): Invocation {
  return { kind: "refused", reason };
}

/**
 * Reads one User id and two variables, or says why it cannot.
 *
 * `argv` is the arguments after the program name, and `env` is a copy of the environment. An
 * empty variable counts as unset, because that is what an unfilled line in a `.env` file
 * produces and a run against an empty password would fail at the login with a worse message.
 */
export function readInvocation(
  argv: readonly string[],
  env: Readonly<Partial<Record<string, string>>>,
): Invocation {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };

  const [user, ...extra] = argv;
  if (user === undefined) return refused("no User id was written, and it is the one argument.");
  if (user.startsWith("-")) {
    return refused(`${user} is not an option of this client, which takes none but --help.`);
  }
  if (extra.length > 0) {
    return refused(
      `one User id is the whole argument list, and ${argv.length} arguments were written: one client is one person.`,
    );
  }

  const password = env[passwordVariable];
  if (password === undefined || password === "") {
    return refused(`${passwordVariable} is unset, and there is no prompt to fall back on.`);
  }

  const written = env[gatewayUrlVariable];
  const baseUrl = written === undefined || written === "" ? defaultGatewayUrl : written;
  const parsed = URL.parse(baseUrl);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return refused(`${gatewayUrlVariable} is ${baseUrl}, which is not an http or https URL.`);
  }

  return { kind: "run", config: { baseUrl, user, password } };
}
