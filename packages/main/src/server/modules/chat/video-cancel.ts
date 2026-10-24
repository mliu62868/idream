import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { settleGenerationRequestCancellation } from "@/server/ai/generation-request-lifecycle";
import { appendGenerationEvent } from "@/server/modules/ourdream/generation-job-authority";

// SPEC: 用户在聊天里取消一次尚未开始执行的视频。
//
// INTENT: 取消的五步结算（锁 User → Request → 前置 → 状态迁移 → Attempt 终态 → 撤销
// dispatch → 退款 → 聊天附件终态）只在 settleGenerationRequestCancellation 里写一遍；
// 这里只负责用户侧的幂等快速返回及取消/退款事件。
export async function cancelChatVideo(userId: string, requestId: string) {
  return prisma.$transaction(async tx => {
    const replay = await tx.generationJob.findFirst({
      where: { id: requestId, userId, sourceType: "chat_video" },
      select: { status: true },
    });
    if (!replay) throw Errors.notFound("Chat video request not found");
    if (replay.status === "cancelled") return { requestId, status: "cancelled" as const, refundAmount: 0 };

    const { refundAmount } = await settleGenerationRequestCancellation(tx, {
      requestId,
      userId,
      expectSourceType: "chat_video",
      guard: { kind: "before_dispatch" },
      reason: "User cancelled before execution",
      cancelledAt: new Date(),
    });

    await appendGenerationEvent(tx, requestId, "cancelled", "Video cancelled before execution", { refundAmount, actorId: userId });
    if (refundAmount > 0) {
      await appendGenerationEvent(tx, requestId, "refunded", "Dreamcoins returned after cancellation", { amount: refundAmount });
    }
    return { requestId, status: "cancelled" as const, refundAmount };
  });
}
