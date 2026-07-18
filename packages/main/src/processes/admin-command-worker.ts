import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";
import {
  CHARACTER_RELEASE_POLICY_VERSION,
  executeCharacterReleaseCommand,
} from "@/server/modules/admin-v2/characters/release-executor";
import {
  dispatchDueReleaseMonitors,
  dispatchStaleReleaseRoutes,
} from "@/server/modules/admin-v2/characters/release-monitor";
import { dispatchDueCharacterReleasePublishes } from "@/server/modules/admin-v2/characters/scheduled-release-dispatcher";
import { executeAcceptedAdminCommand } from "@/server/modules/admin-v2/commands/executor";
import { reconcileExpiredCommandLeases } from "@/server/modules/admin-v2/shared/control-plane-command";
import {
  dispatchCreativeRetryOutbox,
  executeCreativeRetryCommand,
  verifyCreativeRetryCommands,
} from "@/server/modules/admin-v2/creative/retry-executor";
import {
  executeIncidentActionPlanCommand,
  verifyIncidentActionPlanCommands,
} from "@/server/modules/admin-v2/incidents/action-executor";
import { dispatchGenerationIncidentCorrelation } from "@/server/modules/admin-v2/incidents/service";

const COMMAND_TYPES = [
  "character.release.schedule",
  "character.release.publish",
  "character.release.rollback",
  "character.serving.pause",
  "character.serving.resume",
  "character.serving.retire",
  "incident.resolve",
  "incident.action_plan.execute",
  "case.close",
  "chat.session_release.migrate",
  "creative.run.retry_failed",
] as const;
const CHARACTER_COMMAND_TYPES = new Set<string>([
  "character.release.schedule",
  "character.release.publish",
  "character.release.rollback",
  "character.serving.pause",
  "character.serving.resume",
  "character.serving.retire",
]);
const IDLE_DELAY_MS = 1_000;
const BUSY_DELAY_MS = 50;
const RECONCILE_INTERVAL_MS = 60_000;

let running = true;
let lastReconcileAt = 0;
let routeQualificationCursor: string | null = null;

interface AdminCommandChaosConfig {
  readonly commandId: string;
  readonly leaseMs: number;
  readonly pauseAfterClaim: boolean;
}

function adminCommandChaosConfig(): AdminCommandChaosConfig | null {
  const mode = process.env.ADMIN_CHAOS_COMMAND_MODE?.trim();
  const commandId = process.env.ADMIN_CHAOS_COMMAND_ID?.trim();
  const pauseCommandId = process.env.ADMIN_CHAOS_COMMAND_PAUSE_AFTER_CLAIM_ID?.trim();
  const leaseMs = Number(process.env.ADMIN_CHAOS_COMMAND_LEASE_MS);
  const hasChaosInput = Boolean(mode || commandId || pauseCommandId || process.env.ADMIN_CHAOS_COMMAND_LEASE_MS);
  if (!hasChaosInput) return null;
  if (env.APP_ENV !== "test") {
    throw new Error("ADMIN_CHAOS_COMMAND_* is restricted to APP_ENV=test");
  }
  if (mode !== "process_kill_recovery") {
    throw new Error("ADMIN_CHAOS_COMMAND_MODE must be process_kill_recovery");
  }
  if (!commandId) throw new Error("ADMIN_CHAOS_COMMAND_ID is required in command chaos mode");
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("ADMIN_CHAOS_COMMAND_LEASE_MS must be a positive integer");
  }
  if (pauseCommandId && pauseCommandId !== commandId) {
    throw new Error("ADMIN_CHAOS_COMMAND_PAUSE_AFTER_CLAIM_ID must match ADMIN_CHAOS_COMMAND_ID");
  }
  return { commandId, leaseMs, pauseAfterClaim: pauseCommandId === commandId };
}

async function pauseAfterClaimForAdminChaos(commandId: string) {
  // The claim transaction is durable, while the domain transaction below has
  // not started. A process kill here exercises lease recovery without a
  // partially committed CharacterServing transition.
  process.stdout.write(`ADMIN_CHAOS_COMMAND_AFTER_CLAIM_READY ${commandId}\n`);
  await new Promise<void>(() => {
    setInterval(() => undefined, 60_000);
  });
}

async function executeAdminCommand(
  db: PrismaClient,
  command: { readonly id: string; readonly commandType: string },
  input: {
    readonly workerId: string;
    readonly now: Date;
    readonly leaseMs?: number;
    readonly afterClaim?: (commandId: string) => Promise<void>;
  },
) {
  return command.commandType === "creative.run.retry_failed"
    ? executeCreativeRetryCommand(db, { commandId: command.id, workerId: input.workerId })
    : command.commandType === "incident.action_plan.execute"
    ? executeIncidentActionPlanCommand(db, { commandId: command.id, workerId: input.workerId })
    : CHARACTER_COMMAND_TYPES.has(command.commandType)
    ? executeCharacterReleaseCommand(db, {
        commandId: command.id,
        workerId: input.workerId,
        now: input.now,
        leaseMs: input.leaseMs,
        afterClaim: input.afterClaim,
      })
    : executeAcceptedAdminCommand(command.id);
}

export async function drainAdminCommands(
  db: PrismaClient,
  input: {
    readonly workerId: string;
    readonly limit?: number;
    readonly environment?: string;
    readonly now?: Date;
    readonly routeQualificationPolicyVersion?: string;
    readonly routeQualificationEvaluatorVersion?: string;
    readonly routeQualificationReleaseIds?: readonly string[];
  },
) {
  const now = input.now ?? new Date();
  const routeQualifications = await dispatchStaleReleaseRoutes(db, {
    currentPolicyVersion: input.routeQualificationPolicyVersion ?? CHARACTER_RELEASE_POLICY_VERSION,
    currentEvaluatorVersion: input.routeQualificationEvaluatorVersion ?? env.GENERATION_ROUTE_EVALUATOR_VERSION,
    now,
    limit: input.limit,
    releaseIds: input.routeQualificationReleaseIds,
    cursorId: input.routeQualificationReleaseIds ? undefined : routeQualificationCursor ?? undefined,
  });
  if (!input.routeQualificationReleaseIds) routeQualificationCursor = routeQualifications.nextCursor;
  const scheduledReleases = await dispatchDueCharacterReleasePublishes(db, {
    dispatcherId: input.workerId,
    environment: input.environment,
    now,
    limit: input.limit,
  });
  if (scheduledReleases.failed > 0) {
    logger.error(
      { workerId: input.workerId, failures: scheduledReleases.failures },
      "due Character Release dispatch partially failed",
    );
  }
  const releaseMonitors = await dispatchDueReleaseMonitors(db, {
    workerId: input.workerId,
    now,
    limit: input.limit,
  });
  if (releaseMonitors.failed > 0) {
    logger.error(
      { workerId: input.workerId, failures: releaseMonitors.failures },
      "due Release Monitor dispatch partially failed",
    );
  }
  const commands = await db.controlPlaneCommand.findMany({
    where: {
      status: "accepted",
      commandType: { in: [...COMMAND_TYPES] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
    select: { id: true, commandType: true },
  });
  let succeeded = 0;
  let failed = 0;
  let verifying = 0;
  for (const command of commands) {
    const result = await executeAdminCommand(db, command, { workerId: input.workerId, now });
    if (result.status === "succeeded") succeeded += 1;
    else if (["accepted", "running", "verifying"].includes(result.status)) verifying += 1;
    else failed += 1;
  }
  const dispatched = await dispatchCreativeRetryOutbox(db, { limit: input.limit });
  const incidentCorrelation = await dispatchGenerationIncidentCorrelation(db, { limit: input.limit });
  const verified = await verifyCreativeRetryCommands(db, { limit: input.limit });
  const incidentActions = await verifyIncidentActionPlanCommands(db, { limit: input.limit });
  return {
    examined: commands.length,
    succeeded,
    failed,
    verifying,
    scheduledReleases,
    routeQualifications,
    releaseMonitors,
    dispatched,
    incidentCorrelation,
    verified,
    incidentActions,
  };
}

export async function drainTargetAdminCommand(
  db: PrismaClient,
  input: {
    readonly commandId: string;
    readonly workerId: string;
    readonly leaseMs: number;
    readonly afterClaim?: (commandId: string) => Promise<void>;
    readonly now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const command = await db.controlPlaneCommand.findFirst({
    where: {
      id: input.commandId,
      status: "accepted",
      commandType: { in: [...COMMAND_TYPES] },
    },
    select: { id: true, commandType: true },
  });
  if (!command) return { examined: 0, succeeded: 0, failed: 0, verifying: 0 };
  const result = await executeAdminCommand(db, command, {
    workerId: input.workerId,
    now,
    leaseMs: input.leaseMs,
    afterClaim: input.afterClaim,
  });
  return {
    examined: 1,
    succeeded: result.status === "succeeded" ? 1 : 0,
    failed: ["accepted", "running", "verifying", "succeeded"].includes(result.status) ? 0 : 1,
    verifying: ["accepted", "running", "verifying"].includes(result.status) ? 1 : 0,
  };
}

export const drainCharacterReleaseCommands = drainAdminCommands;

export async function runAdminCommandWorkerLoop() {
  const workerId = `admin-command-worker-${randomUUID()}`;
  const chaos = adminCommandChaosConfig();
  logger.info({ workerId }, "admin command worker started");
  while (running) {
    let processed = 0;
    try {
      const now = Date.now();
      if (chaos) {
        const result = await drainTargetAdminCommand(prisma, {
          commandId: chaos.commandId,
          workerId,
          leaseMs: chaos.leaseMs,
          afterClaim: chaos.pauseAfterClaim ? pauseAfterClaimForAdminChaos : undefined,
          now: new Date(now),
        });
        processed = result.examined;
        const reconciled = await reconcileExpiredCommandLeases(prisma, new Date(now), {
          commandIds: [chaos.commandId],
        });
        if (reconciled.examined > 0) logger.info(reconciled, "admin command lease reconciled");
      } else {
        const result = await drainAdminCommands(prisma, { workerId });
        processed = result.examined + result.releaseMonitors.claimed + result.routeQualifications.examined;
      }
      if (!chaos && now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
        lastReconcileAt = now;
        const reconciled = await reconcileExpiredCommandLeases(prisma, new Date(now));
        if (reconciled.examined > 0) logger.info(reconciled, "admin command leases reconciled");
      }
    } catch (error) {
      logger.error({ error, workerId }, "admin command worker iteration failed");
    }
    await new Promise((resolve) => setTimeout(resolve, processed > 0 ? BUSY_DELAY_MS : IDLE_DELAY_MS));
  }
}

export function stopAdminCommandWorkerLoop() {
  running = false;
}

export function isDirectAdminCommandWorkerInvocation(argvEntry = process.argv[1]) {
  const normalized = argvEntry?.replaceAll("\\", "/") ?? "";
  return normalized.endsWith("/admin-command-worker.ts") ||
    normalized.endsWith("/admin-command-worker.js");
}

if (isDirectAdminCommandWorkerInvocation()) {
  const shutdown = () => {
    stopAdminCommandWorkerLoop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  void runAdminCommandWorkerLoop();
}
