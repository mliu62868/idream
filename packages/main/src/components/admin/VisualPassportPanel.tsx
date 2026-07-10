"use client";

// SPEC: Visual Passport 编辑器面板（P2 Task 8）—— 挂载于 OfficialDetailPage 的角色详情区，
//       展示该角色 CharacterVisualProfile 的版本历史 + 当前 active 版本的 traits 只读视图，
//       并提供 identityPrompt/negativeIdentityPrompt/defaultSeed/style 编辑表单铸造新 active 版本。
// INTENT: 自取数（挂载/characterId 变化时拉 list），写操作走 /visual-profiles POST，成功后 refetch。
//         表单初值取自当前 active 版本；MintVersionForm 以 active?.id 为 key 强制重挂载，只在
//         active 版本真正切换（新铸版）时才重置表单——普通 Refresh 不会打断正在编辑的草稿
//         （镜像 TagsView：草稿只在明确的用户动作上从最新数据重新播种，而非用 effect 追同步）。
// INVARIANTS: 文案面向运营，不出现 LoRA/CFG/adapterRefs 等生成模型接线术语；锚点/参考图池本面板
//             只读展示，不提供编辑（池编辑属 P3 素材联动范畴）。
import { useCallback, useEffect, useState } from "react";
import { History, Loader2, RefreshCcw, Save } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";

type VisualProfileItem = {
  id: string;
  version: number;
  status: string;
  style: string;
  identityPrompt: string;
  negativeIdentityPrompt: string | null;
  faceTraits: unknown;
  hairTraits: unknown;
  bodyTraits: unknown;
  signatureTraits: unknown;
  styleTraits: unknown;
  defaultSeed: string | null;
  anchorAssetIds: unknown;
  referenceAssetIds: unknown;
  qualityScore: number | null;
  consistencyScore: number | null;
  createdFrom: string;
  createdAt: string;
  identitySource: "derived" | "manual";
  identityStale: boolean;
};

const STYLES = ["realistic", "anime", "hybrid", "other"] as const;

const inputClass =
  "rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";
const textareaClass =
  "rounded-md min-h-20 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ad-ink)]";

function confirmationToken(characterId: string): string {
  return `${characterId}:visual-profile`;
}

function statusBadgeClass(status: string): string {
  if (status === "active") return "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]";
  if (status === "archived") return "bg-black/[0.05] text-[var(--ad-text-muted)]";
  return "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]";
}

export function VisualPassportPanel({ characterId }: { characterId: string }) {
  const { t, value: valueLabel } = useAdminI18n();
  const [items, setItems] = useState<VisualProfileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const data = await apiGet<{ items: VisualProfileItem[] }>(
        `/api/v1/admin/content/characters/${characterId}/visual-profiles`,
      );
      setItems(data.items);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Load failed");
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

  const active = items.find((item) => item.status === "active") ?? null;

  return (
    <section className="rounded-lg mt-4 border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("Visual Identity")}</h2>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
            {t("Version history and identity prompt editing for this character's visual profile.")}
          </p>
        </div>
        <button
          className="rounded-md inline-flex h-9 shrink-0 items-center gap-2 border border-[var(--ad-border)] px-3 text-xs font-medium text-[var(--ad-text)] hover:border-[var(--ad-ink)] disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          {t("Refresh")}
        </button>
      </div>

      {listError ? <p className="mt-3 text-xs text-[var(--ad-red-text)]">{listError}</p> : null}

      <div className="mt-4">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
          <History className="h-3.5 w-3.5" />
          {t("Version history")}
        </h3>
        {loading ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
          </div>
        ) : items.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
            {t("No visual profile versions yet — minting below creates version 1.")}
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[var(--ad-text-muted)]">
                <tr className="border-b border-[var(--ad-border)]">
                  <th className="py-1.5 pr-3 font-medium">{t("Version")}</th>
                  <th className="py-1.5 pr-3 font-medium">{t("Status")}</th>
                  <th className="py-1.5 pr-3 font-medium">{t("Created from")}</th>
                  <th className="py-1.5 pr-3 font-medium">{t("Created at")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr className="border-b border-[var(--ad-border)]" key={item.id}>
                    <td className="py-1.5 pr-3">v{item.version}</td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={cn(
                          "inline-flex items-center px-2 py-0.5",
                          statusBadgeClass(item.status),
                        )}
                      >
                        {valueLabel(item.status)}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-[var(--ad-text-muted)]">{item.createdFrom}</td>
                    <td className="py-1.5 pr-3 text-[var(--ad-text-muted)]">
                      {new Date(item.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {active ? (
        <div className="mt-4">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
            {t("Active version traits (read-only)")}
            <span
              className={cn(
                "inline-flex items-center px-2 py-0.5 normal-case tracking-normal",
                active.identitySource === "derived"
                  ? "bg-sky-500/15 text-sky-300"
                  : "bg-black/[0.05] text-[var(--ad-text)]",
              )}
            >
              {active.identitySource === "derived" ? t("Derived from traits") : t("Hand-authored")}
            </span>
            {active.identityStale ? (
              <span className="inline-flex items-center px-2 py-0.5 normal-case tracking-normal bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]">
                {t("Stale — traits changed since this was derived")}
              </span>
            ) : null}
          </h3>
          <div className="mt-2 grid gap-2 md:grid-cols-3">
            <TraitBlock label={t("Face traits")} value={active.faceTraits} />
            <TraitBlock label={t("Hair traits")} value={active.hairTraits} />
            <TraitBlock label={t("Body traits")} value={active.bodyTraits} />
            <TraitBlock label={t("Signature traits")} value={active.signatureTraits} />
            <TraitBlock label={t("Style traits")} value={active.styleTraits} />
          </div>
        </div>
      ) : null}

      <MintVersionForm
        active={active}
        characterId={characterId}
        key={active?.id ?? "bootstrap"}
        onMinted={() => void load()}
      />
    </section>
  );
}

function TraitBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
        {label}
      </div>
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-[var(--ad-text)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function MintVersionForm({
  characterId,
  active,
  onMinted,
}: {
  characterId: string;
  active: VisualProfileItem | null;
  onMinted: () => void;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const [identityPrompt, setIdentityPrompt] = useState(active?.identityPrompt ?? "");
  const [negativeIdentityPrompt, setNegativeIdentityPrompt] = useState(
    active?.negativeIdentityPrompt ?? "",
  );
  const [defaultSeed, setDefaultSeed] = useState(active?.defaultSeed ?? "");
  const [style, setStyle] = useState<(typeof STYLES)[number]>(
    (active?.style as (typeof STYLES)[number] | undefined) ?? "realistic",
  );
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function mintVersion() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiWrite(`/api/v1/admin/content/characters/${characterId}/visual-profiles`, "POST", {
        // 留空 → 后端由当前 traits 派生（source: "derived"）；填写 → 原样存 + manual。
        identityPrompt: identityPrompt.trim() || undefined,
        negativeIdentityPrompt: negativeIdentityPrompt.trim() || undefined,
        style,
        defaultSeed: defaultSeed.trim() || undefined,
        reason: reason.trim(),
        confirmation: confirmation.trim(),
      });
      onMinted();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Mint failed");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    !submitting &&
    reason.trim().length >= 3 &&
    confirmation.trim() === confirmationToken(characterId);

  return (
    <div className="mt-4 border-t border-[var(--ad-border)] pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
        {t("Mint new version")}
      </h3>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <textarea
          className={textareaClass}
          onChange={(event) => setIdentityPrompt(event.target.value)}
          placeholder={t("Identity prompt (leave blank to derive from traits)")}
          value={identityPrompt}
        />
        <textarea
          className={textareaClass}
          onChange={(event) => setNegativeIdentityPrompt(event.target.value)}
          placeholder={t("Negative identity prompt")}
          value={negativeIdentityPrompt}
        />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-4">
        <select
          className={cn(inputClass, "appearance-none")}
          onChange={(event) => setStyle(event.target.value as (typeof STYLES)[number])}
          value={style}
        >
          {STYLES.map((value) => (
            <option key={value} value={value}>
              {valueLabel(value)}
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          onChange={(event) => setDefaultSeed(event.target.value)}
          placeholder={t("Default seed")}
          value={defaultSeed}
        />
        <input
          className={inputClass}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t("Reason (≥3, for audit)")}
          value={reason}
        />
        <input
          aria-label={t("Visual profile confirmation")}
          className={cn(inputClass, "font-mono")}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={t("Type {token} to confirm", { token: confirmationToken(characterId) })}
          value={confirmation}
        />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          className="inline-flex h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!canSubmit}
          onClick={() => void mintVersion()}
          type="button"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t("Mint new version")}
        </button>
        {submitError ? <p className="text-xs text-[var(--ad-red-text)]">{submitError}</p> : null}
      </div>
    </div>
  );
}
