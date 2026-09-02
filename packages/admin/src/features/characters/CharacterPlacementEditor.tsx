"use client";

import { useCallback, useRef, useState } from "react";
import { Check, ImageIcon, Loader2, Replace } from "lucide-react";
import Image from "next/image";
import type {
  CharacterImageSourceAsset,
  CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { AssetImage } from "@/components/admin/ui/AssetImage";
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
  const [assets, setAssets] = useState<CharacterImageSourceAsset[]>([]);
  const [choosing, setChoosing] = useState<PlacementPurpose | null>(null);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const pendingSelection = useRef<{ signature: string; key: string } | null>(null);

  const loadAssets = useCallback(async () => {
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
  }, [data.character.id, t]);

  function openChooser(purpose: PlacementPurpose) {
    setChoosing(purpose);
    setError(null);
    void loadAssets();
  }

  async function selectAsset(
    purpose: PlacementPurpose,
    asset: CharacterImageSourceAsset,
  ) {
    setBusyAssetId(asset.id);
    setError(null);
    const body = {
      entityVersion: data.project.version,
      purpose,
      assetId: asset.id,
      ...(asset.qualification?.authority.runId
        ? { runId: asset.qualification.authority.runId } : {}),
      ...(asset.qualification?.authority.itemId
        ? { itemId: asset.qualification.authority.itemId } : {}),
      ...(asset.qualification?.authority.reviewDecisionId
        ? { reviewDecisionId: asset.qualification.authority.reviewDecisionId } : {}),
      reason: `Selected from ${data.character.name}'s image library`,
    };
    const signature = JSON.stringify([data.character.id, body]);
    // A lost response must replay the committed selection before checking its old version.
    if (pendingSelection.current?.signature !== signature) {
      pendingSelection.current = { signature, key: crypto.randomUUID() };
    }
    const idempotencyKey = pendingSelection.current.key;
    try {
      await runCommittedMutation({
        action: `${purpose} image selection`,
        commit: () => adminV2Operation(
          "PATCH /api/v2/admin/characters/:id/draft-image",
          {
            path: { id: data.character.id },
            ifMatch: data.project.version,
            idempotencyKey,
            body,
          },
        ),
        afterRefresh: () => {
          pendingSelection.current = null;
          setChoosing(null);
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Image placement could not be saved"));
    } finally {
      setBusyAssetId(null);
    }
  }

  const selectableAssets = choosing
    ? assets.filter((asset) =>
        asset.qualification?.selectablePurposes.includes(choosing)
      )
    : [];

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
          {loadError ? (
            <div className="mt-3 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">
              <p className="font-semibold">{t("Character images could not be loaded")}</p>
              {assets.length > 0 ? <p className="mt-1">{t("Showing previously loaded items.")}</p> : null}
              <details className="mt-2">
                <summary className="cursor-pointer">{t("Error details")}</summary>
                <p className="mt-1 break-words">{t(loadError)}</p>
              </details>
              <WorkspaceButton className="mt-3" disabled={loading} onClick={() => void loadAssets()}>{t("Retry")}</WorkspaceButton>
            </div>
          ) : null}
          {/* SPEC: A failed read cannot establish that no qualified choices exist. */}
          {loading && assets.length === 0 ? (
            <div className="grid min-h-36 place-items-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : loadError && selectableAssets.length === 0 ? null : selectableAssets.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-[var(--ad-border)] p-6 text-center text-sm text-[var(--ad-text-muted)]">{t("No reviewed images are selectable for this placement. Review an imported candidate or approve a matching generated image in Images first.")}</p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
              {selectableAssets.map((asset) => {
                const selectedPurposes = asset.qualification?.selectedPurposes ?? [];
                const current = selectedPurposes.includes(choosing);
                const currentAuthorityStale = current &&
                  !asset.qualification?.releaseQualifiedPurposes.includes(choosing);
                const usedElsewhere = selectedPurposes.some(
                  (purpose) => purpose !== choosing,
                );
                return (
                  <button
                    aria-label={t("Use image for {placement}", { placement: t(choosing) })}
                    className="overflow-hidden rounded-lg border border-[var(--ad-border)] text-left disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={
                      !canWrite ||
                      busyAssetId !== null ||
                      (current && !currentAuthorityStale) ||
                      usedElsewhere
                    }
                    key={asset.id}
                    onClick={() => void selectAsset(choosing, asset)}
                    type="button"
                  >
                    <AssetImage asset={{
                      url: asset.url,
                      thumbnailUrl: asset.thumbnailUrl ?? asset.url,
                    }} />
                    <span className="flex min-h-10 items-center gap-1.5 px-2 text-xs font-semibold">
                      {busyAssetId === asset.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : current ? <Check className="h-3.5 w-3.5" /> : null}
                      {t(
                        currentAuthorityStale
                          ? "Update Review authority"
                          : current
                            ? "Current"
                            : usedElsewhere
                              ? "Used in another placement"
                              : "Use image",
                      )}
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
