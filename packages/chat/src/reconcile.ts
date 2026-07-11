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
import { enqueue } from "./queue.js";
import { CHAT_QUEUES, idempotencyKeys } from "@idream/shared/contracts";

const STUCK_GENERATING_MS = 2 * 60_000; // 2 minutes
const PENDING_REQUEUE_MS = 5_000;

export async function reconcile(
  prisma: ChatPrismaClient = chatPrisma,
  now: Date = new Date(),
): Promise<{
  requeuedPending: number;
  failedStuck: number;
  scheduledMemory: number;
  outboxDelivered: number;
  inboxApplied: number;
}> {
  const cutoff = new Date(now.getTime() - STUCK_GENERATING_MS);
  const pendingCutoff = new Date(now.getTime() - PENDING_REQUEUE_MS);

  // `pending` is the durable queue intent. If the request committed while Redis
  // was unavailable (or the process died between commit and enqueue), redispatch
  // the exact turn; deterministic jobId makes this safe when the job already exists.
  const pending = await prisma.message.findMany({
    where: {
      role: "assistant",
      status: "pending",
      updatedAt: { lt: pendingCutoff },
      deletedAt: null,
      replyToMessageId: { not: null },
      session: { status: "active" },
    },
    include: { session: true },
    take: 200,
  });
  let requeuedPending = 0;
  for (const message of pending) {
    if (!message.replyToMessageId) continue;
    await enqueue({
      queue: CHAT_QUEUES.generate,
      payload: {
        sessionId: message.sessionId,
        assistantMessageId: message.id,
        userMessageId: message.replyToMessageId,
        attempt: message.attempt,
      },
      dedupeKey: idempotencyKeys.chatGenerate(message.id, message.attempt),
    });
    requeuedPending += 1;
  }

  const stuck = await prisma.message.findMany({
    where: { status: "generating", updatedAt: { lt: cutoff }, deletedAt: null },
    take: 200,
  });
  let failedStuck = 0;
  for (const msg of stuck) {
    const failed = await prisma.message.updateMany({
      where: { id: msg.id, status: "generating", attempt: msg.attempt, updatedAt: { lt: cutoff } },
      data: { status: "failed" },
    });
    if (failed.count === 0) continue;
    await appendStreamEvent(streamKey(msg.id), {
      type: "error",
      attempt: msg.attempt,
      code: "generation_timeout",
      retryable: false,
    }).catch(() => {});
    failedStuck += 1;
  }

  // Finalization is durable before this derived job is scheduled. Re-enqueue any
  // selected attempt whose file-memory watermark lags, covering a crash or Redis
  // outage after the assistant was committed.
  const sent = await prisma.message.findMany({
    where: { role: "assistant", status: "sent", deletedAt: null, session: { memoryEnabled: true } },
    include: { session: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  let scheduledMemory = 0;
  for (const message of sent) {
    if (message.memoryExtractedAttempt >= message.attempt || !message.replyToMessageId) continue;
    await enqueue({
      queue: CHAT_QUEUES.memoryExtract,
      payload: {
        sessionId: message.sessionId,
        assistantMessageId: message.id,
        userMessageId: message.replyToMessageId,
        attempt: message.attempt,
      },
      dedupeKey: idempotencyKeys.chatMemoryExtract(message.id, message.attempt),
    });
    scheduledMemory += 1;
  }

  const { delivered } = await deliverPendingOutbox(prisma);
  const inboxApplied = await reprocessPendingInbox(prisma);

  return { requeuedPending, failedStuck, scheduledMemory, outboxDelivered: delivered, inboxApplied };
}
