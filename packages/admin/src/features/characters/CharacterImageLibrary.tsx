"use client";

import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ImageIcon, Loader2, Search, Trash2, Upload, WandSparkles, X } from "lucide-react";
import {
  CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
  type CharacterImageReviewRequest,
  type CharacterImageSourceAsset,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import {
  AssetBulkArchiveError,
  bulkArchiveAssets,
} from "@/components/admin/assets/assets-api";
import { WorkspaceButton, fieldClass, textAreaClass } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { CharacterAssetStudio } from "./CharacterAssetStudio";
import {
  emptyReviewDraft,
  reviewQualityChecks,
  type CharacterAssetProjectMutation,
} from "./character-asset-studio-authority";

type CharacterImageLibraryProps = {
  actorId: string;
  data: CharacterWorkspaceDetail;
  canRead: boolean;
  canReadProduction: boolean;
  canCreate: boolean;
  canReview: boolean;
  // SPEC: 导入图片审核还要求角色写权限，不能复用生成结果的审核授权。
  canReviewImported: boolean;
  canArchive: boolean;
  onContinue: (tab: "visual" | "preview") => void;
  onProjectReload: () => Promise<void>;
  commitProjectMutation: CharacterAssetProjectMutation;
};

export function CharacterImageLibrary({
  actorId,
  data,
  canRead,
  canReadProduction,
  canCreate,
  canReview,
  canReviewImported,
  canArchive,
  onContinue,
  onProjectReload,
  commitProjectMutation,
}: CharacterImageLibraryProps) {
  const { t } = useAdminI18n();
  const [assets, setAssets] = useState<CharacterImageSourceAsset[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(
    data.visual.identityBootstrap.allowed,
  );
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [archiveSpec, setArchiveSpec] = useState<ConfirmSpec | null>(null);
  const [reviewingAssetId, setReviewingAssetId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewDraft, setReviewDraft] = useState(() => emptyReviewDraft(false));
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadAssets = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await adminV2Operation(
        "GET /api/v2/admin/characters/:id/image-sources",
        {
          path: { id: data.character.id },
          query: new URLSearchParams({ purpose: "character_library" }),
        },
      );
      setAssets([...result.items]);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : t("Character images could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [canRead, data.character.id, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAssets(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAssets]);

  const refreshAfterProduction = useCallback(async () => {
    await onProjectReload();
    await loadAssets();
  }, [loadAssets, onProjectReload]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || uploading || !canCreate) return;
    if (file.size > 15 * 1024 * 1024) {
      setError(t("Image must be 15 MB or smaller"));
      return;
    }
    if (file.type && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError(t("Choose a JPG, PNG, or WebP image"));
      return;
    }
    setUploading(true);
    setError(null);
    setMessage(null);
    const form = new FormData();
    form.set("purpose", "character_library");
    form.set("image", file, file.name);
    try {
      await adminV2Operation(
        "POST /api/v2/admin/characters/:id/image-sources",
        {
          path: { id: data.character.id },
          idempotencyKey: crypto.randomUUID(),
          form,
        },
      );
      setMessage(t("Image imported as a Review candidate"));
      await loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Image import failed"));
    } finally {
      setUploading(false);
    }
  }

  function openReview(asset: CharacterImageSourceAsset) {
    if (!canReviewImported) return;
    const review = asset.qualification?.review;
    setReviewDraft({
      reason: "",
      score: review?.score === null || review?.score === undefined
        ? ""
        : String(review.score),
      identity: review?.identityConsistency === "failed" ? "failed" : "passed",
      quality: review?.quality ?? emptyReviewDraft(false).quality,
    });
    setReviewingAssetId(asset.id);
    setError(null);
    setMessage(null);
  }

  async function submitReview(decision: "approved" | "rejected") {
    const asset = assets.find((candidate) => candidate.id === reviewingAssetId);
    if (!canReviewImported || !asset?.qualification || reviewing) return;
    const numericScore = reviewDraft.score.trim()
      ? Number(reviewDraft.score)
      : undefined;
    const body: CharacterImageReviewRequest = {
      ...(asset.qualification.review?.id
        ? { supersedesDecisionId: asset.qualification.review.id }
        : {}),
      decision,
      identityConsistency: reviewDraft.identity === "failed" ? "failed" : "passed",
      ...(numericScore !== undefined && Number.isInteger(numericScore)
        ? { score: numericScore }
        : {}),
      quality: reviewDraft.quality,
      reason: reviewDraft.reason.trim(),
    };
    setReviewing(true);
    setError(null);
    setMessage(null);
    try {
      await adminV2Operation(
        "POST /api/v2/admin/characters/:id/image-sources/:assetId/reviews",
        {
          path: { id: data.character.id, assetId: asset.id },
          idempotencyKey: crypto.randomUUID(),
          body,
        },
      );
      setMessage(t(decision === "approved"
        ? "Review approved. This image is now selectable."
        : "Review rejected. This image remains in the library but cannot be selected."));
      setReviewingAssetId(null);
      await loadAssets();
      // INTENT: Review is already committed. The workspace owns its refresh
      // error and retry; do not leave a second, stale action error here.
      await onProjectReload().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Image Review failed"));
    } finally {
      setReviewing(false);
    }
  }

  function requestArchive(asset: CharacterImageSourceAsset) {
    setArchiveSpec({
      title: "Remove image from library?",
      summary: t("Images currently used by Character operations must be replaced first."),
      consequence: {
        effect: "The image will be archived and hidden from this Character's library.",
        reversible: true,
      },
      reasonLabel: "Removal reason",
      submitLabel: "Remove from library",
      onSubmit: async (reason) => {
        try {
          await bulkArchiveAssets({
            assetIds: [asset.id],
            reason,
            fallbackMessage: t("Image could not be removed"),
          });
          setMessage(t("Image removed from the library"));
          await loadAssets();
        } catch (cause) {
          if (cause instanceof AssetBulkArchiveError && cause.details.dependencies.length > 0) {
            throw new Error(t("Replace this image in Character operations before removing it."));
          }
          throw cause;
        }
      },
    });
  }

  if (!canRead) {
    return (
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8">
        <ImageIcon className="h-6 w-6" />
        <h3 className="mt-4 font-semibold">{t("No image library permission")}</h3>
      </section>
    );
  }

  const query = search.trim().toLowerCase();
  const visibleAssets = query
    ? assets.filter((asset) => [
        asset.id,
        asset.filename,
        asset.qualification?.source ?? "",
        asset.qualification?.state ?? "",
      ].join(" ").toLowerCase().includes(query))
    : assets;
  const reviewingAsset = assets.find((asset) => asset.id === reviewingAssetId) ?? null;
  const reviewScore = Number(reviewDraft.score);
  const approvalReady =
    reviewDraft.reason.trim().length >= 3 &&
    reviewDraft.identity === "passed" &&
    Number.isInteger(reviewScore) &&
    reviewScore >= CHARACTER_IDENTITY_APPROVAL_MIN_SCORE &&
    reviewScore <= 100 &&
    Object.values(reviewDraft.quality).every(Boolean);
  const rejectionReady = reviewDraft.reason.trim().length >= 3;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
              {t("Character image library")}
            </p>
            <h3 className="mt-1 text-xl font-semibold">{t("All images for {name}", { name: data.character.name })}</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
              {t("Generate here or import images made elsewhere. Character operations chooses from this same library.")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(event) => void upload(event)}
              ref={inputRef}
              type="file"
            />
            <WorkspaceButton disabled={!canCreate || uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t("Import image")}
            </WorkspaceButton>
            <WorkspaceButton disabled={!canCreate || !canReadProduction} onClick={() => setGeneratorOpen((open) => !open)} tone="primary">
              {generatorOpen ? <X className="h-4 w-4" /> : <WandSparkles className="h-4 w-4" />}
              {t(generatorOpen ? "Close creator" : "Create images")}
            </WorkspaceButton>
          </div>
        </div>
        <label className="relative mt-5 block max-w-md">
          <span className="sr-only">{t("Search images")}</span>
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--ad-text-muted)]" />
          <input
            className={`${fieldClass} pl-9`}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Search images")}
            value={search}
          />
        </label>
      </section>

      {error ? <p className="rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{t(error)}</p> : null}
      {message ? <p className="rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">{message}</p> : null}
      {loadError ? (
        <div className="rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">
          <p className="font-semibold">{t("Character images could not be loaded")}</p>
          {assets.length > 0 ? <p className="mt-1">{t("Showing previously loaded items.")}</p> : null}
          <details className="mt-2">
            <summary className="cursor-pointer">{t("Error details")}</summary>
            <p className="mt-1 break-words">{t(loadError)}</p>
          </details>
          <WorkspaceButton className="mt-3" disabled={loading} onClick={() => void loadAssets()}>{t("Retry")}</WorkspaceButton>
        </div>
      ) : null}

      {generatorOpen ? (
        <section aria-label={t("Image creator")} className="rounded-xl border border-[var(--ad-border)] bg-black/[0.015] p-3 sm:p-4">
          <CharacterAssetStudio
            actorId={actorId}
            commitProjectMutation={commitProjectMutation}
            data={data}
            key={`${actorId}:${data.character.id}:production`}
            onContinue={onContinue}
            onProjectReload={refreshAfterProduction}
            permissions={{
              read: canReadProduction,
              create: canCreate,
              review: canReview,
              selectDraft: canCreate,
            }}
            productionOnly={false}
          />
        </section>
      ) : null}

      {reviewingAsset?.qualification ? (
        <section aria-label={t("Review imported Character image")} className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Review")}</p>
              <h3 className="mt-1 text-lg font-semibold">{t("Qualify imported image")}</h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
                {t("This decision is pinned to the current sealed Visual Identity. Initial identity sources belong in Identity Lab; this path qualifies final Cover, Hero, and Chat candidates.")}
              </p>
            </div>
            <button aria-label={t("Close Review")} className="grid min-h-10 min-w-10 place-items-center rounded-md hover:bg-black/[0.04]" onClick={() => setReviewingAssetId(null)} type="button">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-lg border border-[var(--ad-border)]">
              <AssetImage asset={{
                url: reviewingAsset.url,
                thumbnailUrl: reviewingAsset.thumbnailUrl ?? reviewingAsset.url,
              }} />
              <p className="truncate px-3 py-2 text-xs text-[var(--ad-text-muted)]">{reviewingAsset.filename}</p>
            </div>
            <div className="space-y-4">
              <label className="block text-sm font-semibold">
                {t("Identity match score")}
                <input
                  className={`${fieldClass} mt-1`}
                  inputMode="numeric"
                  max={100}
                  min={0}
                  onChange={(event) => setReviewDraft((current) => ({ ...current, score: event.target.value }))}
                  placeholder={`${CHARACTER_IDENTITY_APPROVAL_MIN_SCORE}-100`}
                  type="number"
                  value={reviewDraft.score}
                />
              </label>
              <label className="flex min-h-11 items-center gap-3 rounded-md border border-[var(--ad-border)] px-3 text-sm font-medium">
                <input
                  checked={reviewDraft.identity === "passed"}
                  onChange={(event) => setReviewDraft((current) => ({ ...current, identity: event.target.checked ? "passed" : "failed" }))}
                  type="checkbox"
                />
                {t("Identity matches the current sealed Character")}
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                {reviewQualityChecks.map(([key, label]) => (
                  <label className="flex min-h-11 items-center gap-3 rounded-md border border-[var(--ad-border)] px-3 text-sm" key={key}>
                    <input
                      checked={reviewDraft.quality[key]}
                      onChange={(event) => setReviewDraft((current) => ({
                        ...current,
                        quality: { ...current.quality, [key]: event.target.checked },
                      }))}
                      type="checkbox"
                    />
                    {t(label)}
                  </label>
                ))}
              </div>
              <label className="block text-sm font-semibold">
                {t("Visible Review reason")}
                <textarea
                  className={`${textAreaClass} mt-1`}
                  onChange={(event) => setReviewDraft((current) => ({ ...current, reason: event.target.value }))}
                  value={reviewDraft.reason}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <WorkspaceButton disabled={!canReviewImported || reviewing || !approvalReady} onClick={() => void submitReview("approved")} tone="primary">
                  {reviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {t("Approve for placement")}
                </WorkspaceButton>
                <WorkspaceButton disabled={!canReviewImported || reviewing || !rejectionReady} onClick={() => void submitReview("rejected")} tone="danger">
                  {t("Reject candidate")}
                </WorkspaceButton>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section aria-busy={loading} aria-label={t("Character image library")}>
        {/* SPEC: Only a successful read can establish an empty library. */}
        {loading && assets.length === 0 ? (
          <div className="grid min-h-48 place-items-center rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : loadError && assets.length === 0 ? null : visibleAssets.length === 0 ? (
          <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-[var(--ad-border)] bg-black/[0.015] p-8 text-center">
            <div>
              <ImageIcon className="mx-auto h-7 w-7 text-[var(--ad-text-muted)]" />
              <h3 className="mt-3 font-semibold">{t(query ? "No matching images" : "No images yet")}</h3>
              {query ? (
                <WorkspaceButton className="mt-3" onClick={() => setSearch("")}>{t("Clear search")}</WorkspaceButton>
              ) : (
                <p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Create or import the first image for this Character.")}</p>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {visibleAssets.map((asset) => (
              <article className="group overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]" key={asset.id}>
                <AssetImage asset={{
                  url: asset.url,
                  thumbnailUrl: asset.thumbnailUrl ?? asset.url,
                }} />
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        {t(
                          asset.qualification?.source === "generation"
                            ? "Generated"
                            : asset.qualification?.source === "operator_upload"
                              ? "Imported"
                              : "Legacy",
                        )}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-[var(--ad-text-muted)]">{asset.filename}</p>
                    </div>
                    <span className="rounded-sm bg-black/[0.05] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide">
                      {t((asset.qualification?.state ?? "candidate").replaceAll("_", " "))}
                    </span>
                  </div>
                  {asset.qualification?.blockers.length ? (
                    <p className="mt-2 text-xs leading-5 text-[var(--ad-yellow-text)]">
                      {t("Needs attention: {reasons}", {
                        reasons: asset.qualification.blockers
                          .map((blocker) => t(blocker.replaceAll("_", " ")))
                          .join(", "),
                      })}
                    </p>
                  ) : null}
                  <div className="mt-3 flex items-center gap-2">
                    {canReviewImported &&
                    asset.qualification?.source === "operator_upload" &&
                    !["selected", "release_qualified"].includes(asset.qualification.state) ? (
                      <WorkspaceButton className="min-h-10 flex-1" onClick={() => openReview(asset)}>
                        {t(asset.qualification.review ? "Review again" : "Review image candidate")}
                      </WorkspaceButton>
                    ) : null}
                    {canArchive ? (
                      <button
                        aria-label={t("Remove image from library")}
                        className="grid min-h-10 min-w-10 place-items-center rounded-md text-[var(--ad-text-muted)] hover:bg-[var(--ad-red-bg)] hover:text-[var(--ad-red-text)]"
                        onClick={() => requestArchive(asset)}
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {archiveSpec ? <ConfirmDialog onClose={() => setArchiveSpec(null)} spec={archiveSpec} /> : null}
    </div>
  );
}
