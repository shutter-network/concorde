/**
 * A whole Gateway, assembled by hand.
 *
 *     node example/gateway.ts "what have I asked you before?"
 *
 * Nothing here represents the Gateway. There is no framework object to construct, no
 * registry to add parts to, and no lifecycle to implement: this file *is* the Gateway,
 * and everything below it is a part being constructed and handed to another part. What
 * an assembly is, whole, is four steps:
 *
 *   1. **construct** — the Db, two Fastify instances as Components, the Runtime, the
 *      User Directory and the Signal Worker with its Handlers. A part handed a
 *      server registers its routes on it and a part with tables registers its migration
 *      descriptor with the Db, so construction is also the whole of the wiring
 *      ([ADR-0032](../docs/adr/0032-components-wire-themselves-at-construction.md))
 *   2. **migrate** — explicitly, and after the construction above, because constructing
 *      a part is what registers the descriptor `db.migrate()` applies. `migrate.ts` is
 *      the same call as a deploy step of its own, which is what a second replica needs
 *   3. **order** — the list, which is the one thing in this file that is not arbitrary
 *      and the one thing nothing checks. Its comment is below and is worth reading
 *   4. **start** — one call, in list order, and `stop` in the reverse of it
 *
 * Two things this file is deliberately on the hook for, because the framework ships
 * neither: **shutdown** (the two-line loop at the bottom, whose exit code and escalation
 * policy are this file's) and **emitting Signals** (the last line, which is a Producer —
 * a Producer is anything that emits, including a loop in an entry point).
 *
 * Read ../docs/quickstart.md alongside this. It explains the parts that are load-bearing
 * and cannot be guessed from here: why the agent's container reaches this process at
 * `host.docker.internal` and where that stops being true, what the User Directory does
 * and does not do for you, and the two risks this design accepts.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import {
  components,
  createSignalWorker,
  openDb,
  serverComponent,
  templateHandler,
} from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createUsers } from "shared-agent-framework/users";

// Refused here, by this file, because nothing else can: the framework no longer carries a
// model or a credential, so it cannot tell a deployment that has neither from one whose
// agent reads both out of the files below. A Run that fails is never retried, so a Gateway
// that starts without a usable model turns every Signal it ever receives into a
// permanently failed Run — which is what this line buys, for the one case it can see.
const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined) throw new Error("set ANTHROPIC_API_KEY; the agent's model needs it");

// Where the Agent server *binds* — the Component below — and how the agent's container
// *reaches* it are two separate values, and neither can be derived from the other. The
// second one is not in this file at all: it is written into ./AGENTS.md, which is mounted
// into the agent's Workspace below, because the framework no longer carries the agent's
// instructions and never sees that address. The two are the thing in this deployment most
// likely to need changing on another machine, and changing one means changing the other.
// See the quickstart's note on it.
const agentPort = 7411;

// Two directories, both of them this process's own, both bind-mounted into the agent's
// container, and both created here. The framework creates neither (ADR-0028): a directory
// a mount points at is the Operator's. Creating them is not a courtesy — every entry of
// the Mount Table below is emitted as `--mount type=bind`, and the daemon refuses a bind
// source that is not there, naming it.
//
// Two rather than three: there is no Session root any more. `pi` keeps its transcripts
// under its own agent directory and the framework names no path inside it, so a Session
// survives because the second of these is mounted and for no other reason (ADR-0025).
const state = path.join(import.meta.dirname, "state");
const workspace = path.join(state, "workspace");
const agentDir = path.join(state, "agent");
await Promise.all([workspace, agentDir].map((directory) => mkdir(directory, { recursive: true })));

const db = openDb(process.env.DATABASE_URL ?? "postgres://saf:saf@localhost:5433/saf");

// Two ordinary Fastify instances, because the framework ships no server: there is nothing
// of ours between this file and Fastify, and every option, hook and plugin is reachable
// without asking whether we pass it through. `serverComponent` constructs nothing and
// defaults nothing — it holds the address until `start`, since `Fastify()` takes none,
// and puts the instance on `.fastify` so your own routes go on the same server ours do.
//
// What makes them two different surfaces is what goes on each of them, and nothing else.
// The two bind addresses are written side by side because the asymmetry between them is
// the reason there are two servers at all.
const publicServer = serverComponent("public server", Fastify(), {
  port: 8080,
  // Every interface. This is the surface meant to be exposed, and a Public server on
  // loopback inside a container is reachable by nobody at all — a deployment that looks
  // healthy and serves no User. Behind a reverse proxy on this host, write "localhost".
  host: "0.0.0.0",
});
const agentServer = serverComponent("agent server", Fastify(), {
  port: agentPort,
  // Loopback, which is also Fastify's own default and written out anyway because it is
  // the more consequential of the two: this server has no authentication, so reaching the
  // port is read-write access to everything on it (ADR-0010). "localhost" rather than
  // "127.0.0.1" because Fastify expands it to both loopback addresses, IPv4 and IPv6.
  host: "localhost",
});

// The whole of what the framework is told about the agent: an image, and what the
// container running it sees. There is no model here, no provider and no path inside the
// container, because none of them is the framework's to carry — swapping `pi` for another
// Agent Implementation is this import and this function name, and nothing below
// (ADR-0033).
const runtime = createPiRuntime({
  // Built by compose.yaml, from ./agent/Dockerfile — which is where the two paths that
  // used to be here now live, as `WORKDIR` and `ENV PI_CODING_AGENT_DIR`. An image that
  // declares neither is one that starts and fails every Run, and nothing warns.
  image: "saf-agent:0.83.0",
  // The only environment the agent's container gets. This process's own environment is
  // not inherited, which is the whole reason the agent runs in a container: `pi` hands
  // its shell tool the parent environment wholesale, and this process holds DATABASE_URL.
  //
  // The credential is here because it is the shortest thing that works and the easiest to
  // read. It does not have to be: `pi` reads an `auth.json` out of its own directory, so
  // an Operator who would rather not have a secret in the file they paste into an issue
  // puts one in `state/agent/` and deletes this line (ADR-0025).
  env: { ANTHROPIC_API_KEY: apiKey },
  // The networks compose.yaml declares — a list, because a container can join several.
  // This one holds the agent and nothing else it could usefully talk to: PostgreSQL is on
  // another, so the Db is not reachable by service name from inside a Run.
  networks: ["saf_agent"],
  // The Mount Table: where the container's directories come from on this machine. It is
  // an ordinary list, so a third directory is a third entry rather than a framework
  // change, and an entry may name a single file and may be `readOnly`. Who the container
  // runs as is not in it and is not configuration at all: always this process's own uid
  // and gid, which is what makes a file the agent writes in the Workspace one a Signal
  // Handler can edit in place (ADR-0028).
  mounts: {
    entries: [
      { containerPath: "/workspace", gatewayPath: workspace },
      // Everything `pi` keeps between Runs, the Session transcripts included. Drop this
      // entry and no Session survives its own container, every Run is a first Run, and
      // nothing anywhere says so — the agent simply seems forgetful (ADR-0025).
      { containerPath: "/home/agent/.pi/agent", gatewayPath: agentDir },
      // The third entry, and the whole of what tells the agent about the Agent server: a
      // file committed beside this one, mounted into its working directory, which `pi`
      // finds by itself — the framework passes no flag and has never read it (ADR-0025).
      //
      // `readOnly`, and that is the point of it being a single-file entry: the Workspace
      // around it stays writable, so `pi`'s own tooling is unaffected, while a successful
      // prompt injection cannot rewrite the agent's own instructions for the next Run.
      // The framework used to hold that property by rewriting three files before every
      // Run; the container runtime now holds it by construction (ADR-0003, ADR-0028).
      //
      // The daemon creates the target of a mount that is not there, so after the first
      // Run an *empty* `AGENTS.md` appears in the Workspace on this side, shadowed by
      // this entry on every Run. That is the container runtime's doing and not ours;
      // what it means is that dropping this entry leaves the agent reading an empty file
      // rather than none.
      {
        containerPath: "/workspace/AGENTS.md",
        gatewayPath: path.join(import.meta.dirname, "AGENTS.md"),
        readOnly: true,
      },
      // And the model, which used to be two fields of the Runtime's. `settings.json` is
      // the Operator's file: `defaultModel` and `defaultProvider` in it are what `pi`
      // falls back to when no flag names either, and the framework passes neither flag
      // and has never read this file. Nothing refuses a deployment whose model is missing
      // or wrong any more — that is a Gateway that starts, serves, and fails its first
      // Run permanently (ADR-0017, ADR-0025).
      //
      // `readOnly`, for the same reason `AGENTS.md` is, and it must be the **file** and
      // not the directory: `pi` takes a lock beside this file even to read it, and a
      // write it is refused is recorded rather than thrown, so the Run survives being
      // denied and the agent's own `/model` switch is dropped rather than persisted.
      //
      // And the same footnote as `AGENTS.md`: after the first Run an *empty*
      // `settings.json` appears in `state/agent/` on this side, which is the daemon
      // creating this entry's target. It is shadowed on every Run, so it is harmless
      // while this entry is here and is exactly what an agent with no model reads if it
      // is ever removed.
      {
        containerPath: "/home/agent/.pi/agent/settings.json",
        gatewayPath: path.join(import.meta.dirname, "settings.json"),
        readOnly: true,
      },
    ],
  },
});

// The User Directory, constructed and held by nobody, because handing it the two servers
// is the whole of what this deployment asks of it: `POST /auth/tokens` on the Public one,
// `POST /users` and the two reads on the Agent one. Omitting a server is how either group
// is switched off — there is no flag and no route to guard (ADR-0010).
//
// A deployment with routes of its own keeps the object instead. `requireUser` is on it,
// and so are the four things trusted code may do and the agent may not: setting
// Attributes, replacing a password, issuing a Token and revoking (ADR-0029, ADR-0030).
// It is **not** a Component and has no place in the list below: nothing to start, nothing
// to release (ADR-0031). Seeding the first User is out of band and not in this file,
// because a User has no natural key and so "create if absent" cannot be written.
createUsers({
  db,
  // Thirty days. No default, because the trade is the deployment's: longer is fewer
  // logins and a longer window for a stolen Token, and nothing in the framework can tell
  // which side of that this Gateway is on.
  tokenTtl: 30 * 24 * 60 * 60 * 1000,
  agentServer,
  publicServer,
});

const worker = createSignalWorker({
  db,
  runtime,
  // The primary extension point, and the only one that needs learning. A Handler is a
  // plain object with a `handle` — this one is shipped, renders a Handlebars file per
  // Run, and closes over its template and its Session-naming rule rather than being
  // handed a context object. A Signal whose `kind` is not a key here fails permanently,
  // which is why the map is a construction option: a Worker with no Handlers should not
  // be constructible.
  handlers: {
    ask: templateHandler<{ user: string; text: string }>({
      template: new URL("./prompts/ask.hbs", import.meta.url),
      // One Session per user: one of the topologies ADR-0006 lists, chosen by this
      // deployment, and the framework has no opinion about the name it produces.
      session: (signal) => `user_${signal.payload.user}`,
      data: (signal) => signal.payload,
    }),
  },
  // Which registers the Worker's read-only routes on it at no prefix — `/signals` and
  // `/runs`, the URLs ./AGENTS.md hands the agent. The exported `worker.agentRoutes` is
  // the door out of that default, for a prefix or an encapsulation of your own.
  agentServer,
});

// After construction, because a part registers its own migration descriptor with the Db
// and `db.migrate()` applies whatever registered. migrate.ts is the entry point a deploy
// runs instead of this one, and it registers the same two descriptors explicitly — the
// identical descriptor twice is one registration.
//
// One process on one machine can do this here. More than one cannot: Drizzle's migrator
// takes no advisory lock, so two replicas booting together race into a duplicate-relation
// crash on all but one. Run migrate.ts as a step of its own and delete this line; nothing
// goes unnoticed if you do, because `start` below refuses a schema the database is behind.
await db.migrate();

// The list, and the one thing in this file that is not arbitrary. `components` starts in
// this order and stops in the reverse of it, so every position is a claim about what must
// still be working while the thing after it shuts down:
//
//   1. **the Db**, so it stops last. Everything queries it and the drain queries it on
//      the way down; closing it earlier pulls the `LISTEN` connection out from under a
//      running Signal Worker, which then logs a dropped connection and retries forever.
//   2. **the Agent server**, before the Worker so that it closes *after* the drain. The
//      agent calls it during a Run — ./AGENTS.md is where it is given those URLs — so
//      closing it first refuses the agent its own API mid-Run.
//   3. **the Signal Worker**, whose `stop` waits for the Run in flight and never cancels
//      one: a Run abandoned halfway leaves effects nothing retries (ADR-0017).
//   4. **the Public server**, last, so that it is first to stop accepting submissions.
//
// `[db, worker, agentServer, publicServer]` reads more naturally and groups the two
// servers together, and it is wrong for the reason in 2. **Nothing checks this and
// nothing can**: whether the agent calls the Agent server mid-Run is the model's choice,
// so the ordering is reasoning rather than a passing assertion (ADR-0031).
const gateway = components([db, agentServer, worker, publicServer]);

// Which opens the pool, refuses to serve if any registered schema is behind the migration
// folder shipped beside it, and only then starts the worker and binds the two ports. A
// part that throws here stops everything that had already started, so a Gateway that
// could not boot holds nothing open.
await gateway.start();

// Shutdown, and both of the signals that mean it. The framework ships no signal handling
// at all (ADR-0021), which is why these three lines are here rather than behind an
// option: the exit code, any timeout on the drain and what a second signal does are the
// Operator's, and they differ per deployment.
//
// `SIGTERM` is the one that matters and the one this file used to be missing. `SIGINT` is
// Ctrl-C, but `docker stop`, systemd and a Kubernetes eviction all send `SIGTERM`, so
// without it the drain never ran in the only situation it was written for — and a Signal
// left `processing` fails permanently on the next boot (ADR-0017).
//
// Two things follow from `once` rather than `on`. A **different** second signal — Ctrl-C
// and then a `docker stop` — calls `stop` a second time, which is harmless: it pops what
// it stopped, so the second call finds nothing to do and no part is torn down twice. A
// **repeated** signal finds no listener left and gets Node's default, which kills this
// process mid-drain. That is the escalation this file chooses, and `process.on` is how
// you decline it.
//
// There is no `process.exit` anywhere here, deliberately: once `stop` has returned, the
// pool is closed, the listening connection is closed, the sweep interval is cleared and
// both servers are shut, so nothing holds the event loop and the process ends by itself.
// An exit call would be a way to cut the drain short and buy nothing.
for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}

// A Producer: something inside the Gateway that puts a Signal in the queue. There is no
// framework concept here beyond a function call, and it takes the transaction rather than
// finding one — so recording something and telling the agent about it cannot come apart,
// and a rollback wakes nobody. The Messenger will be one of these; so is this line.
const asked = process.argv[2] ?? "Say hello, and tell me what has arrived recently.";
await db.tx((tx) => worker.emit(tx, { kind: "ask", payload: { user: "42", text: asked } }));
