"use client";

import { useId, useState } from "react";
import {
  CONTENT_REPORT_REASONS,
  DEFAULT_CONTENT_REPORT_REASON,
  type ContentReportReason,
} from "@idream/shared/contracts";
import { parseReportResponse } from "@/lib/public-api-contracts";
import { authHrefForTarget, authNextTargetFromPath } from "./authRedirect";

// SPEC: 站内所有举报入口的唯一实现 —— 选理由、可选补充说明、提交。
// INTENT: 六个入口以前各自 fetch 一次并把 category 写死成 other_prohibited_content，
//         于是后台永远只看到同一个理由和同一句系统文案。收成一个组件是为了让「用户说了什么」
//         真的能到运营手上，不是为了多一层抽象。
// INVARIANT: 提交的 category 只能取自 CONTENT_REPORT_REASONS（服务端同一份枚举校验）。

/** 三个后端入口的差异只有 URL 与是否自带 target，其余完全一致。 */
export type ReportTarget =
  | { kind: "character"; id: string }
  | { kind: "feedItem"; id: string }
  | { kind: "record"; targetType: string; targetId: string };

const REASON_LABELS: Record<ContentReportReason, string> = {
  underage_content: "Underage or minor-coded content",
  nonconsensual_real_person: "A real person, used without consent",
  harassment_or_hate: "Harassment, hate, or threats",
  spam: "Spam, scam, or advertising",
  quality: "Broken or unusable result",
  other_prohibited_content: "Something else against the rules",
};

export function reportRequest(
  target: ReportTarget,
  reason: ContentReportReason,
  description: string,
) {
  const body: Record<string, string> = { category: reason };
  if (description.trim()) body.description = description.trim();
  if (target.kind === "character") {
    return {
      url: `/api/v1/characters/${encodeURIComponent(target.id)}/report`,
      body,
    };
  }
  if (target.kind === "feedItem") {
    return {
      url: `/api/v1/feed/items/${encodeURIComponent(target.id)}/report`,
      body,
    };
  }
  return {
    url: "/api/v1/reports",
    body: { targetType: target.targetType, targetId: target.targetId, ...body },
  };
}

/**
 * 把「打开举报弹窗」接到任意一个按钮上。调用点只保留一行 open + 一行渲染。
 * onStatus 走各页面自己的状态条，所以提交结果仍显示在用户当前看的地方。
 */
export function useReportDialog(onStatus: (message: string) => void) {
  const [target, setTarget] = useState<ReportTarget | null>(null);
  return {
    openReport: (next: ReportTarget) => setTarget(next),
    reportDialog: target ? (
      <ReportDialog
        onClose={() => setTarget(null)}
        onStatus={onStatus}
        target={target}
      />
    ) : null,
  };
}

function ReportDialog({
  onClose,
  onStatus,
  target,
}: Readonly<{
  onClose: () => void;
  onStatus: (message: string) => void;
  target: ReportTarget;
}>) {
  const [reason, setReason] = useState<ContentReportReason>(
    DEFAULT_CONTENT_REPORT_REASON,
  );
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const titleId = useId();
  const descriptionId = useId();

  async function submit() {
    setPending(true);
    try {
      const { url, body } = reportRequest(target, reason, description);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // 未登录时不要只丢一句失败 —— 举报入口在公开页面上，带 next 回跳回来。
      if (response.status === 401) {
        window.location.assign(
          authHrefForTarget(
            "/signup",
            authNextTargetFromPath(
              window.location.pathname,
              window.location.search,
            ),
          ),
        );
        return;
      }
      if (!response.ok) {
        onStatus("Could not submit the report. Please try again.");
        return;
      }
      parseReportResponse(await response.json());
      onStatus("Report submitted.");
      onClose();
    } catch {
      onStatus("Could not submit the report. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-md rounded-[20px] border border-white/10 bg-[rgb(36,36,36)] p-6 text-white shadow-[2px_2px_8px_3px_rgba(0,0,0,0.25)]"
        data-testid="report-dialog"
        role="dialog"
      >
        <h2 className="text-[18px] font-black uppercase" id={titleId}>
          Report content
        </h2>
        <p className="mt-1 text-[13px] text-[rgb(170,170,170)]">
          Pick the closest reason. Moderators read what you write here.
        </p>
        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">Reason</legend>
          {CONTENT_REPORT_REASONS.map((value) => (
            <label
              className="flex cursor-pointer items-center gap-3 rounded-[12px] bg-[rgb(24,24,24)] px-3 py-2.5 text-[14px]"
              key={value}
            >
              <input
                checked={reason === value}
                className="h-4 w-4 accent-[rgb(253,95,194)]"
                name="report-reason"
                onChange={() => setReason(value)}
                type="radio"
                value={value}
              />
              {REASON_LABELS[value]}
            </label>
          ))}
        </fieldset>
        <label
          className="mt-4 block text-[13px] font-bold text-[rgb(170,170,170)]"
          htmlFor={descriptionId}
        >
          What happened? (optional)
        </label>
        <textarea
          className="mt-1.5 w-full rounded-[12px] bg-[rgb(24,24,24)] p-3 text-[14px] text-white placeholder:text-[rgb(114,113,112)]"
          id={descriptionId}
          maxLength={2_000}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Add anything a moderator should know."
          rows={3}
          value={description}
        />
        <div className="mt-5 flex gap-3">
          <button
            className="h-11 flex-1 rounded-full bg-[rgb(60,60,60)] text-[14px] font-bold text-white"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="h-11 flex-1 rounded-full bg-[rgb(253,95,194)] text-[14px] font-black text-[rgb(13,13,13)] disabled:opacity-70"
            disabled={pending}
            onClick={submit}
            type="button"
          >
            {pending ? "Submitting..." : "Submit report"}
          </button>
        </div>
      </div>
    </div>
  );
}
