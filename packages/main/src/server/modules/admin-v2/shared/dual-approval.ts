import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

// SPEC: 当 `dual_approval_enforced` 开着时，某些高危写操作必须先消费一条已批准的
// AdminActionRequest，且一条批准只能用一次。
// INTENT: 这是 v1 的 flag 化双人复核，与 controlPlaneCommand 里绑定 approvalId 的那套
// 是两条独立机制。money 领域（≥1000 币的账本调整、定价发布）沿用它，不是遗留残留：
// 换成绑定式审批会改变运营侧的申请—批准流程，属于产品决策，不在这轮迁移范围内。
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
