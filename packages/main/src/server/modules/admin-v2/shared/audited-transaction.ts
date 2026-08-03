import type { Prisma } from "@prisma/client";
import { incrementCounter } from "@idream/shared";
import { prisma } from "@/server/lib/db";

// SPEC: 跑一个「事务里带原子 Audit 行」的 admin 写入，回滚时按 operation 记一次失败。
// INTENT: 计数器名与 help 文本必须与 observability/admin-operational-metrics.ts 的注册处
// 逐字一致，否则 /internal/metrics 会出现两条同名不同 help 的序列。所以只留一份实现，
// 不在各领域模块里重抄。
export async function auditedTransaction<T>(
  operation: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  try {
    return await prisma.$transaction(callback);
  } catch (error) {
    incrementCounter(
      "admin_audit_transaction_failure_total",
      "Admin domain transactions containing an atomic Audit row that rolled back",
      { operation },
    );
    throw error;
  }
}
