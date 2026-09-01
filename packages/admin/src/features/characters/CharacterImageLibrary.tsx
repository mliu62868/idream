"use client";

import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, Loader2, Search, Trash2, Upload, WandSparkles, X } from "lucide-react";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import {
  AssetBulkArchiveError,
  assetsListPath,
  bulkArchiveAssets,
  type ContentAsset,
} from "@/components/admin/assets/assets-api";
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
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
  const [assets, setAssets] = useState<ContentAsset[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(
    data.visual.identityBootstrap.allowed,
  );
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
        assetsListPath({ targetId: data.character.id, limit: 100 }),
      );
      setAssets(result.items.filter((asset) => asset.platformStatus !== "archived"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Character images could not be loaded"));
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
      setMessage(t("Image imported to this Character's library"));
      await loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Image import failed"));
    } finally {
      setUploading(false);
    }
  }

  function requestArchive(asset: ContentAsset) {
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

      <section aria-busy={loading} aria-label={t("Character image library")}>
        {loading ? (
          <div className="grid min-h-48 place-items-center rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : visibleAssets.length === 0 ? (
          <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-[var(--ad-border)] bg-black/[0.015] p-8 text-center">
            <div>
              <ImageIcon className="mx-auto h-7 w-7 text-[var(--ad-text-muted)]" />
              <h3 className="mt-3 font-semibold">{t("No images yet")}</h3>
              <p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Create or import the first image for this Character.")}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {visibleAssets.map((asset) => (
              <article className="group overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]" key={asset.id}>
                <AssetImage asset={{ url: asset.url, thumbnailUrl: asset.thumbnailUrl }} />
                <div className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{t(asset.sourceJob ? "Generated" : "Imported")}</p>
                    <p className="mt-0.5 truncate text-[11px] text-[var(--ad-text-muted)]">{asset.id}</p>
                  </div>
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
              </article>
            ))}
          </div>
        )}
      </section>
      {archiveSpec ? <ConfirmDialog onClose={() => setArchiveSpec(null)} spec={archiveSpec} /> : null}
    </div>
  );
}
