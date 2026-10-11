import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { approvalMatchesIntent, boundApprovalPolicy, type BoundApprovalAction } from "./intent";

// SPEC: 双人审批凭据的消费端 —— 高风险写入在自己的事务里换掉一条 approved 请求。
// INTENT: 凭据是一次性的，所以消费必须是 CAS（`where: { status: "approved" }` + count 检查），
//         否则两个并发的高风险写入会用掉同一条批准。开关按 feature flag 走，关闭时整条链路无感。
export const DUAL_APPROVAL_FLAG = "dual_approval_enforced" as const;
export const LEDGER_APPROVAL_THRESHOLD = 1000;

// INVARIANT: 每次消费都匹配权限、目标、规范化 payload hash、版本和有效期。
// 无绑定的历史批准必须重新申请，不能作为通配授权消费。
export async function enforceApproval(
  action: BoundApprovalAction,
  targetId: string,
  db: Prisma.TransactionClient,
  payload: Record<string, string | number | boolean>,
  expectedVersion: number | null = null,
) {
  const flag = await db.featureFlag.findUnique({ where: { key: DUAL_APPROVAL_FLAG } });
  if (!flag?.enabled) return;
  const policy = boundApprovalPolicy(action);
  if (!policy) throw Errors.internal("Unknown bound approval action", { action });
  const candidates = await db.adminActionRequest.findMany({
    where: { action, targetId, status: "approved", permissionKey: policy.permission, targetType: policy.targetType },
    orderBy: { decidedAt: "desc" },
  });
  const approved = candidates.find((request) =>
    request.approvedById !== null && request.approvedById !== request.requestedById &&
    approvalMatchesIntent(request, payload, expectedVersion));
  if (!approved) {
    throw Errors.forbidden("Dual approval required: request a new approval for this exact action, version, and payload", { action, targetId, recovery: "request_new_approval" });
  }
  const consumed = await db.adminActionRequest.updateMany({
    where: { id: approved.id, status: "approved" },
    data: { status: "consumed" },
  });
  if (consumed.count !== 1) {
    throw Errors.forbidden("Dual approval required: approved request was already consumed", { action, targetId });
  }
}
