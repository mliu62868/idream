"use client";

import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ImageIcon, Loader2, Search, Trash2, Upload, WandSparkles, X } from "lucide-react";
import {
  type CharacterImageSourceAsset,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import {
  assetArchiveBlocker,
  bulkArchiveAssets,
} from "@/components/admin/assets/assets-api";
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { readActiveDurableMutationIntent } from "@/lib/durable-mutation-intent";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { CharacterAssetStudio } from "./CharacterAssetStudio";
import type { CharacterAssetProjectMutation } from "./character-asset-studio-authority";
import { CharacterChatLibrary, type CharacterChatLibrarySource } from "./CharacterChatLibrary";
import { operatorReasonOrDefault, CHARACTER_LIBRARY_ARCHIVE_DEFAULT_REASON } from "./character-library-archive";
import { characterAssetPurposes, type CharacterAssetPurpose } from "./character-asset-studio-authority";
import { draftImageSelectionFrozen, useCharacterDraftImageSelection } from "./useCharacterDraftImageSelection";

const SEARCH_DEBOUNCE_MS = 300;
const BULK_ARCHIVE_LIMIT = 100;
// The server names files it did not receive a name for; such a name says nothing.
const GENERIC_FILENAME = /^image-source\.[a-z0-9]+$/i;
const PLACEMENT_LABELS: Record<CharacterAssetPurpose, string> = {
  character_cover: "Cover",
  character_hero: "Hero",
  character_chat: "Chat",
};
const PLACEMENT_ACTION_LABELS: Record<CharacterAssetPurpose, string> = {
  character_cover: "Use as cover",
  character_hero: "Use as hero",
  character_chat: "Use as chat image",
};

type CharacterImageLibraryProps = {
  actorId: string;
  data: CharacterWorkspaceDetail;
  canRead: boolean;
  canReadProduction: boolean;
  canCreate: boolean;
  canArchive: boolean;
  canPublish?: boolean;
  onContinue: (tab: "visual" | "preview") => void;
  onProjectReload: () => Promise<void>;
  commitProjectMutation: CharacterAssetProjectMutation;
};

function isPlacementPurpose(purpose: string): purpose is CharacterAssetPurpose {
  return (characterAssetPurposes as readonly string[]).includes(purpose);
}

export function CharacterImageLibrary({
  actorId,
  data,
  canRead,
  canReadProduction,
  canCreate,
  canArchive,
  canPublish = false,
  onContinue,
  onProjectReload,
  commitProjectMutation,
}: CharacterImageLibraryProps) {
  const { locale, t } = useAdminI18n();
  const [assets, setAssets] = useState<CharacterImageSourceAsset[]>([]);
  const [chatSource, setChatSource] = useState<CharacterChatLibrarySource | null>(null);
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [archiveSelection, setArchiveSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [placingAssetId, setPlacingAssetId] = useState<string | null>(null);
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
      readActiveDurableMutationIntent({ scope: `character-asset:create:${actorId}:${data.character.id}` }) ??
      readActiveDurableMutationIntent({ scope: `character-asset:selection:${actorId}:${data.character.id}` }),
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
  const archiveGeneration = useRef(0);
  useEffect(() => () => { archiveGeneration.current += 1; }, [canArchive]);
  if (archiveSpec && !canArchive) setArchiveSpec(null);
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
            ...(searchTerm ? { search: searchTerm } : {}),
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
  }, [canRead, data.character.id, searchTerm, t]);

  useEffect(() => {
    const term = search.trim();
    if (term === searchTerm) return;
    // Clearing is immediate; typing waits so a word is one request, not one per key.
    const timer = window.setTimeout(() => setSearchTerm(term), term ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [search, searchTerm]);

  useEffect(() => {
    const refresh = () => void loadAssets();
    const timer = window.setTimeout(() => void loadAssets(), 0);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [loadAssets]);

  const selection = useCharacterDraftImageSelection({
    actorId,
    data,
    canWrite: canCreate,
    commitProjectMutation,
    reloadProject: async () => {
      await Promise.all([onProjectReload(), loadAssets()]);
    },
    feedback: {
      error: (next) => setError(next),
    },
  });
  const selectionFrozen = draftImageSelectionFrozen(data);

  async function placeAsset(purpose: CharacterAssetPurpose, asset: CharacterImageSourceAsset) {
    setPlacingAssetId(asset.id);
    setMessage(null);
    try {
      await selection.selectLibraryAsset(purpose, asset, () => {
        setMessage(t("Image placed. It goes live with the next Release."));
        void loadAssets();
      });
    } finally {
      setPlacingAssetId(null);
    }
  }

  function toggleArchiveSelection(assetId: string) {
    setArchiveSelection((current) => {
      const next = new Set(current);
      if (!next.delete(assetId) && next.size < BULK_ARCHIVE_LIMIT) next.add(assetId);
      return next;
    });
  }

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
          // SPEC: 上传的意图由「哪个文件」定义 —— form 不进签名，没有它两次不同的上传会共用一把键。
          intent: `${file.name}:${file.size}:${file.lastModified}`,
          form,
        },
      );
      setMessage(t("Image imported. Choose where it appears above."));
      await loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Image import failed"));
    } finally {
      setUploading(false);
    }
  }

  // SPEC: 依赖检查由服务端决定且全成或全拒（assets/bulk）；原因选填，留空用默认。
  function requestArchive(assetIds: readonly string[]) {
    const generation = archiveGeneration.current;
    const single = assetIds.length === 1;
    setArchiveSpec({
      title: single ? "Remove image from library?" : t("Remove {count} images from the library?", { count: assetIds.length }),
      summary: single
        ? t("Images used as the cover, hero or chat image must be replaced first.")
        : t("If any of these images is in use, none will be removed. Replace it in its placement first."),
      consequence: {
        effect: single ? "The image will be archived and hidden from this Character's library." : "These images will be archived and hidden from this Character's library.",
        reversible: false,
      },
      reasonOptional: true,
      reasonLabel: "Removal reason (optional)",
      submitLabel: "Remove from library",
      onSubmit: async (reason) => {
        if (generation !== archiveGeneration.current) return;
        try {
          await bulkArchiveAssets({
            assetIds,
            reason: operatorReasonOrDefault(reason, CHARACTER_LIBRARY_ARCHIVE_DEFAULT_REASON),
          });
          if (generation !== archiveGeneration.current) return;
          setMessage(single ? t("Image removed from the library") : t("{count} images removed from the library", { count: assetIds.length }));
          setArchiveSelection(new Set());
          await loadAssets();
        } catch (cause) {
          if (generation !== archiveGeneration.current) return;
          const blocker = assetArchiveBlocker(cause);
          if (blocker?.kind === "dependency" && blocker.dependencies.length > 0) {
            throw new Error(t(single
              ? "Replace this image in its placement above before removing it."
              : "At least one of these images is in use, so none were removed. Replace it in its placement above first."));
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
              {t("Generate here or import images made elsewhere. The placements above choose from this library.")}
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
            placeholder={t("Search by file name, tag, description or date")}
            value={search}
          />
        </label>
        {canArchive && archiveSelection.size > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm" data-testid="image-library-bulk-actions">
            <span>{t("{count} selected", { count: archiveSelection.size })}</span>
            <WorkspaceButton onClick={() => requestArchive([...archiveSelection])} tone="danger">
              <Trash2 className="h-4 w-4" /> {t("Remove from library")}
            </WorkspaceButton>
            <WorkspaceButton onClick={() => setArchiveSelection(new Set())}>{t("Clear selection")}</WorkspaceButton>
          </div>
        ) : null}
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
              selectDraft: canCreate,
            }}
          />
        </section>
      ) : null}


      {canReadProduction ? <CharacterChatLibrary characterId={data.character.id} mediaType="image"
        canWrite={canCreate} canPublish={canPublish} source={chatSource} onCloseSource={() => setChatSource(null)} /> : null}

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
            {visibleAssets.map((asset) => {
              const usedIn = asset.qualification?.selectedPurposes ?? [];
              const placeable = (asset.qualification?.selectablePurposes ?? []).filter(isPlacementPurpose);
              return (
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
                      <p className="mt-0.5 truncate text-[11px] text-[var(--ad-text-muted)]">
                        {[
                          new Date(asset.createdAt).toLocaleString(adminDateLocale(locale)),
                          GENERIC_FILENAME.test(asset.filename) ? null : asset.filename,
                        ].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <span className="rounded-sm bg-black/[0.05] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide">
                      {t((asset.qualification?.state ?? "candidate").replaceAll("_", " "))}
                    </span>
                  </div>
                  {usedIn.length > 0 ? (
                    <p className="mt-2 flex flex-wrap items-center gap-1 text-xs font-semibold text-[var(--ad-green-text)]" data-testid="image-placements">
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                      {t("Used as {placements}", {
                        placements: usedIn.filter(isPlacementPurpose).map((purpose) => t(PLACEMENT_LABELS[purpose])).join(" · "),
                      })}
                    </p>
                  ) : null}
                  {asset.qualification?.blockers.length ? (
                    <p className="mt-2 text-xs leading-5 text-[var(--ad-yellow-text)]">
                      {t("Needs attention: {reasons}", {
                        reasons: asset.qualification.blockers
                          .map((blocker) => t(blocker.replaceAll("_", " ")))
                          .join(", "),
                      })}
                    </p>
                  ) : null}
                  {/* INVARIANT: 三个槽位用三张不同图片，已占用槽位的图不再提供其它槽位。 */}
                  {canCreate && usedIn.length === 0 && placeable.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5" data-testid="image-placement-actions">
                      {placeable.map((purpose) => (
                        <button
                          className="min-h-9 rounded-md border border-[var(--ad-border)] px-2 text-xs font-semibold hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={selectionFrozen || placingAssetId !== null || Boolean(selection.intent)}
                          key={purpose}
                          onClick={() => void placeAsset(purpose, asset)}
                          type="button"
                        >
                          {t(PLACEMENT_ACTION_LABELS[purpose])}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-3 flex items-center gap-2">
                    {canReadProduction ? <WorkspaceButton onClick={() => setChatSource({ id: asset.id, url: asset.url, thumbnailUrl: asset.thumbnailUrl ?? null })}>{t("Set up chat content")}</WorkspaceButton> : null}
                    {canArchive ? (
                      <>
                        <button
                          aria-label={t("Remove image from library")}
                          className="grid min-h-10 min-w-10 place-items-center rounded-md text-[var(--ad-text-muted)] hover:bg-[var(--ad-red-bg)] hover:text-[var(--ad-red-text)]"
                          onClick={() => requestArchive([asset.id])}
                          type="button"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                        <label className="ml-auto inline-flex min-h-10 items-center gap-1.5 text-xs text-[var(--ad-text-muted)]">
                          <input
                            checked={archiveSelection.has(asset.id)}
                            onChange={() => toggleArchiveSelection(asset.id)}
                            type="checkbox"
                          />
                          {t("Select")}
                        </label>
                      </>
                    ) : null}
                  </div>
                </div>
              </article>
              );
            })}
          </div>
        )}
        {nextCursor ? (
          <WorkspaceButton className="mt-4" disabled={loading} onClick={() => void loadAssets(nextCursor)}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("Load more images")}
          </WorkspaceButton>
        ) : null}
      </section>
      {archiveSpec ? <ConfirmDialog onClose={() => setArchiveSpec(current => current === archiveSpec ? null : current)} spec={archiveSpec} /> : null}
    </div>
  );
}
