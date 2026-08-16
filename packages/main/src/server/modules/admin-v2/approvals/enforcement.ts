import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

// SPEC: 双人审批凭据的消费端 —— 高风险写入在自己的事务里换掉一条 approved 请求。
// INTENT: 凭据是一次性的，所以消费必须是 CAS（`where: { status: "approved" }` + count 检查），
//         否则两个并发的高风险写入会用掉同一条批准。开关按 feature flag 走，关闭时整条链路无感。
export const DUAL_APPROVAL_FLAG = "dual_approval_enforced" as const;
export const LEDGER_APPROVAL_THRESHOLD = 1000;

export async function enforceApproval(
  action: string,
  targetId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const flag = await db.featureFlag.findUnique({ where: { key: DUAL_APPROVAL_FLAG } });
  if (!flag?.enabled) return;
  const approved = await db.adminActionRequest.findFirst({
    where: { action, targetId, status: "approved" },
    orderBy: { decidedAt: "desc" },
  });
  if (!approved) {
    throw Errors.forbidden("Dual approval required: no approved request for this action", { action, targetId });
  }
  const consumed = await db.adminActionRequest.updateMany({
    where: { id: approved.id, status: "approved" },
    data: { status: "consumed" },
  });
  if (consumed.count !== 1) {
    throw Errors.forbidden("Dual approval required: approved request was already consumed", { action, targetId });
  }
}
