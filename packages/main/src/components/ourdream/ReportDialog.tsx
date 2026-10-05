"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  CONTENT_REPORT_REASONS,
  DEFAULT_CONTENT_REPORT_REASON,
  type ContentReportReason,
} from "@idream/shared/contracts";
import { parseReportResponse } from "@/lib/public-api-contracts";
import { useViewerGate, ViewerGateError, type ViewerGate } from "@/hooks/useViewerGate";
import { isAbortError } from "@/lib/viewer-resource-client";
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

type ReportDraft = { target: ReportTarget; reason: ContentReportReason; description: string };
type ReportRecovery = ReportDraft & { nonce: string; returnTarget: string; expiresAt: number };
const REPORT_RECOVERY_KEY = "idream:report-signup-draft";
const REPORT_RECOVERY_QUERY = "reportDraft";

export const REASON_LABELS: Record<ContentReportReason, string> = {
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
  const viewer = useViewerGate({ require: "any" });
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  useEffect(() => viewer.gate.onOwnerChange?.(() => setDraft(null)), [viewer.gate]);
  useEffect(() => {
    if (viewer.identity?.kind !== "user") return;
    const returned = new URL(window.location.href);
    const nonce = returned.searchParams.get(REPORT_RECOVERY_QUERY);
    if (!nonce) return;
    let active = true;
    returned.searchParams.delete(REPORT_RECOVERY_QUERY);
    const returnTarget = `${returned.pathname}${returned.search}${returned.hash}`;
    try {
      const raw = window.sessionStorage.getItem(REPORT_RECOVERY_KEY);
      const saved = raw ? JSON.parse(raw) as ReportRecovery : null;
      const target = saved?.target;
      const validTarget = target && (target.kind === "record"
        ? typeof target.targetType === "string" && Boolean(target.targetType) && typeof target.targetId === "string" && Boolean(target.targetId)
        : (target.kind === "character" || target.kind === "feedItem") && typeof target.id === "string" && Boolean(target.id));
      if (!saved || saved.nonce !== nonce || saved.returnTarget !== returnTarget || typeof saved.expiresAt !== "number" || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now() ||
        !validTarget || !CONTENT_REPORT_REASONS.includes(saved.reason) || typeof saved.description !== "string" || saved.description.length > 2_000) return;
      // Signup restores this tab's explicit report draft. It never submits it
      // or exposes the user's note in the URL or another account's stored data.
      queueMicrotask(() => {
        if (!active) return;
        try {
          window.sessionStorage.removeItem(REPORT_RECOVERY_KEY);
          window.history.replaceState(window.history.state, "", returnTarget);
          setDraft({ target: saved.target, reason: saved.reason, description: saved.description });
        } catch { onStatus("The saved report could not be restored. Open the report again to review it."); }
      });
    } catch { onStatus("The saved report could not be restored. Open the report again to review it."); }
    return () => { active = false; };
  }, [viewer.identity, onStatus]);
  return {
    openReport: (target: ReportTarget) => setDraft({ target, reason: DEFAULT_CONTENT_REPORT_REASON, description: "" }),
    reportDialog: draft ? (
      <ReportDialog
        key={`${viewer.scope ?? "anonymous"}:${JSON.stringify(draft.target)}`}
        onClose={() => setDraft(null)}
        onStatus={onStatus}
        draft={draft}
        viewer={viewer}
      />
    ) : null,
  };
}

function ReportDialog({
  onClose,
  onStatus,
  draft,
  viewer,
}: Readonly<{
  onClose: () => void;
  onStatus: (message: string) => void;
  draft: ReportDraft;
  viewer: ViewerGate;
}>) {
  const [reason, setReason] = useState(draft.reason);
  const [description, setDescription] = useState(draft.description);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const writing = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const titleId = useId();
  const descriptionId = useId();

  async function submit() {
    if (writing.current) return;
    setError("");
    if (viewer.identity?.kind === "anonymous") {
      try {
        const returnTarget = authNextTargetFromPath(window.location.pathname, window.location.search, window.location.hash) ?? "/";
        const returned = new URL(returnTarget, window.location.origin);
        const nonce = globalThis.crypto?.randomUUID?.();
        if (!nonce) throw new Error("A secure report recovery key is unavailable");
        returned.searchParams.set(REPORT_RECOVERY_QUERY, nonce);
        const recovery: ReportRecovery = { target: draft.target, reason, description, nonce, returnTarget, expiresAt: Date.now() + 15 * 60_000 };
        window.sessionStorage.setItem(REPORT_RECOVERY_KEY, JSON.stringify(recovery));
        window.location.assign(authHrefForTarget("/signup", `${returned.pathname}${returned.search}${returned.hash}`));
      } catch {
        const message = "The report draft could not be saved. Keep this dialog open and try again.";
        setError(message); onStatus(message);
      }
      return;
    }
    writing.current = true;
    setPending(true);
    try {
      const expected = viewer.identity;
      const before = await viewer.revalidate();
      if (!before) throw new Error("Your account could not be checked. Reconnect and try again.");
      if (!mounted.current || expected?.kind !== "user" || before !== expected) throw new ViewerGateError();
      const { url, body } = reportRequest(draft.target, reason, description);
      const response = await viewer.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: unknown = response.ok ? await response.json() : null;
      const after = await viewer.revalidate();
      if (!after) throw new Error("The report could not be confirmed. Reconnect before submitting again.");
      if (!mounted.current || after !== expected) throw new ViewerGateError();
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
        const message = "Could not submit the report. Please try again.";
        setError(message); onStatus(message);
        return;
      }
      parseReportResponse(payload);
      onStatus("Report submitted.");
      onClose();
    } catch (error) {
      if (!mounted.current || isAbortError(error)) return;
      const message = error instanceof Error ? error.message : "Could not submit the report. Please try again.";
      setError(message); onStatus(message);
    } finally {
      if (mounted.current) { writing.current = false; setPending(false); }
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
        {viewer.error ? <p role="alert">{viewer.error} <button className="underline" type="button" onClick={() => void viewer.revalidate()}>Retry account check</button></p> : null}
        {error ? <p className="mt-3 text-sm text-amber-200" role="alert">{error}</p> : null}
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
            disabled={pending || !viewer.identity}
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
