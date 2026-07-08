"use client";

// SPEC: 角色预生图面板（P3 Task 4）—— 挂载于 OfficialCharactersView 编辑区，VisualPassportPanel 之后。
//       Pack 触发行（cover×4 / hero×4 / chat×8）→ POST pregen；批次列表含 item 审批（approve/reject）；
//       approved 且带 mediaAssetId 的 item 一键投放（create draft placement → patch 发布），
//       character_avatar/hero 发布会由服务端 syncPlacementTarget 直写角色头像/主图。
// INTENT: 全部走既有 Batch→Job→Asset→Placement 接口，不新增生成链路；reason/confirmation 由面板
//         固定文案自动填充（非 VisualPassportPanel 式手输确认）——运营人员按包/按项点按钮即可。
// INVARIANTS: 只有 approved 素材可投放（服务端 assertApprovedAsset）；chat 包无对应 avatar/hero slot，
//             不提供投放按钮。
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCcw, UploadCloud, XCircle } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";

type PregenJob = {
  id: string;
  status: string;
  errorCode: string | null;
  profileId: string;
  profileVersion: number;
  promptTemplateId: string | null;
  promptTemplateVersion: number | null;
  createdAt: string;
  completedAt: string | null;
} | null;

type PregenAsset = {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  safetyStatus: string;
  sourceJobId: string | null;
  promptSummary: string | null;
} | null;

type PregenItem = {
  id: string;
  batchId: string;
  itemIndex: number;
  jobId: string | null;
  mediaAssetId: string | null;
  status: string;
  reviewNote: string | null;
  rating: number | null;
  tags: string[];
  reviewedById: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  job: PregenJob;
  asset: PregenAsset;
};

type PregenBatch = {
  id: string;
  title: string | null;
  purpose: string;
  status: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  approvedItems: number;
  estimatedCostDreamcoins: number | null;
  createdAt: string;
  items: PregenItem[];
};

type PregenPlacement = {
  id: string;
  slot: string;
  status: string;
  mediaAssetId: string;
  publishedAt: string | null;
};

type PackKey = "cover" | "hero" | "chat";
type PlacementSlot = "character_avatar" | "character_hero";

const PACKS: { pack: PackKey; label: string }[] = [
  { pack: "cover", label: "Generate cover pack (×4)" },
  { pack: "hero", label: "Generate hero pack (×4)" },
  { pack: "chat", label: "Generate chat pack (×8)" },
];

const PLACEMENT_SLOT_BY_PURPOSE: Partial<Record<string, PlacementSlot>> = {
  character_cover: "character_avatar",
  character_hero: "character_hero",
};

function itemStatusBadgeClass(status: string): string {
  if (status === "approved" || status === "published") return "bg-emerald-500/15 text-emerald-300";
  if (status === "rejected" || status === "failed") return "bg-red-500/15 text-red-300";
  if (status === "generated") return "bg-sky-500/15 text-sky-300";
  return "bg-white/10 text-[rgb(180,180,180)]";
}

export function CharacterPregenPanel({ characterId }: { characterId: string }) {
  const { t, value: valueLabel } = useAdminI18n();
  const [batches, setBatches] = useState<PregenBatch[]>([]);
  const [placements, setPlacements] = useState<PregenPlacement[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [packSubmitting, setPackSubmitting] = useState<PackKey | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [itemBusyId, setItemBusyId] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const data = await apiGet<{ items: PregenBatch[]; placements: PregenPlacement[] }>(
        `/api/v1/admin/content/characters/${characterId}/pregen`,
      );
      setBatches(data.items);
      setPlacements(data.placements);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [characterId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function triggerPack(pack: PackKey) {
    setPackSubmitting(pack);
    setPackError(null);
    try {
      await apiWrite(`/api/v1/admin/content/characters/${characterId}/pregen`, "POST", {
        pack,
        reason: "pregen from character panel",
      });
      await load();
    } catch (error) {
      setPackError(error instanceof Error ? error.message : "Pregen request failed");
    } finally {
      setPackSubmitting(null);
    }
  }

  async function reviewItem(itemId: string, decision: "approve" | "reject") {
    setItemBusyId(itemId);
    setItemError(null);
    try {
      await apiWrite(`/api/v1/admin/content/production/items/${itemId}/${decision}`, "POST", {
        reason: "pregen review",
        confirmation: itemId,
      });
      await load();
    } catch (error) {
      setItemError(error instanceof Error ? error.message : "Review failed");
    } finally {
      setItemBusyId(null);
    }
  }

  async function placeItem(item: PregenItem, slot: PlacementSlot) {
    if (!item.mediaAssetId) return;
    setItemBusyId(item.id);
    setItemError(null);
    try {
      const created = await apiWrite<{ placement: { id: string } }>(
        "/api/v1/admin/content/placements",
        "POST",
        {
          mediaAssetId: item.mediaAssetId,
          slot,
          targetType: "character",
          targetId: characterId,
          status: "draft",
          reason: "pregen publish",
        },
      );
      await apiWrite(`/api/v1/admin/content/placements/${created.placement.id}`, "PATCH", {
        status: "published",
        reason: "pregen publish",
        confirmation: created.placement.id,
      });
      await load();
    } catch (error) {
      setItemError(error instanceof Error ? error.message : "Placement failed");
    } finally {
      setItemBusyId(null);
    }
  }

  const currentAvatar = placements.find(
    (placement) => placement.slot === "character_avatar" && placement.status === "published",
  );
  const currentHero = placements.find(
    (placement) => placement.slot === "character_hero" && placement.status === "published",
  );

  return (
    <section className="mt-4 border border-white/10 bg-[rgb(18,18,18)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("Pregen")}</h2>
          <p className="mt-1 text-xs text-[rgb(170,170,170)]">
            {t("Batch-generate cover/hero/chat image packs, review items, and publish placements.")}
          </p>
        </div>
        <button
          className="inline-flex h-9 shrink-0 items-center gap-2 border border-white/10 px-3 text-xs font-medium text-[rgb(220,220,220)] hover:border-white/30 disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          {t("Refresh")}
        </button>
      </div>

      {listError ? <p className="mt-3 text-xs text-red-300">{listError}</p> : null}

      <div className="mt-4 grid gap-2 text-xs text-[rgb(170,170,170)] md:grid-cols-2">
        <div className="border border-white/10 bg-black/20 px-3 py-2">
          {t("Current avatar placement")}:{" "}
          {currentAvatar ? currentAvatar.mediaAssetId : t("Not placed")}
        </div>
        <div className="border border-white/10 bg-black/20 px-3 py-2">
          {t("Current hero placement")}: {currentHero ? currentHero.mediaAssetId : t("Not placed")}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {PACKS.map(({ pack, label }) => (
          <button
            className="inline-flex h-10 items-center gap-2 border border-white/10 px-3 text-sm font-medium text-[rgb(220,220,220)] hover:border-white/30 disabled:opacity-50"
            disabled={packSubmitting !== null}
            key={pack}
            onClick={() => void triggerPack(pack)}
            type="button"
          >
            {packSubmitting === pack ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            {t(label)}
          </button>
        ))}
        {packError ? <p className="text-xs text-red-300">{packError}</p> : null}
      </div>

      {itemError ? <p className="mt-3 text-xs text-red-300">{itemError}</p> : null}

      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[rgb(170,170,170)]">
          {t("Batches")}
        </h3>
        {loading ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-[rgb(170,170,170)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
          </div>
        ) : batches.length === 0 ? (
          <p className="mt-2 text-xs text-[rgb(170,170,170)]">
            {t("No pregen batches yet — trigger a pack above to start.")}
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-3">
            {batches.map((batch) => (
              <BatchCard
                batch={batch}
                itemBusyId={itemBusyId}
                key={batch.id}
                onPlace={placeItem}
                onReview={reviewItem}
                placements={placements}
                t={t}
                valueLabel={valueLabel}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function BatchCard({
  batch,
  placements,
  itemBusyId,
  onReview,
  onPlace,
  t,
  valueLabel,
}: {
  batch: PregenBatch;
  placements: PregenPlacement[];
  itemBusyId: string | null;
  onReview: (itemId: string, decision: "approve" | "reject") => Promise<void>;
  onPlace: (item: PregenItem, slot: PlacementSlot) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  valueLabel: (key: string) => string;
}) {
  const placementSlot = PLACEMENT_SLOT_BY_PURPOSE[batch.purpose];

  return (
    <div className="border border-white/10 bg-black/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{batch.title ?? batch.id}</p>
          <p className="mt-0.5 text-xs text-[rgb(170,170,170)]">
            {valueLabel(batch.purpose)} · {valueLabel(batch.status)} ·{" "}
            {t("{completed}/{total} completed", {
              completed: batch.completedItems,
              total: batch.totalItems,
            })}
            {batch.estimatedCostDreamcoins != null
              ? ` · ${t("{cost} DC", { cost: batch.estimatedCostDreamcoins })}`
              : ""}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {batch.items.map((item) => {
          const placedElsewhere = placementSlot
            ? placements.find(
                (placement) =>
                  placement.slot === placementSlot &&
                  placement.mediaAssetId === item.mediaAssetId &&
                  placement.status === "published",
              )
            : undefined;
          const busy = itemBusyId === item.id;
          return (
            <div
              className="flex flex-wrap items-center justify-between gap-2 border border-white/5 bg-black/20 px-3 py-2"
              key={item.id}
            >
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={cn("inline-flex items-center px-2 py-0.5", itemStatusBadgeClass(item.status))}
                >
                  {valueLabel(item.status)}
                </span>
                <span className="text-[rgb(170,170,170)]">#{item.itemIndex}</span>
                {item.asset?.thumbnailUrl ? (
                  <span className="max-w-[220px] truncate text-[rgb(170,170,170)]">
                    {item.asset.promptSummary ?? item.asset.id}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {item.status === "generated" ? (
                  <>
                    <button
                      className="inline-flex h-8 items-center gap-1.5 border border-white/10 px-2 text-xs font-medium text-emerald-300 hover:border-emerald-300/50 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void onReview(item.id, "approve")}
                      type="button"
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      {t("Approve")}
                    </button>
                    <button
                      className="inline-flex h-8 items-center gap-1.5 border border-white/10 px-2 text-xs font-medium text-red-300 hover:border-red-300/50 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void onReview(item.id, "reject")}
                      type="button"
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" />
                      )}
                      {t("Reject")}
                    </button>
                  </>
                ) : null}
                {item.status === "approved" && item.mediaAssetId && placementSlot ? (
                  placedElsewhere ? (
                    <span className="text-xs text-emerald-300">{t("Placed")}</span>
                  ) : (
                    <button
                      className="inline-flex h-8 items-center gap-1.5 border border-white/10 px-2 text-xs font-medium text-[rgb(220,220,220)] hover:border-white/30 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void onPlace(item, placementSlot)}
                      type="button"
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <UploadCloud className="h-3.5 w-3.5" />
                      )}
                      {t("Publish placement")}
                    </button>
                  )
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
