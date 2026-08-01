/**
 * A whole Gateway, assembled by hand.
 *
 *     node example/gateway.ts "what have I asked you before?"
 *
 * Nothing here represents the Gateway. There is no framework object to construct, no
 * registry to add parts to, and no lifecycle to implement: this file *is* the Gateway,
 * and everything below it is a part being constructed and handed to another part. The
 * ordering is therefore yours, and it is the one thing about this file that is not
 * arbitrary:
 *
 *   1. **open the Store** — a connection URL, and nothing happens on the wire yet
 *   2. **migrate** — explicitly, so it can also be a deploy step of its own
 *   3. **construct, and register routes** — two Fastify instances, the Runtime Adapter,
 *      the Core, and the Core's own routes onto the Agent one. None of it has a side
 *      effect beyond that registration
 *   4. **verify the mounts** — one throwaway container, which refuses the deploy if the
 *      agent cannot see the directories this process thinks it mounted. A step of its own
 *      rather than part of constructing the adapter, for the reason migrating is one
 *   5. **start the Core with its Handlers** — passing them in, because a Core started
 *      with none registered should not be expressible
 *   6. **listen** — last, because Fastify refuses a route registration after that
 *
 * Two things this file is deliberately on the hook for, because the framework ships
 * neither: **shutdown** (the `SIGINT` handler at the bottom, whose ordering matters) and
 * **emitting Signals** (the last line, which is a Producer — a Producer is anything that
 * emits, including a loop in an entry point).
 *
 * Read ../docs/quickstart.md alongside this. It explains the parts that are load-bearing
 * and cannot be guessed from here: why the Public server has no routes, why the agent's
 * container reaches this process at `host.docker.internal` and where that stops being
 * true, and the two risks this design accepts.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { coreMigrations, createCore, openStore, templateHandler } from "shared-agent-framework";
import { createPiAdapter } from "shared-agent-framework/pi";

// Refused here rather than discovered later: a Run that fails is never retried, so a
// Gateway that starts without a usable model turns every Signal it ever receives into a
// permanently failed Run.
const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined) throw new Error("set ANTHROPIC_API_KEY; the agent's model needs it");

// The port appears twice on purpose. Where the Agent server *binds* — the `listen` call
// at the bottom of this file — and how the agent's container *reaches* it are two
// separate values, and neither can be derived from the other. Nothing validates the URL
// either, so it arrives in the agent's instructions exactly as written here. See the
// quickstart's note on this, which is the one thing in this file most likely to need
// changing on another machine.
const agentPort = 7411;
const agentServerUrl = `http://host.docker.internal:${agentPort}`;

// Three directories, all of them this process's own, all bind-mounted into the agent's
// container. The Workspace is created here because the framework refuses to create it: it
// is shared with the Signal Handlers, and a Gateway that conjured a missing one would
// hide a wrong path instead of failing on it. The other two the framework makes itself,
// in the startup check below — and each Session's own directory is made by `pi`, inside
// the container.
const state = path.join(import.meta.dirname, "state");
const workspace = path.join(state, "workspace");
await mkdir(workspace, { recursive: true });

const store = openStore(process.env.DATABASE_URL ?? "postgres://saf:saf@localhost:5433/saf");
await store.migrate(coreMigrations);

// Two ordinary Fastify instances, because the framework ships no server: there is nothing
// of ours between this file and Fastify, and every option, hook and plugin is reachable
// without asking whether we pass it through. What makes them two different surfaces is
// what goes on each of them, and nothing else.
//
// The Public one carries no routes at all, and that is finished work rather than a stub:
// Users reach the Messenger through it and the Messenger is out of scope. It is here
// because it is part of the Gateway's shape, and because it is where your own plugins go.
const publicServer = Fastify();
const agentServer = Fastify();

const runtime = createPiAdapter({
  image: "saf-agent:0.83.0",
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  // The only environment the agent's container gets. This process's own environment is
  // not inherited, which is the whole reason the agent runs in a container: `pi` hands
  // its shell tool the parent environment wholesale, and this process holds DATABASE_URL.
  env: { ANTHROPIC_API_KEY: apiKey },
  // The network compose.yaml declares, which holds the agent and nothing else it could
  // usefully talk to. PostgreSQL is on another one, so the Store is not reachable by
  // service name from inside a Run.
  network: "saf_agent",
  // Each mount says where the directory is *here* and where it appears *to the agent*.
  // Both halves, rather than the one-string form, because the one-string form makes the
  // agent's working directory this machine's own absolute path — which works and reads
  // like a leak. A third value exists for when the container runtime resolves the source
  // somewhere else again, which is what a containerised Gateway needs.
  workspace: { localPath: workspace, agentPath: "/workspace" },
  agentDir: { localPath: path.join(state, "agent"), agentPath: "/home/agent/.pi/agent" },
  sessionRoot: { localPath: path.join(state, "sessions"), agentPath: "/sessions" },
  agentServerUrl,
  instructions: "You are the shared agent of several people. Be brief and be careful.",
});
const core = createCore({ store, runtime });
// Nothing does this for you. Not registering a route group is how you switch it off, and
// this one is read-only and unscoped: the agent sees every Signal and every Run.
await agentServer.register(core.agentRoutes);

// One throwaway container, before anything serves: it writes a token into each of the
// three mounts, has the container read it back and write its own, and reads that. It
// refuses the deploy naming the mount when it cannot, which is worth a container start at
// boot — two of the three failures it catches are otherwise completely silent.
await runtime.verifyMounts();

// The primary extension point, and the only one that needs learning. A Handler is a
// plain object with a `handle` — this one is shipped, renders a Handlebars file per Run,
// and closes over its template and its Session-naming rule rather than being handed a
// context object. A Signal whose `kind` is not a key here fails permanently.
core.start({
  ask: templateHandler<{ user: string; text: string }>({
    template: new URL("./prompts/ask.hbs", import.meta.url),
    // One Session per user: one of the topologies ADR-0006 lists, chosen by this
    // deployment, and the framework has no opinion about the name it produces.
    session: (signal) => `user_${signal.payload.user}`,
    data: (signal) => signal.payload,
  }),
});

// The two bind addresses, side by side, because the asymmetry between them is the reason
// there are two servers and no default of ours hides either one.
await publicServer.listen({
  port: 8080,
  // Every interface. This is the surface meant to be exposed, and a Public server on
  // loopback inside a container is reachable by nobody at all — a deployment that looks
  // healthy and serves no User. Behind a reverse proxy on this host, write "localhost".
  host: "0.0.0.0",
});
await agentServer.listen({
  port: agentPort,
  // Loopback, which is also Fastify's own default and written out anyway because it is
  // the more consequential of the two: this server has no authentication, so reaching the
  // port is read-write access to the whole Store, and moving it off loopback should be a
  // change someone made on purpose (ADR-0010). "localhost" rather than "127.0.0.1"
  // because Fastify expands it to both loopback addresses, IPv4 and IPv6.
  host: "localhost",
});

// Shutdown, in the order that matters. `core.stop()` first: it waits for the Run in
// flight and closes the connection the worker listens for wakeups on. Closing the Store
// first instead pulls that connection out from under a running Core, which then logs a
// dropped connection and retries forever. Nothing here handles a Run that is mid-flight
// when the signal arrives — that is a situation every Operator meets alone.
process.on("SIGINT", async () => {
  await core.stop();
  await Promise.all([agentServer.close(), publicServer.close()]);
  await store.close();
});

// A Producer: something inside the Gateway that puts a Signal in the queue. There is no
// framework concept here beyond a function call, and it takes the transaction rather than
// finding one — so recording something and telling the agent about it cannot come apart,
// and a rollback wakes nobody. The Messenger will be one of these; so is this line.
const asked = process.argv[2] ?? "Say hello, and tell me what has arrived recently.";
await store.tx((tx) => core.emit(tx, { kind: "ask", payload: { user: "42", text: asked } }));
