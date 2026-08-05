import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createGateway, templateHandler } from "shared-agent-framework";
import { createDecisions } from "shared-agent-framework/decisions";
import {
  createHttpMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "shared-agent-framework/http-messenger";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createSignatures } from "shared-agent-framework/signatures";
import { createUsers } from "shared-agent-framework/users";

const hostDir = process.env.HOST_DIR;
if (hostDir === undefined) {
  throw new Error(
    "set HOST_DIR to this directory's path on the host: the agent's mounts are resolved there, not here",
  );
}

// Where the Db connects, read here because the framework reads no environment at all: `databaseUrl`
// is a required option and there is no `DATABASE_URL` fallback inside `createGateway`, so reading
// the variable is on the same footing as reading `HOST_DIR` above and `SIGNING_KEY_FILE` below
// (ADR-0045).
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("set DATABASE_URL to where the Db connects: the framework reads no environment");
}

// The Shared Agent's identity, read here because the framework reads nothing: it takes a
// `KeyObject` and parses no PEM, opens no file and looks at no environment variable, so
// whether this path came from a file, a secrets manager or a shell is this entry point's
// business and nobody else's (ADR-0016, ADR-0041). It is the same division `HOST_DIR` above
// is on, and this is the one place a reader sees whose job it is.
//
// Nothing generates one, deliberately: a fresh key per restart would leave every Decision
// ever published unverifiable, with nothing anywhere saying so.
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
        containerPath: "/workspace",
        gatewayPath: path.join(import.meta.dirname, "state", "workspace"),
      },
      {
        containerPath: "/home/agent/.pi/agent",
        gatewayPath: path.join(import.meta.dirname, "state", "agent"),
      },
      {
        containerPath: "/workspace/AGENTS.md",
        gatewayPath: path.join(import.meta.dirname, "AGENTS.md"),
        readOnly: true,
      },
      {
        containerPath: "/home/agent/.pi/agent/settings.json",
        gatewayPath: path.join(import.meta.dirname, "settings.json"),
        readOnly: true,
      },
    ],
    hostPaths: { [import.meta.dirname]: hostDir },
  },
});

// Thirty days, in milliseconds: this deployment's answer to a trade the framework will not make
// for it (ADR-0030). A department that re-authenticates more often states a shorter one here.
const tokenTtl = 30 * 24 * 60 * 60 * 1000;

const gateway = createGateway({
  databaseUrl,
  runtime,
  publicListen: { port: 8080, host: "0.0.0.0" },
  agentListen: { port: 7411, host: "0.0.0.0" },
  // The four opinionated parts, built by hand from the infrastructure `createGateway` hands us
  // and returned so they become Components of the Gateway — keyed ahead of the Signal Worker, so
  // they stop after the drain a Handler's post phase reaches them through (ADR-0045). This is the
  // wiring and the construction order ADR-0038 hid; here they are where the deployment holding the
  // opinion can see them. A deployment that publishes no Decision builds neither Signatures nor
  // Decisions and reads no signing key at all.
  extend: ({ db, agentServer, publicServer, worker }) => {
    // The User Manager **before** the HTTP Messenger, because `messages.user_id` is a foreign key
    // onto `saf_users.users.id` and `db.migrate()` applies descriptors in registration order,
    // which is construction order: built the other way round, the first migration of a new
    // deployment fails with PostgreSQL's `schema "saf_users" does not exist` (ADR-0036). This is
    // the one construction ordering the Operator now owns, and it fails loudly.
    const users = createUsers({ db, tokenTtl, agentServer, publicServer });
    const signatures = createSignatures({ signingKey, agentServer, publicServer, users });
    const decisions = createDecisions({ db, signatures, users, agentServer, publicServer });
    const messenger = createHttpMessenger({ db, users, worker, publicServer, agentServer });
    return { users, signatures, decisions, messenger };
  },
  handlers: () => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: new URL("./prompts/message-received.hbs", import.meta.url),
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.components.db.migrate();
await gateway.start();

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
