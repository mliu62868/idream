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
  useAuthorityResource,
  usePollingTask,
  type PollingTask,
} from "@/lib/authority-resource";
import {
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { cn } from "@/lib/utils";

type VisualIdentityExperimentData = Pick<CharacterWorkspaceDetail, "visual"> & {
  character: Pick<
    CharacterWorkspaceDetail["character"],
    "id" | "name" | "style" | "imageUrl"
  >;
};

export type ActivateIdentityCandidateInput =
  CharacterVisualProfileCreateRequest;

type ExperimentMode = "text_to_image" | "image_to_image";
type SeedStrategy = "random" | "locked" | "reuse_source";

// INVARIANT: 常量空数组，避免"资源尚未到达"每次渲染都产生新引用而触发下游重算。
const EMPTY_SOURCE_OPTIONS: SourceOption[] = [];

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
  return run.items.every(
    (item) =>
      item.executionState === "ready" || item.executionState === "failed",
  );
}

function itemImage(item: CreativeRunDetail["items"][number] | undefined) {
  return item?.asset?.thumbnailUrl ?? item?.asset?.url ?? null;
}

function modeLabel(mode: ExperimentMode) {
  return mode === "text_to_image" ? "文生图" : "图生图";
}

function generationModelLabel(modelId: string) {
  if (modelId === "redcraft-krea2-redmix3-fp8") return "RedCraft Krea2";
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
  const [profileKey, setProfileKey] = useState(
    preferredProfile?.profileKey ?? "",
  );
  const selectedProfile =
    compatibleProfiles.find((profile) => profile.profileKey === profileKey) ??
    preferredProfile;
  const modelOptions = useMemo(
    () => [...new Set(compatibleProfiles.map((profile) => profile.modelId))],
    [compatibleProfiles],
  );
  const selectedModelId = selectedProfile?.modelId ?? modelOptions[0] ?? "";
  const selectedModelProfiles = compatibleProfiles.filter(
    (profile) => profile.modelId === selectedModelId,
  );
  const [orientation, setOrientation] = useState(
    selectedProfile?.orientation ?? "4:5",
  );
  const [positivePrompt, setPositivePrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState(
    identity?.negativeIdentityPrompt ??
      "different person, inconsistent face, duplicate person, extra limbs, text, watermark",
  );
  const [seedStrategy, setSeedStrategy] = useState<SeedStrategy>("locked");
  const [baseSeed, setBaseSeed] = useState(
    identity?.defaultSeed ?? randomSeed(),
  );
  const count = 1;
  const [consistencyMode, setConsistencyMode] = useState<
    "strict" | "balanced" | "creative"
  >("balanced");
  const [strength, setStrength] = useState(0.65);
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(null);
  const [sourceUploadBusy, setSourceUploadBusy] = useState(false);
  const [pendingSource, setPendingSource] = useState<{
    filename: string;
    url: string | null;
  } | null>(null);
  const [runs, setRuns] = useState<CreativeRun[]>([]);
  const [runDetails, setRunDetails] = useState<
    Record<string, CreativeRunDetail>
  >({});
  const [historyLoading, setHistoryLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<CreativeRunDetail | null>(
    null,
  );
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [busy, setBusy] = useState<"generate" | "review" | "activate" | null>(
    null,
  );
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
  const resolvedOrientation = selectedProfile?.allowedOrientations.includes(
    orientation,
  )
    ? orientation
    : (selectedProfile?.orientation ?? orientation);

  const loadRun = useCallback(
    async (runId: string) => {
      setCandidateQualityConfirmed(false);
      const detail = await adminV2Request(
        `/api/v2/admin/creative/runs/${encodeURIComponent(runId)}`,
        { schema: creativeRunDetailSchema },
      );
      setRunDetails((current) => ({ ...current, [detail.id]: detail }));
      setSelectedRun(detail);
      setSelectedItemId((current) =>
        detail.items.some((item) => item.id === current)
          ? current
          : (detail.items.find((item) => item.asset)?.id ??
            detail.items[0]?.id ??
            null),
      );
      return detail;
    },
    [setCandidateQualityConfirmed, setSelectedItemId],
  );

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
      setHistoryLoading(true);
      void loadRuns()
        .then(async (experiments) => {
          if (!active || experiments.length === 0) {
            if (active) setRunDetails({});
            return;
          }
          const results = await Promise.allSettled(
            experiments.map((run) =>
              adminV2Request(
                `/api/v2/admin/creative/runs/${encodeURIComponent(run.id)}`,
                { schema: creativeRunDetailSchema },
              ),
            ),
          );
          if (!active) return;
          const details = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          );
          setRunDetails(
            Object.fromEntries(details.map((detail) => [detail.id, detail])),
          );
          const latest = details[0] ?? null;
          setSelectedRun(latest);
          setSelectedItemId(
            latest?.items.find((item) => item.asset)?.id ??
              latest?.items[0]?.id ??
              null,
          );
        })
        .catch((cause) => {
          if (active) {
            setError(
              cause instanceof Error ? cause.message : "无法读取视觉实验历史",
            );
          }
        })
        .finally(() => {
          if (active) setHistoryLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loadRuns]);

  // SPEC: 最近上传的本地参考图是一份独立资源，取数生命周期整个交给 useAuthorityResource。
  const uploadedSourcesResource = useAuthorityResource<SourceOption[]>({
    key: data.character.id,
    load: useCallback(async () => {
      const response = await adminV2Request(
        `/api/v2/admin/characters/${encodeURIComponent(data.character.id)}/image-sources`,
        { schema: characterImageSourceListResponseSchema },
      );
      return response.items.map(uploadedSourceOption);
    }, [data.character.id]),
  });
  const uploadedSources = uploadedSourcesResource.data ?? EMPTY_SOURCE_OPTIONS;

  // SPEC: 未落终态的实验 Run 每 3s 刷新一次，失败退避到 6s。
  // INTENT: 这里原本是一个靠 effect 依赖变化重新武装的伪轮询——刷新失败时 selectedRun
  //         不变，依赖也就不变，轮询会永久停摆。改成显式循环后失败能自己退避重试。
  const pollingRunId = selectedRun && !runSettled(selectedRun)
    ? selectedRun.id
    : null;
  const pollExperimentRun = useCallback<PollingTask>(async () => {
    if (!pollingRunId) return null;
    try {
      await loadRun(pollingRunId);
      return 3_000;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法刷新生成结果");
      return 6_000;
    }
  }, [loadRun, pollingRunId]);
  usePollingTask(pollingRunId ? pollExperimentRun : null, 3_000);

  const selectedItem =
    selectedRun?.items.find((item) => item.id === selectedItemId) ??
    selectedRun?.items[0];
  const automaticComposition =
    selectedItem?.asset?.automaticComposition ?? null;
  const systemSingleFramePassed =
    automaticComposition?.evaluatorVersion === "generated-image-sanity-v2" &&
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
    sourceAssetId && visualSources.some((source) => source.id === sourceAssetId)
      ? sourceAssetId
      : (visualSources[0]?.id ?? null);
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
      uploadedSourcesResource.setData((current) => [
        uploaded,
        ...(current ?? []).filter((source) => source.id !== uploaded.id),
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
            ? (resolvedSourceAssetId ?? undefined)
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
      setResultOpen(true);
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
    setResultOpen(false);
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
    setResultOpen(false);
  };

  const submitCandidate = async () => {
    if (
      !selectedRun ||
      !selectedItem?.asset ||
      !systemSingleFramePassed ||
      !candidateQualityConfirmed
    )
      return;
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
        document
          .getElementById("identity-candidate-activation")
          ?.scrollIntoView({
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
    )
      return;
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
    (mode === "text_to_image" ||
      (resolvedSourceAssetId !== null &&
        (resolvedSeedStrategy !== "reuse_source" ||
          selectedSource?.seed !== null)));
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
    identity.anchorAssetIds.includes(selectedItem.asset.id),
  );
  const historyCandidates = runs.flatMap((run, runIndex) => {
    const detail = runDetails[run.id];
    if (!detail) return [];
    return detail.items
      .filter((item) => item.asset)
      .map((item) => ({
        run,
        runDetail: detail,
        runNumber: runs.length - runIndex,
        item,
      }));
  });
  const historyRunsWithoutImages = runs.flatMap((run, runIndex) => {
    const detail = runDetails[run.id];
    if (!detail || detail.items.some((item) => item.asset)) return [];
    return [{ run, runDetail: detail, runNumber: runs.length - runIndex }];
  });

  return (
    <section aria-labelledby="identity-experiment-title">
      <h2 className="sr-only" id="identity-experiment-title">
        视觉身份
      </h2>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,0.86fr)_minmax(420px,1.14fr)] xl:gap-12">
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xl font-semibold tracking-[-0.02em]">
              当前形象
            </h3>
            <span className="text-xs text-[var(--ad-text-muted)]">
              {identity ? `v${identity.version}` : "尚未激活"}
            </span>
          </div>
          <figure className="mt-4 overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/[0.035]">
            <div className="relative aspect-[3/4]">
              {baselineUrl ? (
                <Image
                  alt="当前活动视觉身份基准"
                  className="object-cover"
                  fill
                  loading="eager"
                  sizes="(min-width: 1024px) 36vw, 100vw"
                  src={baselineUrl}
                  unoptimized
                />
              ) : (
                <div className="grid h-full place-items-center p-6 text-center text-sm text-[var(--ad-text-muted)]">
                  还没有当前形象
                </div>
              )}
            </div>
          </figure>
        </div>

        <aside className="min-w-0 lg:pt-1" id="identity-experiment-composer">
          <h3 className="text-xl font-semibold tracking-[-0.02em]">
            想让 {data.character.name} 变成什么样？
          </h3>
          <label className="mt-4 block">
            <span className="sr-only">描述这次想要的画面</span>
            <textarea
              aria-label="描述这次想要的画面"
              className={`${textAreaClass} min-h-48 resize-y px-4 py-4 text-base leading-7`}
              onChange={(event) => setPositivePrompt(event.target.value)}
              placeholder="例如：让她看起来更成熟一些，换成长发，妆容更精致。"
              value={positivePrompt}
            />
          </label>

          <label className="mt-4 block text-sm font-medium">
            负向提示词
            <input
              aria-label="负向提示词"
              className={`${fieldClass} mt-2`}
              onChange={(event) => setNegativePrompt(event.target.value)}
              value={negativePrompt}
            />
          </label>

          <label className="mt-4 block text-sm font-medium">
            种子
            <span className="mt-2 flex gap-3">
              <input
                aria-label="种子"
                className={`${fieldClass} min-w-0 flex-1`}
                disabled={resolvedSeedStrategy === "reuse_source"}
                onChange={(event) => setBaseSeed(event.target.value)}
                value={
                  resolvedSeedStrategy === "reuse_source"
                    ? (selectedSource?.seed ?? "")
                    : baseSeed
                }
              />
              <button
                className="shrink-0 px-2 text-sm font-medium underline decoration-[var(--ad-border)] underline-offset-4 disabled:opacity-40"
                disabled={resolvedSeedStrategy === "reuse_source"}
                onClick={() => {
                  setSeedStrategy("locked");
                  setBaseSeed(randomSeed());
                }}
                type="button"
              >
                随机
              </button>
            </span>
          </label>

          <input
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            disabled={!canUploadSource || sourceUploadBusy}
            onChange={(event) => void uploadSource(event)}
            ref={sourceFileInput}
            tabIndex={-1}
            type="file"
          />
          {mode === "image_to_image" && (pendingSource || selectedSource) ? (
            <p className="mt-4 truncate text-xs text-[var(--ad-text-muted)]">
              参考图：{pendingSource?.filename ?? selectedSource?.label}
            </p>
          ) : null}

          <div className="mt-5 grid items-center gap-4 sm:grid-cols-[190px_minmax(220px,1fr)]">
            <button
              className="justify-self-start text-sm font-medium underline decoration-[var(--ad-border)] underline-offset-4 disabled:opacity-40"
              disabled={!canUploadSource || sourceUploadBusy}
              onClick={() => {
                setMode("image_to_image");
                window.requestAnimationFrame(() =>
                  sourceFileInput.current?.click(),
                );
              }}
              type="button"
            >
              {sourceUploadBusy ? "正在添加…" : "添加参考图"}
            </button>
            <button
              aria-label="生成 1 张候选图"
              className="min-h-14 w-full rounded-md bg-[var(--ad-ink)] px-5 text-base font-semibold text-white transition hover:bg-[#333] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canGenerate || busy !== null}
              onClick={() => void generate()}
              type="button"
            >
              {busy === "generate" ? "正在生成…" : "生成"}
            </button>
          </div>

          {displayedNotice ? (
            <p
              className="mt-4 text-sm leading-6 text-[var(--ad-green-text)]"
              role="status"
            >
              {displayedNotice}
            </p>
          ) : null}
          {error ? (
            <p
              className="mt-4 text-sm leading-6 text-[var(--ad-red-text)]"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {calibration.blocker && !selectedProfile ? (
            <p className="mt-4 text-sm text-[var(--ad-yellow-text)]">
              {calibration.blocker}
            </p>
          ) : null}

          <details className="mt-6 border-t border-[var(--ad-border)] pt-4">
            <summary className="cursor-pointer text-sm font-medium">
              高级设置
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-medium text-[var(--ad-text-muted)]">
                生成方式
                <select
                  aria-label="生成方式"
                  className={`${fieldClass} mt-1`}
                  onChange={(event) =>
                    setMode(event.target.value as ExperimentMode)
                  }
                  value={mode}
                >
                  <option value="text_to_image">文生图</option>
                  <option value="image_to_image">图生图</option>
                </select>
              </label>
              <label className="text-xs font-medium text-[var(--ad-text-muted)]">
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
              <label className="text-xs font-medium text-[var(--ad-text-muted)]">
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
                      {generationProfileLabel(profile.label)} v
                      {profile.profileVersion}
                      {profile.profileKey === preferredProfile?.profileKey
                        ? "（默认）"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-[var(--ad-text-muted)]">
                构图比例
                <select
                  aria-label="高级构图比例"
                  className={`${fieldClass} mt-1`}
                  onChange={(event) => setOrientation(event.target.value)}
                  value={resolvedOrientation}
                >
                  {(selectedProfile?.allowedOrientations ?? [orientation]).map(
                    (value) => (
                      <option key={value}>{value}</option>
                    ),
                  )}
                </select>
              </label>
              <label className="text-xs font-medium text-[var(--ad-text-muted)]">
                身份约束
                <select
                  aria-label="高级身份约束"
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
              <label className="text-xs font-medium text-[var(--ad-text-muted)]">
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
                  <option disabled={!selectedSource?.seed} value="reuse_source">
                    沿用所选图
                  </option>
                </select>
              </label>
              {mode === "image_to_image" ? (
                <label className="text-xs font-medium text-[var(--ad-text-muted)] sm:col-span-2">
                  变化强度：{strength.toFixed(2)}
                  <input
                    className="mt-3 w-full accent-[var(--ad-ink)]"
                    max="0.95"
                    min="0.1"
                    onChange={(event) =>
                      setStrength(Number(event.target.value))
                    }
                    step="0.05"
                    type="range"
                    value={strength}
                  />
                </label>
              ) : null}
            </div>

            {mode === "image_to_image" ? (
              <fieldset className="mt-5 border-t border-[var(--ad-border)] pt-4">
                <legend className="text-sm font-medium">参考图</legend>
                <button
                  className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold"
                  disabled={!canUploadSource || sourceUploadBusy}
                  onClick={() => sourceFileInput.current?.click()}
                  type="button"
                >
                  <Upload aria-hidden="true" size={14} />
                  上传图片
                </button>
                {visualSources.length > 0 ? (
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {visualSources.map((source) => {
                      const selected = source.id === resolvedSourceAssetId;
                      return (
                        <label className="cursor-pointer" key={source.id}>
                          <input
                            checked={selected}
                            className="sr-only"
                            name="identity-experiment-source"
                            onChange={() => setSourceAssetId(source.id)}
                            type="radio"
                            value={source.id}
                          />
                          <span
                            className={cn(
                              "relative block aspect-[4/5] overflow-hidden rounded-md border bg-black/[0.035]",
                              selected
                                ? "border-[var(--ad-ink)]"
                                : "border-[var(--ad-border)]",
                            )}
                          >
                            {source.url ? (
                              <Image
                                alt={source.label}
                                className="object-cover"
                                fill
                                sizes="120px"
                                src={source.url}
                                unoptimized
                              />
                            ) : null}
                          </span>
                          <span className="mt-1 block truncate text-[11px] text-[var(--ad-text-muted)]">
                            {source.label}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
                    还没有可用参考图
                  </p>
                )}
              </fieldset>
            ) : null}
          </details>
        </aside>
      </div>

      <section
        aria-labelledby="identity-history-title"
        className="mt-12 border-t border-[var(--ad-border)] pt-8"
      >
        <div className="flex items-end justify-between gap-4">
          <div>
            <h3
              className="text-xl font-semibold tracking-[-0.02em]"
              id="identity-history-title"
            >
              历史创作
            </h3>
            <p className="mt-1 text-sm text-[var(--ad-text-muted)]">
              打开任意图片，可继续调整或重新设为当前形象。
            </p>
          </div>
          <span className="shrink-0 text-xs text-[var(--ad-text-muted)]">
            {historyCandidates.length} 张
          </span>
        </div>

        {resultOpen && selectedRun && selectedItem ? (
          <article
            className="mt-6 grid gap-6 border-y border-[var(--ad-border)] py-6 lg:grid-cols-[minmax(240px,0.72fr)_minmax(0,1.28fr)]"
            aria-labelledby="selected-history-candidate-title"
          >
            <figure className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/[0.035]">
              <div className="relative aspect-[4/5]">
                {itemImage(selectedItem) ? (
                  <Image
                    alt="所选历史视觉身份候选"
                    className="object-cover"
                    fill
                    sizes="(min-width: 1024px) 32vw, 100vw"
                    src={itemImage(selectedItem)!}
                    unoptimized
                  />
                ) : (
                  <div className="grid h-full place-items-center p-5 text-center text-sm text-[var(--ad-text-muted)]">
                    <div>
                      <p>
                        {selectedItem.executionState === "failed"
                          ? (selectedItem.failure?.operatorGuidance ??
                            "生成失败")
                          : "正在生成"}
                      </p>
                      {selectedItem.failure ? (
                        <p className="mt-2 font-mono text-[10px]">
                          {selectedItem.failure.errorCode}
                        </p>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            </figure>

            <div className="min-w-0">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h4
                    className="text-lg font-semibold"
                    id="selected-history-candidate-title"
                  >
                    所选图片
                  </h4>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {new Date(selectedRun.createdAt).toLocaleString("zh-CN")}
                  </p>
                </div>
                <button
                  className="text-sm underline decoration-[var(--ad-border)] underline-offset-4"
                  onClick={() => setResultOpen(false)}
                  type="button"
                >
                  收起
                </button>
              </div>

              <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-[var(--ad-text-muted)]">
                    实际种子
                  </dt>
                  <dd className="mt-1 break-all font-mono text-xs">
                    {selectedItem.lineage.seed ??
                      experiment?.baseSeed ??
                      "系统生成"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--ad-text-muted)]">
                    生成方式
                  </dt>
                  <dd className="mt-1">
                    {modeLabel(experiment?.mode ?? "text_to_image")}
                  </dd>
                </div>
              </dl>
              <details className="mt-5 border-t border-[var(--ad-border)] pt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  查看提示词
                </summary>
                <div className="mt-3 space-y-3 text-sm leading-6">
                  <p>{experiment?.positivePrompt ?? "本轮没有提示词快照"}</p>
                  <p className="text-[var(--ad-text-muted)]">
                    负向提示词：{experiment?.negativePrompt || "无"}
                  </p>
                </div>
              </details>

              {selectedItem.asset && !systemSingleFramePassed ? (
                <p className="mt-5 text-sm text-[var(--ad-yellow-text)]">
                  旧图片缺少可采用的构图检查记录。可以从这张继续调整，生成的新图仍可重新选择。
                </p>
              ) : null}

              {!selectedApproved &&
              selectedItem.asset &&
              systemSingleFramePassed ? (
                <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm leading-6">
                  <input
                    checked={candidateQualityConfirmed}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--ad-ink)]"
                    onChange={(event) =>
                      setCandidateQualityConfirmed(event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>
                    我已确认人物、画面和图片质量，可将它作为视觉身份。
                  </span>
                </label>
              ) : null}

              <div className="mt-6 flex flex-wrap gap-2">
                <WorkspaceButton
                  disabled={!selectedItem.asset || busy !== null}
                  onClick={continueFromSelected}
                >
                  从这张继续调整
                </WorkspaceButton>
                <WorkspaceButton
                  disabled={!experiment || busy !== null}
                  onClick={reuseRunParameters}
                >
                  沿用生成参数
                </WorkspaceButton>
                {systemSingleFramePassed && selectedApproved ? (
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
                    {selectedIsActiveIdentity ? "当前形象" : "设为当前形象"}
                  </WorkspaceButton>
                ) : systemSingleFramePassed ? (
                  <WorkspaceButton
                    disabled={
                      !canReview ||
                      !selectedItem.asset ||
                      !systemSingleFramePassed ||
                      !candidateQualityConfirmed ||
                      busy !== null
                    }
                    onClick={() => void submitCandidate()}
                    tone="primary"
                  >
                    {busy === "review" ? "正在采用…" : "采用这张图"}
                  </WorkspaceButton>
                ) : null}
              </div>

              {activationOpen &&
              selectedApproved &&
              systemSingleFramePassed &&
              selectedItem.asset ? (
                <div
                  className="mt-6 scroll-mt-6 border-t border-[var(--ad-border)] pt-5"
                  id="identity-candidate-activation"
                >
                  <h4 className="text-sm font-semibold">设为当前形象</h4>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <label className="text-xs font-medium text-[var(--ad-text-muted)] sm:col-span-2">
                      身份描述
                      <textarea
                        className={`${textAreaClass} mt-1 min-h-24`}
                        onChange={(event) =>
                          setActivationPrompt(event.target.value)
                        }
                        value={activationPrompt}
                      />
                    </label>
                    <label className="text-xs font-medium text-[var(--ad-text-muted)]">
                      脸部特征（每行一个）
                      <textarea
                        className={`${textAreaClass} mt-1 min-h-20`}
                        onChange={(event) =>
                          setActivationFaceTraits(event.target.value)
                        }
                        value={activationFaceTraits}
                      />
                    </label>
                    <label className="text-xs font-medium text-[var(--ad-text-muted)]">
                      头发特征（每行一个）
                      <textarea
                        className={`${textAreaClass} mt-1 min-h-20`}
                        onChange={(event) =>
                          setActivationHairTraits(event.target.value)
                        }
                        value={activationHairTraits}
                      />
                    </label>
                    <label className="text-xs font-medium text-[var(--ad-text-muted)]">
                      身形特征（每行一个）
                      <textarea
                        className={`${textAreaClass} mt-1 min-h-20`}
                        onChange={(event) =>
                          setActivationBodyTraits(event.target.value)
                        }
                        value={activationBodyTraits}
                      />
                    </label>
                    <label className="text-xs font-medium text-[var(--ad-text-muted)]">
                      标志特征（可留空）
                      <textarea
                        className={`${textAreaClass} mt-1 min-h-20`}
                        onChange={(event) =>
                          setActivationSignatureTraits(event.target.value)
                        }
                        value={activationSignatureTraits}
                      />
                    </label>
                    <label className="text-xs font-medium text-[var(--ad-text-muted)] sm:col-span-2">
                      变更理由
                      <input
                        className={`${fieldClass} mt-1`}
                        onChange={(event) =>
                          setActivationReason(event.target.value)
                        }
                        value={activationReason}
                      />
                    </label>
                  </div>
                  <label className="mt-4 flex items-start gap-2 text-xs leading-5">
                    <input
                      checked={activationConfirmed}
                      className="mt-1"
                      onChange={(event) =>
                        setActivationConfirmed(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>
                      我确认要创建新的视觉身份版本。线上图片不会自动替换。
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
                      {busy === "activate" ? "正在设置…" : "确认设为当前形象"}
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
            </div>
          </article>
        ) : null}

        {historyLoading ? (
          <p className="mt-6 text-sm text-[var(--ad-text-muted)]">
            正在读取历史创作…
          </p>
        ) : historyCandidates.length === 0 &&
          historyRunsWithoutImages.length === 0 ? (
          <div className="mt-6 border border-dashed border-[var(--ad-border)] px-5 py-10 text-center text-sm text-[var(--ad-text-muted)]">
            生成后的图片会保存在这里
          </div>
        ) : (
          <>
            {historyCandidates.length > 0 ? (
              <div
                className="mt-6 grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                aria-label="历史创作图片"
              >
                {historyCandidates.map(
                  ({ run, runDetail, runNumber, item }) => {
                    const selected =
                      selectedRun?.id === run.id &&
                      selectedItem?.id === item.id &&
                      resultOpen;
                    const isCurrent = Boolean(
                      item.asset &&
                      identity?.anchorAssetIds.includes(item.asset.id),
                    );
                    return (
                      <button
                        aria-label={`查看第 ${runNumber} 次创作的候选图 ${item.ordinal + 1}`}
                        aria-pressed={selected}
                        className="group min-w-0 text-left"
                        key={item.id}
                        onClick={() => {
                          setCandidateQualityConfirmed(false);
                          setActivationOpen(false);
                          setSelectedRun(runDetail);
                          setSelectedItemId(item.id);
                          setResultOpen(true);
                        }}
                        type="button"
                      >
                        <span
                          className={cn(
                            "relative block aspect-[4/5] overflow-hidden rounded-lg border bg-black/[0.035] transition group-hover:border-[var(--ad-text-muted)]",
                            selected
                              ? "border-[var(--ad-ink)]"
                              : "border-[var(--ad-border)]",
                          )}
                        >
                          <Image
                            alt={`第 ${runNumber} 次创作的候选图 ${item.ordinal + 1}`}
                            className="object-cover transition duration-200 group-hover:scale-[1.01]"
                            fill
                            sizes="(min-width: 1280px) 16vw, (min-width: 1024px) 20vw, (min-width: 640px) 30vw, 46vw"
                            src={itemImage(item)!}
                            unoptimized
                          />
                        </span>
                        <span className="mt-2 flex items-center justify-between gap-2 text-xs">
                          <span className="truncate">第 {runNumber} 次</span>
                          <span className="shrink-0 text-[var(--ad-text-muted)]">
                            {isCurrent
                              ? "当前使用"
                              : item.review?.decision === "approved"
                                ? "已采用"
                                : "候选"}
                          </span>
                        </span>
                      </button>
                    );
                  },
                )}
              </div>
            ) : null}
            {historyRunsWithoutImages.length > 0 ? (
              <div
                className="mt-6 flex flex-wrap gap-2"
                aria-label="未产出图片的历史创作"
              >
                {historyRunsWithoutImages.map(
                  ({ run, runDetail, runNumber }) => (
                    <button
                      className="rounded-md border border-[var(--ad-border)] px-3 py-2 text-left text-xs text-[var(--ad-text-muted)] hover:border-[var(--ad-text-muted)]"
                      key={run.id}
                      onClick={() => {
                        setSelectedRun(runDetail);
                        setSelectedItemId(runDetail.items[0]?.id ?? null);
                        setResultOpen(true);
                      }}
                      type="button"
                    >
                      第 {runNumber} 次：未产出图片
                    </button>
                  ),
                )}
              </div>
            ) : null}
          </>
        )}
      </section>
    </section>
  );
}
