// SPEC: chat.reconcile (design §4, PLAN P0-4). Periodic convergence after crashes:
//   - assistant messages stuck `generating` past a deadline → mark failed + emit a
//     stream error so the client stops waiting.
//   - pending outbox / inbox rows → re-deliver / re-consume.
// INVARIANTS: in-flight work lives in PG placeholder + Redis stream, so a restart
// never loses a message — reconcile finishes the job.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import { appendStreamEvent, streamKey } from "./stream.js";
import { deliverPendingOutbox } from "./outbox.js";
import {
  reprocessAccountDeletionRequestsV2,
  reprocessPendingInbox,
} from "./inbox.js";
import { enqueue } from "./queue.js";
import { projectChatFileMutations } from "./file-mutations.js";
import { loadSessionLinkage } from "./relationship-authority.js";
import {
  CHAT_QUEUES,
  idempotencyKeys,
  type ChatGeneratePayload,
  type ChatMemoryExtractPayload,
} from "@idream/shared/contracts";

const STUCK_GENERATING_MS = 2 * 60_000; // 2 minutes
const PENDING_REQUEUE_MS = 5_000;

export async function reconcile(
  prisma: ChatPrismaClient = chatPrisma,
  now: Date = new Date(),
  projectorPrisma: ChatPrismaClient = chatProjectorPrisma,
): Promise<{
  requeuedPending: number;
  failedStuck: number;
  scheduledMemory: number;
  projectedFileMutations: number;
  fileProjectionErrors: number;
  pendingFileMutations: number;
  oldestPendingFileMutationMs: number | null;
  unresolvedMemoryAuthorities: number;
  outboxDelivered: number;
  inboxApplied: number;
}> {
  const cutoff = new Date(now.getTime() - STUCK_GENERATING_MS);
  const pendingCutoff = new Date(now.getTime() - PENDING_REQUEUE_MS);
  const pendingFileUsers = await prisma.$queryRaw<
    Array<{ userId: string; firstSequence: bigint }>
  >`
    SELECT
      user_id AS "userId",
      MIN(sequence) AS "firstSequence"
    FROM chat.chat_file_mutations
    WHERE status = 'pending'
    GROUP BY user_id
    ORDER BY MIN(sequence) ASC
    LIMIT 200
  `;
  let projectedFileMutations = 0;
  let fileProjectionErrors = 0;
  for (const row of pendingFileUsers) {
    try {
      projectedFileMutations += await projectChatFileMutations(
        row.userId,
        projectorPrisma,
      );
    } catch {
      // One poisoned user must remain fail-closed for that user's file reads,
      // but it must not starve unrelated recovery, outbox, or inbox work.
      fileProjectionErrors += 1;
    }
  }

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
      } satisfies ChatGeneratePayload,
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
  // selected attempt whose Scene revision is absent, plus memory-enabled turns
  // whose file-memory watermark lags. Scene is session state and therefore also
  // advances for incognito turns.
  // Apply the watermark predicate before LIMIT. Filtering in JavaScript after
  // selecting the newest 200 lets already-extracted rows permanently starve an
  // older lagging turn.
  const sent = await prisma.$queryRaw<Array<{
    attempt: number;
    id: string;
    sessionId: string;
  }>>`
    SELECT
      attempt,
      id,
      session_id AS "sessionId"
    FROM chat.messages
    WHERE role = 'assistant'
      AND status = 'sent'
      AND deleted_at IS NULL
      AND (
        (
          memory_authority = 'enabled'
          AND (
            memory_extracted_attempt < attempt
            OR NOT EXISTS (
              SELECT 1
              FROM chat.chat_scene_revisions scene
              WHERE scene.source_assistant_message_id = chat.messages.id
                AND scene.source_attempt = chat.messages.attempt
            )
          )
        )
        OR (
          memory_authority = 'disabled'
          AND NOT EXISTS (
            SELECT 1
            FROM chat.chat_scene_revisions scene
            WHERE scene.source_assistant_message_id = chat.messages.id
              AND scene.source_attempt = chat.messages.attempt
          )
        )
      )
    ORDER BY
      (memory_authority = 'enabled' AND memory_extracted_attempt < attempt) DESC,
      updated_at DESC
    LIMIT 200
  `;
  let scheduledMemory = 0;
  let unresolvedMemoryAuthorities = 0;
  const sentBySession = new Map<string, typeof sent>();
  for (const message of sent) {
    const rows = sentBySession.get(message.sessionId) ?? [];
    rows.push(message);
    sentBySession.set(message.sessionId, rows);
  }
  for (const [sessionId, lagging] of sentBySession) {
    const { linkage } = await loadSessionLinkage(prisma, sessionId);
    for (const message of lagging) {
      const source = linkage.sources.get(message.id);
      if (
        !source ||
        source.status !== "sent" ||
        source.deletedAt ||
        !["passed", "unknown"].includes(source.safetyStatus)
      ) {
        unresolvedMemoryAuthorities += 1;
        continue;
      }
      await enqueue({
        queue: CHAT_QUEUES.memoryExtract,
        payload: {
          sessionId: message.sessionId,
          assistantMessageId: message.id,
          userMessageId: source.id,
          attempt: message.attempt,
        } satisfies ChatMemoryExtractPayload,
        dedupeKey: idempotencyKeys.chatMemoryExtract(
          message.id,
          message.attempt,
        ),
      });
      scheduledMemory += 1;
    }
  }

  const { delivered } = await deliverPendingOutbox(prisma);
  const accountDeletionV2Applied = await reprocessAccountDeletionRequestsV2(
    prisma,
    projectorPrisma,
  );
  const inboxApplied =
    accountDeletionV2Applied + await reprocessPendingInbox(prisma);
  const [pendingFileMutations, oldestPendingFileMutation] =
    await Promise.all([
      prisma.chatFileMutation.count({ where: { status: "pending" } }),
      prisma.chatFileMutation.findFirst({
        where: { status: "pending" },
        orderBy: { sequence: "asc" },
        select: { createdAt: true },
      }),
    ]);

  return {
    requeuedPending,
    failedStuck,
    scheduledMemory,
    projectedFileMutations,
    fileProjectionErrors,
    pendingFileMutations,
    oldestPendingFileMutationMs: oldestPendingFileMutation
      ? Math.max(0, now.getTime() - oldestPendingFileMutation.createdAt.getTime())
      : null,
    unresolvedMemoryAuthorities,
    outboxDelivered: delivered,
    inboxApplied,
  };
}
