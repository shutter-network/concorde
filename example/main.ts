/**
 * A whole Gateway.
 *
 *     node example/main.ts
 *
 * It takes no arguments, because there is nothing left to say to it from a shell: a
 * person logs in over the Public server, posts a Message, and reads the agent's answer
 * back. The quickstart walks that through with `curl`.
 *
 * Most of a deployment is not in this file and does not need to be.
 * `createGatewayWithDefaults` builds the Db, the two servers, the User Manager, the HTTP
 * Messenger and the Signal Worker, wires them to each other and puts them in an order
 * ([ADR-0038](../docs/adr/0038-the-default-assembly-is-a-constructor.md)). That order is
 * load-bearing and its reasoning is identical in every deployment built out of these parts,
 * so it lives beside the constructor rather than being copied into each entry point.
 *
 * What is left is what is actually this deployment's:
 *
 *   - **the Runtime**, and inside it the **Mount Table**, which is where this deployment
 *     keeps its two real hazards and is the longest thing in the file for that reason
 *   - **the Signal Handler**, which is the whole of what this Gateway does with a Message
 *   - **shutdown**, the loop at the bottom, whose exit code and escalation policy the
 *     framework ships none of
 *
 * Read ../docs/quickstart.md alongside this. It explains the parts that are load-bearing
 * and cannot be guessed from here: why the agent's container reaches this process at
 * `host.docker.internal` and where that stops being true, what the User Manager does
 * and does not do for you, and the two risks this design accepts.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createGatewayWithDefaults,
  type Db,
  type SignalHandler,
  templateHandler,
} from "shared-agent-framework";
import {
  type HttpMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "shared-agent-framework/http-messenger";
import { createPiRuntime } from "shared-agent-framework/pi";

// Refused here, by this file, because nothing else can: the framework no longer carries a
// model or a credential, so it cannot tell a deployment that has neither from one whose
// agent reads both out of the files below. A Run that fails is never retried, so a Gateway
// that starts without a usable model turns every Signal it ever receives into a
// permanently failed Run — which is what this line buys, for the one case it can see.
const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined) throw new Error("set ANTHROPIC_API_KEY; the agent's model needs it");

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

// The whole of what the framework is told about the agent: an image, and what the
// container running it sees. There is no model here, no provider and no path inside the
// container, because none of them is the framework's to carry — swapping `pi` for another
// Agent Implementation is this import and this function name, and nothing below
// (ADR-0033). It is a Runtime rather than four options on the call below for the same
// reason: a container spec forwarded through a convenience constructor would default
// nothing, and hiding the Mount Table behind an options key would suggest the framework
// had an opinion about the agent when it has none (ADR-0038).
const runtime = createPiRuntime({
  // Built by compose.yml, from ./agent/Dockerfile — which is where the two paths that
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
  // The networks compose.yml declares — a list, because a container can join several.
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

/**
 * The one Handler this deployment has, and the whole of what it does with a Message that
 * arrived: render a Prompt from it, in the Session that person's Prompts have always gone
 * to.
 *
 * A factory taking the two parts it needs, because the Gateway constructs them and hands
 * them back to `handlers` below. A Handler receives only the Signal and reaches everything
 * else through what it closed over (ADR-0024), so these two arguments are the whole of its
 * world — which is also why testing one takes an object literal rather than a Gateway.
 *
 * Typed `SignalHandler<MessageRecord>` rather than left to inference, because the payload
 * type is what makes the template's data function check. Both halves of the Messenger's
 * Signal contract are imported rather than restated here: the `kind` it is registered
 * under, so a Handler map is not a string literal that can drift, and this record, so
 * nothing re-declares a payload shape by hand (ADR-0034). The annotation is also what types
 * `post`'s own arguments, since the Worker's map is `Record<string, SignalHandler<unknown>>`
 * and would otherwise hand a literal written inline a payload of `unknown`.
 */
function answering(db: Db, messenger: HttpMessenger): SignalHandler<MessageRecord> {
  return {
    ...templateHandler<MessageRecord>({
      template: new URL("./prompts/message-received.hbs", import.meta.url),
      // One Session per User: one of the topologies ADR-0006 lists, chosen by this
      // deployment, and the framework has no opinion about the name it produces. What is
      // new is that the id inside it belongs to somebody. The Messenger wrote it from the
      // Token the submission carried, and the Public route has no field a client could put
      // a User in, so routing on it is trustworthy rather than merely convenient
      // (ADR-0020).
      session: (signal) => `user_${signal.payload.userId}`,
      // The payload **is** the Message record, flat, so the template has the text, who sent
      // it, its number in that person's log and when it arrived, with no second query.
      data: (signal) => signal.payload,
    }),
    // The post phase, which runs once after every Run arising from the Signal has finished
    // and is the whole of the framework's failure handling (ADR-0017). It is the only place
    // this deployment answers a person from the Gateway's own code, and it is here because
    // a failed Run is otherwise silent to the one party who is waiting: the Message is
    // stored, the Signal row says `failed`, and nothing retries it.
    //
    // It deliberately does not carry the *answer*, because it cannot: a Run reports `ok` or
    // an error string and none of the agent's output, by decision rather than omission. So
    // the answer reaches this person the one way it can, which is the agent posting it
    // itself during the Run over the Agent server, as ./AGENTS.md and the Prompt both tell
    // it to. One path for an answer and one for a failure, and never two for the same
    // thing.
    async post(signal, outcome) {
      if (!outcome.failed) return;
      // `send` takes the caller's transaction rather than finding one (ADR-0023), so a
      // Handler with tables of its own commits its record of a failure together with the
      // words it sent about it, or neither. This one has no tables, so there is one
      // statement in here.
      await db.tx((tx) =>
        messenger.send(
          tx,
          signal.payload.userId,
          "Something went wrong while I was working on that, and nothing will retry it. Please ask again.",
        ),
      );
    },
  };
}

const gateway = createGatewayWithDefaults({
  databaseUrl: process.env.DATABASE_URL ?? "postgres://saf:saf@localhost:5433/saf",
  runtime,
  // Thirty days. No default, because the trade is the deployment's: longer is fewer logins
  // and a longer window for a stolen Token, and nothing in the framework can tell which
  // side of that this Gateway is on.
  tokenTtl: 30 * 24 * 60 * 60 * 1000,
  // Every interface. This is the surface meant to be exposed, and a Public server on
  // loopback inside a container is reachable by nobody at all — a deployment that looks
  // healthy and serves no User. Behind a reverse proxy on this host, write "localhost".
  publicListen: { port: 8080, host: "0.0.0.0" },
  // Loopback, which is also Fastify's own default and written out anyway because it is the
  // more consequential of the two: the Agent server has no authentication, so reaching the
  // port is read-write access to everything on it (ADR-0010). "localhost" rather than
  // "127.0.0.1" because Fastify expands it to both loopback addresses, IPv4 and IPv6.
  //
  // Where the Agent server *binds* and how the agent's container *reaches* it are two
  // separate values, and neither can be derived from the other. The second one is not in
  // this file at all: it is written into ./AGENTS.md, which is mounted into the agent's
  // Workspace above, because the framework no longer carries the agent's instructions and
  // never sees that address. The two are the thing in this deployment most likely to need
  // changing on another machine, and changing one means changing the other. See the
  // quickstart's note on it.
  agentListen: { port: 7411, host: "localhost" },
  // The primary extension point, and the only one that needs learning. A Signal whose
  // `kind` is not a key here fails permanently, which is why the map is required rather
  // than optional: a Worker with no Handlers should not be constructible. This one has a
  // single key, and it is the constant the Messenger exports rather than the string it
  // stands for.
  //
  // A callback because there is a construction cycle and this is where it is broken: the
  // Worker holds the map, the Messenger holds the Worker, and the Handler above reaches the
  // Messenger to say that a Run failed (ADR-0038). Every part the Gateway built is named
  // and precisely typed here, one step later.
  handlers: ({ db, messenger }) => ({ [messageReceivedKind]: answering(db, messenger) }),
});

// Explicitly, and after construction, because constructing a part is what registers the
// migration descriptor this applies; `start` never migrates (ADR-0032).
//
// One process on one machine can do this here. More than one cannot: Drizzle's migrator
// takes no advisory lock, so two replicas booting together race into a duplicate-relation
// crash on all but one. A deploy that needs the schema up before anything serves the new
// code runs a migration step of its own — a few lines that open a Db, register the three
// exported descriptors and call this same method — and deletes this line. Nothing goes
// unnoticed if you do, because `start` below refuses a schema the database is behind.
await gateway.components.db.migrate();

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
