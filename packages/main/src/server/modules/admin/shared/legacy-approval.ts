import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

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
