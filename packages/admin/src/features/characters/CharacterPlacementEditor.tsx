"use client";

import { useCallback, useState } from "react";
import { Check, ImageIcon, Loader2, Replace } from "lucide-react";
import Image from "next/image";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { assetsListPath, type ContentAsset } from "@/components/admin/assets/assets-api";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import type { RunCommittedCharacterMutation } from "./character-workspace-permissions";

const placements = [
  { purpose: "character_cover", label: "Cover", description: "Character cards and primary portrait", aspect: "aspect-square" },
  { purpose: "character_hero", label: "Hero", description: "Character detail hero image", aspect: "aspect-[16/9]" },
  { purpose: "character_chat", label: "Chat", description: "Conversation scene image", aspect: "aspect-[4/5]" },
] as const;

type PlacementPurpose = (typeof placements)[number]["purpose"];

export function CharacterPlacementEditor({
  data,
  canWrite,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  canWrite: boolean;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const [assets, setAssets] = useState<ContentAsset[]>([]);
  const [choosing, setChoosing] = useState<PlacementPurpose | null>(null);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAssets = useCallback(async () => {
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
  }, [data.character.id, t]);

  function openChooser(purpose: PlacementPurpose) {
    setChoosing(purpose);
    void loadAssets();
  }

  async function selectAsset(purpose: PlacementPurpose, assetId: string) {
    setBusyAssetId(assetId);
    setError(null);
    try {
      await runCommittedMutation({
        action: `${purpose} image selection`,
        commit: () => adminV2Operation(
          "PATCH /api/v2/admin/characters/:id/draft-image",
          {
            path: { id: data.character.id },
            ifMatch: data.project.version,
            idempotencyKey: crypto.randomUUID(),
            body: {
              entityVersion: data.project.version,
              purpose,
              assetId,
              reason: `Selected from ${data.character.name}'s image library`,
            },
          },
        ),
        afterRefresh: () => setChoosing(null),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Image placement could not be saved"));
    } finally {
      setBusyAssetId(null);
    }
  }

  const usedAssetIds = new Set(Object.values(data.project.draftAssetPack));

  return (
    <section className="mb-5 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-5" aria-labelledby="character-placement-title">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Character operations")}</p>
        <h3 className="mt-1 text-xl font-semibold" id="character-placement-title">{t("Choose where existing images appear")}</h3>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
          {t("Each placement uses an image already in this Character's library. Creating and importing stay in Images.")}
        </p>
      </div>
      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        {placements.map((placement) => {
          const slot = data.preview.draft.assetPack[placement.purpose];
          return (
            <article className="overflow-hidden rounded-lg border border-[var(--ad-border)]" key={placement.purpose}>
              <div className={`${placement.aspect} relative grid place-items-center overflow-hidden bg-black/[0.04]`}>
                {slot.imageUrl ? (
                  <Image
                    alt={t("{name} {placement}", { name: data.character.name, placement: t(placement.label) })}
                    className="object-cover"
                    fill
                    sizes="(min-width: 1024px) 33vw, 100vw"
                    src={slot.imageUrl}
                    unoptimized
                  />
                ) : (
                  <ImageIcon className="h-7 w-7 text-[var(--ad-text-muted)]" />
                )}
              </div>
              <div className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold">{t(placement.label)}</h4>
                    <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t(placement.description)}</p>
                  </div>
                  <span className={`text-xs font-semibold ${slot.status === "available" ? "text-[var(--ad-green-text)]" : "text-[var(--ad-yellow-text)]"}`}>
                    {t(slot.status === "available" ? "Selected" : "Missing")}
                  </span>
                </div>
                <WorkspaceButton className="mt-3 w-full justify-center" disabled={!canWrite} onClick={() => openChooser(placement.purpose)}>
                  <Replace className="h-4 w-4" /> {t(slot.assetId ? "Replace image" : "Choose image")}
                </WorkspaceButton>
              </div>
            </article>
          );
        })}
      </div>

      {choosing ? (
        <div className="mt-5 border-t border-[var(--ad-border)] pt-5" aria-live="polite">
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-semibold">{t("Choose {placement} image", { placement: t(placements.find((item) => item.purpose === choosing)?.label ?? choosing) })}</h4>
            <button className="min-h-10 text-sm font-semibold text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]" onClick={() => setChoosing(null)} type="button">{t("Cancel")}</button>
          </div>
          {error ? <p className="mt-3 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{t(error)}</p> : null}
          {loading ? (
            <div className="grid min-h-36 place-items-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : assets.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-[var(--ad-border)] p-6 text-center text-sm text-[var(--ad-text-muted)]">{t("No images are available. Create or import images in Images first.")}</p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
              {assets.map((asset) => {
                const current = data.project.draftAssetPack[choosing] === asset.id;
                const usedElsewhere = !current && usedAssetIds.has(asset.id);
                return (
                  <button
                    aria-label={t("Use image for {placement}", { placement: t(choosing) })}
                    className="overflow-hidden rounded-lg border border-[var(--ad-border)] text-left disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!canWrite || busyAssetId !== null || current || usedElsewhere}
                    key={asset.id}
                    onClick={() => void selectAsset(choosing, asset.id)}
                    type="button"
                  >
                    <AssetImage asset={{ url: asset.url, thumbnailUrl: asset.thumbnailUrl }} />
                    <span className="flex min-h-10 items-center gap-1.5 px-2 text-xs font-semibold">
                      {busyAssetId === asset.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : current ? <Check className="h-3.5 w-3.5" /> : null}
                      {t(current ? "Current" : usedElsewhere ? "Used in another placement" : "Use image")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
