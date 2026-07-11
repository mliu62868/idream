import { setGauge } from "@idream/shared";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { auditAdminCutoverInvariants } from "@/server/modules/admin-v2/reconciliation/invariants";

const outboxQueues = [
  { queue: "chat", eventTypes: Object.values(MAIN_TO_CHAT_EVENTS) },
  { queue: "product_event", eventTypes: ["product.event.persisted.v2"] },
  { queue: "generation_manifest", eventTypes: ["generation.manifest.accepted.v1"] },
] as const;

export async function collectAdminOperationalMetrics(
  db: PrismaClient = prisma,
  now = new Date(),
) {
  const [invariants, oldestByQueue, incidents] = await Promise.all([
    auditAdminCutoverInvariants(db, now),
    Promise.all(outboxQueues.map(async ({ queue, eventTypes }) => ({
      queue,
      oldest: await db.mainOutboxEvent.findFirst({
        where: {
          eventType: { in: [...eventTypes] },
          status: { in: ["pending", "dispatched"] },
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    }))),
    db.opsIncident.findMany({
      orderBy: { createdAt: "desc" },
      take: 1_000,
      select: { severity: true, firstSeen: true, createdAt: true },
    }),
  ]);

  for (const { queue, oldest } of oldestByQueue) {
    setGauge(
      "main_outbox_pending_age_seconds",
      "Age of the oldest pending Main outbox event",
      { queue },
      oldest ? Math.max(0, now.getTime() - oldest.createdAt.getTime()) / 1_000 : 0,
    );
  }

  const detectionLagBySeverity = new Map<string, number>();
  for (const incident of incidents) {
    const lag = Math.max(0, incident.createdAt.getTime() - incident.firstSeen.getTime()) / 1_000;
    detectionLagBySeverity.set(
      incident.severity,
      Math.max(detectionLagBySeverity.get(incident.severity) ?? 0, lag),
    );
  }
  setGauge(
    "incident_detection_lag_seconds",
    "Maximum durable Incident detection lag in the latest 1000 Incidents",
    { severity: "all" },
    Math.max(0, ...detectionLagBySeverity.values()),
  );
  for (const [severity, lag] of detectionLagBySeverity) {
    setGauge(
      "incident_detection_lag_seconds",
      "Maximum durable Incident detection lag in the latest 1000 Incidents",
      { severity },
      lag,
    );
  }

  return invariants;
}
