import { prisma } from "@/server/lib/db";
import { projectCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/projector";

function projectorChaosHook(eventId: string) {
  const pauseEventId = process.env.ADMIN_CHAOS_PROJECTOR_PAUSE_AFTER_APPLY_EVENT_ID;
  const mode = process.env.ADMIN_CHAOS_PROJECTOR_MODE;
  if (!pauseEventId && !mode) return undefined;
  if (
    process.env.APP_ENV !== "test" ||
    mode !== "process_kill_recovery" ||
    pauseEventId !== eventId
  ) {
    throw new Error("Projector process chaos hook is restricted to the explicit test recovery mode");
  }
  return async (appliedEventId: string) => {
    if (appliedEventId !== eventId) return;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write("ADMIN_CHAOS_PROJECTOR_AFTER_APPLY_READY\n", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await new Promise<never>(() => undefined);
  };
}

async function main() {
  const eventId = process.argv[2];
  if (!eventId) throw new Error("canonical AnalyticsEvent ID is required");
  const event = await prisma.analyticsEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (!event.sourceEventId) throw new Error("canonical AnalyticsEvent sourceEventId is required");
  if (!event.occurredAt || !event.ingestedAt) {
    throw new Error("canonical AnalyticsEvent timestamps are required");
  }
  const result = await projectCanonicalMetricEvent(
    prisma,
    {
      ...event,
      sourceEventId: event.sourceEventId,
      occurredAt: event.occurredAt,
      ingestedAt: event.ingestedAt,
    },
    { afterApply: projectorChaosHook(event.id) },
  );
  process.stdout.write(JSON.stringify(result));
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
