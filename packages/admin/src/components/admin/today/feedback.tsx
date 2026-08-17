"use client";

import { useCallback } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { operatorErrorCopy, technicalDetailText } from "@/components/admin/ui/request-error-copy";
import { useToast } from "@/components/admin/ui/Toast";

export type ActionFeedback = {
  tone: "success" | "error";
  /** i18n key —— 调用处不翻译，出口这里翻一次。 */
  message: string;
  values?: Record<string, string | number>;
  /** 失败时的下一步动作（i18n key）。 */
  nextStep?: string;
  nextStepValues?: Record<string, string>;
  /** 原始技术串。只在"复制给工程"里出现 —— 它是证据，不是给运营读的原因。 */
  detail?: string;
  undo?: { label: string; run: () => void | Promise<void> };
};

/**
 * SPEC: Today 上所有写操作（单条 / 批量 / 撤销）共用的唯一反馈出口。
 * INTENT: Today 曾自带一条 <ActionFeedbackBar>，于是同一个控制台有两套 toast：Today 一套、
 *         其余页面一套，成功停留时长和失败可否自动消失的规则都不同。这里只剩一层薄适配 ——
 *         把 ActionFeedback 摊平成 ToastInput，行为交给 ui/Toast.tsx。
 * INVARIANT: 调用方（WorkQueue）的签名不变，仍然是 onFeedback(feedback) 一个入口。
 */
export function useActionFeedback() {
  const { t } = useAdminI18n();
  const { toast } = useToast();
  return useCallback(
    (feedback: ActionFeedback) => {
      const detail = feedback.detail;
      toast({
        tone: feedback.tone,
        title: t(feedback.message, feedback.values),
        description: feedback.nextStep ? t(feedback.nextStep, feedback.nextStepValues) : undefined,
        // INTENT: 撤销优先于「复制给工程」—— 一条 toast 只有一个行动槽位，而推迟是唯一
        //         会让工作项从视线里消失的操作，必须给得回来。成功从来没有 detail，
        //         两者不会同时出现。
        action: feedback.undo
          ? { label: t(feedback.undo.label), onClick: () => void feedback.undo?.run() }
          : detail
            ? { label: t("Copy for engineering"), onClick: () => void navigator.clipboard?.writeText(detail) }
            : undefined,
      });
    },
    [t, toast],
  );
}

/**
 * SPEC: authority 的失败 → 运营看得懂的两句话 + 一份原样保留的技术详情。
 * INTENT: 这里原先自己按 HTTP 状态写了四条文案，与全后台的 ui/request-error-copy 各说各话
 *         （同一个 409，Today 说"刷新重试"，别处说"刷新后重新决定"）。改走那张唯一映射表；
 *         对不上的一律如实说没完成，绝不合成一个听起来合理的原因。
 */
export function failureFeedback(error: unknown): ActionFeedback {
  const copy = operatorErrorCopy(error);
  return {
    tone: "error",
    message: copy.headline,
    nextStep: copy.nextStep,
    nextStepValues: copy.nextStepValues,
    detail: technicalDetailText(copy.technical),
  };
}
