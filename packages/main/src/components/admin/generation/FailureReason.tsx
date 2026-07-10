"use client";
// SPEC: 展示单个失败原因——人话标题 + 建议动作，配色按 severity；原始码/detail 折进 EngineeringDetails。
// INVARIANTS: 首屏只见人话；code/detail 仅在折叠区。
import { useAdminI18n } from "@/components/admin/i18n";
import { EngineeringDetails } from "./EngineeringDetails";
import { resolveFailureReason } from "./failureReasons";

const SEVERITY_CLASS: Record<string, string> = {
  retry: "text-[var(--ad-yellow-text)]",
  engineering: "text-[var(--ad-red-text)]",
  waiting: "text-[var(--ad-text-muted)]",
};

export function FailureReason({ code, detail }: { code: string | null | undefined; detail?: string }) {
  const { t } = useAdminI18n();
  const reason = resolveFailureReason(code);
  const hasTechnical = Boolean(reason.code || detail);
  return (
    <div className="space-y-2">
      <p className="text-sm">
        <span className={`font-medium ${SEVERITY_CLASS[reason.severity]}`}>{t(reason.title)}</span>
        <span className="text-[var(--ad-text-muted)]"> · {t(reason.hint)}</span>
      </p>
      {hasTechnical ? (
        <EngineeringDetails summary={t("Technical detail")}>
          {reason.code ? <div>{reason.code}</div> : null}
          {detail ? <div className="whitespace-pre-wrap">{detail}</div> : null}
        </EngineeringDetails>
      ) : null}
    </div>
  );
}
