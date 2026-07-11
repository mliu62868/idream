"use client";

// SPEC: 运营开关面板（P4 Task 6）——展示/切换该角色在聊天 Agent 里是否可用生图工具。
// INTENT: 自取数（挂载/characterId 变化时 GET 角色详情取 chatImageToolEnabled 派生布尔），
//         写操作走 POST /chat-tools，成功后 refetch 展示最新状态（镜像 VisualPassportPanel 的自取数模式）。
// INVARIANTS: reason 固定为 "toggle chat image tool"（审计要求 ≥3，无需运营手填）。
import { useCallback, useEffect, useState } from "react";
import { Loader2, Wand2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

export function ChatImageToolPanel({ characterId }: { characterId: string }) {
  const { t } = useAdminI18n();
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ chatImageToolEnabled: boolean }>(
        `/api/v1/admin/content/characters/${characterId}`,
      );
      setEnabled(data.chatImageToolEnabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [characterId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function toggle() {
    setToggling(true);
    setError(null);
    try {
      await apiWrite(`/api/v1/admin/content/characters/${characterId}/chat-tools`, "POST", {
        imageToolEnabled: !enabled,
        reason: "toggle chat image tool",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Toggle failed");
    } finally {
      setToggling(false);
    }
  }

  return (
    <section className="rounded-lg mt-4 flex items-center justify-between gap-3 border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex items-center gap-2">
        <Wand2 className="h-4 w-4 text-[var(--ad-text-muted)]" />
        <div>
          <h2 className="text-sm font-semibold">{t("Chat image tool")}</h2>
          <p className="mt-0.5 text-xs text-[var(--ad-text-muted)]">
            {t("Whether this character's chat agent may call the image generation tool.")}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-[var(--ad-text-muted)]" />
        ) : (
          <span className="text-xs font-medium text-[var(--ad-text)]">
            {enabled ? t("Enabled") : t("Disabled")}
          </span>
        )}
        <button
          className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-xs font-semibold disabled:opacity-50"
          disabled={loading || toggling}
          onClick={() => void toggle()}
          type="button"
        >
          {toggling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {enabled ? t("Disable") : t("Enable")}
        </button>
      </div>
      {error ? <p className="text-xs text-[var(--ad-red-text)]">{error}</p> : null}
    </section>
  );
}
