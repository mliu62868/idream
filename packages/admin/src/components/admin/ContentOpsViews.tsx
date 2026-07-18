"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Loader2,
  Play,
  RefreshCcw,
  RotateCcw,
  X,
} from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { cn } from "@/lib/utils";

type Profile = {
  id: string;
  profileKey: string;
  label: string;
  status: string;
  version: number;
  allowedOrientations?: unknown;
};

type Recipe = {
  id: string;
  recipeKey: string;
  label: string;
  status: string;
  version: number;
  useCase: string;
};

type Preset = {
  id: string;
  label: string;
  type: string;
};

type CharacterOption = {
  id: string;
  name: string;
};

type ProductionItem = {
  id: string;
  itemIndex: number;
  status: string;
  jobId: string | null;
  mediaAssetId: string | null;
  tags: string[];
  job: {
    status: string;
    errorCode: string | null;
    profileId: string | null;
    profileVersion: number | null;
  } | null;
  asset: AssetSummary | null;
};

type ProductionBatch = {
  id: string;
  title: string;
  purpose: string;
  targetType: string;
  targetId: string | null;
  profileId: string | null;
  profileVersion: number | null;
  recipeId: string | null;
  recipeVersion: number | null;
  orientation: string | null;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  approvedItems: number;
  estimatedCostDreamcoins: number;
  status: string;
  createdAt: string;
  items: ProductionItem[];
};

type AssetSummary = {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string;
  width: number | null;
  height: number | null;
  safetyStatus: string;
  sourceJobId: string | null;
  createdAt: string;
};

function runAfterEffect(callback: () => void): () => void {
  const timeout = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timeout);
}

const purposeOptions = [
  "character_cover",
  "character_hero",
  "character_chat",
  "feed",
  "homepage",
  "seo",
  "template_cover",
  "campaign",
  "model_eval",
] as const;

function defaultProductionForm() {
  return {
    title: "",
    purpose: "character_chat",
    targetType: "character",
    targetId: "",
    profileId: "",
    recipeId: "",
    presetIds: [] as string[],
    orientation: "4:5",
    count: "4",
    brief: "",
  };
}

export function ProductionStudioView() {
  const { t, value } = useAdminI18n();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [characters, setCharacters] = useState<CharacterOption[]>([]);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultProductionForm);

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedBatchId) ?? batches[0] ?? null,
    [batches, selectedBatchId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [profileData, recipeData, presetData, characterData, batchData] = await Promise.all([
        apiGet<{ items: Profile[] }>("/api/v1/admin/generation/model-profiles?mode=image"),
        apiGet<{ items: Recipe[] }>("/api/v1/admin/generation/recipes?mode=image"),
        apiGet<{ items: Preset[] }>("/api/v1/admin/generation/presets"),
        apiGet<{ items: CharacterOption[] }>("/api/v1/admin/content/characters?limit=100"),
        apiGet<{ items: ProductionBatch[] }>("/api/v1/admin/content/production/batches?limit=24"),
      ]);
      const activeProfiles = profileData.items.filter((profile) => profile.status === "active");
      const activeRecipes = recipeData.items.filter((recipe) => recipe.status === "active");
      setProfiles(activeProfiles);
      setRecipes(activeRecipes);
      setPresets(presetData.items);
      setCharacters(characterData.items);
      setBatches(batchData.items);
      setForm((current) => ({
        ...current,
        profileId: current.profileId || activeProfiles[0]?.profileKey || activeProfiles[0]?.id || "",
        recipeId: current.recipeId || activeRecipes[0]?.recipeKey || activeRecipes[0]?.id || "",
        targetId: current.targetId || characterData.items[0]?.id || "",
      }));
      if (!selectedBatchId && batchData.items[0]) setSelectedBatchId(batchData.items[0].id);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load production studio");
    } finally {
      setLoading(false);
    }
  }, [selectedBatchId]);

  useEffect(() => {
    return runAfterEffect(() => {
      void load();
    });
  }, [load]);

  async function createBatch() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiWrite<{ batch: ProductionBatch }>(
        "/api/v1/admin/content/production/batches",
        "POST",
        {
          title: form.title || undefined,
          purpose: form.purpose,
          targetType: form.targetType,
          targetId: form.targetType === "none" ? undefined : form.targetId,
          profileId: form.profileId,
          recipeId: form.recipeId || undefined,
          presetIds: form.presetIds,
          orientation: form.orientation || undefined,
          count: Number.parseInt(form.count, 10),
          brief: form.brief || undefined,
          reason: "Created from Production Studio",
        },
      );
      setSelectedBatchId(result.batch.id);
      setForm((current) => ({ ...current, title: "", brief: "" }));
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Production batch create failed");
    } finally {
      setBusy(false);
    }
  }

  async function reviewItem(itemId: string, action: "approve" | "reject" | "regenerate") {
    setBusy(true);
    setError(null);
    try {
      if (action === "regenerate") {
        await apiWrite(`/api/v1/admin/content/production/items/${itemId}/regenerate`, "POST", {
          reason: "Regenerated from Production Studio",
          confirmation: itemId,
        });
      } else {
        await apiWrite(`/api/v1/admin/content/production/items/${itemId}/${action}`, "POST", {
          tags: [],
          reason: `${action === "approve" ? "Approved" : "Rejected"} from Production Studio`,
          confirmation: itemId,
        });
      }
      await load();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Production review failed");
    } finally {
      setBusy(false);
    }
  }

  const selectedProfile = profiles.find(
    (profile) => profile.profileKey === form.profileId || profile.id === form.profileId,
  );
  const orientations = jsonStringArray(selectedProfile?.allowedOrientations);

  if (loading) return <AdminLoading label="Production Studio" />;

  return (
    <div className="space-y-5">
      <ViewHeader
        action={<RefreshButton busy={loading} onClick={load} />}
        eyebrow="Media"
        icon={<Play className="h-5 w-5" />}
        title={t("Production Studio")}
      />
      <InlineError message={error} />

      <section className="grid gap-4 xl:grid-cols-[minmax(360px,430px)_minmax(0,1fr)]">
        <div className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
          <h2 className="text-sm font-semibold">{t("Create production batch")}</h2>
          <div className="mt-4 grid gap-3">
            <Field label="Purpose">
              <select
                className="admin-input"
                onChange={(event) => setForm({ ...form, purpose: event.target.value })}
                value={form.purpose}
              >
                {purposeOptions.map((purpose) => (
                  <option key={purpose} value={purpose}>
                    {value(purpose)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Target type">
                <select
                  className="admin-input"
                  onChange={(event) => setForm({ ...form, targetType: event.target.value })}
                  value={form.targetType}
                >
                  {["character", "none"].map((targetType) => (
                    <option key={targetType} value={targetType}>
                      {value(targetType)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Target">
                {form.targetType === "character" ? (
                  <select
                    className="admin-input"
                    onChange={(event) => setForm({ ...form, targetId: event.target.value })}
                    value={form.targetId}
                  >
                    {characters.map((character) => (
                      <option key={character.id} value={character.id}>
                        {character.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="admin-input"
                    onChange={(event) => setForm({ ...form, targetId: event.target.value })}
                    value={form.targetId}
                  />
                )}
              </Field>
            </div>
            <Field label="Title">
              <input
                className="admin-input"
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                value={form.title}
              />
            </Field>
            <Field label="Profile">
              <select
                className="admin-input"
                onChange={(event) => setForm({ ...form, profileId: event.target.value })}
                value={form.profileId}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.profileKey || profile.id}>
                    {profile.label} · v{profile.version}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Recipe">
              <select
                className="admin-input"
                onChange={(event) => setForm({ ...form, recipeId: event.target.value })}
                value={form.recipeId}
              >
                {recipes.map((recipe) => (
                  <option key={recipe.id} value={recipe.recipeKey || recipe.id}>
                    {recipe.label} · {value(recipe.useCase)} · v{recipe.version}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Orientation">
                <select
                  className="admin-input"
                  onChange={(event) => setForm({ ...form, orientation: event.target.value })}
                  value={form.orientation}
                >
                  {(orientations.length ? orientations : ["1:1", "4:5", "16:9"]).map((orientation) => (
                    <option key={orientation} value={orientation}>
                      {orientation}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Count">
                <input
                  className="admin-input"
                  min={1}
                  max={24}
                  onChange={(event) => setForm({ ...form, count: event.target.value })}
                  type="number"
                  value={form.count}
                />
              </Field>
            </div>
            <PresetPicker
              presets={presets}
              selectedIds={form.presetIds}
              onChange={(presetIds) => setForm({ ...form, presetIds })}
            />
            <Field label="Brief">
              <textarea
                className="admin-input min-h-24 resize-y py-2"
                onChange={(event) => setForm({ ...form, brief: event.target.value })}
                value={form.brief}
              />
            </Field>
            <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] sm:grid-cols-3">
              <MiniMetric label="Jobs" value={form.count || "0"} />
              <MiniMetric label="Dreamcoins" value="0" />
              <MiniMetric label="Mode" value="image" />
            </div>
            <button
              className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white hover:bg-[#333333] disabled:opacity-50"
              disabled={busy || !form.profileId || !form.recipeId}
              onClick={() => void createBatch()}
              type="button"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t("Generate batch")}
            </button>
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
            <MiniMetric label="Batches" value={batches.length} />
            <MiniMetric label="Generated" value={selectedBatch?.completedItems ?? 0} />
            <MiniMetric label="Approved" value={selectedBatch?.approvedItems ?? 0} />
            <MiniMetric label="Failed" value={selectedBatch?.failedItems ?? 0} />
          </div>
          <BatchSelector
            batches={batches}
            selectedId={selectedBatch?.id ?? null}
            onSelect={setSelectedBatchId}
          />
          {selectedBatch ? (
            <ReviewGrid batch={selectedBatch} busy={busy} onReview={reviewItem} />
          ) : (
            <EmptyState label="No production batches yet." />
          )}
        </div>
      </section>
    </div>
  );
}

function ReviewGrid({
  batch,
  busy,
  onReview,
}: {
  batch: ProductionBatch;
  busy: boolean;
  onReview: (itemId: string, action: "approve" | "reject" | "regenerate") => Promise<void>;
}) {
  const { t, value } = useAdminI18n();
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--ad-border)] p-4">
        <div>
          <h2 className="text-sm font-semibold">{batch.title}</h2>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
            {value(batch.purpose)} · {batch.completedItems}/{batch.totalItems}
          </p>
        </div>
        <StatusBadge value={batch.status} />
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {batch.items.map((item, index) => (
          <article className="rounded-lg overflow-hidden border border-[var(--ad-border)] bg-black/[0.03]" key={item.id}>
            {item.asset ? (
              <AssetImage asset={item.asset} eager={index < 4} />
            ) : (
              <div className="grid aspect-[4/5] place-items-center bg-black/[0.03] text-center text-xs text-[var(--ad-text-muted)]">
                <div>
                  <Loader2 className="mx-auto mb-2 h-5 w-5" />
                  {item.job?.status ?? item.status}
                </div>
              </div>
            )}
            <div className="space-y-3 p-3">
              <div className="flex items-center justify-between gap-2">
                <StatusBadge value={item.status} />
                <span className="font-mono text-[11px] text-[var(--ad-text-muted)]">#{item.itemIndex + 1}</span>
              </div>
              <p className="truncate text-[11px] text-[var(--ad-text-muted)]">
                {t("Job")} {item.jobId ?? "-"} {item.job?.errorCode ? `· ${item.job.errorCode}` : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <SmallButton disabled={busy || !item.asset} icon={<Check className="h-3.5 w-3.5" />} onClick={() => onReview(item.id, "approve")}>

                  {t("Approve")}
                </SmallButton>
                <SmallButton disabled={busy} icon={<X className="h-3.5 w-3.5" />} onClick={() => onReview(item.id, "reject")}>

                  {t("Reject")}
                </SmallButton>
                <SmallButton disabled={busy} icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => onReview(item.id, "regenerate")}>

                  {t("Regenerate")}
                </SmallButton>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function BatchSelector({
  batches,
  selectedId,
  onSelect,
}: {
  batches: ProductionBatch[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { value } = useAdminI18n();
  if (batches.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto">
      {batches.map((batch) => (
        <button
          className={cn(
            "rounded-lg min-w-52 border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-left hover:bg-black/[0.04]",
            selectedId === batch.id && "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-white hover:bg-[var(--ad-ink)]",
          )}
          key={batch.id}
          onClick={() => onSelect(batch.id)}
          type="button"
        >
          <span className="block truncate text-sm font-semibold">{batch.title}</span>
          <span className={cn("mt-1 block text-xs", selectedId === batch.id ? "text-white/60" : "text-[var(--ad-text-muted)]")}>
            {value(batch.status)} · {batch.completedItems}/{batch.totalItems}
          </span>
        </button>
      ))}
    </div>
  );
}

function PresetPicker({
  presets,
  selectedIds,
  onChange,
}: {
  presets: Preset[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t, value } = useAdminI18n();
  const grouped = ["background", "pose", "outfit", "mode"].map((type) => ({
    type,
    items: presets.filter((preset) => preset.type === type),
  }));
  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-[var(--ad-text-muted)]">{t("Presets")}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        {grouped.map((group) => (
          <select
            className="admin-input"
            key={group.type}
            onChange={(event) => {
              const withoutType = selectedIds.filter((id) => !group.items.some((preset) => preset.id === id));
              onChange(event.target.value ? [...withoutType, event.target.value] : withoutType);
            }}
            value={selectedIds.find((id) => group.items.some((preset) => preset.id === id)) ?? ""}
          >
            <option value="">{value(group.type)}</option>
            {group.items.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        ))}
      </div>
    </div>
  );
}

function ViewHeader({
  action,
  eyebrow,
  icon,
  title,
}: {
  action?: React.ReactNode;
  eyebrow: string;
  icon: React.ReactNode;
  title: string;
}) {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-lg flex flex-wrap items-start justify-between gap-4 border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg grid h-10 w-10 place-items-center border border-[var(--ad-border)] bg-black/[0.03] text-[var(--ad-ink)]">
          {icon}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-[var(--ad-text-muted)]">{t(eyebrow)}</p>
          <h2 className="mt-1 text-lg font-semibold">{t(title)}</h2>
        </div>
      </div>
      {action}
    </section>
  );
}

function RefreshButton({ busy, onClick }: { busy: boolean; onClick: () => void | Promise<void> }) {
  const { t } = useAdminI18n();
  return (
    <button
      className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04]"
      onClick={() => void onClick()}
      type="button"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
      {t("Refresh")}
    </button>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  const { t } = useAdminI18n();
  return (
    <label className="grid min-w-0 gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
      {t(label)}
      {children}
    </label>
  );
}

function MiniMetric({ label, value }: { label: string; value: string | number }) {
  const { t } = useAdminI18n();
  return (
    <div className="bg-[var(--ad-surface)] p-3">
      <p className="text-[11px] font-semibold uppercase text-[var(--ad-text-muted)]">{t(label)}</p>
      <p className="mt-1 font-mono text-xl font-semibold text-[var(--ad-ink)]">{value}</p>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const { value: label } = useAdminI18n();
  const good = ["approved", "published", "completed", "generated"].includes(value);
  const bad = ["failed", "rejected", "archived"].includes(value);
  return (
    <span
      className={cn(
        "inline-flex rounded px-2 py-0.5 text-xs font-medium",
        good && "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]",
        bad && "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
        !good && !bad && "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
      )}
    >
      {label(value)}
    </span>
  );
}

function SmallButton({
  ariaLabel,
  children,
  disabled,
  icon,
  onClick,
}: {
  ariaLabel?: string;
  children: React.ReactNode;
  disabled?: boolean;
  icon: React.ReactNode;
  onClick: () => void | Promise<void>;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className="rounded-md inline-flex h-8 items-center gap-1.5 border border-[var(--ad-border)] px-2.5 text-xs text-[var(--ad-text)] hover:bg-black/[0.04] disabled:opacity-50"
      disabled={disabled}
      onClick={() => void onClick()}
      type="button"
    >
      {icon}
      {children}
    </button>
  );
}

function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]">
      {message}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  const { t } = useAdminI18n();
  return (
    <div className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6 text-sm text-[var(--ad-text-muted)]">
      {t(label)}
    </div>
  );
}

function AdminLoading({ label }: { label: string }) {
  const { t } = useAdminI18n();
  return (
    <div className="rounded-lg flex h-48 items-center justify-center border border-[var(--ad-border)] bg-[var(--ad-surface)] text-[var(--ad-text-muted)]">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
      {t(label)}
    </div>
  );
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
