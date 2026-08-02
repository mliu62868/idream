import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";

export type GenerationAttemptQueueFact = {
  readonly outboxId: string;
  readonly queue: "ai.image.generate" | "ai.video.generate";
  readonly dedupeKey: string;
};

// INVARIANT: queue cleanup is scoped by the immutable dispatch fact for one
// Attempt. A Request-wide prefix can delete a newer retry owned by another
// Attempt and therefore is never an acceptable terminal cleanup key.
export async function findGenerationAttemptQueueFact(input: {
  readonly requestId: string;
  readonly attemptId: string;
}): Promise<GenerationAttemptQueueFact | null> {
  const rows = await prisma.mainOutboxEvent.findMany({
    where: {
      aggregateType: "generation_request",
      aggregateId: input.requestId,
      eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, payload: true },
  });
  for (const row of rows) {
    const payload = jsonRecord(row.payload);
    if (payload.attemptId !== input.attemptId) continue;
    const queueInput = jsonRecord(payload.queueInput);
    const queue = queueInput.queue;
    const dedupeKey = queueInput.dedupeKey;
    if (
      (queue === "ai.image.generate" || queue === "ai.video.generate") &&
      typeof dedupeKey === "string" &&
      dedupeKey.length > 0
    ) {
      return { outboxId: row.id, queue, dedupeKey };
    }
  }
  return null;
}

export async function removeGenerationAttemptQueueJob(input: {
  readonly requestId: string;
  readonly attemptId: string;
}): Promise<boolean> {
  const fact = await findGenerationAttemptQueueFact(input);
  if (!fact) return false;
  return jobQueue.removeByDedupeKey(fact.queue, fact.dedupeKey);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
