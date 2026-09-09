"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { CardGrid } from "@/components/admin/ui/CardGrid";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { Pagination } from "@/components/admin/ui/Pagination";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { LoadingWorkspace } from "@/features/operations/WorkspaceUi";
import type { AdminPageInfo } from "@idream/shared/admin";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  canGoPrevious,
  listPageFromParams,
  requestErrorMessage,
  syncListUrl,
  useDebouncedReload,
  useUrlBootstrap,
} from "@/components/admin/section-kit";
import {
  ASSET_PURPOSES,
  ASSET_STATUSES,
  ASSET_UPLOAD_PURPOSES,
  AssetBulkArchiveError,
  assetAuthorityDependencyView,
  assetsListPath,
  bulkArchiveAssets,
  canonicalAssetIds,
  preflightArchiveAssets,
  uploadPlatformAsset,
  type AssetAuthorityDependency,
  type AssetBulkArchiveErrorDetails,
  type ContentAsset,
} from "./assets-api";
import { MediaAssetAuthorityNotice } from "./MediaAssetAuthority";

const PAGE_SIZE = 25;
const EMPTY_PAGE_INFO: AdminPageInfo = { endCursor: null, hasNextPage: false };

// SPEC: 图片库列表页 —— 状态/用途走服务端查询参数拼接（沿用 旧图片库视图 原有筛选方式，不改
// 成客户端过滤——资产量可观，服务端筛更省），标签/描述/id 关键词走客户端二次过滤（新增，复用运营
// 已经在维护的检索元数据，满足 FilterBar 必填 search 的同时不折损任何既有能力）。图片网格
// （AssetImage + 状态 pill + purpose 一行），点卡进详情页。
// INTENT: 浏览页只浏览；审核动作（通过/保存/拒绝/归档）搬到详情页——旧图片库视图 原本把这些
// 动作和标签/描述编辑框直接摆在每张卡片上，现在随点卡进详情统一处理（capability 仍在，只是换了
// 落脚点；与 Starters/Recipes/Presets 的 list=浏览、detail=编辑 分工一致）。
export function AssetsListPage({ canReview = true }: { canReview?: boolean }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<ContentAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; cause: unknown } | null>(null);
  const [status, setStatus] = useState("all");
  const [purpose, setPurpose] = useState("all");
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<AdminPageInfo>(EMPTY_PAGE_INFO);
  const [ready, setReady] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [preflightBlockers, setPreflightBlockers] = useState<AssetDependencyFinding[]>([]);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [pendingArchiveIds, setPendingArchiveIds] = useState<string[] | null>(null);
  const [serverConflict, setServerConflict] = useState<AssetBulkArchiveErrorDetails | null>(null);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [uploadPurpose, setUploadPurpose] = useState<(typeof ASSET_UPLOAD_PURPOSES)[number]>("campaign");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadRevision, setUploadRevision] = useState(0);
  const requestGate = useRef(createLatestRequestGate());
  const preflightRequestGate = useRef(createLatestRequestGate());
  const uploadInput = useRef<HTMLInputElement>(null);

  const clearBulkFeedback = useCallback(() => {
    preflightRequestGate.current.invalidate();
    setPreflightBusy(false);
    setPreflightBlockers([]);
    setPreflightError(null);
    setServerConflict(null);
    setBulkStatus(null);
  }, []);

  const clearForNextQuery = useCallback(() => {
    requestGate.current.invalidate();
    setRows([]);
    setSelectedIds(new Set());
    clearBulkFeedback();
    setPageInfo(EMPTY_PAGE_INFO);
    setLoading(true);
    setError(null);
    setPage(1);
  }, [clearBulkFeedback]);

  const reload = useCallback(async (nextCursor: string | undefined, nextPage: number) => {
    void uploadRevision;
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: ContentAsset[]; pageInfo: AdminPageInfo }>(assetsListPath({ status, purpose, search, targetId, cursor: nextCursor, limit: PAGE_SIZE }));
      if (!request.isCurrent()) return;
      setRows(data.items);
      setCursor(nextCursor);
      setPageInfo(data.pageInfo);
      const params = new URLSearchParams();
      if (status !== "all") params.set("status", status);
      if (purpose !== "all") params.set("purpose", purpose);
      if (search.trim()) params.set("search", search.trim());
      if (targetId.trim()) params.set("targetId", targetId.trim());
      if (nextCursor) params.set("cursor", nextCursor);
      syncListUrl(params, nextPage);
    } catch (loadError) {
      if (!request.isCurrent()) return;
      setError({ message: requestErrorMessage(loadError, t), cause: loadError });
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [purpose, search, status, targetId, t, uploadRevision]);

  useUrlBootstrap(useCallback((params: URLSearchParams) => {
    setStatus(params.get("status") ?? "all");
    setPurpose(params.get("purpose") ?? "all");
    setSearch(params.get("search") ?? "");
    setTargetId(params.get("targetId") ?? "");
    setCursor(params.get("cursor") ?? undefined);
    setPage(listPageFromParams(params));
    setReady(true);
  }, []), requestGate);
  // 依赖预检有自己的在途请求，卸载时也要作废——它和列表请求不共用同一个闸。
  useEffect(() => {
    const preflightGate = preflightRequestGate.current;
    return () => preflightGate.invalidate();
  }, []);

  useDebouncedReload({ cursor, page, ready, reload, search });

  const hasFilters = status !== "all" || purpose !== "all" || search.trim().length > 0 || targetId.trim().length > 0;

  const selectableIds = useMemo(
    () => rows.filter((asset) => asset.platformStatus !== "archived").map((asset) => asset.id),
    [rows],
  );
  const allSelectableSelected = selectableIds.length > 0
    && selectableIds.every((id) => selectedIds.has(id));

  const updateSelection = useCallback((id: string, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
    clearBulkFeedback();
  }, [clearBulkFeedback]);

  async function preflightSelectedAssets() {
    const ids = canonicalAssetIds([...selectedIds]);
    if (ids.length === 0) return;
    const request = preflightRequestGate.current.begin();
    setPreflightBusy(true);
    setPreflightBlockers([]);
    setPreflightError(null);
    setServerConflict(null);
    setBulkStatus(null);
    try {
      const result = await preflightArchiveAssets(ids, t("Request failed"));
      if (!request.isCurrent()) return;
      const blockers = result.blockers.flatMap((blocker) =>
        blocker.dependencies.map((dependency) => ({
          assetId: blocker.assetId,
          dependency,
        })),
      );
      setPreflightBlockers(blockers);
      if (blockers.length === 0) setPendingArchiveIds(ids);
    } catch (loadError) {
      if (!request.isCurrent()) return;
      if (loadError instanceof AssetBulkArchiveError) {
        const affectedAssetIds = [
          ...(loadError.details.assetId ? [loadError.details.assetId] : []),
          ...loadError.details.missingAssetIds,
        ];
        setPreflightError(
          affectedAssetIds.length > 0
            ? t("Dependency preflight failed for asset(s) {ids}: {message}", {
                ids: affectedAssetIds.join(", "),
                message: loadError.message,
              })
            : loadError.message,
        );
        return;
      }
      setPreflightError(
        loadError instanceof Error
          ? loadError.message
          : t("Could not check selected asset dependencies."),
      );
    } finally {
      if (request.isCurrent()) setPreflightBusy(false);
    }
  }

  async function uploadSelectedImages(files: readonly File[]) {
    if (files.length === 0) return;
    setUploadBusy(true);
    setUploadError(null);
    setUploadStatus(null);
    let uploadedCount = 0;
    try {
      for (const file of files) {
        await uploadPlatformAsset({
          file,
          purpose: uploadPurpose,
          fallbackMessage: t("Image upload failed"),
        });
        uploadedCount += 1;
      }
      setUploadStatus(t("{count} images uploaded to the Library.", {
        count: uploadedCount,
      }));
    } catch (uploadFailure) {
      setUploadError(
        uploadedCount > 0
          ? t("{count} images uploaded; the next upload failed: {message}", {
              count: uploadedCount,
              message: uploadFailure instanceof Error
                ? uploadFailure.message
                : t("Image upload failed"),
            })
          : uploadFailure instanceof Error
            ? uploadFailure.message
            : t("Image upload failed"),
      );
    } finally {
      setUploadBusy(false);
      if (uploadedCount > 0) {
        clearForNextQuery();
        setStatus("all");
        setPurpose("all");
        setSearch("");
        setTargetId("");
        setCursor(undefined);
        setPage(1);
        setUploadRevision((revision) => revision + 1);
      }
    }
  }

  const submitBulkArchive = useCallback(async (assetIds: readonly string[], reason: string) => {
    try {
      const result = await bulkArchiveAssets({ assetIds, reason, fallbackMessage: t("Request failed") });
      setSelectedIds(new Set());
      setPreflightBlockers([]);
      setServerConflict(null);
      setBulkStatus(
        t("{count} assets archived. The selection was cleared.", {
          count: result.updatedIds.length,
        }),
      );
      await reload(cursor, page);
    } catch (submitError) {
      if (submitError instanceof AssetBulkArchiveError) {
        setServerConflict(submitError.details);
      }
      throw submitError;
    }
  }, [cursor, page, reload, t]);

  return (
    <div aria-busy={loading}>
      <PageHeader purpose={t("Upload, organize, and stage operational image assets.")} title={t("Operational Assets")} />
      {canReview ? (
        <section
          aria-label={t("Upload operational images")}
          className="mb-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="font-semibold text-[var(--ad-ink)]">
                {t("Upload operational images")}
              </h2>
              <p className="mt-1 text-sm text-[var(--ad-text-muted)]">
                {t("Create artwork with any tool, then upload the final JPEG, PNG, or WebP here. Character images still belong in the Character workspace.")}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Purpose")}
                <select
                  aria-label={t("Upload purpose")}
                  className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-ink)]"
                  disabled={uploadBusy}
                  onChange={(event) => setUploadPurpose(event.target.value as typeof uploadPurpose)}
                  value={uploadPurpose}
                >
                  {ASSET_UPLOAD_PURPOSES.map((item) => (
                    <option key={item} value={item}>{value(item)}</option>
                  ))}
                </select>
              </label>
              <input
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                aria-label={t("Choose images to upload")}
                className="sr-only"
                disabled={uploadBusy}
                multiple
                onChange={(event) => {
                  const files = [...(event.currentTarget.files ?? [])];
                  event.currentTarget.value = "";
                  void uploadSelectedImages(files);
                }}
                ref={uploadInput}
                type="file"
              />
              <PrimaryButton
                disabled={uploadBusy}
                onClick={() => uploadInput.current?.click()}
              >
                {uploadBusy ? t("Uploading…") : t("Upload images")}
              </PrimaryButton>
            </div>
          </div>
          {uploadError ? (
            <p className="mt-3 rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">
              {uploadError}
            </p>
          ) : null}
          {uploadStatus ? (
            <p className="mt-3 rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">
              {uploadStatus}
            </p>
          ) : null}
        </section>
      ) : null}
      {targetId ? (
        // SPEC: 收窄范围必须可见且可撤销。
        // INTENT: 从角色工作台"查看全部"跳进来时列表只剩该角色的图，不说明就像图库丢了数据。
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] px-3 py-2 text-sm">
          <span>{t("Scoped to character {id}", { id: targetId })}</span>
          <button
            className="min-h-11 shrink-0 text-sm font-semibold underline"
            onClick={() => {
              clearForNextQuery();
              setTargetId("");
              setCursor(undefined);
            }}
            type="button"
          >
            {t("Show all characters")}
          </button>
        </div>
      ) : null}
      <FilterBar
        onSearch={(value) => {
          clearForNextQuery();
          setSearch(value);
          setCursor(undefined);
        }}
        search={search}
        searchPlaceholder={t("Search by tag, description, or asset ID")}
        selects={[
          {
            name: t("Status"),
            value: status,
            onChange: (value) => {
              clearForNextQuery();
              setStatus(value);
              setCursor(undefined);
            },
            options: [
              { value: "all", label: t("All") },
              ...ASSET_STATUSES.map((item) => ({ value: item, label: value(item) })),
            ],
          },
          {
            name: t("Purpose"),
            value: purpose,
            onChange: (value) => {
              clearForNextQuery();
              setPurpose(value);
              setCursor(undefined);
            },
            options: [
              { value: "all", label: t("All") },
              ...ASSET_PURPOSES.map((item) => ({ value: item, label: value(item) })),
            ],
          },
        ]}
      />
      {canReview && rows.length > 0 ? (
        <section
          aria-label={t("Bulk archive")}
          className="mb-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-[var(--ad-ink)]">
                {t("{count} selected", { count: selectedIds.size })}
              </p>
              <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                {t("Archive only after every active usage has been replaced or withdrawn.")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <GhostButton
                disabled={preflightBusy || selectableIds.length === 0 || allSelectableSelected}
                onClick={() => {
                  setSelectedIds(new Set(selectableIds));
                  clearBulkFeedback();
                }}
              >
                {t("Select page")}
              </GhostButton>
              <GhostButton
                disabled={preflightBusy || selectedIds.size === 0}
                onClick={() => {
                  setSelectedIds(new Set());
                  clearBulkFeedback();
                }}
              >
                {t("Clear selection")}
              </GhostButton>
              <DangerButton
                disabled={preflightBusy || selectedIds.size === 0}
                onClick={() => void preflightSelectedAssets()}
              >
                {preflightBusy ? t("Checking dependencies…") : t("Archive selected")}
              </DangerButton>
            </div>
          </div>
        </section>
      ) : null}
      {error ? (
        <div className="mb-4">
          <AuthorityRequestError cause={error.cause} message={error.message} onRetry={() => void reload(cursor, page)} snapshotAt={null} />
        </div>
      ) : null}
      {preflightError ? (
        <p
          className="mb-4 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {preflightError}
        </p>
      ) : null}
      {preflightBlockers.length > 0 ? (
        <div
          className="mb-4 rounded-lg border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-4 text-[var(--ad-yellow-text)]"
          role="alert"
        >
          <p className="text-sm font-semibold">
            {t("{count} selected assets have active authority dependencies.", {
              count: new Set(preflightBlockers.map((finding) => finding.assetId)).size,
            })}
          </p>
          <p className="mt-1 text-xs">
            {t("Repair each usage before archiving. No selected asset was changed.")}
          </p>
          <AssetDependencyList findings={preflightBlockers} />
        </div>
      ) : null}
      {bulkStatus ? (
        <p
          className="mb-4 rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
          role="status"
        >
          {bulkStatus}
        </p>
      ) : null}
      {loading && rows.length === 0 ? (
        <LoadingWorkspace label="Loading the image library…" />
      ) : rows.length === 0 && !error ? (
        // SPEC: 非角色运营素材从上传进入；筛选空态只需放宽筛选，真正空态直接复用上方上传入口。
        <EmptyState
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {hasFilters ? (
                <GhostButton
                  onClick={() => {
                    clearForNextQuery();
                    setStatus("all");
                    setPurpose("all");
                    setSearch("");
                    setTargetId("");
                    setCursor(undefined);
                  }}
                >
                  {t("Reset filters")}
                </GhostButton>
              ) : null}
              {!hasFilters && canReview ? (
                <PrimaryButton onClick={() => uploadInput.current?.click()}>
                  {t("Upload images")}
                </PrimaryButton>
              ) : null}
            </div>
          }
          hint={hasFilters
            ? t("Widen the filters to find an existing asset, or upload new artwork above.")
            : canReview
              ? t("Upload final artwork to create the first platform asset.")
              : t("No operational image assets have been uploaded yet.")}
          kind={hasFilters ? "filtered" : "empty"}
          title={hasFilters ? t("No platform assets match these filters.") : t("No platform assets yet.")}
        />
      ) : rows.length > 0 ? (
        <CardGrid>
          {rows.map((asset, index) => (
            <AssetCard
              asset={asset}
              canSelect={canReview}
              eager={index < 4}
              key={asset.id}
              onSelectedChange={(selected) => updateSelection(asset.id, selected)}
              selected={selectedIds.has(asset.id)}
            />
          ))}
        </CardGrid>
      ) : null}
      <div className="mt-4">
        <Pagination
          hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
          // 这个 operation 的查询契约没有 `before` —— 置灰，不假装已经在第一页（section-kit 有全部理由）。
          hasPrevious={canGoPrevious(pageInfo, false)}
          loading={loading}
          onNext={() => {
            const next = pageInfo.endCursor ?? undefined;
            const nextPage = page + 1;
            clearForNextQuery();
            setCursor(next);
            setPage(nextPage);
          }}
          onPrevious={() => undefined}
          page={page}
          pageSize={PAGE_SIZE}
          rowCount={rows.length}
          totalCount={pageInfo.totalCount ?? null}
        />
      </div>
      {pendingArchiveIds ? (
        <BulkArchiveConfirmDialog
          assetIds={pendingArchiveIds}
          conflict={serverConflict}
          onClose={() => {
            setPendingArchiveIds(null);
            setServerConflict(null);
          }}
          onSubmit={(reason) => submitBulkArchive(pendingArchiveIds, reason)}
        />
      ) : null}
    </div>
  );
}

type AssetDependencyFinding = {
  assetId?: string;
  dependency: AssetAuthorityDependency;
};

function BulkArchiveConfirmDialog({
  assetIds,
  conflict,
  onClose,
  onSubmit,
}: {
  assetIds: readonly string[];
  conflict: AssetBulkArchiveErrorDetails | null;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const { t } = useAdminI18n();
  const confirmation = assetIds.join(",");
  const spec: ConfirmSpec = {
    title: t("Archive selected assets"),
    summary: (
      <div className="space-y-3">
        <p>
          {t(
            "Bulk archive is atomic. If one asset is still in use, none of the selected assets will change.",
          )}
        </p>
        {!conflict ? (
          <p className="rounded-md bg-[var(--ad-green-bg)] p-3 text-[var(--ad-green-text)]">
            {t(
              "Preflight checked {count} assets. No active authority dependencies were found.",
              { count: assetIds.length },
            )}
          </p>
        ) : null}
        <div>
          <p className="text-xs font-semibold text-[var(--ad-ink)]">
            {t("Paste these exact asset IDs to confirm")}
          </p>
          <code className="mt-1 block max-h-28 overflow-auto break-all rounded-md border border-[var(--ad-border)] bg-black/[0.03] p-2 text-xs text-[var(--ad-ink)]">
            {confirmation}
          </code>
        </div>
        {conflict ? <ServerConflictSummary details={conflict} /> : null}
      </div>
    ),
    destructive: {
      expectedName: confirmation,
      inputLabel: t("Paste exact asset IDs to confirm"),
    },
    submitLabel: t("Archive selected"),
    onSubmit,
  };
  return <ConfirmDialog onClose={onClose} spec={spec} />;
}

function AssetDependencyList({ findings }: { findings: AssetDependencyFinding[] }) {
  const { t } = useAdminI18n();
  return (
    <ul className="mt-3 grid gap-2">
      {findings.map((finding) => {
        const dependencyView = assetAuthorityDependencyView(finding.dependency);
        return (
          <li
            className="rounded-md border border-current/15 bg-[var(--ad-surface)] p-3 text-sm text-[var(--ad-ink)]"
            key={`${finding.assetId ?? "server"}:${dependencyView.key}`}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="font-semibold">{t(dependencyView.title)}</p>
                {finding.assetId ? (
                  <code className="mt-1 block break-all text-xs text-[var(--ad-text-muted)]">
                    {finding.assetId}
                  </code>
                ) : null}
                <p className="mt-1 break-all text-xs text-[var(--ad-text-muted)]">
                  {dependencyView.detail}
                </p>
              </div>
              <Link
                className="shrink-0 text-sm font-semibold underline"
                href={finding.dependency.repairPath}
              >
                {t("Open authority")}
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ServerConflictSummary({ details }: { details: AssetBulkArchiveErrorDetails }) {
  const { t } = useAdminI18n();
  const findings = details.dependencies.map((dependency) => ({
    assetId: details.assetId,
    dependency,
  }));
  return (
    <div
      className="rounded-md border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] p-3 text-[var(--ad-red-text)]"
      role="alert"
    >
      <p className="font-semibold">
        {t("Archive blocked by a newer authority dependency. No selected asset was changed.")}
      </p>
      {details.missingAssetIds.length > 0 ? (
        <p className="mt-2 break-all text-xs">
          {t("Missing selected assets: {ids}", {
            ids: details.missingAssetIds.join(", "),
          })}
        </p>
      ) : null}
      {findings.length > 0 ? <AssetDependencyList findings={findings} /> : null}
      {findings.length === 0 && details.repairPath ? (
        <Link className="mt-2 inline-block font-semibold underline" href={details.repairPath}>
          {t("Open authority")}
        </Link>
      ) : null}
    </div>
  );
}

function AssetCard({
  asset,
  canSelect,
  eager,
  onSelectedChange,
  selected,
}: {
  asset: ContentAsset;
  canSelect: boolean;
  eager: boolean;
  onSelectedChange: (selected: boolean) => void;
  selected: boolean;
}) {
  const { t, value } = useAdminI18n();
  const archiveSelectable = asset.platformStatus !== "archived";
  return (
    <article
      className={`overflow-hidden rounded-lg border bg-[var(--ad-surface)] transition-colors ${
        selected
          ? "border-[var(--ad-ink)]"
          : "border-[var(--ad-border)]"
      }`}
    >
      {canSelect ? (
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--ad-border)] px-3 py-2">
          <label className={`flex items-center gap-2 text-xs font-semibold ${
            archiveSelectable ? "cursor-pointer text-[var(--ad-ink)]" : "text-[var(--ad-text-muted)]"
          }`}>
            <input
              aria-label={t("Select asset {id}", { id: asset.id })}
              checked={selected}
              className="h-4 w-4 accent-[var(--ad-ink)]"
              disabled={!archiveSelectable}
              onChange={(event) => onSelectedChange(event.target.checked)}
              type="checkbox"
            />
            {selected ? t("Selected") : t("Select")}
          </label>
          {!archiveSelectable ? (
            <span className="text-xs text-[var(--ad-text-muted)]">{t("Already archived")}</span>
          ) : null}
        </div>
      ) : null}
      <Link
        className="group block transition-shadow hover:shadow-[var(--ad-shadow-hover)]"
        href={`/admin/content/assets/${asset.id}`}
      >
        <AssetImage asset={asset} eager={eager} />
        <div className="space-y-1.5 p-4">
          <MediaAssetAuthorityNotice asset={asset} />
          <StatusPill status={asset.platformStatus} />
          <p className="truncate font-mono text-xs text-[var(--ad-text-muted)]" title={asset.id}>
            {asset.id}
          </p>
          <p className="truncate text-xs text-[var(--ad-text-muted)]">
            {asset.purpose ? value(asset.purpose) : "—"}
          </p>
        </div>
      </Link>
    </article>
  );
}
