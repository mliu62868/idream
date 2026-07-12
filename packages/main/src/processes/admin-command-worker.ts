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
    where: { status: "accepted", commandType: { in: [...COMMAND_TYPES] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
    select: { id: true, commandType: true },
  });
  let succeeded = 0;
  let failed = 0;
  let verifying = 0;
  for (const command of commands) {
    const result = command.commandType === "creative.run.retry_failed"
      ? await executeCreativeRetryCommand(db, { commandId: command.id, workerId: input.workerId })
      : command.commandType === "incident.action_plan.execute"
      ? await executeIncidentActionPlanCommand(db, { commandId: command.id, workerId: input.workerId })
      : CHARACTER_COMMAND_TYPES.has(command.commandType)
      ? await executeCharacterReleaseCommand(db, {
          commandId: command.id,
          workerId: input.workerId,
          now,
        })
      : await executeAcceptedAdminCommand(command.id);
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

export const drainCharacterReleaseCommands = drainAdminCommands;

export async function runAdminCommandWorkerLoop() {
  const workerId = `admin-command-worker-${randomUUID()}`;
  logger.info({ workerId }, "admin command worker started");
  while (running) {
    let processed = 0;
    try {
      const result = await drainAdminCommands(prisma, { workerId });
      processed = result.examined + result.releaseMonitors.claimed + result.routeQualifications.examined;
      const now = Date.now();
      if (now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const shutdown = () => {
    stopAdminCommandWorkerLoop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  void runAdminCommandWorkerLoop();
}
