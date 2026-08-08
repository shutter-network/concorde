import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDecisions } from "shared-agent-framework/decisions";
import { createGateway } from "shared-agent-framework/gateway";
import { createHttpChannel } from "shared-agent-framework/http-channel";
import {
  createMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "shared-agent-framework/messenger";
import { createPasswordAuth } from "shared-agent-framework/password-auth";
import { createPiRuntime } from "shared-agent-framework/pi";
import {
  createScheduler,
  type ScheduleFiredRecord,
  scheduleFiredKind,
} from "shared-agent-framework/scheduler";
import { templateHandler } from "shared-agent-framework/signals";
import { createSignatures } from "shared-agent-framework/signatures";
import { createUsers } from "shared-agent-framework/users";

// The framework reads no environment at all (ADR-0045), so every value this deployment takes
// from outside is read here, in the one place a reader looks to see whose job that is. A missing
// one refuses to start, naming the variable and why it exists, the same shape the
// `SIGNING_KEY_FILE` read below spells out by hand.
function fromEnv(name: string, description: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`set ${name} ${description}`);
  }
  return value;
}

// The shared tree, named twice because a Gateway in a container and the daemon resolving its
// mounts see it at two different paths: `BASE_DIR_GATEWAY` is where this process sees it, and
// `BASE_DIR_HOST` is where it is on the host. Both feed the Mount Table below field for field,
// and compose.yml sets them beside the bind that makes them true, so the image's internal layout
// is not load-bearing here (ADR-0028).
const baseDirGateway = fromEnv(
  "BASE_DIR_GATEWAY",
  "to the shared tree's path inside this container: the agent's mounts are built from there",
);
const baseDirHost = fromEnv(
  "BASE_DIR_HOST",
  "to the shared tree's path on the host: the daemon resolves the agent's mounts there, not in this container",
);

// Where each server binds, read here because the framework defaults neither address and each has
// to agree with the `ports:` compose publishes it on (quickstart, "Where each server binds is
// yours to state"). The Public server is the one meant to be reached; the Agent server is
// unauthenticated, so reaching its port is access, which is why moving it is stated out loud.
const publicHost = fromEnv(
  "PUBLIC_HOST",
  "to the Public server's bind address: the framework defaults none",
);
const publicPort = Number(
  fromEnv("PUBLIC_PORT", "to the Public server's port: it must match the ports: compose publishes"),
);
const agentHost = fromEnv(
  "AGENT_HOST",
  "to the Agent server's bind address: the framework defaults none",
);
const agentPort = Number(
  fromEnv("AGENT_PORT", "to the Agent server's port: it must match the ports: compose publishes"),
);

// Where the Db connects, read here because the framework reads no environment at all: `databaseUrl`
// is a required option and there is no `DATABASE_URL` fallback inside `createGateway`, so reading
// the variable is on the same footing as reading the base directory above and `SIGNING_KEY_FILE`
// below (ADR-0045).
const databaseUrl = fromEnv(
  "DATABASE_URL",
  "to where the Db connects: the framework reads no environment",
);

// The Shared Agent's identity, read here because the framework reads nothing: it takes a
// `KeyObject` and parses no PEM, opens no file and looks at no environment variable, so
// whether this path came from a file, a secrets manager or a shell is this entry point's
// business and nobody else's (ADR-0016, ADR-0041). It is the same division `BASE_DIR_HOST`
// above is on, and this is the one place a reader sees whose job it is.
//
// Nothing generates one, deliberately: a fresh key per restart would leave every Decision
// ever published unverifiable, with nothing anywhere saying so.
//
// WARNING: in this reference stack `SIGNING_KEY_FILE` points at
// `insecure-example-only-signing-key.pem`, a throwaway keypair committed to `example/` so the
// stack comes up from a clone with one command. It is public and worthless: it signs nothing
// anyone should verify, and carrying it into production would let anyone who read this repository
// forge the agent's signature. A real deployment generates its own key and never commits it, and
// the quickstart's "Generating a key" step is where that is taught.
const signingKeyFile = process.env.SIGNING_KEY_FILE;
if (signingKeyFile === undefined) {
  throw new Error(
    "set SIGNING_KEY_FILE to a PEM private key: it is the Shared Agent's identity, and the framework will not invent one",
  );
}
const signingKey = createPrivateKey(readFileSync(signingKeyFile));

const runtime = createPiRuntime({
  image: "saf-agent:0.83.0",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  networks: ["saf_agent"],
  mounts: {
    entries: [
      {
        agentPath: "/workspace",
        gatewayPath: path.join(baseDirGateway, "state", "workspace"),
      },
      {
        agentPath: "/home/agent/.pi/agent",
        gatewayPath: path.join(baseDirGateway, "state", "agent"),
      },
      {
        agentPath: "/workspace/AGENTS.md",
        gatewayPath: path.join(baseDirGateway, "AGENTS.md"),
        readOnly: true,
      },
      {
        agentPath: "/home/agent/.pi/agent/settings.json",
        gatewayPath: path.join(baseDirGateway, "settings.json"),
        readOnly: true,
      },
    ],
    hostRoot: { gatewayPath: baseDirGateway, hostPath: baseDirHost },
  },
});

// Thirty days, in milliseconds: this deployment's answer to a trade the framework will not make
// for it (ADR-0030). A department that re-authenticates more often states a shorter one here.
const tokenTtl = 30 * 24 * 60 * 60 * 1000;

const gateway = createGateway({
  databaseUrl,
  runtime,
  publicListen: { port: publicPort, host: publicHost },
  agentListen: { port: agentPort, host: agentHost },
  // The seven components, built by hand from the infrastructure `createGateway` hands us
  // and returned so they become Components of the Gateway — keyed ahead of the Signal Worker, so
  // they stop after the drain a Handler's post phase reaches them through (ADR-0045). This is the
  // wiring and the construction order ADR-0038 hid; here they are where the deployment holding the
  // opinion can see them. A deployment that publishes no Decision builds neither Signatures nor
  // Decisions and reads no signing key at all.
  extend: ({ db, agentServer, publicServer, worker }) => {
    // Users **before** the Messenger and Password Auth, both of which need it as a value. The
    // tables' order is no longer this line's business. `messages.user_id` is still a foreign
    // key onto `saf_users.users.id`, and so are Password Auth's two columns, but they are
    // declared in those parts' own schemas and ordered by the single generation the migrate
    // service pushes from `schema.ts` (ADR-0036, ADR-0046, ADR-0052). What that barrel does
    // require is that Users be *in* it, and it is.
    const users = createUsers({ db, agentServer, publicServer });
    // Password Auth is the one scheme this deployment accepts. It registers itself with the
    // Public server inside its own constructor, and that server composes every registered
    // scheme into the one `requireUser` every protected route below takes, which is why
    // Signatures, Decisions and the HTTP Channel take no Users at all (ADR-0052).
    const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl });
    const signatures = createSignatures({ signingKey, agentServer, publicServer });
    const decisions = createDecisions({ db, signatures, agentServer, publicServer });
    // The Messenger owns the log and reaches nobody; the HTTP Channel is what reaches a person,
    // and it registers itself with the Messenger inside its own constructor, so there is no wiring
    // line here to forget (ADR-0048). This deployment runs HTTP, which is the whole of the
    // quickstart's spine: `POST /messages` and `GET /messages?after=1`. A second Channel on this
    // Messenger would be refused at that registration, so the choice of medium is the choice of
    // which Channel is constructed.
    const messenger = createMessenger({ db, users, worker, agentServer });
    const httpChannel = createHttpChannel({ db, messenger, publicServer });
    // The Scheduler, the second Producer, opted in and wired like the Messenger: the Db and
    // the Signal Worker it emits into, and the Agent server so the agent can create and cancel
    // Schedules over HTTP (omit it to switch that surface off). It is keyed ahead of the Worker
    // like every part `extend` returns, so its `stop` — which cancels the firing timer — runs
    // *after* the Worker's drain: a fire that lands during the drain is written as a pending
    // Signal the next boot handles, which is the residual ADR-0018 accepts rather than leaving
    // `extend` for `createBareGateway` to stop it first (ADR-0045).
    const scheduler = createScheduler({ db, worker, agentServer });
    return { users, passwordAuth, signatures, decisions, messenger, httpChannel, scheduler };
  },
  handlers: () => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: new URL("./prompts/message-received.hbs", import.meta.url),
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => signal.payload,
    }),
    // The one Handler every matured Schedule flows through: the `kind` is fixed, so a Schedule
    // from the agent and one the Operator declared below arrive here alike, and this Handler
    // routes on the `data` each carried. Registering none would leave `scheduleFiredKind` a
    // permanently failed Signal (ADR-0017, ADR-0018).
    [scheduleFiredKind]: templateHandler<ScheduleFiredRecord>({
      template: new URL("./prompts/schedule-fired.hbs", import.meta.url),
      session: (signal) => `schedule_${signal.payload.scheduleName}`,
      data: (signal) => signal.payload,
    }),
  }),
});

// No migration step here, deliberately: this deployment applies its own schema, from `schema.ts`
// through the one-shot `migrate` service `compose.yml` makes the Gateway wait on (ADR-0046). By
// the time this line runs the tables exist, and if they do not, the first query says so — the
// framework verifies nothing at start, because applying migrations and confirming they applied is
// the Operator's job whole rather than half.
await gateway.start();

// A standing Operator Schedule, declared in code once the Gateway is up and re-declared on every
// boot: the upsert by name converges to one Schedule rather than accumulating a duplicate per
// restart, so the same declaration is safe to re-run. This is the programmatic path — no HTTP and
// no timer loop of the Operator's own — and its matured Signal is `scheduleFiredKind`, which the
// Handler above routes (ADR-0018). Removing this line does not remove the Schedule; a removal is
// an explicit `scheduler.cancel("daily-digest")`.
await gateway.components.scheduler.schedule({
  name: "daily-digest",
  spec: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
  data: { digest: "daily" },
});

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
