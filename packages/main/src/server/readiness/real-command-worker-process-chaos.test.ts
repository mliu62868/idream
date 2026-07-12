import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser } from "@/server/test/helpers";
import { acceptControlPlaneCommand } from "@/server/modules/admin-v2/shared/control-plane-command";

const WORKER_ENTRYPOINT = "src/processes/admin-command-worker.ts";
const READY_MARKER = "ADMIN_CHAOS_COMMAND_AFTER_CLAIM_READY";

interface SpawnedWorker {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`admin command worker ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function killAndWait(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const exited = waitForExit(child, signal === "SIGTERM" ? 1_000 : 5_000);
  if (!child.kill(signal)) {
    void exited.catch(() => undefined);
    throw new Error(`failed to ${signal} admin command worker ${child.pid ?? "unknown"}`);
  }
  try {
    return await exited;
  } catch (error) {
    if (signal !== "SIGTERM" || child.exitCode !== null || child.signalCode !== null) throw error;
    const killed = waitForExit(child, 5_000);
    if (!child.kill("SIGKILL")) {
      void killed.catch(() => undefined);
      throw new Error(`failed to SIGKILL admin command worker ${child.pid ?? "unknown"} after SIGTERM timeout`, {
        cause: error,
      });
    }
    return killed;
  }
}

function spawnWorker(commandId: string, options: { readonly pauseAfterClaim: boolean }): SpawnedWorker {
  const child = spawn(join(process.cwd(), "node_modules/.bin/tsx"), [WORKER_ENTRYPOINT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOG_LEVEL: "silent",
      ADMIN_CHAOS_COMMAND_MODE: "process_kill_recovery",
      ADMIN_CHAOS_COMMAND_ID: commandId,
      ADMIN_CHAOS_COMMAND_LEASE_MS: "250",
      ...(options.pauseAfterClaim
        ? { ADMIN_CHAOS_COMMAND_PAUSE_AFTER_CLAIM_ID: commandId }
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

async function waitForClaimPause(worker: SpawnedWorker) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (worker.stdout().includes(READY_MARKER)) return;
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`admin command worker exited before claim pause: ${worker.stderr() || worker.stdout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`admin command worker did not reach claim pause: ${worker.stderr() || worker.stdout()}`);
}

async function waitForCommandSuccess(commandId: string, worker: SpawnedWorker) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const command = await prisma.controlPlaneCommand.findUnique({ where: { id: commandId } });
    if (command?.status === "succeeded") return command;
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`recovery worker exited before command success: ${worker.stderr() || worker.stdout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`recovery worker did not complete command: ${worker.stderr() || worker.stdout()}`);
}

describe.runIf(process.env.RUN_ADMIN_REAL_COMMAND_WORKER_CHAOS === "1")(
  "real admin command worker process recovery",
  () => {
    const prefix = `real-command-worker-chaos-${randomUUID()}`;
    const actorId = `${prefix}-actor`;
    const characterId = `${prefix}-character`;
    const projectId = `${prefix}-project`;
    const contentId = `${prefix}-content`;
    const revisionId = `${prefix}-revision`;
    const releaseId = `${prefix}-release`;
    const requestId = `${prefix}-request`;
    const unrelatedCommandId = `${prefix}-unrelated-command`;
    const workers = new Set<ChildProcess>();
    let commandId: string | null = null;

    afterAll(async () => {
      const cleanupErrors: unknown[] = [];
      for (const child of workers) {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            await killAndWait(child, "SIGKILL");
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
      if (commandId) {
        await prisma.controlPlaneCommandAttempt.deleteMany({
          where: { commandId: { in: [commandId, unrelatedCommandId] } },
        });
        await prisma.controlPlaneCommand.deleteMany({
          where: { id: { in: [commandId, unrelatedCommandId] } },
        });
      }
      await prisma.characterReleaseEvent.deleteMany({ where: { characterId } });
      await prisma.adminAuditLog.deleteMany({ where: { actorId } });
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [characterId, releaseId] } } });
      await prisma.releaseMonitor.deleteMany({ where: { releaseId } });
      await prisma.characterServing.deleteMany({ where: { characterId } });
      await prisma.characterRelease.deleteMany({ where: { id: releaseId } });
      await prisma.characterRevision.deleteMany({ where: { id: revisionId } });
      await prisma.characterContentVersion.deleteMany({ where: { id: contentId } });
      await prisma.characterProject.deleteMany({ where: { id: projectId } });
      await prisma.character.deleteMany({ where: { id: characterId } });
      await prisma.user.deleteMany({ where: { id: actorId } });
      await prisma.$disconnect();
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "failed to stop all admin command worker children");
      }
    });

    it("reclaims a killed post-claim pause and commits pause state plus evidence exactly once", async () => {
      await createUser({ id: actorId, role: "admin" });
      await createCharacter({
        id: characterId,
        name: "Command worker chaos character",
        status: "approved",
        visibility: "public",
      });
      await prisma.characterProject.create({
        data: {
          id: projectId,
          characterId,
          phase: "live",
          audience: {},
          successCriteria: {},
          activeKey: `official:${characterId}`,
        },
      });
      await prisma.characterContentVersion.create({
        data: {
          id: contentId,
          characterId,
          version: 1,
          contentHash: `${prefix}-content-hash`,
          personaSnapshot: {},
          openingSnapshot: {},
          appearanceSnapshot: {},
          sourceType: "admin_command_worker_chaos_fixture",
          createdById: actorId,
        },
      });
      await prisma.characterRevision.create({
        data: {
          id: revisionId,
          projectId,
          revision: 1,
          characterContentVersionId: contentId,
          projectSnapshot: {},
          createdById: actorId,
        },
      });
      await prisma.characterRelease.create({
        data: {
          id: releaseId,
          projectId,
          revisionId,
          characterContentVersionId: contentId,
          generationProvenance: {},
          releasePlacementManifest: { placements: [] },
          snapshotHash: `${prefix}-release-hash`,
          readiness: "ready",
          status: "published",
          publishedAt: new Date("2026-07-12T00:00:00.000Z"),
        },
      });
      await prisma.characterServing.create({
        data: {
          id: `${prefix}-serving`,
          characterId,
          currentReleaseId: releaseId,
          state: "live",
          version: 1,
        },
      });
      const accepted = await acceptControlPlaneCommand(prisma, {
        environment: "test",
        actor: { id: actorId, role: "admin" },
        idempotencyKey: `${prefix}-pause`,
        commandType: "character.serving.pause",
        target: { type: "character_serving", id: characterId },
        expectedVersion: 1,
        payload: { reason: "real command worker process recovery" },
        retryMode: "idempotent",
        reason: "Exercise lease recovery after a process kill",
        requestId,
      });
      commandId = accepted.commandId;
      await prisma.controlPlaneCommand.create({
        data: {
          id: unrelatedCommandId,
          scope: `${prefix}:unrelated`,
          idempotencyKey: `${prefix}-unrelated`,
          commandType: "character.serving.pause",
          targetType: "character_serving",
          targetId: `${prefix}-unrelated-target`,
          actorId,
          requestId: `${prefix}-unrelated-request`,
          requestHash: `${prefix}-unrelated-hash`,
          requestPayload: {},
          expectedVersion: 1,
          retryMode: "idempotent",
          status: "running",
          leaseOwner: `${prefix}-dead-worker`,
          leaseExpiresAt: new Date("2026-07-11T00:00:00.000Z"),
          heartbeatAt: new Date("2026-07-11T00:00:00.000Z"),
          attemptCount: 1,
          maxAttempts: 3,
        },
      });
      await prisma.controlPlaneCommandAttempt.create({
        data: {
          commandId: unrelatedCommandId,
          attemptNo: 1,
          status: "running",
          startedAt: new Date("2026-07-11T00:00:00.000Z"),
        },
      });

      const fault = spawnWorker(commandId, { pauseAfterClaim: true });
      workers.add(fault.child);
      try {
        await waitForClaimPause(fault);
        await expect(prisma.controlPlaneCommand.findUnique({ where: { id: commandId } })).resolves.toMatchObject({
          status: "running",
          retryMode: "idempotent",
          attemptCount: 1,
        });
        await expect(prisma.characterServing.findUnique({ where: { characterId } })).resolves.toMatchObject({
          state: "live",
          version: 1,
        });
        await expect(prisma.characterReleaseEvent.count({ where: { commandId } })).resolves.toBe(0);
        await expect(killAndWait(fault.child, "SIGKILL")).resolves.toEqual({ code: null, signal: "SIGKILL" });
      } finally {
        if (fault.child.exitCode === null && fault.child.signalCode === null) {
          await killAndWait(fault.child, "SIGKILL");
        }
      }
      expect(fault.stderr()).toBe("");

      await new Promise((resolve) => setTimeout(resolve, 300));
      const recovery = spawnWorker(commandId, { pauseAfterClaim: false });
      workers.add(recovery.child);
      const command = await waitForCommandSuccess(commandId, recovery);
      await expect(killAndWait(recovery.child, "SIGTERM")).resolves.toEqual({ code: 0, signal: null });
      expect(recovery.stderr()).toBe("");

      expect(command).toMatchObject({
        status: "succeeded",
        retryMode: "idempotent",
        attemptCount: 2,
        result: { releaseId, servingState: "paused", verificationState: "passed" },
      });
      await expect(prisma.controlPlaneCommand.count({ where: { id: commandId } })).resolves.toBe(1);
      await expect(prisma.controlPlaneCommandAttempt.findMany({
        where: { commandId },
        orderBy: { attemptNo: "asc" },
        select: { attemptNo: true, status: true, error: true },
      })).resolves.toEqual([
        { attemptNo: 1, status: "failed", error: { code: "lease_expired", leaseOwner: expect.any(String) } },
        { attemptNo: 2, status: "succeeded", error: null },
      ]);
      await expect(prisma.characterServing.findUnique({ where: { characterId } })).resolves.toMatchObject({
        currentReleaseId: releaseId,
        state: "paused",
        version: 2,
      });
      await expect(prisma.character.findUnique({ where: { id: characterId } })).resolves.toMatchObject({
        status: "archived",
        visibility: "private",
      });
      await expect(prisma.characterRelease.findUnique({ where: { id: releaseId } })).resolves.toMatchObject({
        readiness: "ready",
        version: 1,
      });
      await expect(prisma.releaseMonitor.count({ where: { releaseId } })).resolves.toBe(0);
      await expect(prisma.controlPlaneCommand.findUnique({ where: { id: unrelatedCommandId } })).resolves.toMatchObject({
        status: "running",
        leaseOwner: `${prefix}-dead-worker`,
        attemptCount: 1,
      });
      await expect(prisma.controlPlaneCommandAttempt.findUnique({
        where: { commandId_attemptNo: { commandId: unrelatedCommandId, attemptNo: 1 } },
      })).resolves.toMatchObject({ status: "running", finishedAt: null });
      await expect(prisma.adminAuditLog.count({
        where: { actorId, action: "character.serving.pause.executed", targetId: releaseId },
      })).resolves.toBe(1);
      await expect(prisma.adminAuditLog.count({
        where: { actorId, action: "character.serving.pause", targetId: characterId, requestId },
      })).resolves.toBe(1);
      await expect(prisma.adminAuditLog.count({ where: { actorId } })).resolves.toBe(2);
      await expect(prisma.mainOutboxEvent.count({
        where: { eventType: "character.serving.paused.v2", aggregateId: releaseId },
      })).resolves.toBe(1);
      await expect(prisma.mainOutboxEvent.count({
        where: { eventType: "admin.command.accepted.v2", aggregateId: characterId },
      })).resolves.toBe(1);
      await expect(prisma.mainOutboxEvent.count({
        where: { aggregateId: { in: [characterId, releaseId] } },
      })).resolves.toBe(2);
      await expect(prisma.characterReleaseEvent.count({
        where: { commandId, type: "character.serving.paused" },
      })).resolves.toBe(1);
    }, 25_000);
  },
);
