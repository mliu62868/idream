import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { settleGenerationRequestCancellation } from "@/server/ai/generation-request-lifecycle";
import { appendGenerationEvent } from "@/server/modules/ourdream/generation-job-authority";
import { transitionToolEffectAttachment } from "./tool-effect-attachment";
import { lockChatScope } from "./turn-scope";

// SPEC: 用户在聊天里取消一次尚未开始执行的视频。
//
// INTENT: 取消的五步结算（锁 Request → 前置 → 状态迁移 → Attempt 终态 → 撤销
// dispatch → 退款）只在 settleGenerationRequestCancellation 里写一遍；这里只负责
// 用户侧独有的两件事：幂等重放的快速返回，和把聊天附件推进到 cancelled。
//
// INVARIANT: 锁序是 generation_jobs → users → recent_chats → chat_turns →
// chat_turn_attachments。退款在 settle 内部已经取过 users，聊天阶梯随后重取是同
// 事务内的空操作，方向仍与 modules/chat 的产品 Turn 阶梯一致。
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

    const pointer = await tx.chatTurnAttachment.findFirst({
      where: { generationJobId: requestId, kind: "generated_video" },
      select: { id: true },
    });
    if (pointer) {
      // 被取消的视频仍留在会话历史里，所以已删除的会话也要放行：附件的终态与
      // 会话是否可见无关。
      const scope = await lockChatScope(tx, {
        userId,
        at: { attachment: pointer.id },
        allowDeletedSession: true,
      });
      if (scope.attachment) {
        await transitionToolEffectAttachment(tx, scope.attachment, { to: "cancelled", errorCode: null });
      }
    }

    await appendGenerationEvent(tx, requestId, "cancelled", "Video cancelled before execution", { refundAmount, actorId: userId });
    if (refundAmount > 0) {
      await appendGenerationEvent(tx, requestId, "refunded", "Dreamcoins returned after cancellation", { amount: refundAmount });
    }
    return { requestId, status: "cancelled" as const, refundAmount };
  });
}
