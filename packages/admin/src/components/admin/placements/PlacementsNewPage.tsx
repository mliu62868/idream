"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { useFailureToast } from "@/components/admin/ui/Toast";
import { FormPage, FormSection, Field, FormFooter, INPUT_CLASS } from "@/components/admin/ui/FormPage";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import { Pagination } from "@/components/admin/ui/Pagination";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { assetDisplayName, isPublishableOperatorUpload } from "@/components/admin/assets/assets-api";
import { useUrlBootstrap } from "@/components/admin/section-kit";
import type { AdminPageInfo } from "@idream/shared/admin";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  approvedAssetsListPath,
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
export function PlacementsNewPage({ canUpload = false, canReadRuns = false }: { canUpload?: boolean; canReadRuns?: boolean }) {
  const { t, value } = useAdminI18n();
  const [assets, setAssets] = useState<ApprovedAsset[]>([]);
  const [blockedAssets, setBlockedAssets] = useState<ApprovedAsset[]>([]);
  const [draft, setDraft] = useState<PlacementDraft>(defaultPlacementDraft);
  const [selectedAsset, setSelectedAsset] = useState<ApprovedAsset | null>(null);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [creating, setCreating] = useState(false);
  // 只装素材列表的读取失败；创建失败走 failure toast。
  const [error, setError] = useState<unknown>(null);
  const failureToast = useFailureToast();
  const [assetSearch, setAssetSearch] = useState("");
  const [preselectedAssetId, setPreselectedAssetId] = useState("");
  const [urlReady, setUrlReady] = useState(false);
  const [assetCursors, setAssetCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageInfo, setPageInfo] = useState<AdminPageInfo>({ hasNextPage: false, endCursor: null });
  const requestGate = useRef(createLatestRequestGate());
  const lastUrlAsset = useRef("");
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
      const preselected = eligible.find((asset) => asset.id === preselectedAssetId && isPublishableOperatorUpload(asset));
      // A page of search results is not the selected Campaign artwork. Update known
      // eligibility if the selected asset is present; absence says nothing about it.
      setSelectedAsset((current) => current
        ? data.items.find((asset) => asset.id === current.id) ?? current
        : preselected ?? null);
      if (preselected) {
        setDraft((current) => current.mediaAssetId
          ? current
          : { ...current, mediaAssetId: preselected.id, targetId: current.targetId || preselected.targetId || "" });
      }
    } catch (loadError) {
      if (!request.isCurrent()) return;
      setError(loadError);
    } finally {
      if (request.isCurrent()) setLoadingAssets(false);
    }
  }, [assetSearch, assetCursor, preselectedAssetId]);

  useUrlBootstrap(useCallback((params) => {
    const id = params.get("assetId")?.trim() ?? "";
    if (id !== lastUrlAsset.current) {
      lastUrlAsset.current = id;
      setSelectedAsset(null);
      setDraft((current) => current.mediaAssetId ? { ...current, mediaAssetId: "" } : current);
    }
    setPreselectedAssetId(id);
    setAssetSearch(id);
    setAssetCursors([undefined]);
    setUrlReady(true);
  }, []), requestGate);

  useEffect(() => {
    if (!urlReady) return;
    const timer = window.setTimeout(() => {
      void loadAssets();
    }, 200);
    const gate = requestGate.current;
    return () => { window.clearTimeout(timer); gate.invalidate(); };
  }, [loadAssets, urlReady]);

  function patch(partial: Partial<PlacementDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  function selectAsset(assetId: string) {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) return;
    setSelectedAsset(asset);
    patch({ mediaAssetId: assetId, targetId: asset.targetId ?? draft.targetId });
  }

  function invalidateAssets() {
    requestGate.current.invalidate();
    setLoadingAssets(true);
    setAssets([]);
    setBlockedAssets([]);
    setPageInfo({ hasNextPage: false, endCursor: null });
  }

  const isCampaign = draft.slot === "campaign";
  const fixedTarget = isCampaign || draft.slot === "template_cover";
  const targetLabel = t(isCampaign ? "Campaign destination key" : draft.slot === "template_cover" ? "Template ID" : "Target ID");
  const selectableAssets = isCampaign ? assets.filter(isPublishableOperatorUpload) : assets;
  const selectedIsAvailable = selectedAsset && selectedAsset.customerPublishable &&
    (!isCampaign || isPublishableOperatorUpload(selectedAsset));
  const matchedGeneratedAssets = isCampaign && assetSearch.trim()
    ? assets.filter((asset) => !isPublishableOperatorUpload(asset) && asset.sourceBatch)
    : [];
  const sourceRun = matchedGeneratedAssets.find(({ id }) => id === preselectedAssetId)?.sourceBatch ??
    (matchedGeneratedAssets.length === 1 ? matchedGeneratedAssets[0]?.sourceBatch : null);

  let nextStep: string | null = null;
  if (!selectedIsAvailable || selectedAsset?.id !== draft.mediaAssetId) {
    nextStep = "Choose an eligible image for the placement.";
  } else if (!draft.targetId.trim()) {
    nextStep = "Enter a destination key for this placement.";
  } else if (isCampaign && (!draft.eyebrow.trim() || !draft.title.trim())) {
    nextStep = "Enter the campaign eyebrow and title.";
  } else if (!validCampaignDraft(draft)) {
    nextStep = "Add a button label and a site path or HTTPS URL, or leave both blank.";
  }
  const canSubmit = !creating && nextStep === null;

  async function create() {
    if (!canSubmit) return;
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
      failureToast(createError);
      setCreating(false);
    }
  }

  return (
    <FormPage backHref="/admin/creative/placements" backLabel={t("Back to placements")} title={t("New placement")}>
      {isCampaign ? <p className="text-sm text-[var(--ad-text-muted)]">{t("Save the draft first. You can preview and publish it from the placement detail.")}</p> : null}
      <FormSection title={t("Basic info")}>
        <Field full label={t("Asset")}>
          <input aria-label={t("Search images")} className={`${INPUT_CLASS} mb-2`} placeholder={t("Search images")}
            value={assetSearch} onChange={(event) => { invalidateAssets(); setPreselectedAssetId(""); setAssetSearch(event.target.value); setAssetCursors([undefined]); }} />
          <select
            aria-label={t("Asset")}
            className={INPUT_CLASS}
            disabled={loadingAssets || (selectableAssets.length === 0 && !selectedIsAvailable)}
            onChange={(event) => selectAsset(event.target.value)}
            value={selectedIsAvailable ? draft.mediaAssetId : ""}
          >
            {!selectedIsAvailable ? <option value="">{t("Select an image")}</option> : null}
            {selectedIsAvailable && !selectableAssets.some((asset) => asset.id === selectedAsset.id) ? (
              <option value={selectedAsset.id}>{assetDisplayName(selectedAsset)}</option>
            ) : null}
            {selectableAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {assetDisplayName(asset)} · {asset.purpose ? value(asset.purpose) : t("Asset")}
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
          {selectedIsAvailable && selectedAsset.url ? <AssetImage asset={{
            url: selectedAsset.url,
            thumbnailUrl: selectedAsset.thumbnailUrl ?? "",
          }} preview /> : null}
          {blockedAssets.length > 0 ? (
            <p className="mt-2 text-xs text-[var(--ad-yellow-text)]" role="status">
              {blockedAssets.length === 1
                ? t("1 approved asset is hidden because generation authority is incomplete or untrusted.")
                : t("{count} approved assets are hidden because generation authority is incomplete or untrusted.", { count: blockedAssets.length })}
            </p>
          ) : null}
          {!loadingAssets && !error && selectableAssets.length === 0 && !selectedIsAvailable && !sourceRun ? (
            <p className="mt-2 text-sm text-[var(--ad-text-muted)]" role="status">
              {t(assetSearch ? "No eligible image matches this search. Try another name or clear the search." : "Choose an uploaded campaign image from the Image Library.")}
              {canUpload ? <Link className="ml-2 font-semibold underline" href="/admin/creative/library">{t("Open image library")}</Link> : null}
            </p>
          ) : null}
          {isCampaign ? (
            <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
              {t(canReadRuns ? "Generated artwork is placed from Generation History." : "Ask someone with access to Generation History to place generated artwork.")}
              {canReadRuns ? <Link className="ml-2 font-semibold underline" href={sourceRun ? `/admin/creative/runs/${encodeURIComponent(sourceRun.id)}` : "/admin/creative/runs"}>
                {t(sourceRun ? "Open the source generation record" : "Open Generation History")}
              </Link> : null}
            </p>
          ) : null}
        </Field>
        <Field label={t("Slot")}>
          <select className={INPUT_CLASS} onChange={(event) => {
            const slot = event.target.value as PlacementDraft["slot"];
            patch({ slot, targetType: slot === "campaign" ? "campaign" : slot === "template_cover" ? "template" : draft.targetType });
          }} value={draft.slot}>
            {SLOTS.map((slot) => (
              <option key={slot} value={slot}>
                {value(slot)}
              </option>
            ))}
          </select>
        </Field>
      </FormSection>
      <FormSection title={t("Target")}>
        {!fixedTarget ? <Field label={t("Target type")}>
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
        </Field> : null}
        <Field full={fixedTarget} label={targetLabel}>
          <input aria-label={targetLabel} className={INPUT_CLASS} maxLength={180} onChange={(event) => patch({ targetId: event.target.value })} required value={draft.targetId} />
        </Field>
      </FormSection>
      {isCampaign ? <FormSection title={t("Campaign")}>
        <Field label={t("Campaign eyebrow")}><input aria-label={t("Campaign eyebrow")} className={INPUT_CLASS} maxLength={80} required value={draft.eyebrow} onChange={event => patch({ eyebrow: event.target.value })} /></Field>
        <Field label={t("Campaign title")}><input aria-label={t("Campaign title")} className={INPUT_CLASS} maxLength={120} required value={draft.title} onChange={event => patch({ title: event.target.value })} /></Field>
        <Field label={t("Campaign CTA label")}><input aria-label={t("Campaign CTA label")} className={INPUT_CLASS} maxLength={60} value={draft.ctaLabel} onChange={event => patch({ ctaLabel: event.target.value })} /></Field>
        <Field label={t("Campaign CTA href")}><input aria-label={t("Campaign CTA href")} className={INPUT_CLASS} maxLength={512} value={draft.href} onChange={event => patch({ href: event.target.value })} /></Field>
      </FormSection> : <p className="text-sm text-[var(--ad-yellow-text)]">{t("This slot has no customer-facing renderer. It can be saved as a draft only.")}</p>}
      {error ? <AuthorityRequestError cause={error} message={t("The latest data could not be loaded.")} onRetry={() => void loadAssets()} requestKind="read" /> : null}
      <FormFooter>
        <PrimaryButton disabled={!canSubmit} onClick={() => void create()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Save placement draft")}
        </PrimaryButton>
        {nextStep ? <p className="text-sm text-[var(--ad-text-muted)]" role="status">{t(nextStep)}</p> : null}
      </FormFooter>
    </FormPage>
  );
}
