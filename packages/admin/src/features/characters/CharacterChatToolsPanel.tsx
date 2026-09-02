"use client";

// SPEC: 角色详情里的「聊天内生图」开关 —— 单角色关掉聊天 Agent 的生图工具。
//
// INTENT: 这个开关是**活的**，只是后台从来够不着：chat 侧 `policy.ts:56` 算
// `imageToolEnabled: ent.imageToolEnabled && (opts.characterImageToolEnabled ?? true)`，
// `prepared-turn.ts:235` 据此决定这一轮要不要给模型挂生图工具。当前值早就在
// `GET /content/characters/:id` 的顶层返回（`chatImageToolEnabled`，实测 true），
// 写入端点 `POST /content/characters/:id/chat-tools` 也早就实现并带审计
// （`admin-v2/content/chat-tools.ts:14`）—— 但 packages/admin 里两者都零引用。
// 于是一个角色在聊天里疯狂生图时，运营唯一的手段是把整个角色下架。
//
// INVARIANTS:
// - 未设置 = 开。后端 `chatImageToolEnabled()` 是 `=== false ? false : true`，
//   core.chat_character_view 也 COALESCE 成 true；这里必须同口径，否则界面会把"没配过"
//   显示成"已关闭"。
// - 写操作照本仓惯例：必填 reason + ConfirmDialog 说清后果；关闭是**可撤销**的（再打开即可），
//   所以 reversible: true，不摆那句"无法撤回"。

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Wand2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

type ChatToolsDetail = { chatImageToolEnabled?: unknown };

/** 未设置 = 开。与后端 `chatImageToolEnabled()` 同口径。 */
export function chatImageToolEnabledOf(detail: ChatToolsDetail | null | undefined) {
  return detail?.chatImageToolEnabled === false ? false : true;
}

export function CharacterChatToolsPanel({
  canWrite,
  characterId,
}: {
  canWrite: boolean;
  characterId: string;
}) {
  const { t } = useAdminI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const requestGate = useRef(createLatestRequestGate());

  const load = useCallback(async () => {
    const request = requestGate.current.begin();
    setError(null);
    try {
      const data = await apiGet<ChatToolsDetail>(
        `/api/v2/admin/content/characters/${encodeURIComponent(characterId)}`,
      );
      if (request.isCurrent()) setEnabled(chatImageToolEnabledOf(data));
    } catch (cause) {
      if (request.isCurrent()) setError(cause instanceof Error ? cause.message : t("Chat tool state is unavailable"));
    }
  }, [characterId, t]);

  // WHY(setTimeout 0): `load()` 同步就 setError(null)，直接在 effect 体里调会被
  // react-hooks/set-state-in-effect 判为级联渲染。本仓既有做法（WorkflowsView 同款）是把首次
  // 取数推出 effect 的同步阶段。
  useEffect(() => {
    const gate = requestGate.current;
    const refresh = () => { void load(); };
    const timer = window.setTimeout(() => { void load(); }, 0);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [load]);

  function toggle(next: boolean) {
    setConfirmSpec({
      title: next ? t("Enable in-chat image generation") : t("Disable in-chat image generation"),
      consequence: {
        effect: next
          ? t("The chat agent regains its image tool on the next turn of every session with this Character.")
          : t("The chat agent loses its image tool on the next turn of every session with this Character. Images already sent stay."),
        reversible: true,
      },
      reasonLabel: t("Operational reason (≥3)"),
      submitLabel: next ? t("Enable image tool") : t("Disable image tool"),
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v2/admin/content/characters/${encodeURIComponent(characterId)}/chat-tools`,
          "POST",
          { imageToolEnabled: next, reason },
          { "idempotency-key": crypto.randomUUID() },
        );
        await load();
      },
    });
  }

  return (
    <section className="mt-7">
      <div className="flex items-center justify-between gap-3">
        <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
          <Wand2 aria-hidden="true" className="h-4 w-4" />
          {t("In-chat image generation")}
        </h3>
        {enabled === null && !error ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
      </div>
      {error ? (
        <p className="mt-2 text-sm text-[var(--ad-red-text)]" role="alert">
          {error}{" "}
          <button className="font-semibold underline" onClick={() => void load()} type="button">{t("Retry")}</button>
        </p>
      ) : enabled === null ? null : (
        <>
          <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
            {enabled
              ? t("The chat agent may generate images in conversations with this Character.")
              : t("The chat agent cannot generate images in conversations with this Character.")}
          </p>
          {canWrite ? (
            <button
              className="mt-3 min-h-10 text-sm font-semibold underline-offset-4 hover:underline"
              onClick={() => toggle(!enabled)}
              type="button"
            >
              {enabled ? t("Disable image tool") : t("Enable image tool")}
            </button>
          ) : (
            <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
              {t("Read-only: content.production.write is not granted.")}
            </p>
          )}
        </>
      )}
      {confirmSpec ? (
        <ConfirmDialog onClose={() => setConfirmSpec(null)} spec={confirmSpec} />
      ) : null}
    </section>
  );
}
