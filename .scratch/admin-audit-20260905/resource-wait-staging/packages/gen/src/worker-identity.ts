import { randomUUID } from "node:crypto";

const WORKER_RUN_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const WORKER_SLOT = /^(0|[1-9]\d*)$/;

function generationWorkerIdentity(input: {
  mode: "image" | "video";
  appEnv: string;
  pid: number;
  runId?: string;
  slot?: string;
}) {
  const configuredRunId = input.runId?.trim();
  if (input.appEnv === "production" && !configuredRunId) {
    throw new Error(
      `GEN_${input.mode.toUpperCase()}_WORKER_RUN_ID is required for a production ${input.mode} worker`,
    );
  }
  if (input.appEnv === "production" && !input.slot?.trim()) {
    throw new Error(
      `NODE_APP_INSTANCE is required for a production ${input.mode} worker`,
    );
  }
  const runId = configuredRunId ?? `dev-${randomUUID()}`;
  const slot = input.slot?.trim() || "0";
  if (!WORKER_RUN_ID.test(runId)) {
    throw new Error(
      `GEN_${input.mode.toUpperCase()}_WORKER_RUN_ID must contain only letters, digits, _ or -`,
    );
  }
  if (!WORKER_SLOT.test(slot)) {
    throw new Error("NODE_APP_INSTANCE must be a non-negative integer");
  }
  if (!Number.isSafeInteger(Number(slot))) {
    throw new Error("NODE_APP_INSTANCE is outside the safe integer range");
  }
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new Error(`${input.mode} worker PID must be a positive integer`);
  }
  return `idream.gen-${input.mode}.v1.${runId}.${slot}.${input.pid}`;
}

export function imageWorkerIdentity(
  input: Omit<Parameters<typeof generationWorkerIdentity>[0], "mode">,
) {
  return generationWorkerIdentity({ ...input, mode: "image" });
}

export function videoWorkerIdentity(
  input: Omit<Parameters<typeof generationWorkerIdentity>[0], "mode">,
) {
  return generationWorkerIdentity({ ...input, mode: "video" });
}
