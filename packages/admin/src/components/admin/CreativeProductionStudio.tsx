"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  ImageIcon,
  Lightbulb,
  Loader2,
  Play,
  RefreshCcw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { adminV2Request } from "@/lib/admin-v2-api";
import { cn } from "@/lib/utils";

type ConsistencyMode = "strict" | "balanced" | "creative";
type StudioStage = "brief" | "directions" | "review";
type ReviewFilter = "all" | "unreviewed" | "selected" | "failed";

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

type Preset = { id: string; label: string; type: string };
type AssetSource = { id?: string; url: string; thumbnailUrl: string | null };
type CharacterOption = {
  id: string;
  name: string;
  style: string;
  imageAsset: AssetSource | null;
  visualProfiles: Array<{ id: string; version: number; status: string; style: string }>;
};

type ProductionAsset = AssetSource & {
  width: number | null;
  height: number | null;
  createdAt: string;
};

type ProductionItem = {
  id: string;
  itemIndex: number;
  status: string;
  jobId: string | null;
  mediaAssetId: string | null;
  reviewNote: string | null;
  rating: number | null;
  tags: string[];
  job: {
    status: string;
    errorCode: string | null;
    consistencyMode: string | null;
  } | null;
  asset: ProductionAsset | null;
};

type ProductionBatch = {
  id: string;
  title: string;
  purpose: string;
  targetType: string;
  targetId: string | null;
  brief: string | null;
  orientation: string | null;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  approvedItems: number;
  estimatedCostDreamcoins: number;
  consistencyMode: string | null;
  status: string;
  createdAt: string;
  items: ProductionItem[];
};

type CreativeDirection = {
  id: string;
  title: string;
  scenePrompt: string;
  mood: string;
  setting: string;
  outfit: string;
  camera: string;
  lighting: string;
  selected: boolean;
};

type DirectionResponse = {
  directions: Array<Omit<CreativeDirection, "id" | "selected">>;
  source: "model" | "fallback";
};

type StudioForm = {
  characterId: string;
  purpose: string;
  creativeBrief: string;
  scenePrompt: string;
  mood: string;
  setting: string;
  outfit: string;
  camera: string;
  lighting: string;
  consistencyMode: ConsistencyMode;
  profileId: string;
  recipeId: string;
  presetIds: string[];
  orientation: string;
  count: string;
};

type ReviewDraft = { tags: string; description: string };
type StoredStudioDraft = { form: StudioForm; directions: CreativeDirection[]; stage: StudioStage };

const studioDraftStorageKey = "idream.admin.image-production.draft.v1";

const inputClass =
  "h-10 w-full min-w-0 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none transition-colors focus:border-[var(--ad-ink)]";
const textareaClass =
  "w-full min-w-0 resize-y rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm leading-5 text-[var(--ad-text)] outline-none transition-colors placeholder:text-[var(--ad-text-muted)] focus:border-[var(--ad-ink)]";

const purposeOptions = [
  "character_cover",
  "character_hero",
  "character_chat",
  "feed",
  "homepage",
  "seo",
  "template_cover",
  "campaign",
] as const;

const purposeLabels: Record<string, string> = {
  character_cover: "Character cover",
  character_hero: "Character hero",
  character_chat: "Character chat",
  feed: "Feed",
  homepage: "Homepage",
  seo: "SEO",
  template_cover: "Template cover",
  campaign: "Campaign",
};

const fieldSuggestions = {
  mood: ["Intimate", "Playful", "Melancholic", "Confident", "Warm", "Mysterious"],
  setting: ["Urban night", "Bedroom", "Cafe", "Beach", "Studio", "Rooftop"],
  outfit: ["Casual", "Evening look", "Trench coat", "Loungewear", "Streetwear"],
  camera: ["50mm portrait", "85mm close-up", "35mm environmental", "Candid selfie"],
  lighting: ["Soft window light", "Neon + streetlight", "Golden hour", "Studio softbox"],
} as const;

function defaultForm(): StudioForm {
  return {
    characterId: "",
    purpose: "character_chat",
    creativeBrief: "",
    scenePrompt: "",
    mood: "",
    setting: "",
    outfit: "",
    camera: "",
    lighting: "",
    consistencyMode: "balanced",
    profileId: "",
    recipeId: "",
    presetIds: [],
    orientation: "4:5",
    count: "4",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStoredStudioDraft(): StoredStudioDraft | null {
  try {
    const raw = window.sessionStorage.getItem(studioDraftStorageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.form) || !Array.isArray(parsed.directions)) return null;
    if (!parsed.directions.every((item) => isRecord(item))) return null;
    const stage = parsed.stage;
    if (stage !== "brief" && stage !== "directions" && stage !== "review") return null;
    return {
      form: parsed.form as StudioForm,
      directions: parsed.directions as CreativeDirection[],
      stage,
    };
  } catch {
    return null;
  }
}

function preferredProfile(items: Profile[]): Profile | undefined {
  return items.find((item) => !/edit/i.test(`${item.label} ${item.profileKey}`)) ?? items[0];
}

function preferredRecipe(items: Recipe[]): Recipe | undefined {
  return items.find((item) => item.useCase === "character") ?? items[0];
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueAssets(character: CharacterOption | null, batches: ProductionBatch[]): AssetSource[] {
  const candidates: AssetSource[] = [];
  if (character?.imageAsset) candidates.push(character.imageAsset);
  for (const batch of batches) {
    if (batch.targetId !== character?.id) continue;
    for (const item of batch.items) if (item.asset) candidates.push(item.asset);
  }
  const seen = new Set<string>();
  return candidates.filter((asset) => {
    const key = asset.id ?? asset.thumbnailUrl ?? asset.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(value),
  );
}

function runAfterEffect(callback: () => void): () => void {
  const timeout = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timeout);
}

export function CreativeProductionStudio() {
  const { t, value: valueLabel } = useAdminI18n();
  const [form, setForm] = useState<StudioForm>(defaultForm);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [characters, setCharacters] = useState<CharacterOption[]>([]);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [directions, setDirections] = useState<CreativeDirection[]>([]);
  const [stage, setStage] = useState<StudioStage>("brief");
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [perItemCost, setPerItemCost] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [directionBusy, setDirectionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [profileData, recipeData, presetData, characterData, batchData] = await Promise.all([
        apiGet<{ items: Profile[] }>("/api/v1/admin/generation/model-profiles?mode=image"),
        apiGet<{ items: Recipe[] }>("/api/v1/admin/generation/recipes?mode=image"),
        apiGet<{ items: Preset[] }>("/api/v1/admin/generation/presets"),
        apiGet<{ items: CharacterOption[] }>("/api/v1/admin/content/characters?limit=100"),
        apiGet<{ items: ProductionBatch[] }>("/api/v1/admin/content/production/batches?limit=50"),
      ]);
      const activeProfiles = profileData.items.filter((item) => item.status === "active");
      const activeRecipes = recipeData.items.filter((item) => item.status === "active");
      const storedDraft = readStoredStudioDraft();
      const requestedCharacterId = new URLSearchParams(window.location.search).get("characterId");
      const linkedCharacterId = characterData.items.some((item) => item.id === requestedCharacterId)
        ? requestedCharacterId ?? undefined
        : undefined;
      const storedCharacterId = characterData.items.some(
        (item) => item.id === storedDraft?.form.characterId,
      )
        ? storedDraft?.form.characterId
        : undefined;
      const storedProfileId = activeProfiles.some(
        (item) => item.id === storedDraft?.form.profileId || item.profileKey === storedDraft?.form.profileId,
      )
        ? storedDraft?.form.profileId
        : undefined;
      const storedRecipeId = activeRecipes.some(
        (item) => item.id === storedDraft?.form.recipeId || item.recipeKey === storedDraft?.form.recipeId,
      )
        ? storedDraft?.form.recipeId
        : undefined;
      setProfiles(activeProfiles);
      setRecipes(activeRecipes);
      setPresets(presetData.items);
      setCharacters(characterData.items);
      setBatches(batchData.items);
      setForm((current) => ({
        ...current,
        ...(storedDraft?.form ?? {}),
        characterId:
          linkedCharacterId || storedCharacterId || current.characterId || characterData.items[0]?.id || "",
        profileId:
          storedProfileId || current.profileId || preferredProfile(activeProfiles)?.profileKey || preferredProfile(activeProfiles)?.id || "",
        recipeId:
          storedRecipeId || current.recipeId || preferredRecipe(activeRecipes)?.recipeKey || preferredRecipe(activeRecipes)?.id || "",
      }));
      if (storedDraft) {
        setDirections(storedDraft.directions);
        setStage(storedDraft.stage === "review" ? "directions" : storedDraft.stage);
      }
      setSelectedBatchId((current) => current ?? batchData.items[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load image production");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshBatches = useCallback(async () => {
    const data = await apiGet<{ items: ProductionBatch[] }>(
      "/api/v1/admin/content/production/batches?limit=50",
    );
    setBatches(data.items);
    return data.items;
  }, []);

  useEffect(() => runAfterEffect(() => void load()), [load]);

  useEffect(() => {
    if (loading) return;
    window.sessionStorage.setItem(
      studioDraftStorageKey,
      JSON.stringify({ form, directions, stage } satisfies StoredStudioDraft),
    );
  }, [directions, form, loading, stage]);

  useEffect(() => {
    if (!form.profileId) return;
    return runAfterEffect(() => {
      void apiWrite<{ perItemCostDreamcoins: number }>(
        "/api/v1/admin/content/production/estimate",
        "POST",
        { profileId: form.profileId, count: Math.max(1, Number.parseInt(form.count, 10) || 1) },
      )
        .then((result) => setPerItemCost(result.perItemCostDreamcoins))
        .catch(() => setPerItemCost(0));
    });
  }, [form.count, form.profileId]);

  useEffect(() => {
    const hasActive = batches.some((batch) => ["queued", "reviewing"].includes(batch.status));
    if (!hasActive) return;
    const interval = window.setInterval(() => void refreshBatches(), 8_000);
    return () => window.clearInterval(interval);
  }, [batches, refreshBatches]);

  const selectedCharacter = characters.find((item) => item.id === form.characterId) ?? null;
  const selectedBatch = batches.find((item) => item.id === selectedBatchId) ?? null;
  const inspirationAssets = useMemo(
    () => uniqueAssets(selectedCharacter, batches),
    [batches, selectedCharacter],
  );
  const selectedDirectionCount = directions.filter((item) => item.selected).length;
  const countPerDirection = Math.max(1, Number.parseInt(form.count, 10) || 1);
  const estimatedCost = perItemCost * countPerDirection * Math.max(1, selectedDirectionCount);
  const orientations = jsonStringArray(
    profiles.find((item) => item.profileKey === form.profileId || item.id === form.profileId)?.allowedOrientations,
  );

  async function generateDirections() {
    if (!form.characterId) return;
    setDirectionBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiWrite<DirectionResponse>(
        "/api/v1/admin/content/production/directions",
        "POST",
        {
          characterId: form.characterId,
          purpose: form.purpose,
          creativeBrief: form.creativeBrief,
          scenePrompt: form.scenePrompt,
          mood: form.mood,
          setting: form.setting,
          outfit: form.outfit,
          camera: form.camera,
          lighting: form.lighting,
          consistencyMode: form.consistencyMode,
        },
      );
      const stamp = Date.now();
      setDirections(
        result.directions.map((direction, index) => ({
          ...direction,
          id: `${stamp}-${index}`,
          selected: true,
        })),
      );
      setStage("directions");
      setNotice(
        result.source === "model"
          ? t("Four creative directions are ready to edit.")
          : t("Four starter directions are ready to edit."),
      );
    } catch (directionError) {
      setError(directionError instanceof Error ? directionError.message : "Direction generation failed");
    } finally {
      setDirectionBusy(false);
    }
  }

  async function launchSelectedDirections() {
    const selected = directions.filter((item) => item.selected);
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminV2Request<{ batch: { id: string }; replayed: boolean }>(
        "/api/v2/admin/creative/runs",
        {
          method: "POST",
          idempotencyKey: crypto.randomUUID(),
          body: {
            title: form.creativeBrief.trim() || `${selected[0]?.title ?? "Creative direction"} production`,
            purpose: form.purpose,
            targetType: "character",
            targetId: form.characterId,
            profileId: form.profileId,
            ...(form.recipeId ? { recipeId: form.recipeId } : {}),
            presetIds: form.presetIds,
            ...(form.orientation ? { orientation: form.orientation } : {}),
            count: 1,
            brief: form.creativeBrief.trim() || selected.map((direction) => direction.title).join(", "),
            directions: selected.map(({ selected: _selected, ...direction }) => direction),
            outputsPerDirection: countPerDirection,
            consistencyMode: form.consistencyMode,
            priority: "normal",
            reason: "Created from persisted Creative Production directions",
          },
        },
      );
      const refreshed = await refreshBatches();
      const firstId = result.batch.id ?? refreshed[0]?.id ?? null;
      setSelectedBatchId(firstId);
      setSelectedItemIds([]);
      setFocusedItemId(null);
      setStage("review");
      setNotice(t("Production started for {count} creative directions.", { count: selected.length }));
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : "Production launch failed");
    } finally {
      setBusy(false);
    }
  }

  async function reviewItem(item: ProductionItem, action: "approve" | "reject" | "regenerate") {
    setBusy(true);
    setError(null);
    try {
      const draft = reviewDrafts[item.id] ?? { tags: item.tags.join(", "), description: "" };
      if (action === "regenerate") {
        await apiWrite(`/api/v1/admin/content/production/items/${item.id}/regenerate`, "POST", {
          brief: selectedBatch?.brief ?? undefined,
          reason: "Regenerated from Creative Production Studio",
          confirmation: item.id,
        });
      } else {
        await apiWrite(`/api/v1/admin/content/production/items/${item.id}/${action}`, "POST", {
          tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          description: draft.description.trim() || undefined,
          reason: `${action === "approve" ? "Approved" : "Rejected"} from Creative Production Studio`,
          confirmation: item.id,
        });
      }
      await refreshBatches();
      setSelectedItemIds((current) => current.filter((id) => id !== item.id));
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Review action failed");
    } finally {
      setBusy(false);
    }
  }

  async function approveSelected() {
    if (!selectedBatch) return;
    const items = selectedBatch.items.filter(
      (item) => selectedItemIds.includes(item.id) && item.status === "generated" && item.asset,
    );
    for (const item of items) await reviewItem(item, "approve");
  }

  function openBatch(batchId: string) {
    setSelectedBatchId(batchId);
    setSelectedItemIds([]);
    setFocusedItemId(null);
    setStage("review");
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--ad-text-muted)]">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> {t("Loading image production…")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StageNav stage={stage} setStage={setStage} hasDirections={directions.length > 0} hasBatch={Boolean(selectedBatch)} t={t} />

      {error ? (
        <div className="rounded-md border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-[var(--ad-green-text)]/20 bg-[var(--ad-green-bg)] px-4 py-3 text-sm text-[var(--ad-green-text)]" role="status">
          {notice}
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
        <CreativeBriefPanel
          batches={batches}
          busy={busy}
          characters={characters}
          countPerDirection={countPerDirection}
          directionBusy={directionBusy}
          directions={directions}
          estimatedCost={estimatedCost}
          form={form}
          inspirationAssets={inspirationAssets}
          onGenerateDirections={generateDirections}
          onLaunchDirections={launchSelectedDirections}
          orientations={orientations}
          perItemCost={perItemCost}
          presets={presets}
          profiles={profiles}
          recipes={recipes}
          selectedCharacter={selectedCharacter}
          setForm={setForm}
          stage={stage}
          t={t}
          valueLabel={valueLabel}
        />

        <div className="min-w-0 space-y-4">
          {stage === "review" && selectedBatch ? (
            <ReviewWorkspace
              batch={selectedBatch}
              batches={batches.filter((batch) => batch.targetId === form.characterId)}
              busy={busy}
              focusedItemId={focusedItemId}
              onApproveSelected={approveSelected}
              onOpenBatch={openBatch}
              onRefresh={refreshBatches}
              onReview={reviewItem}
              reviewDrafts={reviewDrafts}
              reviewFilter={reviewFilter}
              selectedItemIds={selectedItemIds}
              setFocusedItemId={setFocusedItemId}
              setReviewDrafts={setReviewDrafts}
              setReviewFilter={setReviewFilter}
              setSelectedItemIds={setSelectedItemIds}
              t={t}
              valueLabel={valueLabel}
            />
          ) : (
            <DirectionsWorkspace
              batches={batches.filter((batch) => batch.targetId === form.characterId)}
              directionBusy={directionBusy}
              directions={directions}
              inspirationAssets={inspirationAssets}
              onOpenBatch={openBatch}
              setDirections={setDirections}
              t={t}
              valueLabel={valueLabel}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StageNav({
  stage,
  setStage,
  hasDirections,
  hasBatch,
  t,
}: {
  stage: StudioStage;
  setStage: Dispatch<SetStateAction<StudioStage>>;
  hasDirections: boolean;
  hasBatch: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const steps: Array<{ id: StudioStage; label: string; enabled: boolean }> = [
    { id: "brief", label: "Creative brief", enabled: true },
    { id: "directions", label: "Directions", enabled: hasDirections },
    { id: "review", label: "Generate & review", enabled: hasBatch },
  ];
  return (
    <div aria-label={t("Production steps")} className="grid gap-2 border-b border-[var(--ad-border)] pb-3 sm:grid-cols-3" role="tablist">
      {steps.map((step, index) => {
        const active = stage === step.id;
        return (
          <button
            aria-selected={active}
            className={cn(
              "flex h-10 items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition-colors",
              active ? "text-[var(--ad-ink)]" : "text-[var(--ad-text-muted)] hover:bg-black/[0.04] hover:text-[var(--ad-ink)]",
              !step.enabled && "cursor-not-allowed opacity-45",
            )}
            disabled={!step.enabled}
            key={step.id}
            onClick={() => setStage(step.id)}
            role="tab"
            type="button"
          >
            <span className={cn("grid h-5 w-5 place-items-center rounded-full text-[11px]", active ? "bg-[var(--ad-ink)] text-white" : "bg-black/[0.06]")}>{index + 1}</span>
            {t(step.label)}
          </button>
        );
      })}
    </div>
  );
}

function CreativeBriefPanel({
  batches,
  busy,
  characters,
  countPerDirection,
  directionBusy,
  directions,
  estimatedCost,
  form,
  inspirationAssets,
  onGenerateDirections,
  onLaunchDirections,
  orientations,
  perItemCost,
  presets,
  profiles,
  recipes,
  selectedCharacter,
  setForm,
  stage,
  t,
  valueLabel,
}: {
  batches: ProductionBatch[];
  busy: boolean;
  characters: CharacterOption[];
  countPerDirection: number;
  directionBusy: boolean;
  directions: CreativeDirection[];
  estimatedCost: number;
  form: StudioForm;
  inspirationAssets: AssetSource[];
  onGenerateDirections: () => Promise<void>;
  onLaunchDirections: () => Promise<void>;
  orientations: string[];
  perItemCost: number;
  presets: Preset[];
  profiles: Profile[];
  recipes: Recipe[];
  selectedCharacter: CharacterOption | null;
  setForm: Dispatch<SetStateAction<StudioForm>>;
  stage: StudioStage;
  t: (key: string, vars?: Record<string, string | number>) => string;
  valueLabel: (key: string) => string;
}) {
  const imageSrc = selectedCharacter?.imageAsset?.thumbnailUrl || selectedCharacter?.imageAsset?.url || "";
  const activeIdentity = selectedCharacter?.visualProfiles[0] ?? null;
  const selectedDirectionCount = directions.filter((direction) => direction.selected).length;
  const recentForCharacter = batches.filter((batch) => batch.targetId === selectedCharacter?.id).length;
  const canGenerate = Boolean(form.characterId);
  const canLaunch = selectedDirectionCount > 0 && Boolean(form.profileId && form.recipeId);
  return (
    <aside className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 lg:sticky lg:top-24">
      <div className="space-y-4">
        <Field label={t("Character")}>
          <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 rounded-md border border-[var(--ad-border)] p-2">
            <div className="relative h-13 w-13 overflow-hidden rounded-md bg-black/[0.04]">
              {imageSrc ? <Image alt="" className="object-cover" fill sizes="52px" src={imageSrc} unoptimized /> : <ImageIcon className="m-4 h-5 w-5 text-[var(--ad-text-muted)]" />}
            </div>
            <div className="min-w-0">
              <select
                aria-label={t("Character")}
                className="h-7 w-full bg-transparent text-sm font-semibold outline-none"
                onChange={(event) => setForm((current) => ({ ...current, characterId: event.target.value }))}
                value={form.characterId}
              >
                {characters.map((character) => <option key={character.id} value={character.id}>{character.name} · {character.id.slice(-6)}</option>)}
              </select>
              <p className="mt-0.5 truncate text-xs text-[var(--ad-text-muted)]">
                {activeIdentity ? `${t("Identity locked")} · v${activeIdentity.version}` : t("Identity not configured")}
                {recentForCharacter > 0 ? ` · ${recentForCharacter} ${t("sets")}` : ""}
              </p>
            </div>
          </div>
        </Field>

        <Field label={t("Use case")}>
          <select className={inputClass} onChange={(event) => setForm((current) => ({ ...current, purpose: event.target.value }))} value={form.purpose}>
            {purposeOptions.map((purpose) => <option key={purpose} value={purpose}>{t(purposeLabels[purpose])}</option>)}
          </select>
        </Field>

        <Field label={t("Creative brief")} hint={`${t("Optional")} · ${form.creativeBrief.length}/240`}>
          <input
            className={inputClass}
            maxLength={240}
            onChange={(event) => setForm((current) => ({ ...current, creativeBrief: event.target.value }))}
            placeholder={t("e.g. Rainy night after work")}
            value={form.creativeBrief}
          />
        </Field>

        <Field label={t("Scene prompt")} hint={`${t("Optional")} · ${form.scenePrompt.length}/1200`}>
          <textarea
            className={cn(textareaClass, "min-h-28")}
            maxLength={1_200}
            onChange={(event) => setForm((current) => ({ ...current, scenePrompt: event.target.value }))}
            placeholder={t("Describe the moment, action, atmosphere, and camera story. The character identity is added automatically.")}
            value={form.scenePrompt}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-2">
          {(Object.keys(fieldSuggestions) as Array<keyof typeof fieldSuggestions>).map((field) => (
            <Field key={field} label={t(field[0].toUpperCase() + field.slice(1))}>
              <input
                className={inputClass}
                list={`production-${field}-suggestions`}
                onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))}
                value={form[field]}
              />
              <datalist id={`production-${field}-suggestions`}>
                {fieldSuggestions[field].map((item) => <option key={item} value={item} />)}
              </datalist>
            </Field>
          ))}
        </div>

        <Field label={t("Consistency")}>
          <div className="grid grid-cols-3 rounded-md border border-[var(--ad-border)] p-0.5">
            {(["strict", "balanced", "creative"] as const).map((mode) => (
              <button
                aria-pressed={form.consistencyMode === mode}
                className={cn("h-8 rounded text-xs font-medium", form.consistencyMode === mode ? "bg-[var(--ad-ink)] text-white" : "text-[var(--ad-text-muted)] hover:bg-black/[0.04]")}
                key={mode}
                onClick={() => setForm((current) => ({ ...current, consistencyMode: mode }))}
                type="button"
              >
                {t(mode[0].toUpperCase() + mode.slice(1))}
              </button>
            ))}
          </div>
        </Field>

        <Field label={t("References")} hint={t("Identity sources and recent approved images")}>
          <div className="flex min-h-16 gap-2 overflow-x-auto rounded-md border border-dashed border-[var(--ad-border)] p-2">
            {inspirationAssets.slice(0, 4).map((asset, index) => {
              const src = asset.thumbnailUrl || asset.url;
              return <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded bg-black/[0.04]" key={asset.id ?? `${src}-${index}`}><Image alt="" className="object-cover" fill sizes="48px" src={src} unoptimized /></div>;
            })}
            {inspirationAssets.length === 0 ? <p className="self-center text-xs text-[var(--ad-text-muted)]">{t("No references yet")}</p> : null}
          </div>
        </Field>

        <div className="flex items-center justify-between text-xs text-[var(--ad-text-muted)]">
          <span>{t("Estimated cost")}</span>
          <strong className="font-mono text-sm text-[var(--ad-ink)]">{estimatedCost} DC</strong>
        </div>
        {stage === "directions" && directions.length > 0 ? (
          <button className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !canLaunch} onClick={() => void onLaunchDirections()} type="button">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {t("Generate {count} selected directions", { count: selectedDirectionCount })}
          </button>
        ) : (
          <div className="space-y-2">
            <button className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={directionBusy || !canGenerate} onClick={() => void onGenerateDirections()} type="button">
              {directionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {t("Generate directions")}
            </button>
            {!form.creativeBrief.trim() && !form.scenePrompt.trim() ? (
              <p className="text-center text-[10px] leading-4 text-[var(--ad-text-muted)]">
                {t("No prompt needed — starter directions will use the character identity and references.")}
              </p>
            ) : null}
          </div>
        )}

        <details className="rounded-md border border-[var(--ad-border)]">
          <summary className="flex h-11 cursor-pointer list-none items-center justify-between px-3 text-sm font-medium">
            <span className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4" /> {t("Advanced")}</span><ChevronRight className="h-4 w-4" />
          </summary>
          <div className="space-y-3 border-t border-[var(--ad-border)] p-3">
            <Field label={t("Profile")}><select className={inputClass} onChange={(event) => setForm((current) => ({ ...current, profileId: event.target.value }))} value={form.profileId}>{profiles.map((profile) => <option key={profile.id} value={profile.profileKey || profile.id}>{profile.label} · v{profile.version}</option>)}</select></Field>
            <Field label={t("Recipe")}><select className={inputClass} onChange={(event) => setForm((current) => ({ ...current, recipeId: event.target.value }))} value={form.recipeId}>{recipes.map((recipe) => <option key={recipe.id} value={recipe.recipeKey || recipe.id}>{recipe.label} · {valueLabel(recipe.useCase)} · v{recipe.version}</option>)}</select></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Orientation")}><select className={inputClass} onChange={(event) => setForm((current) => ({ ...current, orientation: event.target.value }))} value={form.orientation}>{(orientations.length ? orientations : ["1:1", "4:5", "16:9"]).map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
              <Field label={t("Images per direction")}><input className={inputClass} max={8} min={1} onChange={(event) => setForm((current) => ({ ...current, count: event.target.value }))} type="number" value={form.count} /></Field>
            </div>
            <PresetFields form={form} presets={presets} setForm={setForm} t={t} valueLabel={valueLabel} />
            <p className="text-xs text-[var(--ad-text-muted)]">{countPerDirection} {t("images per direction")} · {perItemCost} DC {t("each")}</p>
          </div>
        </details>
      </div>
    </aside>
  );
}

function PresetFields({ form, presets, setForm, t, valueLabel }: { form: StudioForm; presets: Preset[]; setForm: Dispatch<SetStateAction<StudioForm>>; t: (key: string) => string; valueLabel: (key: string) => string }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {["background", "pose", "outfit", "mode"].map((type) => {
        const items = presets.filter((preset) => preset.type === type);
        return (
          <Field key={type} label={t(type[0].toUpperCase() + type.slice(1))}>
            <select
              className={inputClass}
              onChange={(event) => setForm((current) => ({ ...current, presetIds: [...current.presetIds.filter((id) => !items.some((item) => item.id === id)), ...(event.target.value ? [event.target.value] : [])] }))}
              value={form.presetIds.find((id) => items.some((item) => item.id === id)) ?? ""}
            >
              <option value="">{valueLabel(type)}</option>
              {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </Field>
        );
      })}
    </div>
  );
}

function DirectionsWorkspace({ batches, directionBusy, directions, inspirationAssets, onOpenBatch, setDirections, t, valueLabel }: { batches: ProductionBatch[]; directionBusy: boolean; directions: CreativeDirection[]; inspirationAssets: AssetSource[]; onOpenBatch: (id: string) => void; setDirections: Dispatch<SetStateAction<CreativeDirection[]>>; t: (key: string, vars?: Record<string, string | number>) => string; valueLabel: (key: string) => string }) {
  const allSelected = directions.length > 0 && directions.every((item) => item.selected);
  function patchDirection(id: string, patch: Partial<CreativeDirection>) {
    setDirections((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }
  return (
    <>
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-lg font-semibold">{t("Creative directions")}</h2><p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Edit the prompts, then select the directions worth producing.")}</p></div>
          {directions.length > 0 ? <label className="flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-xs"><input checked={allSelected} onChange={(event) => setDirections((current) => current.map((item) => ({ ...item, selected: event.target.checked })))} type="checkbox" /> {t("Select all")}</label> : null}
        </div>
        {directionBusy ? <div className="flex h-96 items-center justify-center text-sm text-[var(--ad-text-muted)]"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> {t("Developing four visual stories…")}</div> : directions.length === 0 ? <div className="grid min-h-96 place-items-center text-center"><div className="max-w-sm"><Lightbulb className="mx-auto h-8 w-8 text-[var(--ad-text-muted)]" /><h3 className="mt-4 text-base font-semibold">{t("Start with the story, not the model")}</h3><p className="mt-2 text-sm leading-6 text-[var(--ad-text-muted)]">{t("Add a creative brief or scene prompt for more control, or generate starter directions from the locked identity and references.")}</p></div></div> : <div className="mt-4 grid gap-3 md:grid-cols-2">{directions.map((direction, index) => {
          const asset = inspirationAssets.length >= directions.length ? inspirationAssets[index] : undefined;
          const src = asset ? asset.thumbnailUrl || asset.url : "";
          return <article className={cn("overflow-hidden rounded-md border bg-[var(--ad-surface)] transition-colors", direction.selected ? "border-[var(--ad-ink)]" : "border-[var(--ad-border)]")} key={direction.id}>
            <button aria-label={t("Select direction {title}", { title: direction.title })} className="relative block aspect-[16/8.5] w-full overflow-hidden bg-black/[0.04] text-left" onClick={() => patchDirection(direction.id, { selected: !direction.selected })} type="button">
              {src ? <Image alt="" className="object-cover" fill sizes="(min-width: 1280px) 36vw, 50vw" src={src} unoptimized /> : <span className="absolute inset-0 grid place-items-center p-5 text-center"><span><ImageIcon className="mx-auto h-7 w-7 text-[var(--ad-text-muted)]" /><strong className="mt-3 block text-xs text-[var(--ad-text)]">{t("Shot plan")}</strong><span className="mt-1 block text-[10px] leading-4 text-[var(--ad-text-muted)]">{direction.camera}<br />{direction.lighting}</span></span></span>}
              <span className={cn("absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-md border bg-white", direction.selected ? "border-black text-black" : "border-black/20 text-transparent")}>{direction.selected ? <Check className="h-4 w-4" /> : null}</span>
            </button>
            <div className="space-y-2 p-3">
              <div className="flex items-center gap-2"><span className="font-mono text-xs text-[var(--ad-text-muted)]">{index + 1}.</span><input aria-label={t("Direction title")} className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none" onChange={(event) => patchDirection(direction.id, { title: event.target.value })} value={direction.title} /></div>
              <textarea aria-label={t("Scene prompt")} className="min-h-20 w-full resize-y bg-transparent text-xs leading-5 text-[var(--ad-text-muted)] outline-none" onChange={(event) => patchDirection(direction.id, { scenePrompt: event.target.value })} value={direction.scenePrompt} />
              <div className="flex flex-wrap gap-1.5">{[direction.mood, direction.setting, direction.camera].filter(Boolean).map((item) => <span className="rounded-full bg-black/[0.05] px-2 py-1 text-[10px] text-[var(--ad-text-muted)]" key={item}>{item}</span>)}</div>
            </div>
          </article>;
        })}</div>}
      </section>
      <RecentSets batches={batches} onOpenBatch={onOpenBatch} t={t} valueLabel={valueLabel} />
    </>
  );
}

function RecentSets({ batches, onOpenBatch, t, valueLabel }: { batches: ProductionBatch[]; onOpenBatch: (id: string) => void; t: (key: string) => string; valueLabel: (key: string) => string }) {
  return <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{t("Recent sets")}</h2><span className="text-xs text-[var(--ad-text-muted)]">{batches.length}</span></div>{batches.length === 0 ? <p className="mt-3 text-sm text-[var(--ad-text-muted)]">{t("No production sets for this character yet.")}</p> : <div className="mt-3 flex gap-2 overflow-x-auto">{batches.slice(0, 8).map((batch) => {
    const asset = batch.items.find((item) => item.asset)?.asset;
    const src = asset ? asset.thumbnailUrl || asset.url : "";
    return <button className="grid min-w-56 grid-cols-[44px_minmax(0,1fr)] gap-2 rounded-md border border-[var(--ad-border)] p-2 text-left hover:border-[var(--ad-ink)]" key={batch.id} onClick={() => onOpenBatch(batch.id)} type="button"><div className="relative h-11 w-11 overflow-hidden rounded bg-black/[0.04]">{src ? <Image alt="" className="object-cover" fill sizes="44px" src={src} unoptimized /> : <ImageIcon className="m-3 h-5 w-5 text-[var(--ad-text-muted)]" />}</div><span className="min-w-0"><span className="block truncate text-xs font-semibold">{batch.title}</span><span className="mt-1 block text-[10px] text-[var(--ad-text-muted)]">{formatDate(batch.createdAt)} · {valueLabel(batch.status)} · {batch.completedItems}/{batch.totalItems}</span></span></button>;
  })}</div>}</section>;
}

function ReviewWorkspace({ batch, batches, busy, focusedItemId, onApproveSelected, onOpenBatch, onRefresh, onReview, reviewDrafts, reviewFilter, selectedItemIds, setFocusedItemId, setReviewDrafts, setReviewFilter, setSelectedItemIds, t, valueLabel }: { batch: ProductionBatch; batches: ProductionBatch[]; busy: boolean; focusedItemId: string | null; onApproveSelected: () => Promise<void>; onOpenBatch: (id: string) => void; onRefresh: () => Promise<ProductionBatch[]>; onReview: (item: ProductionItem, action: "approve" | "reject" | "regenerate") => Promise<void>; reviewDrafts: Record<string, ReviewDraft>; reviewFilter: ReviewFilter; selectedItemIds: string[]; setFocusedItemId: Dispatch<SetStateAction<string | null>>; setReviewDrafts: Dispatch<SetStateAction<Record<string, ReviewDraft>>>; setReviewFilter: Dispatch<SetStateAction<ReviewFilter>>; setSelectedItemIds: Dispatch<SetStateAction<string[]>>; t: (key: string, vars?: Record<string, string | number>) => string; valueLabel: (key: string) => string }) {
  const focusedItem = batch.items.find((item) => item.id === focusedItemId) ?? null;
  const filteredItems = batch.items.filter((item) => {
    if (reviewFilter === "unreviewed") return item.status === "generated";
    if (reviewFilter === "selected") return selectedItemIds.includes(item.id);
    if (reviewFilter === "failed") return item.status === "failed";
    return true;
  });
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="border-b border-[var(--ad-border)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium text-[var(--ad-text-muted)]">{t("Generate & review")}</p><h2 className="mt-1 text-lg font-semibold">{batch.title}</h2><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{purposeLabels[batch.purpose] ?? valueLabel(batch.purpose)} · {valueLabel(batch.status)} · {batch.completedItems}/{batch.totalItems} · {batch.estimatedCostDreamcoins} DC</p></div><button className="flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-xs hover:border-[var(--ad-ink)]" onClick={() => void onRefresh()} type="button"><RefreshCcw className="h-3.5 w-3.5" /> {t("Refresh")}</button></div>
        <div className="mt-4 flex gap-2 overflow-x-auto">{batches.slice(0, 10).map((item) => <button className={cn("min-w-44 rounded-md border px-3 py-2 text-left", item.id === batch.id ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-white" : "border-[var(--ad-border)]")} key={item.id} onClick={() => onOpenBatch(item.id)} type="button"><span className="block truncate text-xs font-semibold">{item.title}</span><span className={cn("mt-1 block text-[10px]", item.id === batch.id ? "text-white/65" : "text-[var(--ad-text-muted)]")}>{item.completedItems}/{item.totalItems} · {valueLabel(item.status)}</span></button>)}</div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ad-border)] px-4 py-3"><div className="flex rounded-md border border-[var(--ad-border)] p-0.5">{(["all", "unreviewed", "selected", "failed"] as const).map((filter) => <button aria-pressed={reviewFilter === filter} className={cn("h-8 rounded px-3 text-xs", reviewFilter === filter ? "bg-[var(--ad-ink)] text-white" : "text-[var(--ad-text-muted)] hover:bg-black/[0.04]")} key={filter} onClick={() => setReviewFilter(filter)} type="button">{t(filter[0].toUpperCase() + filter.slice(1))}</button>)}</div>{selectedItemIds.length > 0 ? <button className="flex h-9 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-3 text-xs font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void onApproveSelected()} type="button"><Check className="h-4 w-4" /> {t("Approve {count} selected", { count: selectedItemIds.length })}</button> : null}</div>
      <div className={cn("grid gap-4 p-4", focusedItem ? "2xl:grid-cols-[minmax(0,1fr)_300px]" : "grid-cols-1")}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{filteredItems.map((item) => <ReviewCard busy={busy} item={item} key={item.id} onFocus={() => setFocusedItemId(item.id)} onReview={onReview} selected={selectedItemIds.includes(item.id)} setSelected={(selected) => setSelectedItemIds((current) => selected ? [...new Set([...current, item.id])] : current.filter((id) => id !== item.id))} t={t} valueLabel={valueLabel} />)}</div>
        {focusedItem ? <ReviewDetail batch={batch} busy={busy} draft={reviewDrafts[focusedItem.id] ?? { tags: focusedItem.tags.join(", "), description: "" }} item={focusedItem} onClose={() => setFocusedItemId(null)} onReview={onReview} setDraft={(draft) => setReviewDrafts((current) => ({ ...current, [focusedItem.id]: draft }))} t={t} valueLabel={valueLabel} /> : null}
      </div>
    </section>
  );
}

function ReviewCard({ busy, item, onFocus, onReview, selected, setSelected, t, valueLabel }: { busy: boolean; item: ProductionItem; onFocus: () => void; onReview: (item: ProductionItem, action: "approve" | "reject" | "regenerate") => Promise<void>; selected: boolean; setSelected: (selected: boolean) => void; t: (key: string) => string; valueLabel: (key: string) => string }) {
  return <article className={cn("overflow-hidden rounded-md border bg-[var(--ad-surface)]", selected ? "border-[var(--ad-ink)] ring-1 ring-[var(--ad-ink)]" : "border-[var(--ad-border)]")}>
    <button className="relative block aspect-[4/5] w-full bg-black/[0.04] text-left" onClick={onFocus} type="button">{item.asset ? <AssetImage asset={{ url: item.asset.url, thumbnailUrl: item.asset.thumbnailUrl ?? "" }} /> : item.status === "failed" ? <span className="absolute inset-0 grid place-items-center p-4 text-center"><span><CircleAlert className="mx-auto h-6 w-6 text-[var(--ad-red-text)]" /><strong className="mt-2 block text-xs text-[var(--ad-red-text)]">{t("Generation failed")}</strong><span className="mt-1 block text-[10px] text-[var(--ad-text-muted)]">{item.job?.errorCode ?? t("Unknown error")}</span></span></span> : <span className="absolute inset-0 grid place-items-center text-xs text-[var(--ad-text-muted)]"><span><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />{valueLabel(item.job?.status ?? item.status)}</span></span>}</button>
    <div className="space-y-2 p-2.5"><div className="flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-xs"><input checked={selected} disabled={!item.asset || !["generated", "approved"].includes(item.status)} onChange={(event) => setSelected(event.target.checked)} type="checkbox" /> #{item.itemIndex + 1}</label><span className="text-[10px] text-[var(--ad-text-muted)]">{valueLabel(item.status)}</span></div><div className="flex gap-1.5">{item.status === "generated" ? <><SmallButton disabled={busy} label={t("Approve")} onClick={() => onReview(item, "approve")}><Check className="h-3.5 w-3.5" /></SmallButton><SmallButton disabled={busy} label={t("Reject")} onClick={() => onReview(item, "reject")}><X className="h-3.5 w-3.5" /></SmallButton></> : null}{item.status === "failed" || item.status === "rejected" ? <SmallButton disabled={busy} label={t("Retry")} onClick={() => onReview(item, "regenerate")}><RotateCcw className="h-3.5 w-3.5" /></SmallButton> : null}</div></div>
  </article>;
}

function ReviewDetail({ batch, busy, draft, item, onClose, onReview, setDraft, t, valueLabel }: { batch: ProductionBatch; busy: boolean; draft: ReviewDraft; item: ProductionItem; onClose: () => void; onReview: (item: ProductionItem, action: "approve" | "reject" | "regenerate") => Promise<void>; setDraft: (draft: ReviewDraft) => void; t: (key: string) => string; valueLabel: (key: string) => string }) {
  const releaseOwned = item.status === "approved" && ["character_cover", "character_hero"].includes(batch.purpose);
  return <aside className="rounded-md border border-[var(--ad-border)] p-3 2xl:sticky 2xl:top-24"><div className="flex items-center justify-between"><div><p className="text-xs font-semibold">{t("Image details")} #{item.itemIndex + 1}</p><p className="mt-1 text-[10px] text-[var(--ad-text-muted)]">{valueLabel(item.status)}</p></div><button aria-label={t("Close")} className="grid h-8 w-8 place-items-center rounded-md border border-[var(--ad-border)]" onClick={onClose} type="button"><X className="h-4 w-4" /></button></div>{item.asset ? <div className="mt-3 overflow-hidden rounded-md"><AssetImage asset={{ url: item.asset.url, thumbnailUrl: item.asset.thumbnailUrl ?? "" }} /></div> : null}<div className="mt-3 space-y-3"><Field label={t("Tags")}><input className={inputClass} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} placeholder="selfie, rainy night, city" value={draft.tags} /></Field><Field label={t("Description")}><textarea className={cn(textareaClass, "min-h-24")} onChange={(event) => setDraft({ ...draft, description: event.target.value })} value={draft.description} /></Field><div className="grid grid-cols-2 gap-2">{item.status === "generated" ? <><button className="h-9 rounded-md bg-[var(--ad-ink)] text-xs font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void onReview(item, "approve")} type="button">{t("Approve")}</button><button className="h-9 rounded-md border border-[var(--ad-border)] text-xs disabled:opacity-50" disabled={busy} onClick={() => void onReview(item, "reject")} type="button">{t("Reject")}</button></> : null}<button className="col-span-2 flex h-9 items-center justify-center gap-2 rounded-md border border-[var(--ad-border)] text-xs disabled:opacity-50" disabled={busy} onClick={() => void onReview(item, "regenerate")} type="button"><RotateCcw className="h-3.5 w-3.5" /> {t("More like this")}</button>{releaseOwned ? <p className="col-span-2 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-center text-xs text-[var(--ad-yellow-text)]">Publish through Character Release so the immutable snapshot and Serving pointer change atomically.</p> : null}{item.status === "approved" && batch.purpose === "character_chat" ? <p className="col-span-2 rounded-md bg-[var(--ad-green-bg)] px-3 py-2 text-center text-xs text-[var(--ad-green-text)]">{t("Approved for the character chat pool")}</p> : null}</div></div></aside>;
}

function SmallButton({ children, disabled, label, onClick }: { children: React.ReactNode; disabled: boolean; label: string; onClick: () => void | Promise<void> }) {
  return <button aria-label={label} className="flex h-8 items-center gap-1 rounded-md border border-[var(--ad-border)] px-2 text-[10px] hover:border-[var(--ad-ink)] disabled:opacity-50" disabled={disabled} onClick={() => void onClick()} type="button">{children}<span>{label}</span></button>;
}

function Field({ children, hint, label }: { children: React.ReactNode; hint?: string; label: string }) {
  return <label className="grid min-w-0 gap-1.5"><span className="flex items-center justify-between gap-3 text-xs font-medium text-[var(--ad-text-muted)]"><span>{label}</span>{hint ? <span className="truncate text-[10px] font-normal">{hint}</span> : null}</span>{children}</label>;
}
