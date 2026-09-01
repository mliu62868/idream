"use client";

import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { Loader2, Search, Trash2, Upload, Video, WandSparkles, X } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import {
  AssetBulkArchiveError,
  assetsListPath,
  bulkArchiveAssets,
  type ContentAsset,
} from "@/components/admin/assets/assets-api";
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  CharacterVideoStudio,
  type RunCommittedMutation,
} from "./CharacterVideoStudio";

type CharacterVideoLibraryProps = {
  actorId: string;
  data: CharacterWorkspaceDetail;
  canRead: boolean;
  canReadProduction: boolean;
  canCreate: boolean;
  canArchive: boolean;
  onCreateImage: () => void;
  onProjectReload: () => Promise<void>;
  runCommittedMutation: RunCommittedMutation;
};

export function CharacterVideoLibrary({
  actorId,
  data,
  canRead,
  canReadProduction,
  canCreate,
  canArchive,
  onCreateImage,
  onProjectReload,
  runCommittedMutation,
}: CharacterVideoLibraryProps) {
  const { t } = useAdminI18n();
  const [assets, setAssets] = useState<ContentAsset[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [archiveSpec, setArchiveSpec] = useState<ConfirmSpec | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadAssets = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiGet<{ items: ContentAsset[] }>(
        assetsListPath({
          mediaType: "video",
          targetId: data.character.id,
          limit: 100,
        }),
      );
      setAssets(result.items.filter((asset) => asset.platformStatus !== "archived"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Character videos could not be loaded"));
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
    if (file.size > 100 * 1024 * 1024) {
      setError(t("Video must be 100 MB or smaller"));
      return;
    }
    if (file.type && !["video/mp4", "video/webm"].includes(file.type)) {
      setError(t("Choose an MP4 or WebM video"));
      return;
    }
    setUploading(true);
    setError(null);
    setMessage(null);
    const form = new FormData();
    form.set("purpose", "character_video_library");
    form.set("video", file, file.name);
    try {
      await adminV2Operation(
        "POST /api/v2/admin/characters/:id/video-sources",
        {
          path: { id: data.character.id },
          idempotencyKey: crypto.randomUUID(),
          form,
        },
      );
      setMessage(t("Video imported to this Character's library"));
      await loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Video import failed"));
    } finally {
      setUploading(false);
    }
  }

  function requestArchive(asset: ContentAsset) {
    setArchiveSpec({
      title: "Remove video from library?",
      summary: t("Videos used by an active campaign or release must be replaced first."),
      consequence: {
        effect: "The video will be archived and hidden from this Character's library.",
        reversible: true,
      },
      reasonLabel: "Removal reason",
      submitLabel: "Remove from library",
      onSubmit: async (reason) => {
        try {
          await bulkArchiveAssets({
            assetIds: [asset.id],
            reason,
            fallbackMessage: t("Video could not be removed"),
          });
          setMessage(t("Video removed from the library"));
          await loadAssets();
        } catch (cause) {
          if (cause instanceof AssetBulkArchiveError && cause.details.dependencies.length > 0) {
            throw new Error(t("Replace this video where it is in use before removing it."));
          }
          throw cause;
        }
      },
    });
  }

  if (!canRead) {
    return (
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8">
        <Video className="h-6 w-6" />
        <h3 className="mt-4 font-semibold">{t("No video library permission")}</h3>
      </section>
    );
  }

  const query = search.trim().toLowerCase();
  const visibleAssets = query
    ? assets.filter((asset) => [
        asset.id,
        asset.description ?? "",
        asset.purpose ?? "",
        ...asset.tags,
      ].join(" ").toLowerCase().includes(query))
    : assets;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
              {t("Character video library")}
            </p>
            <h3 className="mt-1 text-xl font-semibold">{t("All videos for {name}", { name: data.character.name })}</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
              {t("Create videos here or import videos made elsewhere. No approval step is required.")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              accept="video/mp4,video/webm,.mp4,.webm"
              className="sr-only"
              onChange={(event) => void upload(event)}
              ref={inputRef}
              type="file"
            />
            <WorkspaceButton disabled={!canCreate || uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t("Import video")}
            </WorkspaceButton>
            <WorkspaceButton disabled={!canCreate || !canReadProduction} onClick={() => setCreatorOpen((open) => !open)} tone="primary">
              {creatorOpen ? <X className="h-4 w-4" /> : <WandSparkles className="h-4 w-4" />}
              {t(creatorOpen ? "Close creator" : "Create video")}
            </WorkspaceButton>
          </div>
        </div>
        <label className="relative mt-5 block max-w-md">
          <span className="sr-only">{t("Search videos")}</span>
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--ad-text-muted)]" />
          <input
            className={`${fieldClass} pl-9`}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Search videos")}
            value={search}
          />
        </label>
      </section>

      {error ? <p className="rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{t(error)}</p> : null}
      {message ? <p className="rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">{message}</p> : null}

      {creatorOpen ? (
        <section aria-label={t("Video creator")} className="rounded-xl border border-[var(--ad-border)] bg-black/[0.015] p-3 sm:p-4">
          <CharacterVideoStudio
            actorId={actorId}
            data={data}
            onCreateImage={onCreateImage}
            onProjectReload={refreshAfterProduction}
            permissions={{ read: canReadProduction, create: canCreate, review: false }}
            productionOnly
            runCommittedMutation={runCommittedMutation}
          />
        </section>
      ) : null}

      <section aria-busy={loading} aria-label={t("Character video library")}>
        {loading ? (
          <div className="grid min-h-48 place-items-center rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : visibleAssets.length === 0 ? (
          <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-[var(--ad-border)] bg-black/[0.015] p-8 text-center">
            <div>
              <Video className="mx-auto h-7 w-7 text-[var(--ad-text-muted)]" />
              <h3 className="mt-3 font-semibold">{t("No videos yet")}</h3>
              <p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Create or import the first video for this Character.")}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleAssets.map((asset) => (
              <article className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]" key={asset.id}>
                <video
                  aria-label={t("Video for {name}", { name: data.character.name })}
                  className="aspect-video w-full bg-black object-contain"
                  controls
                  preload="metadata"
                  src={asset.url}
                />
                <div className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{t(asset.sourceJob ? "Generated" : "Imported")}</p>
                    <p className="mt-0.5 truncate text-[11px] text-[var(--ad-text-muted)]">{asset.id}</p>
                  </div>
                  {canArchive ? (
                    <button
                      aria-label={t("Remove video from library")}
                      className="grid min-h-10 min-w-10 place-items-center rounded-md text-[var(--ad-text-muted)] hover:bg-[var(--ad-red-bg)] hover:text-[var(--ad-red-text)]"
                      onClick={() => requestArchive(asset)}
                      type="button"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  ) : null}
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
