"use client";

import Image from "next/image";
import {
  CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT,
  characterImageSourceListResponseSchema,
  characterImageSourceUploadResponseSchema,
  creativeReviewDecisionResultSchema,
  creativeRunCreateRequestSchema,
  creativeRunCreateResultSchema,
  creativeRunDetailSchema,
  creativeRunListResponseSchema,
  type CharacterImageSourceAsset,
  type CharacterVisualProfileCreateRequest,
  type CharacterWorkspaceDetail,
  type CreativeRun,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import { Upload } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { adminV2FormRequest, adminV2Request } from "@/lib/admin-v2-api";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { cn } from "@/lib/utils";

type VisualIdentityExperimentData = Pick<CharacterWorkspaceDetail, "visual"> & {
  character: Pick<CharacterWorkspaceDetail["character"], "id" | "name" | "style" | "imageUrl">;
};

export type ActivateIdentityCandidateInput =
  CharacterVisualProfileCreateRequest;

type ExperimentMode = "text_to_image" | "image_to_image";
type SeedStrategy = "random" | "locked" | "reuse_source";

type SourceOption = {
  readonly id: string;
  readonly label: string;
  readonly provenance: string;
  readonly url: string | null;
  readonly seed: string | null;
};

function uploadedSourceOption(asset: CharacterImageSourceAsset): SourceOption {
  return {
    id: asset.id,
    label: asset.filename,
    provenance: "本地上传",
    url: asset.thumbnailUrl ?? asset.url,
    seed: null,
  };
}

function sourceRoleLabel(
  role: CharacterWorkspaceDetail["visual"]["anchors"][number]["role"],
) {
  if (role === "primary_face") return "主角色肖像";
  if (role === "identity_anchor") return "身份锚点";
  return "身份参考图";
}

function randomSeed() {
  return String(Math.floor(Math.random() * 2_147_483_647));
}

function runSettled(run: CreativeRunDetail) {
  return run.items.every((item) =>
    item.executionState === "ready" || item.executionState === "failed"
  );
}

function itemImage(item: CreativeRunDetail["items"][number] | undefined) {
  return item?.asset?.thumbnailUrl ?? item?.asset?.url ?? null;
}

function modeLabel(mode: ExperimentMode) {
  return mode === "text_to_image" ? "文生图" : "图生图";
}

function seedStrategyLabel(strategy: SeedStrategy) {
  if (strategy === "locked") return "锁定种子";
  if (strategy === "reuse_source") return "沿用所选图";
  return "每轮随机";
}

function generationModelLabel(modelId: string) {
  if (modelId === "redcraft-krea2-comfyui") return "RedCraft Krea2";
  if (modelId === "qwen-image-edit") return "Qwen Image Edit";
  if (modelId === "darkbeast-flux2-klein-9b-bfs") {
    return "Dark Beast FLUX.2 Klein 9B";
  }
  return modelId;
}

function generationProfileLabel(label: string) {
  if (label === "Default image") return "默认图片";
  if (label === "Premium image") return "高级图片";
  return label;
}

function identityTraitLines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((trait) => trait.trim())
    .filter(Boolean);
}

export function VisualIdentityExperimentWorkbench({
  data,
  canCreate,
  canUploadSource,
  canReview,
  canActivate,
  onActivateCandidate,
}: {
  data: VisualIdentityExperimentData;
  canCreate: boolean;
  canUploadSource: boolean;
  canReview: boolean;
  canActivate: boolean;
  onActivateCandidate?: (
    input: ActivateIdentityCandidateInput,
  ) => Promise<void>;
}) {
  const identity = data.visual.activeIdentity;
  const calibration = data.visual.identityCalibration ?? {
    profiles: [],
    blocker: "当前响应尚未提供视觉身份实验线路。",
  };
  const profiles = calibration.profiles;
  const [mode, setMode] = useState<ExperimentMode>("text_to_image");
  const compatibleProfiles = useMemo(
    () => profiles.filter((profile) => profile.modes.includes(mode)),
    [mode, profiles],
  );
  const preferredProfile =
    compatibleProfiles.find((profile) => profile.recommended) ??
    compatibleProfiles[0] ??
    null;
  const [profileKey, setProfileKey] = useState(preferredProfile?.profileKey ?? "");
  const selectedProfile =
    compatibleProfiles.find((profile) => profile.profileKey === profileKey) ??
    preferredProfile;
  const modelOptions = useMemo(
    () => [...new Set(compatibleProfiles.map((profile) => profile.modelId))],
    [compatibleProfiles],
  );
  const selectedModelId =
    selectedProfile?.modelId ?? modelOptions[0] ?? "";
  const selectedModelProfiles = compatibleProfiles.filter(
    (profile) => profile.modelId === selectedModelId,
  );
  const selectedProfileIsDefault =
    selectedProfile?.profileKey === preferredProfile?.profileKey;
  const [orientation, setOrientation] = useState(
    selectedProfile?.orientation ?? "4:5",
  );
  const [positivePrompt, setPositivePrompt] = useState(
    identity?.identityPrompt ??
      "Definitive portrait of this adult character, natural expression, coherent face, polished editorial photography.",
  );
  const [negativePrompt, setNegativePrompt] = useState(
    identity?.negativeIdentityPrompt ??
      "different person, inconsistent face, duplicate person, extra limbs, text, watermark",
  );
  const [seedStrategy, setSeedStrategy] = useState<SeedStrategy>("random");
  const [baseSeed, setBaseSeed] = useState(
    identity?.defaultSeed ?? randomSeed(),
  );
  const count = 1;
  const [consistencyMode, setConsistencyMode] = useState<
    "strict" | "balanced" | "creative"
  >("balanced");
  const [strength, setStrength] = useState(0.65);
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(null);
  const [uploadedSources, setUploadedSources] = useState<SourceOption[]>([]);
  const [sourceUploadBusy, setSourceUploadBusy] = useState(false);
  const [pendingSource, setPendingSource] = useState<{
    filename: string;
    url: string | null;
  } | null>(null);
  const [runs, setRuns] = useState<CreativeRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<CreativeRunDetail | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"generate" | "review" | "activate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidateQualityConfirmed, setCandidateQualityConfirmed] =
    useState(false);
  const [activationOpen, setActivationOpen] = useState(false);
  const [activationPrompt, setActivationPrompt] = useState(
    `${data.character.name}. ${CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT}.`,
  );
  const [activationFaceTraits, setActivationFaceTraits] = useState("");
  const [activationHairTraits, setActivationHairTraits] = useState("");
  const [activationBodyTraits, setActivationBodyTraits] = useState("");
  const [activationSignatureTraits, setActivationSignatureTraits] =
    useState("");
  const [activationReason, setActivationReason] = useState("");
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const idempotencyKeys = useRef(new Map<string, string>());
  const sourceFileInput = useRef<HTMLInputElement>(null);
  const resolvedOrientation =
    selectedProfile?.allowedOrientations.includes(orientation)
      ? orientation
      : selectedProfile?.orientation ?? orientation;

  const loadRun = useCallback(async (runId: string) => {
    setCandidateQualityConfirmed(false);
    const detail = await adminV2Request(
      `/api/v2/admin/creative/runs/${encodeURIComponent(runId)}`,
      { schema: creativeRunDetailSchema },
    );
    setSelectedRun(detail);
    setSelectedItemId((current) =>
      detail.items.some((item) => item.id === current)
        ? current
        : detail.items.find((item) => item.asset)?.id ??
          detail.items[0]?.id ??
          null
    );
    return detail;
  }, [setCandidateQualityConfirmed, setSelectedItemId]);

  const loadRuns = useCallback(async () => {
    const response = await adminV2Request(
      `/api/v2/admin/creative/runs?targetType=character&targetId=${encodeURIComponent(data.character.id)}&sort=updated_desc&limit=30`,
      { schema: creativeRunListResponseSchema },
    );
    const experiments = response.items.filter(
      (run) => run.purpose === "identity_calibration",
    );
    setRuns(experiments);
    return experiments;
  }, [data.character.id]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void loadRuns()
        .then(async (experiments) => {
          if (!active || experiments.length === 0) return;
          const detail = await adminV2Request(
            `/api/v2/admin/creative/runs/${encodeURIComponent(experiments[0]!.id)}`,
            { schema: creativeRunDetailSchema },
          );
          if (!active) return;
          setSelectedRun(detail);
          setSelectedItemId(
            detail.items.find((item) => item.asset)?.id ??
              detail.items[0]?.id ??
              null,
          );
        })
        .catch((cause) => {
          if (active) {
            setError(
              cause instanceof Error ? cause.message : "无法读取视觉实验历史",
            );
          }
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loadRuns]);

  useEffect(() => {
    let active = true;
    void adminV2Request(
      `/api/v2/admin/characters/${encodeURIComponent(data.character.id)}/image-sources`,
      { schema: characterImageSourceListResponseSchema },
    )
      .then((response) => {
        if (active) {
          setUploadedSources(response.items.map(uploadedSourceOption));
        }
      })
      .catch((cause) => {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : "无法读取最近上传的本地参考图",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [data.character.id]);

  useEffect(() => {
    if (!selectedRun || runSettled(selectedRun)) return;
    const timer = window.setTimeout(() => {
      void loadRun(selectedRun.id).catch((cause) => {
        setError(cause instanceof Error ? cause.message : "无法刷新生成结果");
      });
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [loadRun, selectedRun]);

  const selectedItem =
    selectedRun?.items.find((item) => item.id === selectedItemId) ??
    selectedRun?.items[0];
  const automaticComposition =
    selectedItem?.asset?.automaticComposition ?? null;
  const systemSingleFramePassed =
    automaticComposition?.evaluatorVersion ===
      "generated-image-sanity-v2" &&
    automaticComposition.status === "passed";
  const settledReadyCount =
    selectedRun && runSettled(selectedRun)
      ? selectedRun.items.filter((item) => item.asset).length
      : null;
  const displayedNotice =
    notice?.startsWith("本轮参数已冻结") && settledReadyCount !== null
      ? settledReadyCount > 0
        ? `本轮已完成 ${settledReadyCount} 张候选图；参数与实际种子已冻结，当前视觉身份未改动。`
        : "本轮未产出可用候选图；参数快照仍已保留，可修改后重试。"
      : notice;
  const experiment = selectedRun?.reviewContext.experiment ?? null;
  const baselineUrl =
    data.character.imageUrl ??
    data.visual.anchors.find((asset) => asset.available)?.url ??
    data.visual.activeReferenceSet?.references.find((asset) => asset.available)
      ?.url ??
    null;
  const visualSources = useMemo<SourceOption[]>(() => {
    const byId = new Map<string, SourceOption>();
    for (const source of uploadedSources) {
      byId.set(source.id, source);
    }
    const addAssets = (
      assets: CharacterWorkspaceDetail["visual"]["anchors"],
      provenance: string,
    ) => {
      for (const asset of assets) {
        if (!asset.available || byId.has(asset.mediaAssetId)) continue;
        byId.set(asset.mediaAssetId, {
          id: asset.mediaAssetId,
          label: sourceRoleLabel(asset.role),
          provenance,
          url: asset.thumbnailUrl ?? asset.url,
          seed: null,
        });
      }
    };
    if (data.visual.activeReferenceSet) {
      addAssets(
        data.visual.activeReferenceSet.references,
        `正式参考集 R${data.visual.activeReferenceSet.revision}`,
      );
    }
    addAssets(data.visual.anchors, "视觉身份");
    addAssets(data.visual.references, "可用参考图");
    for (const item of selectedRun?.items ?? []) {
      if (!item.asset || byId.has(item.asset.id)) continue;
      byId.set(item.asset.id, {
        id: item.asset.id,
        label: `实验候选 ${(item.ordinal ?? 0) + 1}`,
        provenance: "最近实验",
        url: item.asset.thumbnailUrl ?? item.asset.url,
        seed: item.lineage.seed ?? null,
      });
    }
    return [...byId.values()];
  }, [
    data.visual.activeReferenceSet,
    data.visual.anchors,
    data.visual.references,
    uploadedSources,
    selectedRun?.items,
  ]);
  const resolvedSourceAssetId =
    sourceAssetId &&
    visualSources.some((source) => source.id === sourceAssetId)
      ? sourceAssetId
      : visualSources[0]?.id ?? null;
  const selectedSource =
    visualSources.find((source) => source.id === resolvedSourceAssetId) ?? null;
  const resolvedSeedStrategy =
    seedStrategy === "reuse_source" && !selectedSource?.seed
      ? "random"
      : seedStrategy;

  const uploadSource = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file || sourceUploadBusy || !canUploadSource) return;
    event.target.value = "";
    if (file.size > 15 * 1024 * 1024) {
      setError("图片不能超过 15 MB");
      return;
    }
    if (
      file.type &&
      !["image/jpeg", "image/png", "image/webp"].includes(file.type)
    ) {
      setError("请选择 JPG、PNG 或 WebP 图片");
      return;
    }

    const previewUrl =
      typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : null;
    setPendingSource({ filename: file.name, url: previewUrl });
    setSourceUploadBusy(true);
    setError(null);
    setNotice(null);
    const form = new FormData();
    form.set("purpose", "identity_experiment_source");
    form.set("image", file, file.name);
    try {
      const result = await adminV2FormRequest(
        `/api/v2/admin/characters/${encodeURIComponent(data.character.id)}/image-sources`,
        {
          form,
          idempotencyKey: crypto.randomUUID(),
          schema: characterImageSourceUploadResponseSchema,
        },
      );
      const uploaded = uploadedSourceOption(result.asset);
      setUploadedSources((current) => [
        uploaded,
        ...current.filter((source) => source.id !== uploaded.id),
      ]);
      setSourceAssetId(uploaded.id);
      if (seedStrategy === "reuse_source") setSeedStrategy("random");
      setNotice(
        result.replayed
          ? "已恢复这张本地参考图，并设为本轮图生图来源。"
          : "本地图片已上传并设为本轮来源；正式参考集未改变。",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "本地图片上传失败");
    } finally {
      if (previewUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(previewUrl);
      }
      setPendingSource(null);
      setSourceUploadBusy(false);
    }
  };

  const generate = async () => {
    if (!selectedProfile) return;
    const payload = {
      title: `${data.character.id} · visual identity calibration`,
      purpose: "identity_calibration" as const,
      targetType: "character" as const,
      targetId: data.character.id,
      profileId: selectedProfile.profileKey,
      presetIds: [],
      referenceAssetIds: [],
      bootstrapIdentity: false,
      orientation: resolvedOrientation,
      count,
      brief: positivePrompt.trim(),
      identityExperiment: {
        mode,
        negativePrompt: negativePrompt.trim(),
        seedStrategy: resolvedSeedStrategy,
        baseSeed: baseSeed.trim() || undefined,
        sourceAssetId:
          mode === "image_to_image"
            ? resolvedSourceAssetId ?? undefined
            : undefined,
        strength,
      },
      consistencyMode,
      priority: "normal" as const,
      reason: "Create a reversible visual identity calibration experiment",
    };
    const parsed = creativeRunCreateRequestSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "实验参数不完整");
      return;
    }
    const signature = JSON.stringify(parsed.data);
    const idempotencyKey =
      idempotencyKeys.current.get(signature) ?? crypto.randomUUID();
    idempotencyKeys.current.set(signature, idempotencyKey);
    setBusy("generate");
    setError(null);
    setNotice(null);
    try {
      const result = await adminV2Request("/api/v2/admin/creative/runs", {
        method: "POST",
        idempotencyKey,
        schema: creativeRunCreateResultSchema,
        body: parsed.data,
      });
      idempotencyKeys.current.delete(signature);
      const detail = await loadRun(result.batch.id);
      await loadRuns();
      setNotice("本轮参数已冻结，正在生成候选图；当前视觉身份不会被改动。");
      if (resolvedSeedStrategy === "random" && !result.replayed) {
        setBaseSeed(randomSeed());
      }
      return detail;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建视觉身份实验");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const continueFromSelected = () => {
    if (!selectedItem?.asset) return;
    setMode("image_to_image");
    setSourceAssetId(selectedItem.asset.id);
    setSeedStrategy(selectedItem.lineage.seed ? "reuse_source" : "random");
    if (experiment) {
      setPositivePrompt(experiment.positivePrompt);
      setNegativePrompt(experiment.negativePrompt);
      setStrength(experiment.strength);
    }
    setNotice("已把所选候选图设为下一轮图生图来源；请继续修改提示词后再生成。");
    window.requestAnimationFrame(() => {
      document.getElementById("identity-experiment-composer")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const reuseRunParameters = () => {
    if (!experiment) return;
    setMode(experiment.mode);
    setPositivePrompt(experiment.positivePrompt);
    setNegativePrompt(experiment.negativePrompt);
    setSeedStrategy(experiment.seedStrategy);
    setBaseSeed(experiment.baseSeed ?? randomSeed());
    setStrength(experiment.strength);
    setSourceAssetId(experiment.sourceAssetId);
    if (selectedRun?.reviewContext.orientation) {
      setOrientation(selectedRun.reviewContext.orientation);
    }
    setNotice("已载入这一轮的参数快照；修改后可创建新一轮。");
  };

  const submitCandidate = async () => {
    if (
      !selectedRun ||
      !selectedItem?.asset ||
      !systemSingleFramePassed ||
      !candidateQualityConfirmed
    ) return;
    const body = {
      entityVersion: selectedRun.version,
      ...(selectedItem.review
        ? { supersedesDecisionId: selectedItem.review.id }
        : {}),
      decision: "approved" as const,
      identityConsistency: "unscored" as const,
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "已确认候选图为单人单画面并符合视觉身份要求",
    };
    const signature = `${selectedRun.id}:${selectedItem.id}:${JSON.stringify(body)}`;
    const idempotencyKey =
      idempotencyKeys.current.get(signature) ?? crypto.randomUUID();
    idempotencyKeys.current.set(signature, idempotencyKey);
    setBusy("review");
    setError(null);
    try {
      await adminV2Request(
        `/api/v2/admin/creative/runs/${selectedRun.id}/items/${selectedItem.id}/decisions`,
        {
          method: "POST",
          idempotencyKey,
          schema: creativeReviewDecisionResultSchema,
          body,
        },
      );
      idempotencyKeys.current.delete(signature);
      await loadRun(selectedRun.id);
      await loadRuns();
      setCandidateQualityConfirmed(false);
      setActivationOpen(true);
      setNotice("已采用这张候选图；请完成身份信息并激活新的视觉身份版本。");
      window.requestAnimationFrame(() => {
        document.getElementById("identity-candidate-activation")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "候选身份采用失败");
    } finally {
      setBusy(null);
    }
  };

  const activateCandidate = async () => {
    if (
      !selectedRun ||
      !selectedItem?.asset ||
      !selectedItem.review ||
      !systemSingleFramePassed ||
      !selectedApproved ||
      !onActivateCandidate ||
      !activationConfirmed
    ) return;
    setBusy("activate");
    setError(null);
    try {
      await onActivateCandidate({
        identityPrompt: activationPrompt.trim(),
        faceTraits: {
          canonicalPortraitAuthority: true,
          stableTraits: identityTraitLines(activationFaceTraits),
        },
        hairTraits: {
          stableTraits: identityTraitLines(activationHairTraits),
        },
        bodyTraits: {
          stableTraits: identityTraitLines(activationBodyTraits),
        },
        signatureTraits: {
          stableTraits: identityTraitLines(activationSignatureTraits),
        },
        reason: activationReason.trim(),
        confirmation: `${data.character.id}:visual-profile`,
        candidateAuthority: {
          runId: selectedRun.id,
          itemId: selectedItem.id,
          assetId: selectedItem.asset.id,
          reviewDecisionId: selectedItem.review.id,
        },
      });
      setActivationOpen(false);
      setActivationConfirmed(false);
      setActivationReason("");
      setNotice(
        "已激活新的不可变视觉身份和 Reference Set；旧身份保留为历史版本，线上图片未自动替换。",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "候选身份激活失败");
    } finally {
      setBusy(null);
    }
  };

  const canGenerate =
    canCreate &&
    !sourceUploadBusy &&
    selectedProfile !== null &&
    positivePrompt.trim().length > 0 &&
    (
      mode === "text_to_image" ||
      (
        resolvedSourceAssetId !== null &&
        (
          resolvedSeedStrategy !== "reuse_source" ||
          selectedSource?.seed !== null
        )
      )
    );
  const selectedApproved =
    selectedItem?.review?.decision === "approved" &&
    selectedItem.review.identityConsistency === "unscored" &&
    Boolean(
      selectedItem.review.quality &&
      Object.values(selectedItem.review.quality).every(Boolean),
    );
  const selectedIsActiveIdentity = Boolean(
    selectedItem?.asset &&
    identity &&
    data.visual.anchors.some(
      (anchor) => anchor.mediaAssetId === selectedItem.asset?.id,
    ),
  );

  return (
    <section
      aria-labelledby="identity-experiment-title"
      className="overflow-hidden rounded-2xl border border-[var(--ad-border)] bg-[var(--ad-surface)] shadow-[0_18px_45px_rgba(25,26,24,0.06)]"
    >
      <header className="border-b border-[var(--ad-border)] px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ad-text-muted)]">
              可逆实验 · 不影响线上
            </p>
            <h2
              className="mt-2 text-xl font-semibold tracking-[-0.02em]"
              id="identity-experiment-title"
            >
              边生成，边定义视觉身份
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--ad-text-muted)]">
              每轮都会冻结提示词、负向提示词、来源图、强度、线路和种子。只有单独提交并激活后，才会改变正式视觉身份。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge value={identity ? `active v${identity.version}` : "no active identity"} />
            <span className="rounded-full bg-[var(--ad-green-bg)] px-3 py-1 text-xs font-semibold text-[var(--ad-green-text)]">
              实验草稿
            </span>
          </div>
        </div>
      </header>

      <div className="grid min-h-[760px] lg:grid-cols-[390px_minmax(0,1fr)]">
        <aside
          className="border-b border-[var(--ad-border)] bg-black/[0.015] p-4 lg:border-b-0 lg:border-r lg:p-5"
          id="identity-experiment-composer"
        >
          <div className="grid grid-cols-2 rounded-lg bg-black/[0.05] p-1" role="tablist" aria-label="生成方式">
            {(["text_to_image", "image_to_image"] as const).map((value) => (
              <button
                aria-selected={mode === value}
                className={cn(
                  "min-h-10 rounded-md px-3 text-sm font-semibold transition",
                  mode === value
                    ? "bg-[var(--ad-surface)] text-[var(--ad-ink)] shadow-sm"
                    : "text-[var(--ad-text-muted)]",
                )}
                key={value}
                onClick={() => setMode(value)}
                role="tab"
                type="button"
              >
                {modeLabel(value)}
              </button>
            ))}
          </div>

          <section
            aria-label={`${modeLabel(mode)}模型选择`}
            className="mt-4 rounded-xl bg-[var(--ad-blue-bg)] p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[var(--ad-blue-text)]">
                  当前{modeLabel(mode)}模型
                </p>
                <p className="mt-1 truncate text-sm font-semibold text-[var(--ad-ink)]">
                  {selectedProfile
                    ? generationModelLabel(selectedProfile.modelId)
                    : "暂无可用模型"}
                </p>
              </div>
              {selectedProfile ? (
                <span className="shrink-0 rounded-full bg-[var(--ad-surface)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ad-blue-text)]">
                  {selectedProfileIsDefault ? "当前默认" : "当前选择"}
                </span>
              ) : null}
            </div>
            {selectedProfile ? (
              <p className="mt-1 break-all font-mono text-[11px] leading-5 text-[var(--ad-blue-text)]">
                {selectedProfile.modelId}
              </p>
            ) : null}
            <label className="mt-3 block text-xs font-semibold text-[var(--ad-blue-text)]">
              模型
              <select
                aria-label={`${modeLabel(mode)}模型`}
                className={`${fieldClass} mt-1`}
                disabled={modelOptions.length < 2}
                onChange={(event) => {
                  const nextProfile = compatibleProfiles.find(
                    (profile) => profile.modelId === event.target.value,
                  );
                  if (nextProfile) {
                    setProfileKey(nextProfile.profileKey);
                    setOrientation(nextProfile.orientation);
                  }
                }}
                value={selectedModelId}
              >
                {modelOptions.map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {generationModelLabel(modelId)}
                    {modelId === preferredProfile?.modelId ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-xs font-semibold text-[var(--ad-blue-text)]">
              配置档位
              <select
                aria-label="配置档位"
                className={`${fieldClass} mt-1`}
                disabled={selectedModelProfiles.length < 2}
                onChange={(event) => {
                  const nextProfile = selectedModelProfiles.find(
                    (profile) => profile.profileKey === event.target.value,
                  );
                  setProfileKey(event.target.value);
                  if (nextProfile) setOrientation(nextProfile.orientation);
                }}
                value={selectedProfile?.profileKey ?? ""}
              >
                {selectedModelProfiles.map((profile) => (
                  <option
                    key={`${profile.profileKey}:${profile.profileVersion}`}
                    value={profile.profileKey}
                  >
                    {generationProfileLabel(profile.label)} · v
                    {profile.profileVersion}
                    {profile.profileKey === preferredProfile?.profileKey
                      ? "（默认）"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-[11px] leading-5 text-[var(--ad-blue-text)]">
              {modelOptions.length > 1
                ? `当前生成方式有 ${modelOptions.length} 个已上线模型可选。`
                : "当前生成方式只有 1 个已上线模型；新模型通过能力检查后会自动出现在这里。"}
              配置档位用于选择同一模型的参数和资源规格。
            </p>
            {selectedProfile ? (
              <p className="mt-2 border-t border-black/10 pt-2 text-[11px] leading-5 text-[var(--ad-blue-text)]">
                工作流 {selectedProfile.workflowKey} v
                {selectedProfile.workflowVersion}；模型、配置档位和工作流会随本轮冻结。
              </p>
            ) : null}
          </section>

          {mode === "image_to_image" ? (
            <fieldset
              aria-describedby="identity-experiment-source-help"
              className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3"
            >
              <legend className="px-1 text-sm font-semibold">
                选择参考图
              </legend>
              <div className="flex items-start justify-between gap-3">
                <p
                  className="text-xs leading-5 text-[var(--ad-text-muted)]"
                  id="identity-experiment-source-help"
                >
                  直接按画面选择本轮来源，不会修改正式参考集。
                </p>
                <span className="shrink-0 text-xs text-[var(--ad-text-muted)]">
                  {visualSources.length} 张可用
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <button
                  className="inline-flex min-h-10 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-3 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!canUploadSource || sourceUploadBusy}
                  onClick={() => sourceFileInput.current?.click()}
                  type="button"
                >
                  <Upload aria-hidden="true" size={14} />
                  {sourceUploadBusy ? "正在上传…" : "上传本地图片"}
                </button>
                <input
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  disabled={!canUploadSource || sourceUploadBusy}
                  onChange={(event) => void uploadSource(event)}
                  ref={sourceFileInput}
                  tabIndex={-1}
                  type="file"
                />
                <span className="text-[11px] leading-5 text-[var(--ad-text-muted)]">
                  JPG、PNG 或 WebP，最大 15 MB
                  {!canUploadSource ? "；当前账号没有上传权限" : ""}
                </span>
              </div>

              {pendingSource || visualSources.length > 0 ? (
                <div className="mt-3 grid max-h-[326px] grid-cols-2 gap-2 overflow-y-auto pr-1">
                  {pendingSource ? (
                    <div
                      aria-live="polite"
                      className="overflow-hidden rounded-lg border border-[var(--ad-ink)] bg-black/[0.02] p-1.5"
                    >
                      <span className="relative block aspect-[4/5] overflow-hidden rounded-md bg-black/[0.06]">
                        {pendingSource.url ? (
                          <Image
                            alt=""
                            className="object-cover opacity-70"
                            fill
                            sizes="150px"
                            src={pendingSource.url}
                            unoptimized
                          />
                        ) : null}
                        <span className="absolute inset-x-2 bottom-2 rounded-md bg-black/75 px-2 py-1 text-center text-[10px] font-semibold text-white">
                          正在上传并校验
                        </span>
                      </span>
                      <span className="mt-2 block truncate text-xs font-semibold">
                        {pendingSource.filename}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-[var(--ad-text-muted)]">
                        上传完成后自动选中
                      </span>
                    </div>
                  ) : null}
                  {visualSources.map((source) => {
                    const selected = source.id === resolvedSourceAssetId;
                    return (
                      <label
                        className={cn(
                          "relative cursor-pointer overflow-hidden rounded-lg border bg-black/[0.02] p-1.5 transition focus-within:ring-2 focus-within:ring-[var(--ad-ink)] focus-within:ring-offset-2 hover:border-[var(--ad-text-muted)]",
                          selected
                            ? "border-[var(--ad-ink)] shadow-[0_0_0_1px_var(--ad-ink)]"
                            : "border-[var(--ad-border)]",
                        )}
                        key={source.id}
                      >
                        <input
                          checked={selected}
                          className="sr-only"
                          name="identity-experiment-source"
                          onChange={() => {
                            setSourceAssetId(source.id);
                            if (seedStrategy === "reuse_source" && !source.seed) {
                              setSeedStrategy("random");
                            }
                          }}
                          type="radio"
                          value={source.id}
                        />
                        <span className="relative block aspect-[4/5] overflow-hidden rounded-md bg-black/[0.06]">
                          {source.url ? (
                            <Image
                              alt=""
                              className="object-cover"
                              fill
                              sizes="150px"
                              src={source.url}
                              unoptimized
                            />
                          ) : (
                            <span className="grid h-full place-items-center px-2 text-center text-xs text-[var(--ad-text-muted)]">
                              暂无预览
                            </span>
                          )}
                          {selected ? (
                            <span
                              aria-hidden="true"
                              className="absolute right-1.5 top-1.5 rounded-full bg-[var(--ad-ink)] px-2 py-1 text-[10px] font-semibold text-white"
                            >
                              已选
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-2 block truncate text-xs font-semibold">
                          {source.label}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-[var(--ad-text-muted)]">
                          {source.provenance}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3">
                  <p className="text-xs leading-5 text-[var(--ad-yellow-text)]">
                    还没有可用参考图。可以直接上传本地图片，或先创建一轮文生图候选。
                  </p>
                  <button
                    className="mt-2 min-h-9 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-xs font-semibold"
                    onClick={() => setMode("text_to_image")}
                    type="button"
                  >
                    先创建文生图候选
                  </button>
                </div>
              )}
            </fieldset>
          ) : null}

          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            正向提示词
            <textarea
              className={`${textAreaClass} mt-1 min-h-32 resize-y`}
              onChange={(event) => setPositivePrompt(event.target.value)}
              value={positivePrompt}
            />
          </label>
          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            负向提示词
            <textarea
              className={`${textAreaClass} mt-1 min-h-24 resize-y`}
              onChange={(event) => setNegativePrompt(event.target.value)}
              value={negativePrompt}
            />
          </label>

          <div className="mt-4 grid grid-cols-[1fr_112px] gap-3">
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              种子策略
              <select
                aria-label="种子策略"
                className={`${fieldClass} mt-1`}
                onChange={(event) =>
                  setSeedStrategy(event.target.value as SeedStrategy)
                }
                value={resolvedSeedStrategy}
              >
                <option value="random">每轮随机</option>
                <option value="locked">锁定种子</option>
                <option
                  disabled={!selectedSource?.seed}
                  value="reuse_source"
                >
                  沿用所选图
                </option>
              </select>
            </label>
            <div className="text-xs font-semibold text-[var(--ad-text-muted)]">
              每次生成
              <p className={`${fieldClass} mt-1 flex items-center`}>1 张</p>
            </div>
          </div>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            基础种子
            <span className="mt-1 flex gap-2">
              <input
                className={fieldClass}
                disabled={resolvedSeedStrategy === "reuse_source"}
                onChange={(event) => setBaseSeed(event.target.value)}
                value={resolvedSeedStrategy === "reuse_source"
                  ? selectedSource?.seed ?? ""
                  : baseSeed}
              />
              <button
                className="shrink-0 rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold disabled:opacity-40"
                disabled={resolvedSeedStrategy === "reuse_source"}
                onClick={() => setBaseSeed(randomSeed())}
                type="button"
              >
                换一个
              </button>
            </span>
          </label>
          <p className="mt-2 text-[11px] leading-5 text-[var(--ad-text-muted)]">
            {resolvedSeedStrategy === "locked"
              ? "跨轮保持相同变体种子，适合只改一个参数做 A/B。"
              : resolvedSeedStrategy === "reuse_source"
                ? "从所选图的生成种子继续，来源关系会写入快照。"
                : "每次创建新轮次；同一轮内仍会派生互不重复的变体种子。"}
          </p>

          <details className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]">
            <summary className="cursor-pointer px-3 py-3 text-sm font-semibold">
              其它生成参数
            </summary>
            <div className="grid gap-3 border-t border-[var(--ad-border)] p-3">
              <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                构图比例
                <select
                  aria-label="构图比例"
                  className={`${fieldClass} mt-1`}
                  onChange={(event) => setOrientation(event.target.value)}
                  value={resolvedOrientation}
                >
                  {(selectedProfile?.allowedOrientations ?? [orientation]).map(
                    (value) => <option key={value}>{value}</option>,
                  )}
                </select>
              </label>
              <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                身份约束
                <select
                  aria-label="身份约束"
                  className={`${fieldClass} mt-1`}
                  onChange={(event) =>
                    setConsistencyMode(
                      event.target.value as typeof consistencyMode,
                    )
                  }
                  value={consistencyMode}
                >
                  <option value="strict">严格</option>
                  <option value="balanced">平衡</option>
                  <option value="creative">创意</option>
                </select>
              </label>
              {mode === "image_to_image" ? (
                <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  变化强度 · {strength.toFixed(2)}
                  <input
                    className="mt-2 w-full accent-[var(--ad-ink)]"
                    max="0.95"
                    min="0.1"
                    onChange={(event) => setStrength(Number(event.target.value))}
                    step="0.05"
                    type="range"
                    value={strength}
                  />
                </label>
              ) : null}
            </div>
          </details>

          {calibration.blocker ? (
            <p className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-xs text-[var(--ad-yellow-text)]">
              {calibration.blocker}
            </p>
          ) : null}
          <button
            className="mt-5 min-h-12 w-full rounded-lg bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canGenerate || busy !== null}
            onClick={() => void generate()}
            type="button"
          >
            {busy === "generate" ? "正在创建实验…" : "生成 1 张候选图"}
          </button>
          <p className="mt-2 text-center text-[11px] leading-5 text-[var(--ad-text-muted)]">
            生成只创建候选，不修改活动身份、Reference Set、资产包或线上图片。
          </p>
        </aside>

        <div className="min-w-0 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
                对照画布
              </p>
              <h3 className="mt-1 text-lg font-semibold">
                活动基准 vs. 所选候选
              </h3>
            </div>
            {selectedRun ? (
              <div className="flex items-center gap-2">
                <StatusBadge value={selectedRun.executionOutcome} />
                <button
                  className="text-xs font-semibold underline"
                  onClick={reuseRunParameters}
                  type="button"
                >
                  载入本轮参数
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <figure className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-black/[0.04]">
              <div className="flex items-center justify-between border-b border-[var(--ad-border)] px-3 py-2 text-xs">
                <strong>活动基准</strong>
                <span className="text-[var(--ad-text-muted)]">
                  {identity ? `v${identity.version}` : "尚未激活"}
                </span>
              </div>
              <div className="relative aspect-[4/5]">
                {baselineUrl ? (
                  <Image
                    alt="当前活动视觉身份基准"
                    className="object-cover"
                    fill
                    sizes="(min-width: 1024px) 32vw, 50vw"
                    src={baselineUrl}
                    unoptimized
                  />
                ) : (
                  <div className="grid h-full place-items-center p-6 text-center text-sm text-[var(--ad-text-muted)]">
                    暂无活动基准；先用文生图探索第一张身份图。
                  </div>
                )}
              </div>
            </figure>

            <figure className="overflow-hidden rounded-xl border border-[var(--ad-ink)] bg-black/[0.04]">
              <div className="flex items-center justify-between border-b border-[var(--ad-border)] px-3 py-2 text-xs">
                <strong>所选候选</strong>
                <span className="text-[var(--ad-text-muted)]">
                  {selectedItem ? `#${selectedItem.ordinal + 1}` : "等待生成"}
                </span>
              </div>
              <div className="relative aspect-[4/5]">
                {itemImage(selectedItem) ? (
                  <Image
                    alt="所选视觉身份候选"
                    className="object-cover"
                    fill
                    sizes="(min-width: 1024px) 32vw, 50vw"
                    src={itemImage(selectedItem)!}
                    unoptimized
                  />
                ) : selectedItem ? (
                  <div className="grid h-full place-items-center p-6 text-center">
                    <div>
                      <StatusBadge value={selectedItem.executionState} />
                      <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
                        {selectedItem.executionState === "failed"
                          ? selectedItem.failure?.operatorGuidance ??
                            "这一张生成失败，可创建新一轮继续尝试。"
                          : "生成完成后会自动出现在这里。"}
                      </p>
                      {selectedItem.failure ? (
                        <p className="mt-2 font-mono text-[10px] text-[var(--ad-text-muted)]">
                          {selectedItem.failure.errorCode}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="grid h-full place-items-center p-6 text-center text-sm text-[var(--ad-text-muted)]">
                    在左侧编辑提示词和种子，然后开始第一轮实验。
                  </div>
                )}
              </div>
            </figure>
          </div>

          {selectedRun ? (
            <>
              <div className="mt-4 flex gap-3 overflow-x-auto pb-2" aria-label="本轮候选图">
                {selectedRun.items.map((item) => (
                  <button
                    aria-pressed={selectedItem?.id === item.id}
                    className={cn(
                      "relative h-24 w-20 shrink-0 overflow-hidden rounded-lg border-2 bg-black/[0.04]",
                      selectedItem?.id === item.id
                        ? "border-[var(--ad-ink)]"
                        : "border-transparent",
                    )}
                    key={item.id}
                    onClick={() => {
                      setCandidateQualityConfirmed(false);
                      setSelectedItemId(item.id);
                      setActivationOpen(false);
                    }}
                    type="button"
                  >
                    {itemImage(item) ? (
                      <Image
                        alt={`候选图 ${item.ordinal + 1}`}
                        className="object-cover"
                        fill
                        sizes="80px"
                        src={itemImage(item)!}
                        unoptimized
                      />
                    ) : (
                      <span className="grid h-full place-items-center px-2 text-[10px] text-[var(--ad-text-muted)]">
                        {item.executionState}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="mt-2 rounded-lg bg-black/[0.035] px-3 py-2 text-xs leading-5 text-[var(--ad-text-muted)]">
                {modeLabel(experiment?.mode ?? "text_to_image")} · 基数{" "}
                {experiment?.baseSeed ?? "由系统派生"} · 变体{" "}
                {(selectedItem?.ordinal ?? 0) + 1}/{selectedRun.items.length} ·{" "}
                {seedStrategyLabel(experiment?.seedStrategy ?? "random")}
                {selectedItem?.lineage.seed
                  ? ` · 实际种子 ${selectedItem.lineage.seed}`
                  : ""}
              </div>
            </>
          ) : null}

          {selectedItem?.asset ? (
            <div
              className={cn(
                "mt-4 rounded-lg border px-3 py-2 text-xs leading-5",
                systemSingleFramePassed
                  ? "border-[var(--ad-green-text)]/30 bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]"
                  : "border-[var(--ad-yellow-text)]/30 bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
              )}
            >
              {systemSingleFramePassed
                ? "系统构图检查已通过：这是一个连续画面，不是拼图、分栏或缩略图合成。"
                : "这张候选缺少新版单画面系统证据，不能采用。请载入本轮参数后重新生成。"}
            </div>
          ) : null}

          {!selectedApproved && selectedItem?.asset && systemSingleFramePassed ? (
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] p-3 text-sm leading-6 text-[var(--ad-text)]">
              <input
                checked={candidateQualityConfirmed}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--ad-ink)]"
                onChange={(event) =>
                  setCandidateQualityConfirmed(event.target.checked)
                }
                type="checkbox"
              />
              <span>
                采用前确认：只有一个人物、一个连续画面（无拼图、分栏或缩略图），无明显瑕疵、无可见文字，并符合本轮身份设计意图。
              </span>
            </label>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            <WorkspaceButton
              disabled={!selectedItem?.asset || busy !== null}
              onClick={continueFromSelected}
            >
              从这张继续调整
            </WorkspaceButton>
            {selectedApproved ? (
              <WorkspaceButton
                disabled={
                  !canActivate ||
                  !onActivateCandidate ||
                  !systemSingleFramePassed ||
                  selectedIsActiveIdentity ||
                  busy !== null
                }
                onClick={() => setActivationOpen((current) => !current)}
                tone="primary"
              >
                {selectedIsActiveIdentity ? "当前活动身份" : "激活为新视觉身份"}
              </WorkspaceButton>
            ) : (
              <WorkspaceButton
                disabled={
                  !canReview ||
                  !selectedItem?.asset ||
                  !systemSingleFramePassed ||
                  !candidateQualityConfirmed ||
                  busy !== null
                }
                onClick={() => void submitCandidate()}
                tone="primary"
              >
                {busy === "review" ? "正在采用…" : "采用这张图并继续"}
              </WorkspaceButton>
            )}
          </div>

          {activationOpen &&
          selectedApproved &&
          systemSingleFramePassed &&
          selectedItem?.asset ? (
            <div
              className="mt-4 scroll-mt-6 rounded-xl border border-[var(--ad-ink)] bg-[var(--ad-surface)] p-4"
              id="identity-candidate-activation"
            >
              <h4 className="text-sm font-semibold">激活新的视觉身份版本</h4>
              <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                候选图将成为新身份的规范肖像和首个 Reference Set。这里填写的是跨场景保持不变的视觉身份，不是剧情、姿势、服装或场景提示词。
              </p>
              <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                身份锁定描述
                <textarea
                  className={`${textAreaClass} mt-1 min-h-24`}
                  onChange={(event) => setActivationPrompt(event.target.value)}
                  value={activationPrompt}
                />
              </label>
              <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                脸部稳定特征（每行一个，必填）
                <textarea
                  className={`${textAreaClass} mt-1 min-h-20`}
                  onChange={(event) => setActivationFaceTraits(event.target.value)}
                  placeholder={"例如：椭圆脸\n蓝灰色杏眼\n窄鼻梁"}
                  value={activationFaceTraits}
                />
              </label>
              <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                头发稳定特征（每行一个，必填）
                <textarea
                  className={`${textAreaClass} mt-1 min-h-20`}
                  onChange={(event) => setActivationHairTraits(event.target.value)}
                  placeholder={"例如：深棕色波浪长发\n中央分缝"}
                  value={activationHairTraits}
                />
              </label>
              <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                身形稳定特征（每行一个，必填）
                <textarea
                  className={`${textAreaClass} mt-1 min-h-20`}
                  onChange={(event) => setActivationBodyTraits(event.target.value)}
                  placeholder={"例如：高挑身形\n肩腰比例"}
                  value={activationBodyTraits}
                />
              </label>
              <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                标志特征（每行一个，可留空）
                <textarea
                  className={`${textAreaClass} mt-1 min-h-20`}
                  onChange={(event) => setActivationSignatureTraits(event.target.value)}
                  placeholder={"例如：左眼下方小痣"}
                  value={activationSignatureTraits}
                />
              </label>
              <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                激活理由
                <input
                  className={`${fieldClass} mt-1`}
                  onChange={(event) => setActivationReason(event.target.value)}
                  value={activationReason}
                />
              </label>
              <label className="mt-3 flex items-start gap-2 text-xs leading-5">
                <input
                  checked={activationConfirmed}
                  className="mt-1"
                  onChange={(event) => setActivationConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  我确认这段文字只描述人物身份；激活会归档旧身份、创建新 Reference Set，并使旧草稿图片失效。
                </span>
              </label>
              <div className="mt-4 flex flex-wrap gap-2">
                <WorkspaceButton
                  disabled={
                    busy !== null ||
                    activationPrompt.trim().length < 10 ||
                    identityTraitLines(activationFaceTraits).length === 0 ||
                    identityTraitLines(activationHairTraits).length === 0 ||
                    identityTraitLines(activationBodyTraits).length === 0 ||
                    activationReason.trim().length < 3 ||
                    !activationConfirmed
                  }
                  onClick={() => void activateCandidate()}
                  tone="primary"
                >
                  {busy === "activate" ? "正在激活…" : "确认激活新身份"}
                </WorkspaceButton>
                <WorkspaceButton
                  disabled={busy !== null}
                  onClick={() => setActivationOpen(false)}
                >
                  取消
                </WorkspaceButton>
              </div>
            </div>
          ) : null}

          {displayedNotice ? (
            <p className="mt-4 rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">
              {displayedNotice}
            </p>
          ) : null}
          {error ? (
            <p className="mt-4 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">
              {error}
            </p>
          ) : null}

          <details className="mt-6 border-t border-[var(--ad-border)] pt-4">
            <summary className="cursor-pointer text-sm font-semibold">
              最近实验轮次 · {runs.length}
            </summary>
            <div className="mt-3 grid gap-2">
              {runs.length === 0 ? (
                <p className="text-sm text-[var(--ad-text-muted)]">
                  尚无视觉身份实验。
                </p>
              ) : runs.map((run, index) => (
                <button
                  className={cn(
                    "flex min-h-12 items-center justify-between gap-3 rounded-lg border px-3 text-left text-xs",
                    selectedRun?.id === run.id
                      ? "border-[var(--ad-ink)] bg-black/[0.035]"
                      : "border-[var(--ad-border)]",
                  )}
                  key={run.id}
                  onClick={() => void loadRun(run.id)}
                  type="button"
                >
                  <span>
                    <strong>第 {runs.length - index} 轮</strong>
                    <span className="mt-0.5 block text-[var(--ad-text-muted)]">
                      {new Date(run.createdAt).toLocaleString("zh-CN")} · {run.counts.total} 张
                    </span>
                  </span>
                  <StatusBadge value={run.executionOutcome} />
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
