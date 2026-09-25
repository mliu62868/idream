"use client";

import { useState } from "react";
import { apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
import { AdminV2RequestError } from "@/lib/admin-v2-api";

// SPEC: 双人复核开启时，高风险写入被 enforceApproval 以 403「Dual approval required…」拒绝。
// INTENT: 没有东西会自动替运营发起审批申请，所以被拦下的那个表单就是申请入口——
//         调账、定价发布、金币商品发布、大额兑换码四处共用这一条提示与申请动作。
export function isDualApprovalRequired(error: unknown) {
  return error instanceof AdminV2RequestError && error.status === 403 && error.message.startsWith("Dual approval required");
}

export type BlockedApproval = {
  permissionKey: string;
  action: string;
  targetType: string;
  targetId: string;
  // INVARIANT: 与服务端 enforceApproval 的 payload 逐字一致，否则批准了也消费不上。
  payload: Record<string, string | number>;
  reason: string;
};

export function ApprovalRequiredNotice({ blocked, message, onRequested, testId }: {
  blocked: BlockedApproval;
  message: string;
  onRequested: () => void;
  testId: string;
}) {
  const { t } = useAdminI18n();
  const { toast } = useToast();
  const failureToast = useFailureToast();
  const [pending, setPending] = useState(false);
  async function request() {
    setPending(true);
    try {
      await apiWrite("/api/v2/admin/approvals", "POST", {
        ...blocked,
        confirmation: `${blocked.targetId}:${blocked.action}`,
      });
      toast({ tone: "success", title: t("Approval requested. Run the same action again once it is approved.") });
      onRequested();
    } catch (error) {
      failureToast(error);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--ad-border)] bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]" data-testid={testId} role="status">
      <p>{message}</p>
      <button className="inline-flex min-h-11 items-center rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 text-sm font-semibold disabled:opacity-50" disabled={pending} onClick={() => void request()} type="button">{t("Request approval")}</button>
    </div>
  );
}
