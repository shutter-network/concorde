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

Send messages through a Concorde HTTP channel. The client logs in, displays your
message log, and polls for new messages once a second. Type a line to send it.

Arguments:
  <user-id>  User id supplied by the operator.

Environment:
  ${gatewayUrlVariable}  Public server URL (default: ${defaultGatewayUrl}).
  ${passwordVariable}     Required password. The client does not prompt for it.

Use --help or -h to show this help. Use another HTTP client for decisions,
schedules, and other gateway APIs.`;

function refused(reason: string): Invocation {
  return { kind: "refused", reason };
}

export function readInvocation(
  argv: readonly string[],
  env: Readonly<Partial<Record<string, string>>>,
): Invocation {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };

  const [user, ...extra] = argv;
  if (user === undefined) return refused("Missing user id. Usage: http-client-tui <user-id>");
  if (user.startsWith("-")) {
    return refused(`Unknown option: ${user}. Use --help for usage.`);
  }
  if (extra.length > 0) {
    return refused(`Expected one user id; received ${argv.length} arguments.`);
  }

  const password = env[passwordVariable];
  if (password === undefined || password === "") {
    return refused(
      `Set ${passwordVariable} to the user's password. Interactive entry is not supported.`,
    );
  }

  const written = env[gatewayUrlVariable];
  const baseUrl = written === undefined || written === "" ? defaultGatewayUrl : written;
  const parsed = URL.parse(baseUrl);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return refused(`${gatewayUrlVariable} must be an HTTP or HTTPS URL; received ${baseUrl}.`);
  }

  return { kind: "run", config: { baseUrl, user, password } };
}
