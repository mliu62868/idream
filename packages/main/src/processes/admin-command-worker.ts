import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-validation";
import {
  dispatchDueReleaseMonitors,
  dispatchStaleReleaseRoutes,
} from "@/server/modules/admin-v2/characters/release-monitor";
import { dispatchStaleUnknownGenerationRequests } from "@/server/modules/admin-v2/jobs/stale-unknown-dispatcher";
import { ADMIN_COMMAND_TYPES, executeAcceptedAdminCommand } from "@/server/modules/admin-v2/commands/executor";
import { reconcileExpiredCommandLeases } from "@/server/modules/admin-v2/shared/control-plane-command";
import {
  verifyCreativeRetryCommands,
} from "@/server/modules/admin-v2/creative/retry-executor";
import { dispatchGenerationAttemptOutbox } from "@/server/modules/generation/generation-attempt-authority";
import {
  verifyIncidentActionPlanCommands,
} from "@/server/modules/admin-v2/incidents/action-executor";
import { dispatchGenerationIncidentCorrelation } from "@/server/modules/admin-v2/incidents/service";
import { isProcessEntrypoint } from "./process-entrypoint";

const IDLE_DELAY_MS = 1_000;
const BUSY_DELAY_MS = 50;
const RECONCILE_INTERVAL_MS = 60_000;
const CLOSE_TIMEOUT_MS = 30_000;

const stopping = new AbortController();
let lastReconcileAt = 0;
// SPEC: unknown 生成结算的巡检节流。
// INTENT: 它的宽限期是 30 分钟，没有任何理由挤在主循环的忙碌间隔里跑 ——
//   那个间隔是 50ms，等于每秒扫二十次 generation_attempts。与同循环里的
//   lease 回收用同一套节流约定。
let lastStaleUnknownSweepAt = 0;
const STALE_UNKNOWN_SWEEP_INTERVAL_MS = 60_000;
let routeQualificationCursor: string | null = null;

export function shouldDispatchStaleUnknownSweep(
  lastSweepAt: number,
  now: number,
  intervalMs = STALE_UNKNOWN_SWEEP_INTERVAL_MS,
) {
  return now - lastSweepAt >= intervalMs;
}

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
  return executeAcceptedAdminCommand(command.id, { db, ...input });
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
    readonly signal?: AbortSignal;
  },
) {
  const now = input.now ?? new Date();
  input.signal?.throwIfAborted();
  const routeQualifications = await dispatchStaleReleaseRoutes(db, {
    currentPolicyVersion: input.routeQualificationPolicyVersion ?? CHARACTER_RELEASE_POLICY_VERSION,
    currentEvaluatorVersion: input.routeQualificationEvaluatorVersion ?? env.GENERATION_ROUTE_EVALUATOR_VERSION,
    now,
    limit: input.limit,
    releaseIds: input.routeQualificationReleaseIds,
    cursorId: input.routeQualificationReleaseIds ? undefined : routeQualificationCursor ?? undefined,
  });
  if (!input.routeQualificationReleaseIds) routeQualificationCursor = routeQualifications.nextCursor;
  input.signal?.throwIfAborted();
  const releaseMonitors = await dispatchDueReleaseMonitors(db, {
    workerId: input.workerId,
    now,
    limit: input.limit,
    signal: input.signal,
  });
  if (releaseMonitors.failed > 0) {
    logger.error(
      { workerId: input.workerId, failures: releaseMonitors.failures },
      "due Release Monitor dispatch partially failed",
    );
  }
  input.signal?.throwIfAborted();
  const commands = await db.controlPlaneCommand.findMany({
    where: {
      status: "accepted",
      commandType: { in: ADMIN_COMMAND_TYPES },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
    select: { id: true, commandType: true },
  });
  let succeeded = 0;
  let failed = 0;
  let verifying = 0;
  for (const command of commands) {
    input.signal?.throwIfAborted();
    const result = await executeAdminCommand(db, command, { workerId: input.workerId, now });
    if (result.status === "succeeded") succeeded += 1;
    else if (["accepted", "running", "verifying"].includes(result.status)) verifying += 1;
    else failed += 1;
  }
  input.signal?.throwIfAborted();
  const dispatched = await dispatchGenerationAttemptOutbox(db, { limit: input.limit, signal: input.signal });
  input.signal?.throwIfAborted();
  const incidentCorrelation = await dispatchGenerationIncidentCorrelation(db, { limit: input.limit });
  input.signal?.throwIfAborted();
  const verified = await verifyCreativeRetryCommands(db, { limit: input.limit });
  input.signal?.throwIfAborted();
  const incidentActions = await verifyIncidentActionPlanCommands(db, { limit: input.limit });
  return {
    examined: commands.length,
    succeeded,
    failed,
    verifying,
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
      commandType: { in: ADMIN_COMMAND_TYPES },
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
  while (!stopping.signal.aborted) {
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
        if (stopping.signal.aborted) break;
        const reconciled = await reconcileExpiredCommandLeases(prisma, new Date(now), {
          commandIds: [chaos.commandId],
        });
        if (reconciled.examined > 0) logger.info(reconciled, "admin command lease reconciled");
      } else {
        // Finish the current authority operation on shutdown, without claiming
        // another command or starting a new dispatch responsibility.
        const result = await drainAdminCommands(prisma, { workerId, signal: stopping.signal });
        processed = result.examined + result.releaseMonitors.claimed + result.routeQualifications.examined;
      }
      if (stopping.signal.aborted) break;
      if (!chaos && now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
        lastReconcileAt = now;
        const reconciled = await reconcileExpiredCommandLeases(prisma, new Date(now));
        if (reconciled.examined > 0) logger.info(reconciled, "admin command leases reconciled");
      }
      if (stopping.signal.aborted) break;
      if (!chaos && shouldDispatchStaleUnknownSweep(lastStaleUnknownSweepAt, now)) {
        lastStaleUnknownSweepAt = now;
        const settled = await dispatchStaleUnknownGenerationRequests(prisma, {
          now: new Date(now),
        });
        if (settled.settled > 0 || settled.skipped > 0) {
          logger.info(settled, "stale unknown Generation Requests settled");
        }
      }
    } catch (error) {
      if (stopping.signal.aborted && error === stopping.signal.reason) break;
      logger.error({ error, workerId }, "admin command worker iteration failed");
    }
    if (stopping.signal.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, processed > 0 ? BUSY_DELAY_MS : IDLE_DELAY_MS));
  }
}

export function stopAdminCommandWorkerLoop() {
  stopping.abort();
}

export function isDirectAdminCommandWorkerInvocation(
  argvEntry = process.argv[1],
  pmExecPath = process.env["pm_exec_path"],
) {
  return isProcessEntrypoint(
    ["admin-command-worker.ts", "admin-command-worker.js"],
    { argvEntry, pmExecPath },
  );
}

if (isDirectAdminCommandWorkerInvocation()) {
  const loop = runAdminCommandWorkerLoop();
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    if (shutdownPromise) return;
    stopAdminCommandWorkerLoop();
    shutdownPromise = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          loop,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Admin command worker drain timed out")), CLOSE_TIMEOUT_MS);
          }),
        ]);
        process.exit(0);
      } catch (error) {
        logger.error({ error, timeoutMs: CLOSE_TIMEOUT_MS }, "admin command worker shutdown failed; unfinished work retains its lease");
        process.exit(1);
      } finally {
        clearTimeout(deadline);
      }
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  void loop.catch((error) => {
    if (shutdownPromise) return;
    logger.error({ error }, "admin command worker exited unexpectedly");
    process.exit(1);
  });
}
