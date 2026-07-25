"use client";

import Image from "next/image";
import {
  CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT,
  creativeReviewDecisionResultSchema,
  creativeRunCreateRequestSchema,
  creativeRunCreateResultSchema,
  creativeRunDetailSchema,
  creativeRunListResponseSchema,
  type CharacterVisualProfileCreateRequest,
  type CharacterWorkspaceDetail,
  type CreativeRun,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { adminV2Request } from "@/lib/admin-v2-api";
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
  readonly url: string | null;
  readonly seed: string | null;
};

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

function identityTraitLines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((trait) => trait.trim())
    .filter(Boolean);
}

export function VisualIdentityExperimentWorkbench({
  data,
  canCreate,
  canReview,
  canActivate,
  onActivateCandidate,
}: {
  data: VisualIdentityExperimentData;
  canCreate: boolean;
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
  const [count, setCount] = useState(4);
  const [consistencyMode, setConsistencyMode] = useState<
    "strict" | "balanced" | "creative"
  >("balanced");
  const [strength, setStrength] = useState(0.65);
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CreativeRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<CreativeRunDetail | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"generate" | "review" | "activate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalReason, setProposalReason] = useState("");
  const [proposalQuality, setProposalQuality] = useState({
    artifactFree: false,
    singleSubject: false,
    intentMatch: false,
    noVisibleText: false,
  });
  const [proposalConfirmed, setProposalConfirmed] = useState(false);
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
  const resolvedOrientation =
    selectedProfile?.allowedOrientations.includes(orientation)
      ? orientation
      : selectedProfile?.orientation ?? orientation;

  const loadRun = useCallback(async (runId: string) => {
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
  }, []);

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
    for (const asset of [
      ...data.visual.anchors,
      ...data.visual.references,
      ...(data.visual.activeReferenceSet?.references ?? []),
    ]) {
      if (!asset.available) continue;
      byId.set(asset.mediaAssetId, {
        id: asset.mediaAssetId,
        label: asset.role.replaceAll("_", " "),
        url: asset.thumbnailUrl ?? asset.url,
        seed: null,
      });
    }
    for (const item of selectedRun?.items ?? []) {
      if (!item.asset) continue;
      byId.set(item.asset.id, {
        id: item.asset.id,
        label: `第 ${(item.ordinal ?? 0) + 1} 张实验图`,
        url: item.asset.thumbnailUrl ?? item.asset.url,
        seed: item.lineage.seed ?? null,
      });
    }
    return [...byId.values()];
  }, [
    data.visual.activeReferenceSet?.references,
    data.visual.anchors,
    data.visual.references,
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
      !proposalConfirmed ||
      Object.values(proposalQuality).some((passed) => !passed)
    ) return;
    const body = {
      entityVersion: selectedRun.version,
      ...(selectedItem.review
        ? { supersedesDecisionId: selectedItem.review.id }
        : {}),
      decision: "approved" as const,
      identityConsistency: "unscored" as const,
      quality: proposalQuality,
      reason: proposalReason.trim(),
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
      setProposalOpen(false);
      setProposalConfirmed(false);
      setProposalReason("");
      setProposalQuality({
        artifactFree: false,
        singleSubject: false,
        intentMatch: false,
        noVisibleText: false,
      });
      setNotice("候选身份已提交为不可变评审决定；激活身份版本仍需单独执行。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "候选身份提交失败");
    } finally {
      setBusy(null);
    }
  };

  const activateCandidate = async () => {
    if (
      !selectedRun ||
      !selectedItem?.asset ||
      !selectedItem.review ||
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

          {mode === "image_to_image" ? (
            <div className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3">
              <div className="flex gap-3">
                <div className="relative h-20 w-16 shrink-0 overflow-hidden rounded-md bg-black/[0.06]">
                  {selectedSource?.url ? (
                    <Image
                      alt="当前图生图来源"
                      className="object-cover"
                      fill
                      sizes="64px"
                      src={selectedSource.url}
                      unoptimized
                    />
                  ) : null}
                </div>
                <label className="min-w-0 flex-1 text-xs font-semibold text-[var(--ad-text-muted)]">
                  来源图
                  <select
                    className={`${fieldClass} mt-1`}
                    onChange={(event) => {
                      const nextSourceId = event.target.value || null;
                      setSourceAssetId(nextSourceId);
                      const nextSource = visualSources.find(
                        (source) => source.id === nextSourceId,
                      );
                      if (seedStrategy === "reuse_source" && !nextSource?.seed) {
                        setSeedStrategy("random");
                      }
                    }}
                    value={resolvedSourceAssetId ?? ""}
                  >
                    <option value="">选择一张来源图</option>
                    {visualSources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.label} · {source.id.slice(0, 10)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {visualSources.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--ad-yellow-text)]">
                  先完成一轮文生图，或准备可用的角色参考图。
                </p>
              ) : null}
            </div>
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
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              每轮张数
              <select
                className={`${fieldClass} mt-1`}
                onChange={(event) => setCount(Number(event.target.value))}
                value={count}
              >
                {[1, 2, 4, 6, 8].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
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
              <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                实验线路
                <select
                  className={`${fieldClass} mt-1`}
                  onChange={(event) => setProfileKey(event.target.value)}
                  value={selectedProfile?.profileKey ?? ""}
                >
                  {compatibleProfiles.map((profile) => (
                    <option key={`${profile.profileKey}:${profile.profileVersion}`} value={profile.profileKey}>
                      {profile.label} · v{profile.profileVersion}
                    </option>
                  ))}
                </select>
              </label>
              {selectedProfile ? (
                <p className="rounded-md bg-black/[0.035] p-3 text-[11px] leading-5 text-[var(--ad-text-muted)]">
                  {selectedProfile.workflowKey} v{selectedProfile.workflowVersion}
                  <br />
                  线路、工作流版本与方向会在创建时冻结；这里不会授予正式生产线路资格。
                </p>
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
            {busy === "generate" ? "正在创建实验…" : `生成 ${count} 张候选图`}
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
                          ? "这一张生成失败，可创建新一轮继续尝试。"
                          : "生成完成后会自动出现在这里。"}
                      </p>
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
                      setSelectedItemId(item.id);
                      setProposalOpen(false);
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

          <div className="mt-5 flex flex-wrap gap-2">
            <WorkspaceButton
              disabled={!selectedItem?.asset || busy !== null}
              onClick={continueFromSelected}
            >
              从这张继续（图生图）
            </WorkspaceButton>
            <WorkspaceButton
              disabled={
                !canReview ||
                !selectedItem?.asset ||
                selectedApproved ||
                busy !== null
              }
              onClick={() => setProposalOpen((current) => !current)}
              tone="primary"
            >
              {selectedApproved ? "候选身份已提交" : "提交候选身份"}
            </WorkspaceButton>
            {selectedApproved ? (
              <WorkspaceButton
                disabled={
                  !canActivate ||
                  !onActivateCandidate ||
                  selectedIsActiveIdentity ||
                  busy !== null
                }
                onClick={() => setActivationOpen((current) => !current)}
                tone="primary"
              >
                {selectedIsActiveIdentity ? "当前活动身份" : "激活为新视觉身份"}
              </WorkspaceButton>
            ) : null}
          </div>

          {proposalOpen && selectedItem?.asset ? (
            <div className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
              <h4 className="text-sm font-semibold">确认候选身份评审</h4>
              <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                这会记录不可变的候选评审，但不会自动激活新身份版本，也不会替换 Reference Set 或线上图片。
              </p>
              <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                决策理由
                <input
                  className={`${fieldClass} mt-1`}
                  onChange={(event) => setProposalReason(event.target.value)}
                  value={proposalReason}
                />
              </label>
              <fieldset className="mt-3 rounded-lg border border-[var(--ad-border)] p-3">
                <legend className="px-1 text-xs font-semibold text-[var(--ad-text-muted)]">
                  可见质量证据（逐项检查）
                </legend>
                {([
                  ["artifactFree", "无明显瑕疵"],
                  ["singleSubject", "只有一个主体"],
                  ["intentMatch", "符合本轮身份设计意图"],
                  ["noVisibleText", "画面没有可见文字"],
                ] as const).map(([key, label]) => (
                  <label
                    className="mt-2 flex items-start gap-2 text-xs leading-5 first:mt-0"
                    key={key}
                  >
                    <input
                      checked={proposalQuality[key]}
                      className="mt-1"
                      onChange={(event) => setProposalQuality((current) => ({
                        ...current,
                        [key]: event.target.checked,
                      }))}
                      type="checkbox"
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              <label className="mt-3 flex items-start gap-2 text-xs leading-5">
                <input
                  checked={proposalConfirmed}
                  className="mt-1"
                  onChange={(event) => setProposalConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  我确认以上逐项判断将作为不可变评审证据写入。
                </span>
              </label>
              <div className="mt-4 flex flex-wrap gap-2">
                <WorkspaceButton
                  disabled={
                    busy !== null ||
                    proposalReason.trim().length < 3 ||
                    Object.values(proposalQuality).some((passed) => !passed) ||
                    !proposalConfirmed
                  }
                  onClick={() => void submitCandidate()}
                  tone="primary"
                >
                  {busy === "review" ? "正在提交…" : "确认提交候选"}
                </WorkspaceButton>
                <WorkspaceButton
                  disabled={busy !== null}
                  onClick={() => setProposalOpen(false)}
                >
                  取消
                </WorkspaceButton>
              </div>
            </div>
          ) : null}

          {activationOpen && selectedApproved && selectedItem?.asset ? (
            <div className="mt-4 rounded-xl border border-[var(--ad-ink)] bg-[var(--ad-surface)] p-4">
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
