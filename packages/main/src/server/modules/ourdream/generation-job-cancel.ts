import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  removeLatestGenerationAttemptQueueJob,
  settleGenerationRequestCancellation,
} from "@/server/ai/generation-request-lifecycle";
import { appendGenerationEvent } from "./generation-job-authority";

// SPEC: 用户取消一次尚未进入 provider 的生成，无论它还在 Bull 里排队还是在等设备租约。
//
// INTENT: 取消的结算顺序（锁 User → Request → 前置 → 状态迁移 → Attempt 终态 → 撤销
// dispatch → 退款 → 聊天附件终态）只在 settleGenerationRequestCancellation 里写一遍；
// 这里只负责用户侧的幂等快速返回、取消/退款事件和提交后移除 Bull 行。
//
// INVARIANT: 只开放给取消后没有下游等待它的来源。序列分镜归 stopVideoSequence 统一停止，
// 聊天图片和角色预览由各自的 Turn / 草稿流程等待结果，这里不替它们做决定。
export const USER_CANCELLABLE_GENERATION_SOURCE_TYPES: readonly string[] = [
  "generator",
  "chat_video",
  "feed_remix",
  "media_variation",
  "media_enhance",
];

export async function cancelGenerationBeforeProviderEntry(userId: string, requestId: string) {
  const result = await prisma.$transaction(async tx => {
    const replay = await tx.generationJob.findFirst({
      where: { id: requestId, userId, sourceType: { in: [...USER_CANCELLABLE_GENERATION_SOURCE_TYPES] } },
      select: { status: true },
    });
    if (!replay) throw Errors.notFound("Generation request not found");
    if (replay.status === "cancelled") return { requestId, status: "cancelled" as const, refundAmount: 0 };

    const { job, refundAmount } = await settleGenerationRequestCancellation(tx, {
      requestId,
      userId,
      guard: { kind: "before_provider_entry" },
      reason: "User cancelled before execution",
      cancelledAt: new Date(),
    });

    if (job.status === "cancelled") return { requestId, status: "cancelled" as const, refundAmount: 0 };
    await appendGenerationEvent(tx, requestId, "cancelled", "Generation cancelled before execution", { refundAmount, actorId: userId });
    if (refundAmount > 0) {
      await appendGenerationEvent(tx, requestId, "refunded", "Dreamcoins returned after cancellation", { amount: refundAmount });
    }
    return { requestId, status: "cancelled" as const, refundAmount };
  });
  // After commit, and on replay too: a removal that failed last time gets another
  // chance, and a row left in Bull would only occupy a worker slot to be refused.
  await removeLatestGenerationAttemptQueueJob(requestId);
  return result;
}
