"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Download,
  Flag,
  Heart,
  ImageIcon,
  RefreshCw,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { CharacterCardData } from "@/types/ourdream";

type MediaItem = {
  id: string;
  type: "image" | "video";
  url: string;
  thumbnailUrl: string;
  contentType?: string | null;
  prompt: string | null;
  liked: boolean;
};

type GenerationMode = "image" | "video";
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
  category: string | null;
  label: string;
};

type GenerationConfig = {
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

export function GeneratorWorkspace() {
  const [config, setConfig] = useState<GenerationConfig | null>(null);
  const [characters, setCharacters] = useState<CharacterCardData[]>([]);
  const [characterId, setCharacterId] = useState("");
  const [freeplay, setFreeplay] = useState(false);
  const [mode, setMode] = useState<GenerationMode>("image");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [orientation, setOrientation] = useState("4:5");
  const [count, setCount] = useState(1);
  const [model, setModel] = useState("");
  const [backgroundPresetId, setBackgroundPresetId] = useState("");
  const [posePresetId, setPosePresetId] = useState("");
  const [outfitPresetId, setOutfitPresetId] = useState("");
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [galleryTab, setGalleryTab] = useState<GalleryTab>("image");
  const [view, setView] = useState<WorkspaceView>("create");
  const [status, setStatus] = useState("");
  const [configError, setConfigError] = useState("");
  const [pending, setPending] = useState(false);
  const [failedMediaIds, setFailedMediaIds] = useState<Set<string>>(() => new Set());

  const availableModels = useMemo(
    () => (mode === "video" ? (config?.video.models ?? []) : (config?.image.models ?? [])),
    [config, mode],
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
      : Boolean(config?.video.enabled);
  const canUsePrompt = Boolean(config?.entitlements.premium_controls);
  const insufficientBalance =
    Boolean(config) && estimatedCost > (config?.dreamcoins.balance ?? 0);
  const presetsOf = useCallback(
    (type: PresetConfig["type"]) => (config?.presets ?? []).filter((preset) => preset.type === type),
    [config],
  );
  const canSubmit =
    !pending &&
    (freeplay || Boolean(characterId)) &&
    Boolean(config) &&
    modeAvailable &&
    !insufficientBalance;

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
  }, [galleryTab]);

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
      fetch("/api/v1/characters?limit=12")
        .then((response) => response.json())
        .then((payload: ApiPayload<{ items: CharacterCardData[] }>) => {
          const items = payload.data?.items ?? [];
          setCharacters(items);
          if (items.length === 0) {
            setCharacterId("");
            setFreeplay(true);
            return;
          }
          // Chat → Generate deep link (P1-E): preselect the character passed as
          // ?characterId=. Falls back to the first card when absent/unknown.
          const desired = new URLSearchParams(window.location.search).get("characterId");
          const preset = desired && items.some((c) => c.id === desired) ? desired : "";
          if (preset) setFreeplay(false);
          setCharacterId((current) => current || preset || items[0]?.id || "");
        })
        .catch(() => {
          setCharacters([]);
          setCharacterId("");
          setFreeplay(true);
          setStatus((current) => current || "Character catalog unavailable. Freeplay selected.");
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshConfig, refreshJobs, refreshMedia]);

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
    if (!canSubmit) return;
    setPending(true);
    setStatus("");
    try {
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
          outputCount,
          prompt: canUsePrompt && prompt ? prompt : undefined,
          negativePrompt: canUsePrompt && negativePrompt ? negativePrompt : undefined,
          controls: {
            orientation,
            model: selectedModel?.id,
            seconds: mode === "video" ? 4 : undefined,
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
      setView("jobs");
      void refreshConfig();
      void pollGeneration(job.id);
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

  async function likeMedia(id: string) {
    setMedia((current) =>
      current.map((item) => (item.id === id ? { ...item, liked: true } : item)),
    );
    const response = await fetch(`/api/v1/media/${id}/like`, { method: "POST" });
    if (!response.ok) void refreshMedia(galleryTab);
  }

  async function deleteMedia(id: string) {
    setMedia((current) => current.filter((item) => item.id !== id));
    const response = await fetch(`/api/v1/media/${id}`, { method: "DELETE" });
    if (!response.ok) void refreshMedia(galleryTab);
  }

  async function downloadMedia(id: string) {
    const downloadWindow = openDownloadWindow();
    const response = await fetch(`/api/v1/media/${id}/download`);
    if (!response.ok) {
      downloadWindow?.close();
      return;
    }
    const payload = (await response.json()) as ApiPayload<{ url: string }>;
    if (payload.data?.url) {
      navigateDownloadWindow(downloadWindow, payload.data.url);
    } else {
      downloadWindow?.close();
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

  function switchGallery(tab: GalleryTab) {
    setGalleryTab(tab);
    setView("gallery");
    void refreshMedia(tab);
  }

  return (
    <section className="px-4 py-8 md:px-[60px] md:py-12">
      <div className="mx-auto max-w-6xl">
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
                <p className="text-[22px] font-black text-white">
                  {config ? `${config.dreamcoins.balance.toLocaleString()} coins` : "Loading..."}
                </p>
              </div>
              <div className="rounded-full bg-[rgb(36,36,36)] px-3 py-2 text-[12px] font-bold text-white">
                {estimatedCost} coins
              </div>
            </div>

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
                disabled={!config?.video.enabled}
                onClick={() => {
                  const firstVideoModel = config?.video.models[0];
                  setMode("video");
                  setModel(firstVideoModel?.id ?? "");
                  setOrientation(firstVideoModel?.orientations?.[0] ?? "9:16");
                  setCount(1);
                }}
                type="button"
              >
                Video Beta
              </button>
            </div>

            <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
              Character
              <select
                className="mt-2 h-12 w-full rounded-[10px] bg-[rgb(36,36,36)] px-4 text-[13px] font-semibold text-white outline-none"
                disabled={freeplay}
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
                onChange={(event) => setFreeplay(event.target.checked)}
                type="checkbox"
              />
              Freeplay
            </label>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                Orientation
                <select
                  className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
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
                  max={maxCount}
                  min={1}
                  onChange={(event) =>
                    setCount(Math.max(1, Math.min(maxCount, Number(event.target.value))))
                  }
                  disabled={mode === "video"}
                  type="number"
                  value={outputCount}
                />
              </label>
            </div>

            <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
              Model
              <select
                className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
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

            {mode === "image" && (config?.presets?.length ?? 0) > 0 && (
              <div className="mt-4 grid gap-3">
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">Presets</p>
                <div className="grid grid-cols-3 gap-2">
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

            <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
              Prompt
              <textarea
                className="mt-2 min-h-24 w-full rounded-[10px] bg-[rgb(36,36,36)] p-4 text-[13px] font-semibold text-white outline-none disabled:text-[rgb(114,113,112)]"
                disabled={!canUsePrompt}
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
                onChange={(event) => setNegativePrompt(event.target.value)}
                placeholder={canUsePrompt ? "Artifacts to avoid" : "Premium control"}
                value={negativePrompt}
              />
            </label>

            {!canUsePrompt && (
              <Link
                className="mt-2 flex items-center justify-between gap-2 rounded-[10px] bg-[rgb(36,36,36)] px-4 py-3 text-[12px] font-semibold text-[rgb(190,190,190)]"
                href="/upgrade"
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
                href="/upgrade"
              >
                <span>
                  Need {estimatedCost} coins · you have {config?.dreamcoins.balance ?? 0}.
                </span>
                <span className="rounded-full bg-[rgb(255,48,170)] px-3 py-1 text-[11px] font-black text-white">
                  Get coins
                </span>
              </Link>
            )}

            <button
              className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[rgb(255,48,170)] text-[14px] font-black text-white disabled:bg-[rgb(64,64,64)] disabled:text-[rgb(150,150,150)]"
              disabled={!canSubmit}
              type="submit"
            >
              <WandSparkles className="h-4 w-4" />
              {pending ? "Queuing..." : "Generate"}
            </button>
            {configError && (
              <p className="mt-4 text-[13px] font-medium text-[rgb(255,184,112)]">
                {configError}
              </p>
            )}
            {status && (
              <p className="mt-4 text-[13px] font-medium text-[rgb(190,190,190)]">{status}</p>
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
                  <div className="rounded-[10px] bg-[rgb(36,36,36)] p-4" key={job.id}>
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
                          Provider hiccup — your coins were refunded. Retry is free of new charges
                          until it succeeds.
                        </p>
                      </div>
                    )}
                    {job.status === "blocked" && (
                      <p className="mt-3 text-[12px] font-medium text-[rgb(255,184,112)]">
                        This request was blocked by our content policy and can&apos;t be retried.{" "}
                        <Link className="underline" href="/help">
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
                <div className="flex gap-2">
                  {(["image", "video", "liked"] as const).map((tab) => (
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
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {media.map((item) => {
                  const source = item.thumbnailUrl ?? item.url;
                  const isUnavailable =
                    failedMediaIds.has(item.id) || isBuiltInMediaPlaceholderUrl(source);
                  return (
                    <div
                      className="group relative aspect-[4/5] overflow-hidden rounded-[10px] bg-[rgb(36,36,36)]"
                      data-media-id={item.id}
                      data-testid="gallery-media-card"
                      key={item.id}
                    >
                      {isUnavailable ? (
                        <div
                          className="grid h-full place-items-center px-4 text-center text-[13px] font-semibold text-[rgb(170,170,170)]"
                          data-testid="gallery-media-unavailable"
                        >
                          <div className="flex flex-col items-center gap-2">
                            <ImageIcon className="h-5 w-5" />
                            Media unavailable
                          </div>
                        </div>
                      ) : (
                        <MediaPreview
                          item={item}
                          onError={() =>
                            setFailedMediaIds((current) => {
                              if (current.has(item.id)) return current;
                              const next = new Set(current);
                              next.add(item.id);
                              return next;
                            })
                          }
                          source={source}
                        />
                      )}
                      <div className="absolute inset-x-2 bottom-2 flex justify-end gap-2 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
                        <IconButton label="Like" onClick={() => likeMedia(item.id)}>
                          <Heart className="h-4 w-4" />
                        </IconButton>
                        <IconButton label="Download" onClick={() => downloadMedia(item.id)}>
                          <Download className="h-4 w-4" />
                        </IconButton>
                        <IconButton label="Report" onClick={() => reportMedia(item.id)}>
                          <Flag className="h-4 w-4" />
                        </IconButton>
                        <IconButton label="Delete" onClick={() => deleteMedia(item.id)}>
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </div>
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
  return (
    <label className="block text-[11px] font-bold uppercase text-[rgb(114,113,112)]">
      {label}
      <select
        className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-2 text-[12px] font-semibold text-white outline-none disabled:text-[rgb(114,113,112)]"
        disabled={options.length === 0}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">None</option>
        {options.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MediaPreview({
  item,
  onError,
  source,
}: {
  item: MediaItem;
  onError: () => void;
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

function isTerminal(status: string) {
  return ["completed", "failed", "blocked", "refunded"].includes(status);
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
