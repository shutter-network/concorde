import path from "node:path";
import { createGateway } from "shared-agent-framework/gateway";
import { createPiRuntime } from "shared-agent-framework/pi";
import {
  createScheduler,
  type ScheduleFiredRecord,
  scheduleFiredKind,
} from "shared-agent-framework/scheduler";
import type { SignalHandler } from "shared-agent-framework/signals";

function fromEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`set ${name}: the framework reads no environment, so this file does`);
  }
  return value;
}

const baseDirGateway = fromEnv("BASE_DIR_GATEWAY");
const baseDirHost = fromEnv("BASE_DIR_HOST");
const databaseUrl = fromEnv("DATABASE_URL");

const publicPort = 8080;
const agentPort = 7411;

function taskOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (!("task" in data) || typeof data.task !== "string") return undefined;
  return data.task;
}

// Written by hand rather than with `templateHandler`, so there is no `.hbs` here. Every fire of
// every Schedule arrives under one fixed kind, whoever arranged it, so the routing is on the
// `data` each Schedule carried.
const scheduleFired: SignalHandler<ScheduleFiredRecord> = {
  handle(signal) {
    const { scheduleName, data, scheduledFor, firedAt } = signal.payload;
    const task = taskOf(data);
    const text =
      task === undefined
        ? `The Schedule "${scheduleName}" fired and carried no task. Append one line to ` +
          `/workspace/log.md that says so, and do nothing else.`
        : `${task}\n\nThat came from the Schedule "${scheduleName}", which was arranged for ` +
          `${scheduledFor} and fired at ${firedAt}.`;
    return [{ session: `schedule_${scheduleName}`, text }];
  },
  post(signal, outcome) {
    if (outcome.failed) {
      console.error(`the Run for the Schedule ${signal.payload.scheduleName} failed`);
    }
  },
};

const runtime = createPiRuntime({
  image: "saf-scheduler-agent:0.83.0",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  networks: ["saf_scheduler_agent"],
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

const gateway = createGateway({
  databaseUrl,
  runtime,
  publicListen: { host: "0.0.0.0", port: publicPort },
  agentListen: { host: "0.0.0.0", port: agentPort },
  // One component. No Users, no Messenger and no Channel: nothing here reaches a person.
  extend: ({ db, worker, agentServer }) => ({
    scheduler: createScheduler({ db, worker, agentServer }),
  }),
  handlers: () => ({ [scheduleFiredKind]: scheduleFired }),
});

await gateway.start();

// Both are upserts by name, so a restart converges on these two rather than adding a pair.
await gateway.components.scheduler.schedule({
  name: "hello-once",
  spec: { kind: "once", at: new Date(Date.now() + 20_000).toISOString() },
  data: {
    task: "Append one line to /workspace/log.md saying the boot Schedule woke you.",
  },
});

await gateway.components.scheduler.schedule({
  name: "every-minute",
  spec: { kind: "cron", expr: "* * * * *", tz: "UTC" },
  data: {
    task: "Append the time and one short sentence to /workspace/heartbeat.md.",
  },
});

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
