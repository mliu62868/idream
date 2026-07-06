"use client";

import Image from "next/image";
import Link from "next/link";
import {
  CheckSquare,
  Download,
  EyeOff,
  Flag,
  Heart,
  ImageIcon,
  ListChecks,
  RefreshCw,
  Square,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CharacterCardData } from "@/types/ourdream";
import { authHrefForTarget } from "./authRedirect";

type MediaItem = {
  id: string;
  characterId?: string | null;
  type: "image" | "video";
  url: string;
  thumbnailUrl: string;
  contentType?: string | null;
  width?: number | null;
  height?: number | null;
  prompt: string | null;
  liked: boolean;
  canEditIdentity?: boolean;
  visualProfileId?: string | null;
  visualProfileVersion?: number | null;
  identity?: {
    selectedAsCharacterImage?: boolean;
    addedToReferences?: boolean;
  };
  provenance?: {
    sourceType: string;
    sourceId?: string | null;
    label: string;
    feedItemId?: string | null;
    sourceCharacterId?: string | null;
    sourceCharacterName?: string | null;
    href?: string | null;
  } | null;
};

type GenerationMode = "image" | "video";
type ImageWorkflow = "presets" | "image-edit";
type ConsistencyMode = "balanced" | "strict" | "creative";
type WorkspaceView = "create" | "jobs" | "gallery";
type GalleryTab = "image" | "video" | "liked";

type ModelConfig = {
  id: string;
  label: string;
  orientations?: string[];
  costMultiplier: number;
  entitlement: string | null;
  maxCount: number;
};

type PresetConfig = {
  id: string;
  type: "background" | "pose" | "outfit" | "mode";
  scope?: "built_in" | "community";
  category: string | null;
  label: string;
};

// US-GN-04: a user-saved preset. We store the active control selections
// (background/pose/outfit ids + optional prompt) inside `controls` as a
// string map, and use type "mode" so it stays a client-side container that
// the server prompt-fragment resolver leaves untouched.
type UserPreset = {
  id: string;
  type: string;
  category: string | null;
  label: string;
  controls: Record<string, unknown>;
  visibility: string;
};

type BulkAction = "delete" | "visibility";
type BulkVisibility = "private" | "public_pack" | "unlisted";

type GenerationConfig = {
  viewer?: {
    authenticated: boolean;
  };
  entitlements: Record<string, unknown>;
  dreamcoins: { balance: number };
  pricing: {
    image: { baseCost: number; maxCount: number };
    video: { baseCost: number };
  };
  image: {
    orientations: string[];
    models: ModelConfig[];
  };
  video: {
    enabled: boolean;
    requiredEntitlement: string;
    models: ModelConfig[];
  };
  presets?: PresetConfig[];
};

type GenerationJob = {
  id: string;
  mode: GenerationMode;
  status: string;
  costDreamcoins: number;
  outputCount: number;
  errorCode: string | null;
  createdAt: string;
};

type ApiPayload<T> = {
  ok: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
};

type PresetDraft = {
  label: string;
  modePresetId: string;
  backgroundPresetId: string;
  posePresetId: string;
  outfitPresetId: string;
  prompt: string;
  savedAt: number;
};

const generatorPresetDraftStorageKey = "idream.generatePresetDraft.v1";

export function GeneratorWorkspace() {
  const [config, setConfig] = useState<GenerationConfig | null>(null);
  const [characters, setCharacters] = useState<CharacterCardData[]>([]);
  const [characterId, setCharacterId] = useState("");
  const [freeplay, setFreeplay] = useState(false);
  const [mode, setMode] = useState<GenerationMode>("image");
  const [imageWorkflow, setImageWorkflow] = useState<ImageWorkflow>("presets");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [orientation, setOrientation] = useState("4:5");
  const [count, setCount] = useState(1);
  const [model, setModel] = useState("");
  const [consistencyMode, setConsistencyMode] = useState<ConsistencyMode>("balanced");
  const [modePresetId, setModePresetId] = useState("");
  const [backgroundPresetId, setBackgroundPresetId] = useState("");
  const [posePresetId, setPosePresetId] = useState("");
  const [outfitPresetId, setOutfitPresetId] = useState("");
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [identityMedia, setIdentityMedia] = useState<MediaItem[]>([]);
  const [galleryTab, setGalleryTab] = useState<GalleryTab>("image");
  const [view, setView] = useState<WorkspaceView>("create");
  const [status, setStatus] = useState("");
  const [configError, setConfigError] = useState("");
  const [pending, setPending] = useState(false);
  const [failedMediaIds, setFailedMediaIds] = useState<Set<string>>(() => new Set());
  const [invalidPreviewMediaIds, setInvalidPreviewMediaIds] = useState<Set<string>>(() => new Set());
  const [userPresets, setUserPresets] = useState<UserPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [manageMode, setManageMode] = useState(false);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(() => new Set());
  const [deleteConfirmMediaId, setDeleteConfirmMediaId] = useState<string | null>(null);
  const [bulkDeleteConfirmKey, setBulkDeleteConfirmKey] = useState<string | null>(null);
  const [deleteConfirmPresetId, setDeleteConfirmPresetId] = useState<string | null>(null);
  const [editSourceMediaId, setEditSourceMediaId] = useState("");
  const [remixFeedItemId, setRemixFeedItemId] = useState("");
  const [authReturnTarget, setAuthReturnTarget] = useState("/generate");
  const workspaceTopRef = useRef<HTMLDivElement>(null);

  const videoModeEnabled = Boolean(config?.video.enabled && (config.video.models.length ?? 0) > 0);
  const availableModels = useMemo(
    () => (mode === "video" && videoModeEnabled ? (config?.video.models ?? []) : (config?.image.models ?? [])),
    [config, mode, videoModeEnabled],
  );
  const selectedModel = useMemo(
    () => availableModels.find((item) => item.id === model) ?? availableModels[0],
    [availableModels, model],
  );
  const maxCount =
    selectedModel?.maxCount ?? (mode === "video" ? 1 : (config?.pricing.image.maxCount ?? 4));
  const outputCount = mode === "video" ? 1 : Math.max(1, Math.min(count, maxCount));
  const estimatedCost = Math.ceil(
    (mode === "video" ? (config?.pricing.video.baseCost ?? 100) : (config?.pricing.image.baseCost ?? 5)) *
      outputCount *
      (selectedModel?.costMultiplier ?? 1),
  );
  const modeAvailable =
    mode === "image"
      ? (config?.image.models.length ?? 0) > 0
      : videoModeEnabled;
  const galleryTabs = useMemo<GalleryTab[]>(
    () => (videoModeEnabled ? ["image", "video", "liked"] : ["image", "liked"]),
    [videoModeEnabled],
  );
  const canUsePrompt = Boolean(config?.entitlements.premium_controls);
  const insufficientBalance =
    Boolean(config) && estimatedCost > (config?.dreamcoins.balance ?? 0);
  const imageEditMode = mode === "image" && imageWorkflow === "image-edit";
  const anonymousViewer = config?.viewer?.authenticated === false;
  const upgradeHref = upgradeHrefForTarget(authReturnTarget);
  const insufficientBalanceHref = anonymousViewer
    ? authHrefForTarget("/signup", authReturnTarget)
    : upgradeHref;
  const selectedCharacter = useMemo(
    () => characters.find((character) => character.id === characterId) ?? null,
    [characterId, characters],
  );
  const imageEditCandidates = useMemo(
    () =>
      media
        .filter((item) => item.type === "image")
        .filter((item) => !isBuiltInMediaPlaceholderUrl(item.thumbnailUrl ?? item.url))
        .slice(0, 6),
    [media],
  );
  const selectedEditSource = useMemo(
    () => imageEditCandidates.find((item) => item.id === editSourceMediaId) ?? null,
    [editSourceMediaId, imageEditCandidates],
  );
  const identityReferenceCount = useMemo(() => {
    const profile = selectedCharacter?.visualProfile;
    const anchorCount = Array.isArray(profile?.anchorAssetIds) ? profile.anchorAssetIds.length : 0;
    const referenceCount = Array.isArray(profile?.referenceAssetIds) ? profile.referenceAssetIds.length : 0;
    return anchorCount + referenceCount;
  }, [selectedCharacter]);
  const identityTimeline = useMemo(
    () =>
      identityMedia
        .filter((item) => item.type === "image" && item.characterId === selectedCharacter?.id)
        .filter((item) =>
          Boolean(
            item.identity?.selectedAsCharacterImage ||
              item.identity?.addedToReferences ||
              item.visualProfileVersion,
          ),
        )
        .slice(0, 4),
    [identityMedia, selectedCharacter],
  );
  const editableIdentityCharacterIds = useMemo(
    () =>
      new Set(
        characters
          .filter((character) => character.canEditIdentity)
          .map((character) => character.id),
      ),
    [characters],
  );
  const presetsOf = useCallback(
    (type: PresetConfig["type"]) => (config?.presets ?? []).filter((preset) => preset.type === type),
    [config],
  );
  const canSubmit =
    !pending &&
    (imageEditMode || freeplay || Boolean(characterId)) &&
    Boolean(config) &&
    modeAvailable &&
    (!imageEditMode || Boolean(selectedEditSource)) &&
    !insufficientBalance;
  const selectedMediaConfirmKey = Array.from(selectedMediaIds).sort().join("|");
  const bulkDeleteArmed =
    selectedMediaIds.size > 0 && bulkDeleteConfirmKey === selectedMediaConfirmKey;

  const showJobsView = useCallback(() => {
    setView("jobs");
    window.setTimeout(() => {
      workspaceTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, []);

  useEffect(() => {
    const draft = readPresetDraft();
    if (!draft) return;
    const timer = window.setTimeout(() => {
      setPresetName(draft.label);
      setModePresetId(draft.modePresetId);
      setBackgroundPresetId(draft.backgroundPresetId);
      setPosePresetId(draft.posePresetId);
      setOutfitPresetId(draft.outfitPresetId);
      setPrompt(draft.prompt);
      setMode("image");
      setImageWorkflow("presets");
      setStatus("Preset draft restored. Save it to add it to My Presets.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const target = `${window.location.pathname}${window.location.search}`;
      setAuthReturnTarget(target || "/generate");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/generation/config", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | ApiPayload<GenerationConfig>
        | null;
      const data = payload?.data;
      if (!response.ok || !payload?.ok || !data) {
        setConfig(null);
        setConfigError(
          payload?.error?.message ?? generationConfigErrorMessage(response.status),
        );
        return;
      }
      setConfig(data);
      setConfigError("");
      const nextVideoModeEnabled = data.video.enabled && data.video.models.length > 0;
      if (!nextVideoModeEnabled) {
        setMode((current) => (current === "video" ? "image" : current));
        setGalleryTab((current) => (current === "video" ? "image" : current));
      }
      const firstModel = data.image.models[0]?.id ?? "";
      setModel((current) => current || firstModel);
      setOrientation((current) => current || data.image.orientations[0] || "4:5");
      setCount((current) => Math.min(current, data.pricing.image.maxCount));
    } catch {
      setConfig(null);
      setConfigError("Generation controls could not load. Refresh and try again.");
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    const response = await fetch("/api/v1/generation/jobs?limit=20");
    if (!response.ok) return;
    const payload = (await response.json()) as ApiPayload<{ items: GenerationJob[] }>;
    setJobs(payload.data?.items ?? []);
  }, []);

  const refreshMedia = useCallback(async (tab: GalleryTab = galleryTab) => {
    const query = tab === "liked" ? "liked=1" : `type=${tab}`;
    const response = await fetch(`/api/v1/media?${query}`);
    if (!response.ok) return;
    const payload = (await response.json()) as ApiPayload<{ items: MediaItem[] }>;
    setMedia(payload.data?.items ?? []);
    setDeleteConfirmMediaId(null);
    setBulkDeleteConfirmKey(null);
  }, [galleryTab]);

  const refreshPresets = useCallback(async () => {
    // scope=user yields only the signed-in user's saved presets (built-in
    // background/pose/outfit presets arrive separately via the config endpoint).
    const response = await fetch("/api/v1/generation/presets?scope=user");
    if (!response.ok) return;
    const payload = (await response.json()) as ApiPayload<{ items: UserPreset[] }>;
    setUserPresets(payload.data?.items ?? []);
    setDeleteConfirmPresetId(null);
  }, []);

  const refreshIdentityMedia = useCallback(async () => {
    const response = await fetch("/api/v1/media?type=image&limit=60");
    if (!response.ok) return;
    const payload = (await response.json()) as ApiPayload<{ items: MediaItem[] }>;
    setIdentityMedia(payload.data?.items ?? []);
  }, []);

  const refreshCharacters = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/characters?limit=12");
      const payload = (await response.json()) as ApiPayload<{ items: CharacterCardData[] }>;
      const searchParams = new URLSearchParams(window.location.search);
      const desired = searchParams.get("characterId");
      const nextRemixFeedItemId = searchParams.get("remixFeedItemId") ?? "";
      const listedItems = payload.data?.items ?? [];
      const desiredCharacter =
        desired && !listedItems.some((character) => character.id === desired)
          ? await fetchCharacterById(desired)
          : null;
      const items = desiredCharacter ? [desiredCharacter, ...listedItems] : listedItems;
      setCharacters(items);
      if (items.length === 0) {
        setCharacterId("");
        setFreeplay(true);
        return;
      }
      if (nextRemixFeedItemId) {
        setRemixFeedItemId(nextRemixFeedItemId);
        setStatus((current) => current || "Remix ready from Feed. Adjust details and generate.");
      }
      const preset = desired && items.some((c) => c.id === desired) ? desired : "";
      if (preset) setFreeplay(false);
      setCharacterId((current) => current || preset || items[0]?.id || "");
    } catch {
      setCharacters([]);
      setCharacterId("");
      setFreeplay(true);
      setStatus((current) => current || "Character catalog unavailable. Freeplay selected.");
    }
  }, []);

  const pollGeneration = useCallback(async (jobId: string) => {
    const response = await fetch(`/api/v1/generation/jobs/${jobId}`);
    if (!response.ok) return;
    const payload = (await response.json()) as ApiPayload<{
      job: GenerationJob;
      assets: MediaItem[];
    }>;
    const job = payload.data?.job;
    if (!job) return;
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    if (job.status === "completed") {
      setStatus("Generation complete.");
      setGalleryTab(job.mode);
      void refreshConfig();
      void refreshMedia(job.mode);
    }
    if (job.status === "failed" || job.status === "blocked" || job.status === "refunded") {
      setStatus(statusMessage(job));
      void refreshConfig();
    }
  }, [refreshConfig, refreshMedia]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshConfig();
      void refreshJobs();
      void refreshMedia("image");
      void refreshPresets();
      void refreshIdentityMedia();
      void refreshCharacters();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshCharacters, refreshConfig, refreshIdentityMedia, refreshJobs, refreshMedia, refreshPresets]);

  useEffect(() => {
    const pendingJobs = jobs.filter((job) => !isTerminal(job.status));
    if (pendingJobs.length === 0) return;
    const timer = window.setInterval(() => {
      void refreshJobs();
      for (const job of pendingJobs) {
        void pollGeneration(job.id);
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [jobs, pollGeneration, refreshJobs]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      if (imageEditMode && !selectedEditSource) {
        setStatus("Choose a source image to edit.");
      }
      return;
    }
    setPending(true);
    setStatus("");
    try {
      if (imageEditMode && selectedEditSource) {
        await createMediaVariation(selectedEditSource, { outputCount });
        return;
      }
      const response = await fetch("/api/v1/generation/jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          mode,
          characterId: freeplay ? undefined : characterId,
          freeplay,
          consistencyMode,
          outputCount,
          prompt: canUsePrompt && prompt ? prompt : undefined,
          negativePrompt: canUsePrompt && negativePrompt ? negativePrompt : undefined,
          remixFeedItemId: remixFeedItemId || undefined,
          controls: {
            orientation,
            model: selectedModel?.id,
            seconds: mode === "video" ? 4 : undefined,
            modePresetId: mode === "image" && modePresetId ? modePresetId : undefined,
            backgroundPresetId: mode === "image" && backgroundPresetId ? backgroundPresetId : undefined,
            posePresetId: mode === "image" && posePresetId ? posePresetId : undefined,
            outfitPresetId: mode === "image" && outfitPresetId ? outfitPresetId : undefined,
          },
        }),
      });
      const payload = (await response.json()) as ApiPayload<{
        job: GenerationJob;
        assets: MediaItem[];
      }>;
      if (!response.ok || !payload.ok || !payload.data?.job) {
        setStatus(payload.error?.message ?? "Generation failed");
        return;
      }
      const job = payload.data.job;
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setStatus("Generation queued.");
      showJobsView();
      void refreshConfig();
      void pollGeneration(job.id);
    } catch {
      // Network/server failure: surface a clear message instead of a silent no-op.
      setStatus("Generation request failed. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  async function retryJob(jobId: string) {
    const response = await fetch(`/api/v1/generation/jobs/${jobId}/retry`, {
      method: "POST",
    });
    const payload = (await response.json()) as ApiPayload<{ job: GenerationJob }>;
    if (!response.ok || !payload.data?.job) {
      setStatus(payload.error?.message ?? "Retry failed");
      return;
    }
    const job = payload.data.job;
    setJobs((current) => [job, ...current]);
    setStatus("Retry queued.");
    void refreshConfig();
  }

  async function toggleLike(item: MediaItem) {
    const nextLiked = !item.liked;
    // Optimistic: flip the heart. On the "liked" tab an unlike removes the card,
    // since it no longer belongs there.
    setMedia((current) => {
      if (!nextLiked && galleryTab === "liked") {
        return current.filter((m) => m.id !== item.id);
      }
      return current.map((m) => (m.id === item.id ? { ...m, liked: nextLiked } : m));
    });
    const response = await fetch(`/api/v1/media/${item.id}/like`, {
      method: nextLiked ? "POST" : "DELETE",
    });
    if (!response.ok) void refreshMedia(galleryTab);
  }

  async function deleteMedia(id: string) {
    setStatus("");
    if (deleteConfirmMediaId !== id) {
      setDeleteConfirmMediaId(id);
      setStatus("Press Confirm delete to remove this media.");
      return;
    }
    setMedia((current) => current.filter((item) => item.id !== id));
    setDeleteConfirmMediaId(null);
    try {
      const response = await fetch(`/api/v1/media/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setStatus("Delete failed.");
        void refreshMedia(galleryTab);
        return;
      }
      setStatus("Media deleted.");
    } catch {
      setStatus("Delete failed.");
      void refreshMedia(galleryTab);
    }
  }

  async function downloadMedia(id: string) {
    setStatus("");
    const downloadWindow = openDownloadWindow();
    try {
      const response = await fetch(`/api/v1/media/${id}/download`);
      if (!response.ok) {
        downloadWindow?.close();
        setStatus("Download failed.");
        return;
      }
      const payload = (await response.json()) as ApiPayload<{ url: string }>;
      if (payload.data?.url) {
        navigateDownloadWindow(downloadWindow, payload.data.url);
        setStatus("Download started.");
      } else {
        downloadWindow?.close();
        setStatus("Download failed.");
      }
    } catch {
      downloadWindow?.close();
      setStatus("Download failed.");
    }
  }

  async function reportMedia(id: string) {
    const response = await fetch("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetType: "media",
        targetId: id,
        category: "other_prohibited_content",
        description: "Gallery media report",
      }),
    });
    setStatus(response.ok ? "Report submitted." : "Report failed.");
  }

  async function runIdentityMediaAction(
    item: MediaItem,
    action: "use-as-character-image" | "add-to-identity",
  ) {
    if (item.type !== "image") return;
    const targetCharacterId = item.characterId ?? (!freeplay ? characterId : "");
    if (!targetCharacterId) {
      setStatus("Choose a character before updating identity.");
      return;
    }
    const response = await fetch(`/api/v1/media/${item.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: targetCharacterId }),
    });
    const payload = (await response.json().catch(() => null)) as ApiPayload<unknown> | null;
    if (!response.ok || !payload?.ok) {
      setStatus(payload?.error?.message ?? "Identity update failed.");
      return;
    }
    setStatus(
      action === "use-as-character-image"
        ? "Character image updated."
        : "Added to identity references.",
    );
    void refreshCharacters();
    void refreshIdentityMedia();
    void refreshMedia(galleryTab);
  }

  function canEditIdentityForMedia(item: MediaItem) {
    if (item.characterId) return Boolean(item.canEditIdentity);
    const targetCharacterId = !freeplay ? characterId : "";
    return Boolean(targetCharacterId && editableIdentityCharacterIds.has(targetCharacterId));
  }

  async function createMediaVariation(item: MediaItem, options?: { outputCount?: number }) {
    if (item.type !== "image") return;
    try {
      const response = await fetch(`/api/v1/media/${item.id}/variation`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ outputCount: options?.outputCount ?? 1, consistencyMode }),
      });
      const payload = (await response.json().catch(() => null)) as
        | ApiPayload<{ job: GenerationJob; assets: MediaItem[] }>
        | null;
      if (!response.ok || !payload?.ok || !payload.data?.job) {
        setStatus(payload?.error?.message ?? "Variation failed.");
        return;
      }
      const job = payload.data.job;
      setJobs((current) => [job, ...current.filter((itemJob) => itemJob.id !== job.id)]);
      setStatus(imageEditMode ? "Image edit queued." : "Variation queued.");
      showJobsView();
      void refreshConfig();
      void pollGeneration(job.id);
    } catch {
      setStatus("Variation failed. Check your connection and try again.");
    }
  }

  function switchGallery(tab: GalleryTab) {
    setGalleryTab(tab);
    setView("gallery");
    setManageMode(false);
    setSelectedMediaIds(new Set());
    setDeleteConfirmMediaId(null);
    setBulkDeleteConfirmKey(null);
    void refreshMedia(tab);
  }

  async function saveCurrentPreset() {
    const label = presetName.trim();
    if (!label) {
      setStatus("Name your preset before saving.");
      return;
    }
    const controls = currentPresetControls({
      backgroundPresetId,
      canUsePrompt,
      modePresetId,
      outfitPresetId,
      posePresetId,
      prompt,
    });
    if (Object.keys(controls).length === 0) {
      setStatus("Pick a mode, background, pose, outfit, or prompt before saving a preset.");
      return;
    }
    try {
      const response = await fetch("/api/v1/generation/presets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "mode", label, controls, visibility: "private" }),
      });
      const payload = (await response.json()) as ApiPayload<{ preset: UserPreset }>;
      if (!response.ok || !payload.ok) {
        if (response.status === 401) {
          savePresetDraft({
            backgroundPresetId,
            label,
            modePresetId,
            outfitPresetId,
            posePresetId,
            prompt: canUsePrompt ? prompt.trim() : "",
            savedAt: Date.now(),
          });
          window.location.assign(authHrefForTarget("/signup", "/generate"));
          return;
        }
        setStatus(payload.error?.message ?? "Couldn't save preset.");
        return;
      }
      setPresetName("");
      setDeleteConfirmPresetId(null);
      clearPresetDraft();
      setStatus(`Saved preset "${label}".`);
      void refreshPresets();
    } catch {
      setStatus("Couldn't save preset. Check your connection and try again.");
    }
  }

  function applyPreset(preset: UserPreset) {
    const controls = isRecord(preset.controls) ? preset.controls : {};
    setModePresetId(presetControlString(controls, "modePresetId"));
    setBackgroundPresetId(presetControlString(controls, "backgroundPresetId"));
    setPosePresetId(presetControlString(controls, "posePresetId"));
    setOutfitPresetId(presetControlString(controls, "outfitPresetId"));
    const savedPrompt = presetControlString(controls, "prompt");
    if (savedPrompt && canUsePrompt) setPrompt(savedPrompt);
    setMode("image");
    setDeleteConfirmPresetId(null);
    setStatus(`Applied preset "${preset.label}".`);
  }

  async function deletePreset(id: string) {
    if (deleteConfirmPresetId !== id) {
      setDeleteConfirmPresetId(id);
      setStatus("Press Confirm delete preset to delete this preset.");
      return;
    }
    try {
      const response = await fetch(`/api/v1/generation/presets/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setDeleteConfirmPresetId(null);
        setStatus("Couldn't delete preset.");
        void refreshPresets();
        return;
      }
      setStatus("Preset deleted.");
      await refreshPresets();
    } catch {
      setStatus("Couldn't delete preset. Check your connection and try again.");
      void refreshPresets();
    }
  }

  function toggleManage() {
    setManageMode((current) => !current);
    setSelectedMediaIds(new Set());
    setBulkDeleteConfirmKey(null);
  }

  function toggleSelect(id: string) {
    setBulkDeleteConfirmKey(null);
    setSelectedMediaIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setBulkDeleteConfirmKey(null);
    setSelectedMediaIds((current) =>
      current.size === media.length ? new Set() : new Set(media.map((item) => item.id)),
    );
  }

  async function runBulkMedia(action: BulkAction, visibility?: BulkVisibility) {
    const ids = Array.from(selectedMediaIds);
    if (ids.length === 0) {
      setStatus("Select media first.");
      return;
    }
    const confirmKey = ids.slice().sort().join("|");
    if (action === "delete" && bulkDeleteConfirmKey !== confirmKey) {
      setBulkDeleteConfirmKey(confirmKey);
      setStatus(
        `Press Confirm delete selected to delete ${ids.length} item${ids.length === 1 ? "" : "s"}.`,
      );
      return;
    }
    try {
      const response = await fetch("/api/v1/media/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, action, visibility }),
      });
      const payload = (await response.json()) as ApiPayload<{ deleted?: number; updated?: number }>;
      if (!response.ok || !payload.ok) {
        setStatus(payload.error?.message ?? "Bulk action failed.");
        return;
      }
      setStatus(
        action === "delete"
          ? `Deleted ${ids.length} item${ids.length === 1 ? "" : "s"}.`
          : `Updated ${ids.length} item${ids.length === 1 ? "" : "s"}.`,
      );
      setSelectedMediaIds(new Set());
      setBulkDeleteConfirmKey(null);
      void refreshMedia(galleryTab);
    } catch {
      setStatus("Bulk action failed. Check your connection and try again.");
    }
  }

  return (
    <section className="px-4 py-8 md:px-[60px] md:py-12">
      <div className="mx-auto max-w-6xl" ref={workspaceTopRef}>
        <div className="mb-4 grid grid-cols-3 gap-2 md:hidden">
          {(["create", "jobs", "gallery"] as const).map((item) => (
            <button
              className={`h-10 rounded-full text-[12px] font-bold ${
                view === item ? "bg-white text-[rgb(13,13,13)]" : "bg-[rgb(36,36,36)] text-white"
              }`}
              key={item}
              onClick={() => setView(item)}
              type="button"
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>

        <div className="grid gap-5 md:grid-cols-[390px_1fr]">
          <form
            className={`${view === "create" ? "block" : "hidden"} rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:block`}
            onSubmit={submit}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Balance
                </p>
                {config ? (
                  <p className="text-[22px] font-black text-white">
                    {`${config.dreamcoins.balance.toLocaleString()} coins`}
                  </p>
                ) : configError ? (
                  <button
                    className="flex items-center gap-2 text-left text-[14px] font-bold text-[rgb(255,184,112)]"
                    onClick={() => void refreshConfig()}
                    type="button"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Couldn&apos;t load generator. Retry.
                  </button>
                ) : (
                  <p className="text-[22px] font-black text-white">Loading...</p>
                )}
              </div>
              <div className="rounded-full bg-[rgb(36,36,36)] px-3 py-2 text-[12px] font-bold text-white">
                {estimatedCost} coins
              </div>
            </div>

            {videoModeEnabled && (
              <div className="mt-4 grid grid-cols-2 rounded-full bg-[rgb(36,36,36)] p-1">
                <button
                  className={`h-10 rounded-full text-[13px] font-bold ${
                    mode === "image" ? "bg-white text-[rgb(13,13,13)]" : "text-[rgb(170,170,170)]"
                  }`}
                  onClick={() => {
                    setMode("image");
                    setModel(config?.image.models[0]?.id ?? "");
                    setOrientation(config?.image.orientations[0] ?? "4:5");
                  }}
                  type="button"
                >
                  Image
                </button>
                <button
                  className={`h-10 rounded-full text-[13px] font-bold ${
                    mode === "video" ? "bg-white text-[rgb(13,13,13)]" : "text-[rgb(170,170,170)]"
                  }`}
                  onClick={() => {
                    const firstVideoModel = config?.video.models[0];
                    setMode("video");
                    setModel(firstVideoModel?.id ?? "");
                    setOrientation(firstVideoModel?.orientations?.[0] ?? "9:16");
                    setCount(1);
                  }}
                  type="button"
                >
                  Video
                </button>
              </div>
            )}

            {mode === "image" && (
              <div className="mt-4 grid grid-cols-2 rounded-full bg-[rgb(36,36,36)] p-1">
                {(["presets", "image-edit"] as const).map((item) => (
                  <button
                    aria-pressed={imageWorkflow === item}
                    className={`h-10 rounded-full text-[13px] font-bold ${
                      imageWorkflow === item
                        ? "bg-white text-[rgb(13,13,13)]"
                        : "text-[rgb(170,170,170)]"
                    }`}
                    key={item}
                    onClick={() => {
                      setImageWorkflow(item);
                      setStatus("");
                      if (item === "image-edit") setGalleryTab("image");
                    }}
                    type="button"
                  >
                    {item === "presets" ? "Presets" : "Image Edit"}
                  </button>
                ))}
              </div>
            )}

            {imageEditMode && (
              <div
                className="mt-4 rounded-[10px] border border-white/10 bg-black/25 p-3"
                data-testid="image-edit-panel"
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                      Source image
                    </p>
                    <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">
                      Pick a Gallery image to create a more-like-this edit.
                    </p>
                  </div>
                  <button
                    className="h-8 rounded-full bg-[rgb(36,36,36)] px-3 text-[11px] font-black text-white"
                    onClick={() => {
                      setView("gallery");
                      void refreshMedia("image");
                    }}
                    type="button"
                  >
                    Open Gallery
                  </button>
                </div>
                {imageEditCandidates.length === 0 ? (
                  <p className="rounded-[8px] bg-[rgb(36,36,36)] p-3 text-[12px] font-semibold text-[rgb(170,170,170)]">
                    No editable images yet. Generate an image first, then return to Image Edit.
                  </p>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {imageEditCandidates.map((item, index) => {
                      const source = item.thumbnailUrl ?? item.url;
                      const selected = item.id === selectedEditSource?.id;
                      return (
                        <button
                          aria-label={`Select image edit source ${index + 1}`}
                          aria-pressed={selected}
                          className={`relative aspect-square overflow-hidden rounded-[8px] bg-[rgb(36,36,36)] ${
                            selected ? "ring-2 ring-[rgb(255,48,170)]" : ""
                          }`}
                          data-media-id={item.id}
                          data-testid="image-edit-source-card"
                          key={item.id}
                          onClick={() => setEditSourceMediaId(item.id)}
                          type="button"
                        >
                          <Image
                            alt=""
                            className="object-cover object-top"
                            fill
                            loading={index < 3 ? "eager" : "lazy"}
                            sizes="96px"
                            src={source}
                            unoptimized={isPrivateMediaUrl(source)}
                          />
                          {selected && (
                            <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[rgb(255,48,170)] text-white">
                              <CheckSquare className="h-3.5 w-3.5" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!imageEditMode && (
              <>
                <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Character
                  <select
                    aria-label="Character"
                    className="mt-2 h-12 w-full rounded-[10px] bg-[rgb(36,36,36)] px-4 text-[13px] font-semibold text-white outline-none"
                    disabled={freeplay}
                    id="generator-character"
                    name="characterId"
                    onChange={(event) => setCharacterId(event.target.value)}
                    value={characterId}
                  >
                    {characters.map((character) => (
                      <option key={character.id} value={character.id}>
                        {character.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="mt-3 flex items-center gap-2 text-[13px] font-semibold text-white">
                  <input
                    checked={freeplay}
                    className="h-4 w-4 accent-[rgb(255,64,180)]"
                    id="generator-freeplay"
                    name="freeplay"
                    onChange={(event) => setFreeplay(event.target.checked)}
                    type="checkbox"
                  />
                  Freeplay
                </label>
              </>
            )}

            {mode === "image" && !freeplay && !imageEditMode && (
              <div className="mt-4">
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Consistency
                </p>
                <div className="mt-2 flex min-h-10 items-center justify-between gap-3 rounded-[10px] bg-black/25 px-3 py-2 text-xs">
                  <span className="inline-flex min-w-0 items-center gap-2 font-bold text-white">
                    <ImageIcon className="h-4 w-4 shrink-0 text-[rgb(255,64,180)]" />
                    <span className="truncate">
                      {selectedCharacter?.visualProfile
                        ? `Identity locked · v${selectedCharacter.visualProfile.version}`
                        : "Set up identity image"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[rgb(170,170,170)]">
                    {selectedCharacter?.visualProfile ? `${identityReferenceCount} refs` : "No anchor"}
                  </span>
                </div>
                {!selectedCharacter?.visualProfile && (
                  <div className="mt-2 rounded-[10px] border border-[rgb(255,184,112)]/30 bg-[rgb(36,28,18)] p-3 text-[12px] font-semibold leading-5 text-[rgb(255,184,112)]">
                    Generate a first image, then choose Use as character image in Gallery to lock this character&apos;s visual identity.
                  </div>
                )}
                {identityTimeline.length > 0 && (
                  <div className="mt-2 rounded-[10px] bg-black/25 p-3" data-testid="identity-timeline">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                        Identity timeline
                      </p>
                      <span className="text-[11px] font-semibold text-[rgb(170,170,170)]">
                        v{selectedCharacter?.visualProfile?.version ?? identityTimeline[0]?.visualProfileVersion ?? 1}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {identityTimeline.map((item) => {
                        const source = item.thumbnailUrl ?? item.url;
                        return (
                          <div
                            className="relative aspect-square overflow-hidden rounded-[8px] bg-[rgb(36,36,36)]"
                            key={item.id}
                          >
                            <Image
                              alt="Identity reference"
                              className="object-cover object-top"
                              fill
                              sizes="64px"
                              src={source}
                              unoptimized={isPrivateMediaUrl(source)}
                            />
                            <span className="absolute bottom-1 left-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-black text-white">
                              {item.identity?.selectedAsCharacterImage
                                ? "Main"
                                : `v${item.visualProfileVersion ?? "?"}`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="mt-2 grid grid-cols-3 rounded-full bg-[rgb(36,36,36)] p-1">
                  {(["balanced", "strict", "creative"] as const).map((item) => (
                    <button
                      className={`h-9 rounded-full text-[12px] font-bold capitalize ${
                        consistencyMode === item
                          ? "bg-white text-[rgb(13,13,13)]"
                          : "text-[rgb(170,170,170)]"
                      }`}
                      key={item}
                      onClick={() => setConsistencyMode(item)}
                      type="button"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!imageEditMode ? (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Orientation
                  <select
                    className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                    id="generator-orientation"
                    name="orientation"
                    onChange={(event) => setOrientation(event.target.value)}
                    value={orientation}
                  >
                    {(selectedModel?.orientations?.length
                      ? selectedModel.orientations
                      : config?.image.orientations ?? ["1:1", "4:5", "3:4", "9:16", "16:9"]
                    ).map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Count
                  <input
                    className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                    id="generator-output-count"
                    max={maxCount}
                    min={1}
                    name="outputCount"
                    onChange={(event) =>
                      setCount(Math.max(1, Math.min(maxCount, Number(event.target.value))))
                    }
                    disabled={mode === "video"}
                    type="number"
                    value={outputCount}
                  />
                </label>
              </div>
            ) : (
              <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                Count
                <input
                  className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                  id="generator-output-count"
                  max={maxCount}
                  min={1}
                  name="outputCount"
                  onChange={(event) =>
                    setCount(Math.max(1, Math.min(maxCount, Number(event.target.value))))
                  }
                  type="number"
                  value={outputCount}
                />
              </label>
            )}

            {!imageEditMode && (
              <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                Model
                <select
                  className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                  id="generator-model"
                  name="modelId"
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const nextModel = availableModels.find((item) => item.id === nextId);
                    setModel(nextId);
                    if (nextModel?.orientations?.[0]) {
                      setOrientation((current) =>
                        nextModel.orientations?.includes(current)
                          ? current
                          : (nextModel.orientations?.[0] ?? current),
                      );
                    }
                  }}
                  value={model}
                >
                  {availableModels.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {mode === "image" && !imageEditMode && (config?.presets?.length ?? 0) > 0 && (
              <div className="mt-4 grid gap-3">
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">Presets</p>
                <div className="grid grid-cols-2 gap-2">
                  <PresetSelect
                    label="Mode preset"
                    onChange={setModePresetId}
                    options={presetsOf("mode")}
                    value={modePresetId}
                  />
                  <PresetSelect
                    label="Background"
                    onChange={setBackgroundPresetId}
                    options={presetsOf("background")}
                    value={backgroundPresetId}
                  />
                  <PresetSelect
                    label="Pose"
                    onChange={setPosePresetId}
                    options={presetsOf("pose")}
                    value={posePresetId}
                  />
                  <PresetSelect
                    label="Outfit"
                    onChange={setOutfitPresetId}
                    options={presetsOf("outfit")}
                    value={outfitPresetId}
                  />
                </div>
              </div>
            )}

            {mode === "image" && !imageEditMode && (
              <div className="mt-4 grid gap-3" data-testid="my-presets">
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  My Presets
                </p>
                <div className="flex gap-2">
                  <input
                    aria-label="Preset name"
                    className="h-11 flex-1 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                    id="generator-preset-name"
                    name="presetName"
                    onChange={(event) => setPresetName(event.target.value)}
                    placeholder="Name this preset"
                    value={presetName}
                  />
                  <button
                    className="h-11 shrink-0 rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)] disabled:bg-[rgb(64,64,64)] disabled:text-[rgb(150,150,150)]"
                    disabled={!presetName.trim()}
                    onClick={() => void saveCurrentPreset()}
                    type="button"
                  >
                    Save
                  </button>
                </div>
                {userPresets.length === 0 ? (
                  <p className="text-[12px] font-medium text-[rgb(114,113,112)]">
                    Save your current background, pose, outfit, or prompt to reuse later.
                  </p>
                ) : (
                  <ul className="grid gap-2">
                    {userPresets.map((preset) => {
                      const confirmingDelete = deleteConfirmPresetId === preset.id;
                      return (
                        <li
                          className="flex items-center justify-between gap-2 rounded-[10px] bg-[rgb(36,36,36)] px-3 py-2"
                          data-testid="my-preset-item"
                          key={preset.id}
                        >
                          <span className="min-w-0 truncate text-[13px] font-semibold text-white">
                            {preset.label}
                          </span>
                          <span className="flex shrink-0 flex-wrap justify-end gap-2">
                            <button
                              className="h-8 rounded-full bg-white px-3 text-[11px] font-black text-[rgb(13,13,13)]"
                              onClick={() => applyPreset(preset)}
                              type="button"
                            >
                              Apply
                            </button>
                            <button
                              aria-label={
                                confirmingDelete
                                  ? `Confirm delete preset ${preset.label}`
                                  : `Delete preset ${preset.label}`
                              }
                              className={`h-8 rounded-full text-[11px] font-black ${
                                confirmingDelete
                                  ? "bg-white px-3 text-[rgb(13,13,13)]"
                                  : "grid w-8 place-items-center bg-black/40 text-white"
                              }`}
                              onClick={() => void deletePreset(preset.id)}
                              title={confirmingDelete ? "Confirm delete preset" : "Delete preset"}
                              type="button"
                            >
                              {confirmingDelete ? "Confirm delete" : <Trash2 className="h-4 w-4" />}
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {!imageEditMode && (
              <>
                <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Scene Prompt
                  <textarea
                    aria-label="Prompt"
                    className="mt-2 min-h-24 w-full rounded-[10px] bg-[rgb(36,36,36)] p-4 text-[13px] font-semibold text-white outline-none disabled:text-[rgb(114,113,112)]"
                    disabled={!canUsePrompt}
                    id="generator-prompt"
                    name="prompt"
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder={canUsePrompt ? "Scene, pose, mood" : "Premium control"}
                    value={prompt}
                  />
                </label>

                <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Negative Prompt
                  <input
                    className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none disabled:text-[rgb(114,113,112)]"
                    disabled={!canUsePrompt}
                    id="generator-negative-prompt"
                    name="negativePrompt"
                    onChange={(event) => setNegativePrompt(event.target.value)}
                    placeholder={canUsePrompt ? "Artifacts to avoid" : "Premium control"}
                    value={negativePrompt}
                  />
                </label>
              </>
            )}

            {!imageEditMode && !canUsePrompt && (
              <Link
                className="mt-2 flex items-center justify-between gap-2 rounded-[10px] bg-[rgb(36,36,36)] px-4 py-3 text-[12px] font-semibold text-[rgb(190,190,190)]"
                href={upgradeHref}
              >
                <span>Custom prompt &amp; negative prompt are Premium controls.</span>
                <span className="rounded-full bg-[rgb(255,48,170)] px-3 py-1 text-[11px] font-black text-white">
                  Upgrade
                </span>
              </Link>
            )}

            {insufficientBalance && (
              <Link
                className="mt-3 flex items-center justify-between gap-2 rounded-[10px] border border-[rgb(255,184,112)]/40 bg-[rgb(36,28,18)] px-4 py-3 text-[12px] font-semibold text-[rgb(255,184,112)]"
                data-testid="generator-insufficient-balance"
                href={insufficientBalanceHref}
              >
                <span>
                  {anonymousViewer
                    ? remixFeedItemId
                      ? "Join free to get starter coins for this remix."
                      : "Join free to get starter coins before generating."
                    : `Need ${estimatedCost} coins · you have ${config?.dreamcoins.balance ?? 0}.`}
                </span>
                <span className="rounded-full bg-[rgb(255,48,170)] px-3 py-1 text-[11px] font-black text-white">
                  {anonymousViewer ? "Join Free" : "Get coins"}
                </span>
              </Link>
            )}

            <button
              className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[rgb(255,48,170)] text-[14px] font-black text-white disabled:bg-[rgb(64,64,64)] disabled:text-[rgb(150,150,150)]"
              disabled={!canSubmit}
              type="submit"
            >
              <WandSparkles className="h-4 w-4" />
              {pending ? (imageEditMode ? "Queuing edit..." : "Queuing...") : imageEditMode ? "Create edit" : "Generate"}
            </button>
            {configError && (
              <p
                aria-live="assertive"
                className="mt-4 text-[13px] font-medium text-[rgb(255,184,112)]"
                data-testid="generator-config-error"
                role="alert"
              >
                {configError}
              </p>
            )}
            {status && (
              <p
                aria-live="polite"
                className="mt-4 text-[13px] font-medium text-[rgb(190,190,190)]"
                data-testid="generator-status"
                role="status"
              >
                {status}
              </p>
            )}
          </form>

          <div className="grid gap-5">
            <section
              className={`${view === "jobs" ? "block" : "hidden"} rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:block`}
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-[16px] font-black text-white">Active Jobs</h2>
                <button
                  aria-label="Refresh jobs"
                  className="grid h-9 w-9 place-items-center rounded-full bg-[rgb(36,36,36)] text-white"
                  onClick={() => void refreshJobs()}
                  title="Refresh"
                  type="button"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
              <div className="grid gap-3">
                {jobs.length === 0 && (
                  <div className="rounded-[10px] bg-[rgb(36,36,36)] p-5 text-[13px] font-medium text-[rgb(170,170,170)]">
                    No jobs yet.
                  </div>
                )}
                {jobs.map((job) => (
                  <div
                    className="rounded-[10px] bg-[rgb(36,36,36)] p-4"
                    data-generation-job-id={job.id}
                    data-testid="generator-job-card"
                    key={job.id}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[13px] font-black text-white">
                          {job.mode === "image" ? "Image" : "Video"} x{job.outputCount}
                        </p>
                        <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">
                          {jobStatusLabel(job.status, job.errorCode)}
                        </p>
                      </div>
                      <span className="rounded-full bg-black/30 px-3 py-1 text-[11px] font-bold uppercase text-white">
                        {job.status}
                      </span>
                    </div>
                    {job.status === "failed" && (
                      <div className="mt-3 flex flex-col gap-2">
                        <button
                          className="h-9 w-fit rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]"
                          onClick={() => retryJob(job.id)}
                          type="button"
                        >
                          Retry
                        </button>
                        <p className="text-[12px] font-medium text-[rgb(170,170,170)]">
                          Provider hiccup — your coins were refunded. Retry will reserve the normal
                          cost again.
                        </p>
                      </div>
                    )}
                    {job.status === "blocked" && (
                      <p className="mt-3 text-[12px] font-medium text-[rgb(255,184,112)]">
                        This request was blocked by our content policy and can&apos;t be retried.{" "}
                        <Link className="underline" href="/helpdesk">
                          Get help
                        </Link>
                      </p>
                    )}
                    {job.status === "refunded" && (
                      <p className="mt-3 text-[12px] font-medium text-[rgb(170,170,170)]">
                        Coins for unfinished outputs were refunded to your balance.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section
              className={`${view === "gallery" ? "block" : "hidden"} rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:block`}
            >
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-[16px] font-black text-white">Gallery</h2>
                <div className="flex flex-wrap gap-2">
                  {galleryTabs.map((tab) => (
                    <button
                      className={`h-9 rounded-full px-4 text-[12px] font-bold ${
                        galleryTab === tab
                          ? "bg-white text-[rgb(13,13,13)]"
                          : "bg-[rgb(36,36,36)] text-white"
                      }`}
                      key={tab}
                      onClick={() => switchGallery(tab)}
                      type="button"
                    >
                      {galleryTabLabel(tab)}
                    </button>
                  ))}
                  <button
                    className={`flex h-9 items-center gap-2 rounded-full px-4 text-[12px] font-bold ${
                      manageMode ? "bg-white text-[rgb(13,13,13)]" : "bg-[rgb(36,36,36)] text-white"
                    }`}
                    data-testid="gallery-manage-toggle"
                    disabled={media.length === 0}
                    onClick={toggleManage}
                    type="button"
                  >
                    <ListChecks className="h-4 w-4" />
                    {manageMode ? "Done" : "Manage"}
                  </button>
                </div>
              </div>

              {manageMode && (
                <div
                  className="mb-4 flex flex-wrap items-center gap-2 rounded-[10px] bg-[rgb(36,36,36)] p-3"
                  data-testid="gallery-bulk-toolbar"
                >
                  <button
                    className="flex h-9 items-center gap-2 rounded-full bg-black/40 px-4 text-[12px] font-bold text-white"
                    onClick={toggleSelectAll}
                    type="button"
                  >
                    {media.length > 0 && selectedMediaIds.size === media.length ? (
                      <CheckSquare className="h-4 w-4" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                    Select all
                  </button>
                  <span className="text-[12px] font-semibold text-[rgb(170,170,170)]">
                    {selectedMediaIds.size} selected
                  </span>
                  <span className="ml-auto flex gap-2">
                    <button
                      className="flex h-9 items-center gap-2 rounded-full bg-black/40 px-4 text-[12px] font-bold text-white disabled:opacity-50"
                      disabled={selectedMediaIds.size === 0}
                      onClick={() => void runBulkMedia("visibility", "private")}
                      type="button"
                    >
                      <EyeOff className="h-4 w-4" />
                      Make private
                    </button>
                    <button
                      aria-label={bulkDeleteArmed ? "Confirm delete selected" : "Delete selected"}
                      className="flex h-9 items-center gap-2 rounded-full bg-[rgb(255,48,170)] px-4 text-[12px] font-black text-white disabled:bg-[rgb(64,64,64)] disabled:text-[rgb(150,150,150)]"
                      disabled={selectedMediaIds.size === 0}
                      onClick={() => void runBulkMedia("delete")}
                      type="button"
                    >
                      <Trash2 className="h-4 w-4" />
                      {bulkDeleteArmed ? "Confirm delete selected" : "Delete selected"}
                    </button>
                  </span>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {media.map((item, index) => {
                  const source = item.thumbnailUrl ?? item.url;
                  const isUnavailable =
                    failedMediaIds.has(item.id) ||
                    invalidPreviewMediaIds.has(item.id) ||
                    isUnusableImagePreview(item) ||
                    isBuiltInMediaPlaceholderUrl(source);
                  const isSelected = selectedMediaIds.has(item.id);
                  return (
                    <div
                      className={`group relative aspect-[4/5] overflow-hidden rounded-[10px] bg-[rgb(36,36,36)] ${
                        manageMode && isSelected ? "ring-2 ring-[rgb(255,48,170)]" : ""
                      }`}
                      data-media-id={item.id}
                      data-testid="gallery-media-card"
                      key={item.id}
                    >
                      {isUnavailable ? (
                        <div
                          className="grid h-full place-items-center px-4 text-center text-[13px] font-semibold text-[rgb(170,170,170)]"
                          data-testid="gallery-media-unavailable"
                        >
                          <div
                            className="flex flex-col items-center gap-2"
                            data-testid="gallery-media-preview-fallback"
                          >
                            <ImageIcon className="h-5 w-5" />
                            Preview unavailable
                          </div>
                        </div>
                      ) : (
                        <MediaPreview
                          item={item}
                          loading={index < 3 ? "eager" : "lazy"}
                          onError={() =>
                            setFailedMediaIds((current) => {
                              if (current.has(item.id)) return current;
                              const next = new Set(current);
                              next.add(item.id);
                              return next;
                            })
                          }
                          onInvalidPreview={() =>
                            setInvalidPreviewMediaIds((current) => {
                              if (current.has(item.id)) return current;
                              const next = new Set(current);
                              next.add(item.id);
                              return next;
                            })
                          }
                          source={source}
                        />
                      )}
                      {manageMode ? (
                        <button
                          aria-label={isSelected ? "Deselect media" : "Select media"}
                          aria-pressed={isSelected}
                          className="absolute inset-0 grid place-items-start p-2"
                          data-testid="gallery-media-select"
                          onClick={() => toggleSelect(item.id)}
                          type="button"
                        >
                          <span className="grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white">
                            {isSelected ? (
                              <CheckSquare className="h-4 w-4 text-[rgb(255,48,170)]" />
                            ) : (
                              <Square className="h-4 w-4" />
                            )}
                          </span>
                        </button>
                      ) : (
                        <>
                          {item.type === "image" && (
                            <div className="absolute left-2 top-2 flex gap-2 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
                              {canEditIdentityForMedia(item) && (
                                <>
                                  <IconButton
                                    label="Use as character image"
                                    onClick={() =>
                                      void runIdentityMediaAction(item, "use-as-character-image")
                                    }
                                  >
                                    <ImageIcon className="h-4 w-4" />
                                  </IconButton>
                                  <IconButton
                                    label="Add to identity"
                                    onClick={() =>
                                      void runIdentityMediaAction(item, "add-to-identity")
                                    }
                                  >
                                    <ListChecks className="h-4 w-4" />
                                  </IconButton>
                                </>
                              )}
                              <IconButton
                                label="Create variation"
                                onClick={() => void createMediaVariation(item)}
                              >
                                <WandSparkles className="h-4 w-4" />
                              </IconButton>
                            </div>
                          )}
                          {item.type === "image" &&
                            (item.identity?.selectedAsCharacterImage || item.identity?.addedToReferences) && (
                              <div className="absolute left-2 top-12 rounded-full bg-black/70 px-2 py-1 text-[10px] font-black uppercase text-white">
                                {item.identity.selectedAsCharacterImage ? "Character image" : "Identity ref"}
                              </div>
                            )}
                          {item.provenance && (
                            <GalleryProvenanceBadge provenance={item.provenance} />
                          )}
                          <div className="absolute inset-x-2 bottom-2 flex justify-end gap-2 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
                            <IconButton
                              label={item.liked ? "Unlike" : "Like"}
                              onClick={() => toggleLike(item)}
                            >
                              <Heart
                                className={`h-4 w-4 ${
                                  item.liked ? "fill-current text-[rgb(255,48,170)]" : ""
                                }`}
                              />
                            </IconButton>
                            <IconButton label="Download" onClick={() => downloadMedia(item.id)}>
                              <Download className="h-4 w-4" />
                            </IconButton>
                            <IconButton label="Report" onClick={() => reportMedia(item.id)}>
                              <Flag className="h-4 w-4" />
                            </IconButton>
                            <button
                              aria-label={
                                deleteConfirmMediaId === item.id ? "Confirm delete media" : "Delete"
                              }
                              className={
                                deleteConfirmMediaId === item.id
                                  ? "inline-flex h-9 items-center justify-center rounded-full bg-[rgb(170,20,45)] px-3 text-[12px] font-bold text-white"
                                  : "grid h-9 w-9 place-items-center rounded-full bg-black/70 text-white"
                              }
                              onClick={() => deleteMedia(item.id)}
                              title={
                                deleteConfirmMediaId === item.id ? "Confirm delete media" : "Delete"
                              }
                              type="button"
                            >
                              {deleteConfirmMediaId === item.id ? (
                                "Confirm delete"
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
                {media.length === 0 && (
                  <div className="col-span-full grid min-h-40 place-items-center rounded-[10px] bg-[rgb(36,36,36)] text-[13px] font-medium text-[rgb(170,170,170)]">
                    <div className="flex items-center gap-2">
                      <ImageIcon className="h-4 w-4" />
                      No media yet.
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}

function GalleryProvenanceBadge({
  provenance,
}: {
  provenance: NonNullable<MediaItem["provenance"]>;
}) {
  const label = provenance.sourceCharacterName
    ? `${provenance.label}: ${provenance.sourceCharacterName}`
    : provenance.label;
  const className =
    "absolute bottom-12 left-2 z-10 inline-flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full bg-black/75 px-2 py-1 text-[10px] font-bold text-white shadow-sm backdrop-blur";
  const content = (
    <>
      <WandSparkles className="h-3 w-3 shrink-0 text-[rgb(255,48,170)]" />
      <span className="truncate">{label}</span>
    </>
  );

  if (provenance.href) {
    return (
      <Link
        className={className}
        data-testid="gallery-provenance-link"
        href={provenance.href}
        prefetch={false}
      >
        {content}
      </Link>
    );
  }

  return (
    <div className={className} data-testid="gallery-provenance-badge">
      {content}
    </div>
  );
}

function galleryTabLabel(tab: GalleryTab) {
  if (tab === "image") return "Images";
  if (tab === "video") return "Videos";
  return "Liked";
}

function PresetSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: PresetConfig[];
  value: string;
  onChange: (value: string) => void;
}) {
  const testId = `preset-select-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const fieldName = testId.replace("preset-select-", "preset-");
  return (
    <label className="block text-[11px] font-bold uppercase text-[rgb(114,113,112)]">
      {label}
      <select
        className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-2 text-[12px] font-semibold text-white outline-none disabled:text-[rgb(114,113,112)]"
        data-testid={testId}
        disabled={options.length === 0}
        id={testId}
        name={fieldName}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">None</option>
        {options.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.scope === "community" ? `Community · ${preset.label}` : preset.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MediaPreview({
  item,
  loading,
  onError,
  onInvalidPreview,
  source,
}: {
  item: MediaItem;
  loading: "eager" | "lazy";
  onError: () => void;
  onInvalidPreview: () => void;
  source: string;
}) {
  if (item.type === "video") {
    return (
      <video
        aria-label="Generated video"
        className="h-full w-full object-cover object-top"
        controls
        data-testid="gallery-media-video"
        playsInline
        preload="none"
      >
        <source src={source} type={item.contentType ?? "video/mp4"} />
        Video playback is not supported.
      </video>
    );
  }

  return (
    <Image
      alt=""
      className="object-cover object-top"
      data-testid="gallery-media-image"
      fill
      loading={loading}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (
          image.naturalWidth <= 1 ||
          image.naturalHeight <= 1 ||
          isBlankImagePreview(image)
        ) {
          onInvalidPreview();
        }
      }}
      onError={onError}
      sizes="(min-width: 1024px) 240px, 45vw"
      src={source}
      unoptimized={isPrivateMediaUrl(source)}
    />
  );
}

function IconButton({
  children,
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="grid h-9 w-9 place-items-center rounded-full bg-black/70 text-white"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

async function fetchCharacterById(id: string) {
  const response = await fetch(`/api/v1/characters/${encodeURIComponent(id)}`);
  if (!response.ok) return null;
  const payload = (await response.json()) as ApiPayload<{ character: CharacterCardData }>;
  return payload.data?.character ?? null;
}

function isTerminal(status: string) {
  return ["completed", "failed", "blocked", "refunded"].includes(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function presetControlString(controls: Record<string, unknown>, key: string): string {
  const value = controls[key];
  return typeof value === "string" ? value : "";
}

function currentPresetControls({
  backgroundPresetId,
  canUsePrompt,
  modePresetId,
  outfitPresetId,
  posePresetId,
  prompt,
}: {
  backgroundPresetId: string;
  canUsePrompt: boolean;
  modePresetId: string;
  outfitPresetId: string;
  posePresetId: string;
  prompt: string;
}) {
  const controls: Record<string, string> = {};
  if (modePresetId) controls.modePresetId = modePresetId;
  if (backgroundPresetId) controls.backgroundPresetId = backgroundPresetId;
  if (posePresetId) controls.posePresetId = posePresetId;
  if (outfitPresetId) controls.outfitPresetId = outfitPresetId;
  if (canUsePrompt && prompt.trim()) controls.prompt = prompt.trim();
  return controls;
}

function savePresetDraft(draft: PresetDraft) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(generatorPresetDraftStorageKey, JSON.stringify(draft));
}

function clearPresetDraft() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(generatorPresetDraftStorageKey);
}

function readPresetDraft(): PresetDraft | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(generatorPresetDraftStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      clearPresetDraft();
      return null;
    }
    const draft: PresetDraft = {
      backgroundPresetId: presetControlString(parsed, "backgroundPresetId"),
      label: presetControlString(parsed, "label"),
      modePresetId: presetControlString(parsed, "modePresetId"),
      outfitPresetId: presetControlString(parsed, "outfitPresetId"),
      posePresetId: presetControlString(parsed, "posePresetId"),
      prompt: presetControlString(parsed, "prompt"),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
    if (!draft.label) {
      clearPresetDraft();
      return null;
    }
    return draft;
  } catch {
    clearPresetDraft();
    return null;
  }
}

function openDownloadWindow() {
  const target = window.open("about:blank", "_blank");
  if (target) target.opener = null;
  return target;
}

function navigateDownloadWindow(target: Window | null, url: string) {
  if (target) {
    target.location.href = url;
    return;
  }
  window.location.href = url;
}

function upgradeHrefForTarget(target: string) {
  return `/upgrade?returnTo=${encodeURIComponent(target || "/generate")}`;
}

function isPrivateMediaUrl(url: string) {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}

function isBuiltInMediaPlaceholderUrl(url: string) {
  const lower = url.toLowerCase();
  return (
    lower.includes("/images/ourdream/card-sarah-mercer.webp") ||
    lower.includes("%2fimages%2fourdream%2fcard-sarah-mercer.webp")
  );
}

function isUnusableImagePreview(item: MediaItem) {
  if (item.type !== "image") return false;
  if (item.width == null || item.height == null) return false;
  return item.width <= 1 || item.height <= 1;
}

function isBlankImagePreview(image: HTMLImageElement) {
  const width = Math.min(16, image.naturalWidth);
  const height = Math.min(16, image.naturalHeight);
  if (width <= 0 || height <= 0) return false;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;

    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    let min = 255;
    let max = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
    }

    const range = max - min;
    return range <= 1 || (range <= 4 && (min >= 250 || max <= 5));
  } catch {
    return false;
  }
}

function generationConfigErrorMessage(status: number) {
  if (status === 401) return "Sign in to use generation controls.";
  if (status === 403) return "Complete age checks before using generation controls.";
  return "Generation controls could not load. Refresh and try again.";
}

function jobStatusLabel(status: string, errorCode: string | null) {
  if (status === "queued") return "Queued";
  if (status === "moderating_input") return "Checking prompt";
  if (status === "running") return "Generating";
  if (status === "moderating_output") return "Checking output";
  if (status === "completed") return "Completed";
  if (status === "blocked") return `Blocked${errorCode ? `: ${errorCode}` : ""}`;
  if (status === "failed") return `Failed${errorCode ? `: ${errorCode}` : ""}`;
  if (status === "refunded") return "Refunded";
  return status;
}

function statusMessage(job: GenerationJob) {
  if (job.status === "blocked") return job.errorCode ? `Blocked: ${job.errorCode}` : "Blocked.";
  if (job.status === "failed") return job.errorCode ? `Failed: ${job.errorCode}` : "Failed.";
  if (job.status === "refunded") return "Refunded.";
  return "Generation stopped.";
}
