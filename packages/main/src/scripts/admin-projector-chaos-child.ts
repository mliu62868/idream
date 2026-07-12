import { prisma } from "@/server/lib/db";
import { projectCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/projector";

async function main() {
  const eventId = process.argv[2];
  if (!eventId) throw new Error("canonical AnalyticsEvent ID is required");
  const event = await prisma.analyticsEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (!event.sourceEventId) throw new Error("canonical AnalyticsEvent sourceEventId is required");
  if (!event.occurredAt || !event.ingestedAt) {
    throw new Error("canonical AnalyticsEvent timestamps are required");
  }
  const result = await projectCanonicalMetricEvent(prisma, {
    ...event,
    sourceEventId: event.sourceEventId,
    occurredAt: event.occurredAt,
    ingestedAt: event.ingestedAt,
  });
  process.stdout.write(JSON.stringify(result));
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
