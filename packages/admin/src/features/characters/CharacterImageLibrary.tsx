"use client";

import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, Loader2, Search, Trash2, Upload, WandSparkles, X } from "lucide-react";
import {
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
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { readActiveDurableMutationIntent } from "@/lib/durable-mutation-intent";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { CharacterAssetStudio } from "./CharacterAssetStudio";
import type { CharacterAssetProjectMutation } from "./character-asset-studio-authority";

type CharacterImageLibraryProps = {
  actorId: string;
  data: CharacterWorkspaceDetail;
  canRead: boolean;
  canReadProduction: boolean;
  canCreate: boolean;
  canReview: boolean;
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
  canArchive,
  onContinue,
  onProjectReload,
  commitProjectMutation,
}: CharacterImageLibraryProps) {
  const { t } = useAdminI18n();
  const [assets, setAssets] = useState<CharacterImageSourceAsset[]>([]);
  const [search, setSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const activeImage = data.mediaOperations.operations.find((operation) =>
    operation.modality === "image" && operation.requestId &&
    ["pending", "queued", "running", "moderating_input", "moderating_output", "finalizing", "unknown"].includes(operation.status ?? "")
  );
  const [generatorOpen, setGeneratorOpen] = useState(() =>
    data.visual.identityBootstrap.allowed || Boolean(activeImage) || Boolean(
      readActiveDurableMutationIntent({ scope: `character-asset:create:${actorId}:${data.character.id}` }),
    ),
  );
  const showGenerator = generatorOpen;
  const activeImageLabel = activeImage?.status === "unknown"
    ? "Generation result awaiting confirmation"
    : "Image request in progress";
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [archiveSpec, setArchiveSpec] = useState<ConfirmSpec | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadAssets = useCallback(async (cursor: string | null = null) => {
    if (!canRead) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await adminV2Operation(
        "GET /api/v2/admin/characters/:id/image-sources",
        {
          path: { id: data.character.id },
          query: new URLSearchParams({ purpose: "character_library",
            ...(search.trim() ? { search: search.trim() } : {}),
            ...(cursor ? { cursor } : {}),
          }),
        },
      );
      if (version !== requestVersion.current) return;
      setAssets((current) => cursor ? [...current, ...result.items] : [...result.items]);
      setNextCursor(result.nextCursor ?? null);
    } catch (cause) {
      if (version === requestVersion.current) setLoadError(cause instanceof Error ? cause.message : t("Character images could not be loaded"));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [canRead, data.character.id, search, t]);

  useEffect(() => {
    const refresh = () => void loadAssets();
    const timer = window.setTimeout(() => void loadAssets(), 0);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [loadAssets]);

  const refreshAfterProduction = useCallback(async () => {
    await Promise.all([onProjectReload(), loadAssets()]);
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
      setMessage(t("Image imported. Choose it in Character operations."));
      await loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Image import failed"));
    } finally {
      setUploading(false);
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
  const visibleAssets = assets;

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
              aria-label={t("Import image")}
              className="sr-only"
              onChange={(event) => void upload(event)}
              ref={inputRef}
              type="file"
            />
            <WorkspaceButton disabled={!canCreate || uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t("Import image")}
            </WorkspaceButton>
            <WorkspaceButton disabled={!canReadProduction || (!canCreate && !activeImage)} onClick={() => setGeneratorOpen((open) => !open)} tone="primary">
              {showGenerator ? <X className="h-4 w-4" /> : <WandSparkles className="h-4 w-4" />}
              {t(showGenerator ? "Close creator" : activeImage ? "View generation" : "Create images")}
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

      {activeImage ? <p className="rounded-lg bg-[var(--ad-blue-bg)] p-3 text-sm" role="status">{t(activeImageLabel)}</p> : null}
      {showGenerator ? (
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
              <h3 className="mt-3 font-semibold">{t(query ? "No matching images" : activeImage ? activeImageLabel : "No images yet")}</h3>
              {query ? (
                <WorkspaceButton className="mt-3" onClick={() => setSearch("")}>{t("Clear search")}</WorkspaceButton>
              ) : (
                activeImage ? null : <p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Create or import the first image for this Character.")}</p>
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
        {nextCursor ? (
          <WorkspaceButton className="mt-4" disabled={loading} onClick={() => void loadAssets(nextCursor)}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("Load more images")}
          </WorkspaceButton>
        ) : null}
      </section>
      {archiveSpec ? <ConfirmDialog onClose={() => setArchiveSpec(null)} spec={archiveSpec} /> : null}
    </div>
  );
}
