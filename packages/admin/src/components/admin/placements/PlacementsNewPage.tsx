"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { FormPage, FormSection, Field, FormFooter, INPUT_CLASS } from "@/components/admin/ui/FormPage";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import {
  APPROVED_ASSETS_LIST,
  CREATE_STATUSES,
  PLACEMENTS_BASE,
  SLOTS,
  TARGET_TYPES,
  defaultPlacementDraft,
  placementCreatePayload,
  publishableApprovedAssets,
  type ApprovedAsset,
  type PlacementDraft,
} from "./placements-api";

// SPEC: 全屏新建页 —— 原样搬运 旧内容运营视图 create() 的表单字段（资产/slot/目标类型/目标 ID/
// 状态）+ FormFooter reason 输入（placementCreateSchema 要求 reason，spec §7 新建页）。
// INTENT: 选择资产时把该资产的 targetId 带入表单（原样搬运 旧内容运营视图 资产配对逻辑），运营
// 仍可手动改写；assets 加载完成后若表单为空则默认选中第一个资产（同样搬运自旧视图的 load()）。
export function PlacementsNewPage() {
  const { t, value } = useAdminI18n();
  const [assets, setAssets] = useState<ApprovedAsset[]>([]);
  const [blockedAssets, setBlockedAssets] = useState<ApprovedAsset[]>([]);
  const [draft, setDraft] = useState<PlacementDraft>(defaultPlacementDraft);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const loadAssets = useCallback(async () => {
    setLoadingAssets(true);
    setError(null);
    try {
      const data = await apiGet<{ items: ApprovedAsset[] }>(APPROVED_ASSETS_LIST);
      const eligible = publishableApprovedAssets(data.items);
      setAssets(eligible);
      setBlockedAssets(
        data.items.filter((asset) => !asset.customerPublishable),
      );
      setDraft((current) => ({
        ...current,
        mediaAssetId:
          eligible.some((asset) => asset.id === current.mediaAssetId)
            ? current.mediaAssetId
            : eligible[0]?.id ?? "",
        targetId:
          current.targetId ||
          eligible.find((asset) => asset.id === current.mediaAssetId)?.targetId ||
          eligible[0]?.targetId ||
          "",
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoadingAssets(false);
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAssets();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAssets]);

  function patch(partial: Partial<PlacementDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
    setIdempotencyKey(crypto.randomUUID());
  }

  function selectAsset(assetId: string) {
    const asset = assets.find((item) => item.id === assetId);
    patch({ mediaAssetId: assetId, targetId: asset?.targetId ?? draft.targetId });
  }

  const canSubmit =
    !creating &&
    assets.some((asset) => asset.id === draft.mediaAssetId) &&
    draft.targetId.trim().length > 0 &&
    draft.reason.trim().length >= 3;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await apiWrite<{ placement?: { id?: string } }>(
        PLACEMENTS_BASE,
        "POST",
        placementCreatePayload(draft),
        { "idempotency-key": idempotencyKey },
      );
      const newId = created.placement?.id;
      window.location.href = newId ? `/admin/content/placements/${newId}` : "/admin/content/placements";
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t("Request failed"));
      setCreating(false);
    }
  }

  return (
    <FormPage backHref="/admin/content/placements" backLabel={t("Back to placements")} title={t("New placement")}>
      <div className="rounded-lg bg-[var(--ad-blue-bg)] p-3 text-sm leading-6 text-[var(--ad-blue-text)]">
        {t("Standalone placements are draft records only. Customer-visible campaign activation happens from a verified Creative Run; Character images publish through a Character Release.")}
      </div>
      <FormSection title={t("Basic info")}>
        <Field full label={t("Asset")}>
          <select
            className={INPUT_CLASS}
            disabled={loadingAssets || assets.length === 0}
            onChange={(event) => selectAsset(event.target.value)}
            value={draft.mediaAssetId}
          >
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.id} · {asset.purpose ? value(asset.purpose) : t("Asset")}
              </option>
            ))}
          </select>
          {blockedAssets.length > 0 ? (
            <p className="mt-2 text-xs text-[var(--ad-yellow-text)]" role="status">
              {blockedAssets.length === 1
                ? t("1 approved asset is hidden because generation authority is incomplete or untrusted.")
                : t("{count} approved assets are hidden because generation authority is incomplete or untrusted.").replace("{count}", String(blockedAssets.length))}
            </p>
          ) : null}
          {!loadingAssets && !error && assets.length === 0 ? (
            <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">
              {t("No customer-publishable approved assets are available. Repair generation authority in the Image Library or create a new reviewed asset.")}
            </p>
          ) : null}
        </Field>
        <Field label={t("Slot")}>
          <select className={INPUT_CLASS} onChange={(event) => patch({ slot: event.target.value as PlacementDraft["slot"] })} value={draft.slot}>
            {SLOTS.map((slot) => (
              <option key={slot} value={slot}>
                {value(slot)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Status")}>
          <select
            className={INPUT_CLASS}
            onChange={(event) => patch({ status: event.target.value as PlacementDraft["status"] })}
            value={draft.status}
          >
            {CREATE_STATUSES.map((statusValue) => (
              <option key={statusValue} value={statusValue}>
                {value(statusValue)}
              </option>
            ))}
          </select>
        </Field>
      </FormSection>
      <FormSection title={t("Target")}>
        <Field label={t("Target type")}>
          <select
            className={INPUT_CLASS}
            onChange={(event) => patch({ targetType: event.target.value as PlacementDraft["targetType"] })}
            value={draft.targetType}
          >
            {TARGET_TYPES.map((targetType) => (
              <option key={targetType} value={targetType}>
                {value(targetType)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Target ID")}>
          <input className={INPUT_CLASS} onChange={(event) => patch({ targetId: event.target.value })} value={draft.targetId} />
        </Field>
      </FormSection>
      <FormFooter error={error}>
        <input
          aria-label={t("Reason (≥3)")}
          className={`${INPUT_CLASS} max-w-xs`}
          onChange={(event) => patch({ reason: event.target.value })}
          placeholder={t("Reason (≥3)")}
          value={draft.reason}
        />
        <PrimaryButton disabled={!canSubmit} onClick={() => void create()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Create placement")}
        </PrimaryButton>
      </FormFooter>
    </FormPage>
  );
}
