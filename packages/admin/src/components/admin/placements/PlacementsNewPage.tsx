"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { requestErrorMessage } from "@/components/admin/section-kit";
import { FormPage, FormSection, Field, FormFooter, INPUT_CLASS } from "@/components/admin/ui/FormPage";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import { Pagination } from "@/components/admin/ui/Pagination";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import type { AdminPageInfo } from "@idream/shared/admin";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  approvedAssetsListPath,
  CREATE_STATUSES,
  PLACEMENTS_BASE,
  SLOTS,
  TARGET_TYPES,
  defaultPlacementDraft,
  placementCreatePayload,
  publishableApprovedAssets,
  validCampaignDraft,
  type ApprovedAsset,
  type PlacementDraft,
} from "./placements-api";

// A Campaign draft includes the copy actually rendered to customers. Selecting artwork does not publish it.
export function PlacementsNewPage() {
  const { t, value } = useAdminI18n();
  const [assets, setAssets] = useState<ApprovedAsset[]>([]);
  const [blockedAssets, setBlockedAssets] = useState<ApprovedAsset[]>([]);
  const [draft, setDraft] = useState<PlacementDraft>(defaultPlacementDraft);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetSearch, setAssetSearch] = useState("");
  const [assetCursors, setAssetCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageInfo, setPageInfo] = useState<AdminPageInfo>({ hasNextPage: false, endCursor: null });
  const requestGate = useRef(createLatestRequestGate());
  const assetCursor = assetCursors.at(-1);

  const loadAssets = useCallback(async () => {
    const request = requestGate.current.begin();
    setLoadingAssets(true);
    setError(null);
    try {
      const data = await apiGet<{ items: ApprovedAsset[]; pageInfo: AdminPageInfo }>(approvedAssetsListPath(assetSearch, assetCursor));
      if (!request.isCurrent()) return;
      setPageInfo(data.pageInfo);
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
      if (!request.isCurrent()) return;
      setError(requestErrorMessage(loadError, t));
    } finally {
      if (request.isCurrent()) setLoadingAssets(false);
    }
  }, [assetSearch, assetCursor, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAssets();
    }, 200);
    const gate = requestGate.current;
    return () => { window.clearTimeout(timer); gate.invalidate(); };
  }, [loadAssets]);

  function patch(partial: Partial<PlacementDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  function selectAsset(assetId: string) {
    const asset = assets.find((item) => item.id === assetId);
    patch({ mediaAssetId: assetId, targetId: asset?.targetId ?? draft.targetId });
  }

  function invalidateAssets() {
    requestGate.current.invalidate();
    setLoadingAssets(true);
    setAssets([]);
    setBlockedAssets([]);
    setPageInfo({ hasNextPage: false, endCursor: null });
  }

  const canSubmit =
    !creating &&
    !loadingAssets &&
    assets.some((asset) => asset.id === draft.mediaAssetId) &&
    draft.targetId.trim().length > 0 &&
    validCampaignDraft(draft) &&
    draft.reason.trim().length >= 3;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await apiWrite<{ placement?: { id?: string } }>(
        PLACEMENTS_BASE,
        "POST",
        placementCreatePayload(draft),
      );
      const newId = created.placement?.id;
      window.location.href = newId ? `/admin/creative/placements/${newId}` : "/admin/creative/placements";
    } catch (createError) {
      setError(requestErrorMessage(createError, t));
      setCreating(false);
    }
  }

  return (
    <FormPage backHref="/admin/creative/placements" backLabel={t("Back to placements")} title={t("New placement")}>
      <div className="rounded-lg bg-[var(--ad-blue-bg)] p-3 text-sm leading-6 text-[var(--ad-blue-text)]">
        {t("Upload artwork, prepare a Campaign draft, then publish it after image verification. Generated campaigns use Creative Runs; Character images use Character Releases.")}
      </div>
      <FormSection title={t("Basic info")}>
        <Field full label={t("Asset")}>
          <input aria-label={t("Search images")} className={`${INPUT_CLASS} mb-2`} placeholder={t("Search images")}
            value={assetSearch} onChange={(event) => { invalidateAssets(); setAssetSearch(event.target.value); setAssetCursors([undefined]); }} />
          <select
            aria-label={t("Asset")}
            className={INPUT_CLASS}
            disabled={loadingAssets || assets.length === 0}
            onChange={(event) => selectAsset(event.target.value)}
            value={draft.mediaAssetId}
          >
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.description || asset.id} · {asset.purpose ? value(asset.purpose) : t("Asset")}
              </option>
            ))}
          </select>
          <Pagination page={assetCursors.length} pageSize={25} rowCount={assets.length + blockedAssets.length}
            loading={loadingAssets} hasPrevious={assetCursors.length > 1} hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
            onPrevious={() => { if (loadingAssets) return; invalidateAssets(); setAssetCursors(current => current.slice(0, -1)); }}
            onNext={() => {
              if (loadingAssets || !pageInfo.endCursor) return;
              const nextCursor = pageInfo.endCursor;
              invalidateAssets();
              setAssetCursors(current => current.at(-1) === nextCursor ? current : [...current, nextCursor]);
            }} />
          {assets.find(asset => asset.id === draft.mediaAssetId)?.url ? <AssetImage asset={{
            url: assets.find(asset => asset.id === draft.mediaAssetId)!.url!,
            thumbnailUrl: assets.find(asset => asset.id === draft.mediaAssetId)!.thumbnailUrl ?? "",
          }} preview /> : null}
          {blockedAssets.length > 0 ? (
            <p className="mt-2 text-xs text-[var(--ad-yellow-text)]" role="status">
              {blockedAssets.length === 1
                ? t("1 approved asset is hidden because generation authority is incomplete or untrusted.")
                : t("{count} approved assets are hidden because generation authority is incomplete or untrusted.", { count: blockedAssets.length })}
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
          <input aria-label={t(draft.slot === "campaign" ? "Campaign destination key" : "Target ID")} className={INPUT_CLASS} maxLength={180} onChange={(event) => patch({ targetId: event.target.value })} value={draft.targetId} />
        </Field>
      </FormSection>
      {draft.slot === "campaign" ? <FormSection title={t("Campaign")}>
        <Field label={t("Campaign eyebrow")}><input aria-label={t("Campaign eyebrow")} className={INPUT_CLASS} maxLength={80} value={draft.eyebrow} onChange={event => patch({ eyebrow: event.target.value })} /></Field>
        <Field label={t("Campaign title")}><input aria-label={t("Campaign title")} className={INPUT_CLASS} maxLength={120} value={draft.title} onChange={event => patch({ title: event.target.value })} /></Field>
        <Field label={t("Campaign CTA label")}><input aria-label={t("Campaign CTA label")} className={INPUT_CLASS} maxLength={60} value={draft.ctaLabel} onChange={event => patch({ ctaLabel: event.target.value })} /></Field>
        <Field label={t("Campaign CTA href")}><input aria-label={t("Campaign CTA href")} className={INPUT_CLASS} maxLength={512} value={draft.href} onChange={event => patch({ href: event.target.value })} /></Field>
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Add both a CTA label and destination, or leave both blank.")}</p>
      </FormSection> : <p className="text-sm text-[var(--ad-yellow-text)]">{t("This slot has no customer-facing renderer. It can be saved as a draft only.")}</p>}
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
