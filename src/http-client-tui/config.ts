export const gatewayUrlVariable = "CONCORDE_GATEWAY_URL";

export const passwordVariable = "CONCORDE_PASSWORD";

export const defaultGatewayUrl = "http://localhost:8080";

export type ClientConfig = {
  readonly baseUrl: string;
  readonly user: string;
  readonly password: string;
};

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
