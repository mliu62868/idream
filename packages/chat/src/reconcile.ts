// SPEC: chat.reconcile (design §4, PLAN P0-4). Periodic convergence after crashes:
//   - assistant messages stuck `generating` past a deadline → mark failed + emit a
//     stream error so the client stops waiting.
//   - pending outbox / inbox rows → re-deliver / re-consume.
// INVARIANTS: in-flight work lives in PG placeholder + Redis stream, so a restart
// never loses a message — reconcile finishes the job.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { appendStreamEvent, streamKey } from "./stream.js";
import { deliverPendingOutbox } from "./outbox.js";
import { reprocessPendingInbox } from "./inbox.js";

const STUCK_GENERATING_MS = 2 * 60_000; // 2 minutes

export async function reconcile(
  prisma: ChatPrismaClient = chatPrisma,
  now: Date = new Date(),
): Promise<{ failedStuck: number; outboxDelivered: number; inboxApplied: number }> {
  const cutoff = new Date(now.getTime() - STUCK_GENERATING_MS);

  const stuck = await prisma.message.findMany({
    where: { status: "generating", updatedAt: { lt: cutoff }, deletedAt: null },
    take: 200,
  });
  let failedStuck = 0;
  for (const msg of stuck) {
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: "failed" },
    });
    await appendStreamEvent(streamKey(msg.id), {
      type: "error",
      attempt: msg.attempt,
      code: "generation_timeout",
      retryable: false,
    }).catch(() => {});
    failedStuck += 1;
  }

  const { delivered } = await deliverPendingOutbox(prisma);
  const inboxApplied = await reprocessPendingInbox(prisma);

  return { failedStuck, outboxDelivered: delivered, inboxApplied };
}
