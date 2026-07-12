import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

const CHILD_SCRIPT = "src/scripts/admin-projector-chaos-child.ts";

function waitForExit(child: ChildProcess) {
  return new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function killAndWait(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const exited = waitForExit(child);
  if (!child.kill("SIGKILL")) throw new Error(`failed to SIGKILL projector child ${child.pid ?? "unknown"}`);
  return exited;
}

async function spawnProjectorChild(
  eventId: string,
  options: { readonly pauseAfterApply: boolean },
) {
  const child = spawn(join(process.cwd(), "node_modules/.bin/tsx"), [CHILD_SCRIPT, eventId], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(options.pauseAfterApply
        ? { ADMIN_CHAOS_PROJECTOR_PAUSE_AFTER_APPLY_EVENT_ID: eventId }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForReady(child: ChildProcess, stdout: () => string, stderr: () => string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (stdout().includes("ADMIN_CHAOS_PROJECTOR_AFTER_APPLY_READY")) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`projector child exited before fault point: ${stderr() || stdout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("projector child did not reach the after-apply fault point");
}

describe.runIf(process.env.RUN_ADMIN_REAL_PROCESS_CHAOS === "1")(
  "real canonical projector process recovery",
  () => {
    const prefix = `real-projector-chaos-${randomUUID()}`;
    const userId = `${prefix}-user`;
    const eventId = `${prefix}-event`;
    const sourceEventId = `${prefix}-source`;

    afterAll(async () => {
      await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId } });
      await prisma.customerSignupFact.deleteMany({ where: { userId } });
      await prisma.analyticsEvent.deleteMany({ where: { id: eventId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    });

    it("rolls back a killed in-flight transaction and applies exactly once after a fresh process restart", async () => {
      await prisma.user.create({
        data: { id: userId, email: `${userId}@example.test`, role: "user", status: "active" },
      });
      await prisma.analyticsEvent.create({
        data: {
          id: eventId,
          name: "customer.signup.completed.v2",
          props: { userId },
          sourceService: "main",
          sourceEventId,
          schemaVersion: 2,
          occurredAt: new Date("2026-07-12T00:00:00.000Z"),
          ingestedAt: new Date("2026-07-12T00:00:01.000Z"),
          environment: "production",
          dataClass: "customer",
          trustClass: "canonical",
          actor: { userId, isInternal: false },
          context: {},
        },
      });

      const fault = await spawnProjectorChild(eventId, { pauseAfterApply: true });
      try {
        await waitForReady(fault.child, fault.stdout, fault.stderr);
        await expect(killAndWait(fault.child)).resolves.toEqual({ code: null, signal: "SIGKILL" });
      } finally {
        if (fault.child.exitCode === null && fault.child.signalCode === null) await killAndWait(fault.child);
      }
      expect(fault.stderr()).toBe("");

      await expect(prisma.customerSignupFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.metricProjectionReceipt.count({ where: { sourceEventId } })).resolves.toBe(0);

      const recovery = await spawnProjectorChild(eventId, { pauseAfterApply: false });
      await expect(waitForExit(recovery.child)).resolves.toEqual({ code: 0, signal: null });
      expect(recovery.stderr()).toBe("");
      expect(JSON.parse(recovery.stdout())).toMatchObject({ status: "applied", factType: "customer_signup" });

      const replay = await spawnProjectorChild(eventId, { pauseAfterApply: false });
      await expect(waitForExit(replay.child)).resolves.toEqual({ code: 0, signal: null });
      expect(replay.stderr()).toBe("");
      expect(JSON.parse(replay.stdout())).toMatchObject({ status: "duplicate", factType: "customer_signup" });

      await expect(prisma.customerSignupFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.metricProjectionReceipt.count({ where: { sourceEventId } })).resolves.toBe(1);
    }, 20_000);
  },
);
