import { createGateway } from "@shutter-network/concorde/gateway";
import { createPiRuntime } from "@shutter-network/concorde/pi";
import {
  createScheduler,
  type ScheduleFiredRecord,
  scheduleFiredKind,
} from "@shutter-network/concorde/scheduler";
import type { SignalHandler } from "@shutter-network/concorde/signals";

function taskOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (!("task" in data) || typeof data.task !== "string") return undefined;
  return data.task;
}

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
  image: process.env.AGENT_IMAGE!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    AGENT_SERVER_URL: process.env.AGENT_SERVER_URL!,
  },
  networks: [process.env.AGENT_NETWORK!],
  mounts: {
    runtimeDir: process.env.RUNTIME_DIR_HOST!,
    entries: [
      { agentPath: "/workspace", path: "state/workspace" },
      { agentPath: "/home/agent/.pi/agent", path: "state/agent" },
      { agentPath: "/workspace/AGENTS.md", path: "AGENTS.md", readOnly: true },
      { agentPath: "/home/agent/.pi/agent/settings.json", path: "settings.json", readOnly: true },
    ],
  },
});

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL!,
  runtime,
  publicListen: { host: process.env.PUBLIC_HOST!, port: Number(process.env.PUBLIC_PORT) },
  agentListen: { host: process.env.AGENT_HOST!, port: Number(process.env.AGENT_PORT) },
  extend: ({ db, worker, agentServer }) => ({
    scheduler: createScheduler({ db, worker, agentServer }),
  }),
  handlers: () => ({ [scheduleFiredKind]: scheduleFired }),
});

await gateway.start();

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
