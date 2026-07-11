import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
import { executeCharacterReleaseCommand } from "@/server/modules/admin-v2/characters/release-executor";
import { executeAcceptedAdminCommand } from "@/server/modules/admin-v2/commands/executor";
import { reconcileExpiredCommandLeases } from "@/server/modules/admin-v2/shared/control-plane-command";

const COMMAND_TYPES = [
  "character.release.schedule",
  "character.release.publish",
  "character.release.rollback",
  "character.serving.pause",
  "character.serving.resume",
  "incident.resolve",
  "case.close",
] as const;
const CHARACTER_COMMAND_TYPES = new Set<string>([
  "character.release.schedule",
  "character.release.publish",
  "character.release.rollback",
  "character.serving.pause",
  "character.serving.resume",
]);
const IDLE_DELAY_MS = 1_000;
const BUSY_DELAY_MS = 50;
const RECONCILE_INTERVAL_MS = 60_000;

let running = true;
let lastReconcileAt = 0;

export async function drainAdminCommands(
  db: PrismaClient,
  input: { readonly workerId: string; readonly limit?: number },
) {
  const commands = await db.controlPlaneCommand.findMany({
    where: { status: "accepted", commandType: { in: [...COMMAND_TYPES] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
    select: { id: true, commandType: true },
  });
  let succeeded = 0;
  let failed = 0;
  for (const command of commands) {
    const result = CHARACTER_COMMAND_TYPES.has(command.commandType)
      ? await executeCharacterReleaseCommand(db, {
          commandId: command.id,
          workerId: input.workerId,
        })
      : await executeAcceptedAdminCommand(command.id);
    if (result.status === "succeeded") succeeded += 1;
    else failed += 1;
  }
  return { examined: commands.length, succeeded, failed };
}

export const drainCharacterReleaseCommands = drainAdminCommands;

export async function runAdminCommandWorkerLoop() {
  const workerId = `admin-command-worker-${randomUUID()}`;
  logger.info({ workerId }, "admin command worker started");
  while (running) {
    let processed = 0;
    try {
      const result = await drainAdminCommands(prisma, { workerId });
      processed = result.examined;
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
