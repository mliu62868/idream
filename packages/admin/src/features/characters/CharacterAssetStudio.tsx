"use client";

import {
  creativeRunCreateRequestSchema,
  type CharacterWorkspaceDetail,
  type CreativeRun,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import {
  Check,
  Loader2,
  RefreshCcw,
  ShieldAlert,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  StatusBadge,
  WorkspaceButton,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  claimDurableMutationIntent,
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  updateDurableMutationIntent,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";
import { reconcileDurableMutationIntent } from "@/lib/durable-mutation-recovery";
import { usePollingTask, type PollingTask } from "@/lib/authority-resource";
import {
  committedProjectionTargetId,
  isProjectionRequestCancellation,
  SupersededProjectionError,
  useCommittedProjectionLoader,
} from "@/lib/committed-projection";
import { createLatestRequestGate } from "@/lib/latest-request";
import { cn } from "@/lib/utils";
import { characterIdentityBootstrapMutation } from "@/features/image-workflow-transport";
import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import {
  canChooseCharacterAssetPurpose,
  candidateState,
  characterAssetBootstrapRequestKey,
  characterAssetDraftSelectionRequestKey,
  characterAssetReviewIntentSnapshot,
  characterAssetRunRequestKey,
  characterAssetRunReceiptMessage,
  characterAssetSelectionIntentCommandType,
  characterAssetSelectionIntentSnapshot,
  characterAssetSelectionRecoveryVerification,
  characterAssetStudioLayoutClass,
  characterSourceVariationBlockerMessage,
  characterSourceVariationAvailabilityMessage,
  committedCharacterRunProjectionMatches,
  committedRunProjectionUnavailable,
  isCharacterAssetPurpose,
  nextIncompleteCharacterAssetPurpose,
  preferredCharacterAssetRunId,
  purposeConfig,
  resolveCharacterAssetSubject,
  type CharacterAssetProjectMutation,
  type CharacterAssetPurpose,
  type ReviewDraft,
} from "./character-asset-studio-authority";
import {
  AssetImage,
  CandidateBatchGrid,
  CandidateComparisonStage,
  IdentityRail,
  ImageProductionReadinessCard,
} from "./CharacterAssetStudioStage";

export function CharacterAssetStudio({
  actorId = "anonymous",
  data,
  permissions,
  onContinue,
  onProjectReload,
  commitProjectMutation,
  productionOnly = false,
}: {
  actorId?: string;
  data: CharacterWorkspaceDetail;
  permissions: {
    read: boolean;
    create: boolean;
    review: boolean;
    selectDraft: boolean;
  };
  onContinue: (tab: "visual" | "preview") => void;
  onProjectReload: () => Promise<void>;
  commitProjectMutation: CharacterAssetProjectMutation;
  productionOnly?: boolean;
}) {
  const { locale, t } = useAdminI18n();
  const subject = resolveCharacterAssetSubject({
    draftName: data.preview.draft?.name,
    draftDescription: data.preview.draft?.description,
    liveName: data.character.name,
    liveDescription: data.character.description,
  });
  const [runs, setRuns] = useState<CreativeRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<CreativeRunDetail | null>(
    null,
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedExistingImageId, setSelectedExistingImageId] = useState<
    string | null
  >(null);
  const [comparisonItemId, setComparisonItemId] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<"library" | "review">(
    () =>
      productionOnly || !data.visual.identityBootstrap.allowed
        ? "library"
        : "review",
  );
  const [activePurpose, setActivePurpose] = useState<CharacterAssetPurpose>(
    () =>
      data.project.draftAssetRouteAuthority?.recoveryPurpose ??
      nextIncompleteCharacterAssetPurpose(data.journey) ??
      "character_chat",
  );
  const [briefs, setBriefs] = useState<Record<CharacterAssetPurpose, string>>(
    () => ({
      character_cover: data.visual.identityBootstrap.allowed
        ? t(
            "Create the first definitive portrait of {name} from the approved visual direction. This portrait will define the identity for future images.",
            { name: subject.name },
          )
        : t(
            "Create a definitive primary portrait of {name}, preserving the locked identity and personality.",
            { name: subject.name },
          ),
      character_hero: t(
        "Create a cinematic but natural hero scene for {name}, preserving the locked identity and personality.",
        { name: subject.name },
      ),
      character_chat: t(
        "Create a warm, candid conversational moment with {name}, preserving the locked identity and emotional presence.",
        { name: subject.name },
      ),
    }),
  );
  const [negativePrompts, setNegativePrompts] = useState<
    Record<CharacterAssetPurpose, string>
  >({
    character_cover: "",
    character_hero: "",
    character_chat: "",
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<
    "generate" | "review" | "select" | "prepare" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const readinessRepairKeys = useRef<Record<string, string>>({});
  const [, setReviewDrafts] = useState<Record<string, ReviewDraft>>(
    {},
  );
  const [runCreationIntent, setRunCreationIntent] =
    useState<DurableMutationIntent | null>(() =>
      readActiveDurableMutationIntent({
        scope: `character-asset:create:${actorId}:${data.character.id}`,
      }),
    );
  const runCreationIntentRef = useRef(runCreationIntent);
  const [reviewMutationIntent, setReviewMutationIntent] =
    useState<DurableMutationIntent | null>(() =>
      productionOnly
        ? null
        : readActiveDurableMutationIntent({
            scope: `character-asset:review:${actorId}:${data.character.id}`,
          }),
    );
  const [selectionMutationIntent, setSelectionMutationIntent] =
    useState<DurableMutationIntent | null>(() =>
      readActiveDurableMutationIntent({
        scope: `character-asset:selection:${actorId}:${data.character.id}`,
      }),
    );
  const runListRequestGate = useRef(createLatestRequestGate());
  const selectRunId = useCallback(
    (runId: string | null) => {
      selectedRunIdRef.current = runId;
      setSelectedRunId(runId);
      setComparisonItemId(null);
    },
    [setComparisonItemId],
  );
  const updateRunCreationIntentState = useCallback(
    (intent: DurableMutationIntent | null) => {
      runCreationIntentRef.current = intent;
      setRunCreationIntent(intent);
    },
    [],
  );
  const identityBootstrap = data.visual.identityBootstrap;
  const bootstrapMode = identityBootstrap.allowed;
  const qualifiedRoute =
    data.visual.routeQualifications.find(
      (route) => route.result === "qualified" && !route.stale,
    ) ?? null;
  const bootstrapProfile = identityBootstrap.profile;
  const qualifiedImageProfile = data.visual.identityCalibration?.profiles.find(
    (profile) =>
      profile.profileKey === qualifiedRoute?.generationProfileKey &&
      profile.profileVersion === qualifiedRoute.generationProfileVersion &&
      profile.workflowKey === qualifiedRoute.workflowKey &&
      profile.workflowVersion === qualifiedRoute.workflowVersion,
  );
  const orientationForPurpose = (purpose: CharacterAssetPurpose) => {
    if (bootstrapMode) return bootstrapProfile?.orientation;
    const preferred = purposeConfig[purpose].orientation;
    const allowed = qualifiedImageProfile?.allowedOrientations;
    // Purpose ratios are preferences; the qualified profile owns supported
    // dimensions. Missing capability data leaves the choice to Main's profile.
    return allowed?.includes(preferred) ? preferred : allowed?.[0];
  };
  const variationRouteReady =
    qualifiedRoute?.sourceVariationAuthority?.ready === true;
  const variationRouteBlocker =
    qualifiedRoute?.sourceVariationAuthority?.blocker ?? "no_qualified_route";
  const nextIncompletePurpose = nextIncompleteCharacterAssetPurpose(
    data.journey,
  );
  // SPEC: 「已选中」按钮的文案和点击行为必须读同一个值。
  // INTENT: 文案曾读路由过滤后的 pack、点击读未过滤的原始 pack —— 写着「下一个资产」、点下去跳到别处。
  // null = 当前用途就是最后一件待办（或图池已齐），下一步是 Launch preview。
  const advanceTargetPurpose =
    nextIncompletePurpose === activePurpose ? null : nextIncompletePurpose;
  const pinnedRunIds = useMemo(
    () =>
      new Set(
        Object.values(data.project.draftAssetSelections ?? {}).flatMap(
          (selection) => (selection?.runId ? [selection.runId] : []),
        ),
      ),
    [data.project.draftAssetSelections],
  );
  const existingImages = useMemo(() => {
    const images: Array<{
      readonly id: string;
      readonly url: string;
      readonly thumbnailUrl: string;
    }> = [];
    const seen = new Set<string>();
    const add = (
      id: string,
      url: string | null | undefined,
      thumbnailUrl: string | null | undefined = url,
    ) => {
      const displayUrl = url ?? thumbnailUrl;
      if (!displayUrl || seen.has(displayUrl)) return;
      seen.add(displayUrl);
      images.push({
        id,
        url: displayUrl,
        thumbnailUrl: thumbnailUrl ?? displayUrl,
      });
    };
    const references = [
      ...(data.visual.activeReferenceSet?.references ?? []),
      ...data.visual.anchors,
      ...data.visual.references,
      ...(data.visual.videoSources ?? []),
    ];
    const preferredAssetId =
      data.project.draftAssetPack[activePurpose] ??
      (activePurpose === "character_cover"
        ? data.project.draftImageAssetId
        : null);
    const preferred = references.find(
      (reference) =>
        reference.mediaAssetId === preferredAssetId && reference.available,
    );
    if (preferred)
      add(preferred.mediaAssetId, preferred.url, preferred.thumbnailUrl);
    add(`${data.character.id}:primary`, data.character.imageUrl);
    add(`${data.character.id}:draft`, data.preview.draft?.imageUrl);
    for (const reference of references) {
      if (!reference.available) continue;
      add(reference.mediaAssetId, reference.url, reference.thumbnailUrl);
    }
    return images;
  }, [activePurpose, data]);

  const loadRuns = useCallback(
    async (
      options: {
        readonly signal?: AbortSignal;
        readonly preserveSelectedRunId?: string;
      } = {},
    ) => {
      const request = runListRequestGate.current.begin();
      const query = new URLSearchParams({
        limit: "20",
        targetType: "character",
        targetId: data.character.id,
        sort: "updated_desc",
      });
      const response = await adminV2Operation(
        "GET /api/v2/admin/creative/runs",
        {
          query,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      const scoped = [...response.items].filter((run) =>
        isCharacterAssetPurpose(run.purpose),
      );
      if (!request.isCurrent()) throw new SupersededProjectionError();
      setRuns(scoped);
      const current = selectedRunIdRef.current;
      const committedTargetId = committedProjectionTargetId(
        runCreationIntentRef.current,
      );
      const preserveCurrent = Boolean(
        current &&
        (scoped.some((run) => run.id === current) ||
          current === options.preserveSelectedRunId ||
          current === committedTargetId),
      );
      if (!preserveCurrent) {
        const desiredPurpose = nextIncompletePurpose ?? "character_chat";
        const selectedRunForPurpose =
          data.project.draftAssetSelections?.[desiredPurpose]?.runId;
        selectRunId(
          committedTargetId ??
            scoped.find((run) => ["pending", "running"].includes(run.executionOutcome))?.id ??
            preferredCharacterAssetRunId({
              runs: scoped,
              purpose: desiredPurpose,
              pinnedRunId: selectedRunForPurpose,
            }),
        );
      }
      return scoped;
    },
    [
      nextIncompletePurpose,
      data.character.id,
      data.project.draftAssetSelections,
      selectRunId,
    ],
  );

  // SPEC: 精确读一份 Run 投影，并据此确认「刚提交的那笔生成」是否已被服务端认下。
  // INTENT: 取消语义 / 在途去重 / 两道闸门顺序 / 失败分流全在 committed-projection 里；
  //         这里只剩三样组件才知道的东西：怎么取、什么算「已反映」、成功后写哪些状态。
  const runLoader = useCommittedProjectionLoader<CreativeRunDetail>({
    fetch: (runId, signal) =>
      adminV2Operation("GET /api/v2/admin/creative/runs/:id", {
        path: { id: runId },
        signal,
      }),
    isCurrentTarget: (runId) => selectedRunIdRef.current === runId,
    committed: {
      current: () => runCreationIntentRef.current,
      reflects: (intent, detail) =>
        committedCharacterRunProjectionMatches(
          intent,
          detail,
          data.character.id,
        ),
      mismatchMessage:
        "The committed Run projection does not match this Character and image purpose. The workspace remains locked.",
      onReleased: () => updateRunCreationIntentState(null),
    },
    commit: (detail, verdict) => {
      setSelectedRun(detail);
      // SPEC: 被草稿钉住的 Run 即使掉出最近 20 条也要留在列表里，否则运营台会看不到自己
      //       正在评审的那一条。
      if (pinnedRunIds.has(detail.id)) {
        setRuns((current) =>
          current.some((run) => run.id === detail.id)
            ? current
            : [detail, ...current],
        );
      }
      setSelectedIndex((current) => {
        if (isCharacterAssetPurpose(detail.purpose)) {
          const selectedItemId =
            data.project.draftAssetSelections?.[detail.purpose]?.itemId;
          const selectedItemIndex = detail.items.findIndex(
            (item) => item.id === selectedItemId,
          );
          if (selectedItemIndex >= 0) return selectedItemIndex;
        }
        return Math.min(current, Math.max(detail.items.length - 1, 0));
      });
      if (isCharacterAssetPurpose(detail.purpose)) {
        setActivePurpose(detail.purpose);
      }
      if (verdict.kind === "reflected") {
        setRefreshWarning(null);
        setMessage(characterAssetRunReceiptMessage(detail));
      }
    },
  });
  const loadRun = runLoader.load;
  const unconfirmedOperations = data.mediaOperations.operations.filter((operation) =>
    operation.modality === "image" && operation.status === "unknown" && operation.requestId,
  );

  const refreshedDeliveries = useRef(new Set<string>());
  useEffect(() => {
    if (!selectedRun) return;
    const assetIds = selectedRun.items.flatMap((item) => item.asset ? [item.asset.id] : []);
    const terminal = ["succeeded", "partially_succeeded", "failed", "cancelled"].includes(selectedRun.executionOutcome);
    const itemFailure = selectedRun.items.some((item) => item.executionState === "failed");
    if (assetIds.length === 0 && !terminal && !itemFailure) return;
    const receipt = `${selectedRun.id}:${terminal ? selectedRun.executionOutcome : itemFailure ? "needs_confirmation" : "delivered"}:${assetIds.sort().join(",")}`;
    if (refreshedDeliveries.current.has(receipt)) return;
    // A Run projection can deliver an image without a project mutation. Refresh
    // the library and workspace once per delivered asset set, including recovery.
    refreshedDeliveries.current.add(receipt);
    void onProjectReload().catch((cause) => {
      setRefreshWarning(cause instanceof Error ? cause.message : "Character assets could not be refreshed");
    });
  }, [onProjectReload, selectedRun]);

  useEffect(() => {
    if (!permissions.read) return;
    let cancelled = false;
    const controller = new AbortController();
    const gate = runListRequestGate.current;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        await loadRuns({ signal: controller.signal });
      } catch (cause) {
        if (!cancelled && !isProjectionRequestCancellation(cause)) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Character assets could not be loaded",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      gate.invalidate();
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadRuns, permissions.read]);

  useEffect(() => {
    if (!selectedRunId || selectedRun?.id === selectedRunId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadRun(selectedRunId, { signal: controller.signal }).catch(
        (cause: unknown) => {
          // SPEC: 失败的是不是「刚提交、还在等投影」的那一条，决定它进旁注还是进主错误。
          const route = runLoader.routeFailure(selectedRunId, cause);
          if (route.kind === "recoverable") {
            setRefreshWarning(committedRunProjectionUnavailable(route.detail));
          } else if (route.kind === "fatal") {
            setError(route.detail ?? "Creative Run could not be loaded");
          }
        },
      );
    }, 0);
    return () => {
      if (selectedRunIdRef.current === selectedRunId) {
        runLoader.invalidate();
      }
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadRun, runLoader, selectedRun?.id, selectedRunId]);

  const pollingRunId = selectedRun?.id ?? null;
  const shouldPollSelectedRun =
    selectedRun !== null &&
    (["pending", "running"].includes(selectedRun.executionOutcome) ||
      runs.some((run) => ["pending", "running"].includes(run.executionOutcome)));
  // SPEC: 生成中的 Run 每 4s 刷新一次，失败退避到 8s。
  const pollAssetRun = useCallback<PollingTask>(
    async (context) => {
      if (!pollingRunId) return null;
      try {
        await Promise.all([loadRun(pollingRunId), loadRuns()]);
        if (!context.cancelled) setRefreshWarning(null);
        return 4_000;
      } catch (cause) {
        // INTENT: 请求被新一轮取代不是故障，静默停手等新一轮接管即可。
        if (isProjectionRequestCancellation(cause)) return null;
        if (!context.cancelled) {
          setRefreshWarning(
            cause instanceof Error
              ? `Automatic refresh was delayed: ${cause.message}. Retrying in the background; Refresh is also available.`
              : "Automatic refresh was delayed. Retrying in the background; Refresh is also available.",
          );
        }
        return 8_000;
      }
    },
    [loadRun, loadRuns, pollingRunId],
  );
  usePollingTask(
    pollingRunId && shouldPollSelectedRun ? pollAssetRun : null,
    4_000,
  );

  const activeRunDetail =
    selectedRun?.id === selectedRunId ? selectedRun : null;
  const selectedExistingImage =
    existingImages.find((image) => image.id === selectedExistingImageId) ??
    existingImages[0] ??
    null;
  const selectedItem = activeRunDetail?.items[selectedIndex] ?? null;
  const comparisonItem = comparisonItemId
    ? (activeRunDetail?.items.find((item) => item.id === comparisonItemId) ??
      null)
    : null;
  const activateCandidate = (index: number) => {
    const nextItem = activeRunDetail?.items[index];
    if (!nextItem || mutationContextLocked) return;
    if (nextItem.id === comparisonItemId) {
      setComparisonItemId(selectedItem?.id ?? null);
    }
    setSelectedIndex(index);
    setWorkspaceMode(productionOnly ? "library" : "review");
  };
  const toggleCandidateComparison = (itemId: string) => {
    if (mutationContextLocked || itemId === selectedItem?.id) return;
    setComparisonItemId((current) => (current === itemId ? null : itemId));
    setWorkspaceMode(productionOnly ? "library" : "review");
  };
  const activeConfig = purposeConfig[activePurpose];
  const imageRequestInProgress = runs.some((run) => run.purpose === activePurpose && ["pending", "running"].includes(
    selectedRun?.id === run.id ? selectedRun.executionOutcome : run.executionOutcome,
  )) || (selectedRun?.purpose === activePurpose && ["pending", "running"].includes(selectedRun.executionOutcome));
  const mutationContextLocked = Boolean(
    runCreationIntent ||
    selectionMutationIntent,
  );
  const canGenerate =
    permissions.create &&
    !imageRequestInProgress &&
    unconfirmedOperations.length === 0 &&
    (bootstrapMode
      ? Boolean(bootstrapProfile) && activePurpose === "character_cover"
      : Boolean(qualifiedRoute) && data.visual.readiness.ready) &&
    !refreshWarning;
  const productionBlocked = !bootstrapMode && !data.visual.readiness.ready;
  const imageProductionRepairable =
    productionBlocked &&
    data.visual.imageReadiness?.state === "repairable" &&
    Boolean(data.visual.imageReadiness.repair);
  const recurringProductionReady = !bootstrapMode && !productionBlocked;
  const readinessDescriptionId = `character-image-readiness-${data.character.id}`;
  const canUseGenerationAction = runCreationIntent
    ? permissions.create
    : canGenerate;
  const selectedPackAssetId =
    data.project.draftAssetPack[activePurpose] ??
    (activePurpose === "character_cover"
      ? (data.project.draftImageAssetId ?? undefined)
      : undefined);
  const selectedPackRouteCurrent =
    data.project.draftAssetSelections?.[activePurpose]?.routeCurrent !== false;
  const isSelectedAsset = Boolean(selectedItem?.asset && selectedPackRouteCurrent &&
    selectedPackAssetId === selectedItem.asset.id);
  const isApprovedItem = Boolean(selectedItem?.asset);
  const decisionActionLabel = isSelectedAsset
    ? advanceTargetPurpose === null ? "Selected · preview" : "Selected · next asset"
    : bootstrapMode ? "Set as identity" : activePurpose === "character_cover"
      ? "Select primary · next asset" : activePurpose === "character_hero"
        ? "Select hero · next asset" : "Select chat asset · preview";
  const canUseDecisionAction =
    Boolean(selectedItem?.asset) &&
    (isSelectedAsset || (isApprovedItem && permissions.selectDraft));
  const prepareImageProduction = async () => {
    const readiness = data.visual.imageReadiness;
    if (!readiness || readiness.state !== "repairable" || !readiness.repair)
      return;
    setBusy("prepare");
    setError(null);
    setMessage(null);
    const signature = readiness.fingerprint;
    const idempotencyKey =
      readinessRepairKeys.current[signature] ?? crypto.randomUUID();
    readinessRepairKeys.current[signature] = idempotencyKey;
    try {
      const committed = await commitProjectMutation({
        action: "Character image-production preparation",
        commit: () =>
          adminV2Operation(
            "POST /api/v2/admin/characters/:id/image-readiness/repair",
            {
              path: { id: data.character.id },
              idempotencyKey,
              ifMatch: data.project.version,
              body: {
                entityVersion: data.project.version,
                expectedReadinessFingerprint: readiness.fingerprint,
                reason:
                  "Adopt the exact live editorial portrait as future image-generation identity authority",
                confirmation: `PREPARE IMAGE PRODUCTION ${data.character.id}`,
              },
            },
          ),
      });
      if (committed.refreshed) {
        delete readinessRepairKeys.current[signature];
      }
      setMessage(
        committed.result.state === "ready"
          ? "The live portrait is now the sealed identity reference. Image production is ready."
          : "The live portrait is now the sealed identity reference. A production administrator still needs to activate a compatible image route.",
      );
    } catch {
      setError(
        "Image production could not be enabled. Your live images were not changed. Try again.",
      );
    } finally {
      setBusy(null);
    }
  };

  const choosePurpose = (
    purpose: CharacterAssetPurpose,
    options: { readonly identityCommitted?: boolean } = {},
  ) => {
    if (
      !canChooseCharacterAssetPurpose(
        purpose,
        bootstrapMode,
        options.identityCommitted,
      )
    )
      return;
    runLoader.invalidate();
    setActivePurpose(purpose);
    setMessage(null);
    const selectedRunForPurpose =
      data.project.draftAssetSelections?.[purpose]?.runId;
    const nextRunId = preferredCharacterAssetRunId({
      runs,
      purpose,
      pinnedRunId: selectedRunForPurpose,
    });
    selectRunId(nextRunId);
    if (!nextRunId || nextRunId !== selectedRun?.id) setSelectedRun(null);
    setSelectedIndex(0);
    // The bootstrap completion callback still closes over pre-commit authority.
    if (!bootstrapMode || options.identityCommitted) setWorkspaceMode("library");
  };

  const createRun = async (
    purpose: CharacterAssetPurpose,
    referenceAssetIds: string[] = [],
  ) => {
    if (unconfirmedOperations.length > 0) return;
    if (!runCreationIntent && (
      runs.some((run) => run.purpose === purpose && ["pending", "running"].includes(
        selectedRun?.id === run.id ? selectedRun.executionOutcome : run.executionOutcome,
      )) || (selectedRun?.purpose === purpose && ["pending", "running"].includes(selectedRun.executionOutcome))
    )) return;
    if (
      runCreationIntent?.status === "committed_projection_pending" &&
      runCreationIntent.committedTargetId
    ) {
      const committedTargetId = runCreationIntent.committedTargetId;
      setBusy("generate");
      setError(null);
      try {
        runLoader.invalidate();
        selectRunId(committedTargetId);
        setSelectedRun(null);
        await Promise.all([
          loadRuns({
            preserveSelectedRunId: committedTargetId,
          }),
          loadRun(committedTargetId),
        ]);
      } catch (cause) {
        // INTENT: 这条路径的目标必然就是已提交的那一条，出口固定是旁注——不走 routeFailure，
        //         因为并发的 loadRuns 失败也应留在旁注里，不该因为 intent 恰好刚被释放
        //         就升级成主错误。
        if (!isProjectionRequestCancellation(cause)) {
          setRefreshWarning(
            committedRunProjectionUnavailable(
              cause instanceof Error ? cause.message : null,
            ),
          );
        }
      } finally {
        setBusy(null);
      }
      return;
    }
    const recovered = runCreationIntent
      ? creativeRunCreateRequestSchema.safeParse(
          runCreationIntent.requestSnapshot,
        )
      : null;
    if (
      runCreationIntent &&
      (runCreationIntent.status === "reconciliation_required" ||
        (recovered !== null && !recovered.success))
    ) {
      setBusy("generate");
      setError(null);
      setMessage(null);
      try {
        const receipt = await reconcileDurableMutationIntent({
          intent: runCreationIntent,
          commandType: "creative.run.create",
          expectedCharacterId: data.character.id,
          ...(recovered?.success &&
          isCharacterAssetPurpose(recovered.data.purpose)
            ? { expectedPurpose: recovered.data.purpose }
            : {}),
        });
        if (receipt.state === "committed") {
          if (
            !receipt.committedTargetId ||
            receipt.verification?.kind !== "creative_run" ||
            receipt.verification.runId !== receipt.committedTargetId
          ) {
            throw new Error(
              "The committed Run receipt is missing exact projection evidence. The workspace remains locked.",
            );
          }
          const trustedRequest = creativeRunCreateRequestSchema.safeParse(
            receipt.verification.requestSnapshot,
          );
          if (
            !trustedRequest.success ||
            trustedRequest.data.targetType !== "character" ||
            trustedRequest.data.targetId !== data.character.id ||
            !isCharacterAssetPurpose(trustedRequest.data.purpose)
          ) {
            throw new Error(
              "The committed Run receipt does not contain the exact Character image request. The workspace remains locked.",
            );
          }
          const committed = updateDurableMutationIntent(runCreationIntent, {
            status: "committed_projection_pending",
            committedTargetId: receipt.committedTargetId,
            requestSnapshot: trustedRequest.data,
          });
          updateRunCreationIntentState(committed);
          runLoader.invalidate();
          selectRunId(receipt.committedTargetId);
          setSelectedRun(null);
          await Promise.all([
            loadRuns({
              preserveSelectedRunId: receipt.committedTargetId,
            }),
            loadRun(receipt.committedTargetId),
          ]);
          setMessage(
            "The committed generation receipt was recovered from the server.",
          );
          return;
        }
        if (receipt.state === "cancelled") {
          clearDurableMutationIntent(runCreationIntent);
          updateRunCreationIntentState(null);
          setMessage(
            "The old generation request had no committed effect. Its key was sealed, so a new request is safe.",
          );
          return;
        }
        setError(
          receipt.state === "failed"
            ? `The saved generation command ${receipt.commandId} is terminally failed. Its key remains locked for operator investigation; do not submit a replacement Run.`
            : `The saved generation request is ${receipt.state}. Keep this workspace locked and reconcile again after the server reaches a terminal receipt.`,
        );
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The saved generation request could not be reconciled.",
        );
      } finally {
        setBusy(null);
      }
      return;
    }
    const profileId = bootstrapMode
      ? bootstrapProfile?.profileKey
      : qualifiedRoute?.generationProfileKey;
    const orientation = orientationForPurpose(purpose);
    if (
      !recovered?.success &&
      (!profileId ||
        (bootstrapMode && (!orientation || purpose !== "character_cover")))
    )
      return;
    const count = 1;
    const brief = briefs[purpose].trim();
    // SPEC: 这个 title 会写进生成请求并存到后端，不是纯 UI 文案 —— 所以不翻译。
    // INTENT: Today 页上出现的英文「… · Primary portrait」来自历史数据里存着的这个字段。
    //         翻译它只影响新数据，旧数据仍是英文，同一列会变成两种语言并存，更糟。
    //         要改得连同后端已有数据一起迁移，属另一件事。
    const title = `${subject.name} · ${purposeConfig[purpose].label}`;
    const body = recovered?.success
      ? recovered.data
      : {
          title,
          purpose,
          targetType: "character" as const,
          targetId: data.character.id,
          profileId: profileId ?? "",
          presetIds: [],
          referenceAssetIds,
          bootstrapIdentity: bootstrapMode,
          orientation,
          count,
          brief,
          ...(negativePrompts[purpose].trim()
            ? { negativePrompt: negativePrompts[purpose].trim() }
            : {}),
          consistencyMode: "strict" as const,
          priority: "normal" as const,
          reason: bootstrapMode
            ? "Create the first identity portrait"
            : referenceAssetIds.length
              ? "Create identity-preserving variations from the selected character asset"
              : "Create a customer-facing character asset pack candidate",
        };
    if (
      body.targetType !== "character" ||
      body.targetId !== data.character.id ||
      !isCharacterAssetPurpose(body.purpose)
    ) {
      setError(
        "The saved generation intent does not belong to this Character Asset Studio.",
      );
      return;
    }
    const requestKey = characterAssetRunRequestKey({
      characterId: data.character.id,
      title: body.title ?? title,
      purpose: body.purpose,
      profileId: body.profileId,
      referenceAssetIds: body.referenceAssetIds,
      bootstrapIdentity: body.bootstrapIdentity,
      orientation: body.orientation ?? "",
      count: body.count,
      brief: body.brief,
      negativePrompt: body.negativePrompt,
    });
    let intent = runCreationIntent;
    if (!intent) {
      const claim = await claimDurableMutationIntent({
        scope: `character-asset:create:${actorId}:${data.character.id}`,
        signature: requestKey,
        requestSnapshot: body,
      });
      intent = claim.intent;
      if (
        intent.signature !== requestKey ||
        ["committed_projection_pending", "reconciliation_required"].includes(
          intent.status,
        )
      ) {
        const saved = creativeRunCreateRequestSchema.safeParse(
          intent.requestSnapshot,
        );
        if (
          saved.success &&
          saved.data.targetType === "character" &&
          saved.data.targetId === data.character.id &&
          isCharacterAssetPurpose(saved.data.purpose)
        ) {
          setActivePurpose(saved.data.purpose);
          setBriefs((current) => ({
            ...current,
            [saved.data.purpose]: saved.data.brief,
          }));
          setNegativePrompts((current) => ({
            ...current,
            [saved.data.purpose]: saved.data.negativePrompt ?? "",
          }));
        }
        updateRunCreationIntentState(intent);
        setError(
          intent.status === "committed_projection_pending"
            ? "Another tab already has a committed Character Run receipt. Verify it before creating again."
            : intent.status === "reconciliation_required"
              ? "Another tab has an aged Character Run receipt. Reconcile it with the server before creating again."
              : "Another tab already started a different Character image request. Its exact context is locked for safe resume.",
        );
        return;
      }
    }
    updateRunCreationIntentState(intent);
    setBusy("generate");
    setError(null);
    setMessage(null);
    setRefreshWarning(null);
    let result: {
      readonly batch: { readonly id: string };
      readonly replayed: boolean;
    };
    try {
      result = await adminV2Operation("POST /api/v2/admin/creative/runs", {
        idempotencyKey: intent.idempotencyKey,
        body,
      });
    } catch (cause) {
      const rejectedByRuntimePreflight =
        cause instanceof AdminV2RequestError &&
        cause.status === 503 &&
        cause.code === "unavailable" &&
        cause.message.includes("No Run was created");
      if (
        cause instanceof AdminV2RequestError &&
        ([400, 401, 403, 404, 409, 422].includes(cause.status) ||
          rejectedByRuntimePreflight)
      ) {
        clearDurableMutationIntent(intent);
        updateRunCreationIntentState(null);
        setError(
          rejectedByRuntimePreflight
            ? "Image generation is offline. Restore backend health, then generate again. No Run was created."
            : cause.message,
        );
      } else {
        const unknown = updateDurableMutationIntent(intent, {
          status: "outcome_unknown",
        });
        updateRunCreationIntentState(unknown);
        setError(
          "Generation outcome is unknown. Choose Resume generation to replay the same intent without creating a duplicate Run.",
        );
      }
      setBusy(null);
      return;
    }
    const committed = updateDurableMutationIntent(intent, {
      status: "committed_projection_pending",
      committedTargetId: result.batch.id,
    });
    updateRunCreationIntentState(committed);
    setActivePurpose(body.purpose);
    setSelectedIndex(0);
    setMessage(
      body.bootstrapIdentity
        ? "First-portrait generation was committed. Results will appear here automatically."
        : body.referenceAssetIds.length
          ? "Variation run was committed from this candidate."
          : "Generation was committed. Results will appear here automatically.",
    );
    try {
      runLoader.invalidate();
      selectRunId(result.batch.id);
      setSelectedRun(null);
      await loadRuns({
        preserveSelectedRunId: result.batch.id,
      });
    } catch (refreshCause) {
      if (!isProjectionRequestCancellation(refreshCause)) {
        setRefreshWarning(
          refreshCause instanceof Error
            ? `The Run was created, but the latest projection could not be refreshed: ${refreshCause.message}. Choose Verify created Run to retry safely.`
            : "The Run was created, but the latest projection could not be refreshed. Choose Verify created Run to retry safely.",
        );
      }
    } finally {
      setBusy(null);
    }
  };

  // SPEC: 按钮要说清这一下会重跑哪一张。
  // INTENT: 它只对 recoveryPurpose 发一条 Run，但旁边写着「3 selected assets…」，
  //         「Regenerate under current route」会被读成"三张一起重跑"。
  const regenerateLabel = data.project.draftAssetRouteAuthority?.recoveryPurpose
    ? t("Regenerate {purpose}", {
        purpose: t(
          purposeConfig[data.project.draftAssetRouteAuthority.recoveryPurpose]
            .label,
        ),
      })
    : t("Regenerate under current route");

  const regenerateUnderCurrentRoute = () => {
    const purpose = data.project.draftAssetRouteAuthority?.recoveryPurpose;
    if (!purpose) return;
    choosePurpose(purpose);
    void createRun(purpose);
  };

  const refreshWorkspace = async () => {
    setError(null);
    try {
      await Promise.all([
        onProjectReload(),
        loadRuns(),
        selectedRunId ? loadRun(selectedRunId) : Promise.resolve(),
      ]);
      setRefreshWarning(null);
    } catch (cause) {
      if (isProjectionRequestCancellation(cause)) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Character assets could not be refreshed",
      );
    }
  };

  const verifyReviewIntentProjection = async (
    intent: DurableMutationIntent,
    snapshot: {
      readonly runId: string;
      readonly itemId: string;
    },
  ) => {
    runLoader.invalidate();
    selectRunId(snapshot.runId);
    const detail = await loadRun(snapshot.runId);
    await loadRuns({
      preserveSelectedRunId: snapshot.runId,
    });
    const projected = detail.items.some(
      (item) =>
        item.id === snapshot.itemId &&
        item.review?.id === intent.committedTargetId,
    );
    if (!projected) {
      throw new Error(
        "The exact review receipt is not present in the latest Run projection yet.",
      );
    }
    // The surrounding library must observe the same committed review as the inspector.
    await onProjectReload();
    clearDurableMutationIntent(intent);
    setReviewMutationIntent(null);
    setRefreshWarning(null);
    setReviewDrafts((current) => {
      const drafts = { ...current };
      delete drafts[snapshot.itemId];
      return drafts;
    });
    return detail;
  };

  const resumeReviewMutation = async () => {
    if (!permissions.review || !reviewMutationIntent) return;
    const snapshot = characterAssetReviewIntentSnapshot(
      reviewMutationIntent.requestSnapshot,
    );
    if (
      reviewMutationIntent.status === "reconciliation_required" ||
      !snapshot
    ) {
      setBusy("review");
      setError(null);
      setMessage(null);
      try {
        const receipt = await reconcileDurableMutationIntent({
          intent: reviewMutationIntent,
          commandType: "creative.review.decision",
        });
        if (receipt.state === "committed") {
          if (
            !receipt.committedTargetId ||
            receipt.verification?.kind !== "creative_review_decision" ||
            receipt.verification.decisionId !== receipt.committedTargetId
          ) {
            throw new Error(
              "The committed review receipt is missing exact projection evidence. The workspace remains locked.",
            );
          }
          const committed = updateDurableMutationIntent(reviewMutationIntent, {
            status: "committed_projection_pending",
            committedTargetId: receipt.committedTargetId,
            requestSnapshot: receipt.verification.requestSnapshot,
          });
          setReviewMutationIntent(committed);
          selectRunId(receipt.verification.runId);
          await verifyReviewIntentProjection(committed, receipt.verification);
          setMessage(
            "The committed review receipt was recovered and verified against its exact Run item.",
          );
          return;
        }
        if (receipt.state === "cancelled") {
          clearDurableMutationIntent(reviewMutationIntent);
          setReviewMutationIntent(null);
          setMessage(
            "The old review request had no committed effect. Its key was sealed, so a new decision is safe.",
          );
          return;
        }
        setError(
          receipt.state === "failed"
            ? `The saved review command ${receipt.commandId} is terminally failed. Its key remains locked for operator investigation; do not submit a replacement decision.`
            : `The saved review request is ${receipt.state}. Keep this workspace locked and reconcile again after the server reaches a terminal receipt.`,
        );
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The saved review request could not be reconciled.",
        );
      } finally {
        setBusy(null);
      }
      return;
    }
    setBusy("review");
    setError(null);
    setRefreshWarning(null);
    let currentIntent = reviewMutationIntent;
    try {
      if (reviewMutationIntent.status === "committed_projection_pending") {
        await verifyReviewIntentProjection(reviewMutationIntent, snapshot);
        return;
      }
      const result = await adminV2Operation(
        "POST /api/v2/admin/creative/runs/:id/items/:itemId/decisions",
        {
          path: { id: snapshot.runId, itemId: snapshot.itemId },
          idempotencyKey: reviewMutationIntent.idempotencyKey,
          body: snapshot.body,
        },
      );
      const committed = updateDurableMutationIntent(reviewMutationIntent, {
        status: "committed_projection_pending",
        committedTargetId: result.decisionId,
      });
      currentIntent = committed;
      setReviewMutationIntent(committed);
      await verifyReviewIntentProjection(committed, snapshot);
    } catch (cause) {
      if (currentIntent.status === "committed_projection_pending") {
        setRefreshWarning(
          cause instanceof Error
            ? `The review was committed, but verification is still pending: ${cause.message}`
            : "The review was committed, but verification is still pending.",
        );
      } else if (
        cause instanceof AdminV2RequestError &&
        [400, 401, 403, 404, 409, 422].includes(cause.status)
      ) {
        clearDurableMutationIntent(currentIntent);
        setReviewMutationIntent(null);
        setError(cause.message);
      } else {
        const unknown = updateDurableMutationIntent(currentIntent, {
          status: "outcome_unknown",
        });
        setReviewMutationIntent(unknown);
        setError(
          "Review outcome remains unknown. Resume will continue to reuse the same request key.",
        );
      }
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (
      !selectionMutationIntent ||
      selectionMutationIntent.status !== "committed_projection_pending"
    ) {
      return;
    }
    const snapshot = characterAssetSelectionIntentSnapshot(
      selectionMutationIntent.requestSnapshot,
    );
    const recoveryVerification = characterAssetSelectionRecoveryVerification(
      selectionMutationIntent.requestSnapshot,
    );
    if (!snapshot && !recoveryVerification) return;
    const projected = recoveryVerification
      ? recoveryVerification.characterId === data.character.id &&
        (recoveryVerification.kind === "character_identity_bootstrap"
          ? data.visual.activeReferenceSet?.id ===
              recoveryVerification.referenceSetRevisionId &&
            data.visual.activeReferenceSet.references.some(
              (reference) =>
                reference.mediaAssetId === recoveryVerification.anchorAssetId,
            ) &&
            data.project.draftImageAssetId ===
              recoveryVerification.draftImageAssetId &&
            data.project.draftAssetPack.character_cover ===
              recoveryVerification.draftImageAssetId &&
            data.visual.activeIdentity !== null
          : isCharacterAssetPurpose(recoveryVerification.selectedPurpose) &&
            data.project.draftAssetPack[
              recoveryVerification.selectedPurpose
            ] === recoveryVerification.selectedAssetId &&
            data.project.draftAssetSelections?.[
              recoveryVerification.selectedPurpose
            ]?.assetId === recoveryVerification.selectedAssetId)
      : snapshot
        ? snapshot.kind === "bootstrap"
          ? data.visual.activeReferenceSet?.id ===
              selectionMutationIntent.committedTargetId &&
            data.project.draftAssetPack.character_cover ===
              snapshot.body.assetId &&
            data.visual.activeIdentity !== null
          : (() => {
              const selection =
                data.project.draftAssetSelections?.[snapshot.body.purpose];
              return (
                data.project.draftAssetPack[snapshot.body.purpose] ===
                  snapshot.body.assetId &&
                selection?.runId === snapshot.body.runId &&
                selection?.itemId === snapshot.body.itemId &&
                (selection?.reviewDecisionId ?? null) ===
                  (snapshot.body.reviewDecisionId ?? null)
              );
            })()
        : false;
    if (!projected) return;
    const timer = window.setTimeout(() => {
      clearDurableMutationIntent(selectionMutationIntent);
      setSelectionMutationIntent(null);
      setRefreshWarning(null);
      setMessage(
        recoveryVerification?.kind === "character_identity_bootstrap" ||
          snapshot?.kind === "bootstrap"
          ? "Identity bootstrap authority is verified in the Character workspace."
          : "The exact draft asset selection is verified in the Character workspace.",
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    data.character.id,
    data.project.draftAssetPack,
    data.project.draftAssetSelections,
    data.project.draftImageAssetId,
    data.visual.activeIdentity,
    data.visual.activeReferenceSet?.id,
    data.visual.activeReferenceSet?.references,
    selectionMutationIntent,
  ]);

  const resumeSelectionMutation = async () => {
    if (!permissions.selectDraft || !selectionMutationIntent) return;
    const snapshot = characterAssetSelectionIntentSnapshot(
      selectionMutationIntent.requestSnapshot,
    );
    const recoveryVerification = characterAssetSelectionRecoveryVerification(
      selectionMutationIntent.requestSnapshot,
    );
    if (
      selectionMutationIntent.status === "reconciliation_required" ||
      (!snapshot && !recoveryVerification)
    ) {
      setBusy("select");
      setError(null);
      setMessage(null);
      try {
        let commandType = characterAssetSelectionIntentCommandType(
          selectionMutationIntent,
        );
        let receipt: Awaited<ReturnType<typeof reconcileDurableMutationIntent>>;
        try {
          receipt = await reconcileDurableMutationIntent({
            intent: selectionMutationIntent,
            commandType,
            expectedCharacterId: data.character.id,
          });
        } catch (cause) {
          const details =
            cause instanceof AdminV2RequestError &&
            cause.status === 409 &&
            cause.details &&
            typeof cause.details === "object" &&
            !Array.isArray(cause.details)
              ? (cause.details as Record<string, unknown>)
              : null;
          const existingCommandType = details?.existingCommandType;
          if (
            existingCommandType !== "character.identity.bootstrap" &&
            existingCommandType !== "character.project.draft_image.select"
          ) {
            throw cause;
          }
          commandType = existingCommandType;
          receipt = await reconcileDurableMutationIntent({
            intent: selectionMutationIntent,
            commandType,
            expectedCharacterId: data.character.id,
          });
        }
        if (receipt.state === "committed") {
          const verification = receipt.verification;
          const matchesBootstrap =
            commandType === "character.identity.bootstrap" &&
            verification?.kind === "character_identity_bootstrap" &&
            verification.characterId === data.character.id &&
            verification.referenceSetRevisionId === receipt.committedTargetId;
          const matchesDraftSelection =
            commandType === "character.project.draft_image.select" &&
            verification?.kind === "character_draft_image_selection" &&
            verification.characterId === data.character.id &&
            verification.selectedAssetId === receipt.committedTargetId;
          if (
            !receipt.committedTargetId ||
            (!matchesBootstrap && !matchesDraftSelection)
          ) {
            throw new Error(
              "The committed selection receipt is missing exact Character projection evidence. The workspace remains locked.",
            );
          }
          const committed = updateDurableMutationIntent(
            selectionMutationIntent,
            {
              status: "committed_projection_pending",
              committedTargetId: receipt.committedTargetId,
              requestSnapshot: verification,
            },
          );
          setSelectionMutationIntent(committed);
          await Promise.all([onProjectReload(), loadRuns()]);
          setMessage(
            "The committed selection receipt was recovered. It remains locked until the exact Character authority is visible.",
          );
          return;
        }
        if (receipt.state === "cancelled") {
          clearDurableMutationIntent(selectionMutationIntent);
          setSelectionMutationIntent(null);
          setMessage(
            "The old selection request had no committed effect. Its key was sealed, so a new selection is safe.",
          );
          return;
        }
        setError(
          receipt.state === "failed"
            ? `The saved selection command ${receipt.commandId} is terminally failed. Its key remains locked for operator investigation; do not submit a replacement selection.`
            : `The saved selection request is ${receipt.state}. Keep this workspace locked and reconcile again after the server reaches a terminal receipt.`,
        );
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The saved selection request could not be reconciled.",
        );
      } finally {
        setBusy(null);
      }
      return;
    }
    if (!snapshot) {
      setBusy("select");
      setError(null);
      try {
        await onProjectReload();
      } catch (cause) {
        setRefreshWarning(
          cause instanceof Error
            ? `Selection authority is still refreshing: ${cause.message}`
            : "Selection authority is still refreshing.",
        );
      } finally {
        setBusy(null);
      }
      return;
    }
    setBusy("select");
    setError(null);
    let currentIntent = selectionMutationIntent;
    try {
      if (currentIntent.status === "committed_projection_pending") {
        await onProjectReload();
        return;
      }
      await commitProjectMutation({
        action:
          snapshot.kind === "bootstrap"
            ? "Identity bootstrap recovery"
            : "Draft asset selection recovery",
        commit: async () => {
          if (snapshot.kind === "bootstrap") {
            const result = await adminV2Operation(
              "POST /api/v2/admin/characters/:id/identity-bootstrap",
              {
                path: { id: data.character.id },
                idempotencyKey: currentIntent.idempotencyKey,
                ifMatch: snapshot.body.entityVersion,
                body: snapshot.body,
              },
            );
            currentIntent = updateDurableMutationIntent(currentIntent, {
              status: "committed_projection_pending",
              committedTargetId: result.referenceSetRevisionId,
            });
            setSelectionMutationIntent(currentIntent);
            return result;
          }
          const result = await adminV2Operation(
            "PATCH /api/v2/admin/characters/:id/draft-image",
            {
              path: { id: data.character.id },
              idempotencyKey: currentIntent.idempotencyKey,
              ifMatch: snapshot.body.entityVersion,
              body: snapshot.body,
            },
          );
          currentIntent = updateDurableMutationIntent(currentIntent, {
            status: "committed_projection_pending",
            committedTargetId: result.selectedAssetId,
          });
          setSelectionMutationIntent(currentIntent);
          return result;
        },
      });
    } catch (cause) {
      if (currentIntent.status === "committed_projection_pending") {
        setRefreshWarning(
          cause instanceof Error
            ? `Selection was committed, but authority verification is still pending: ${cause.message}`
            : "Selection was committed, but authority verification is still pending.",
        );
      } else if (
        cause instanceof AdminV2RequestError &&
        [400, 401, 403, 404, 409, 422].includes(cause.status)
      ) {
        clearDurableMutationIntent(currentIntent);
        setSelectionMutationIntent(null);
        setError(cause.message);
      } else {
        currentIntent = updateDurableMutationIntent(currentIntent, {
          status: "outcome_unknown",
        });
        setSelectionMutationIntent(currentIntent);
        setError(
          "Selection outcome remains unknown. Resume will continue to reuse the same request key.",
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const approveAndContinue = async () => {
    if (selectionMutationIntent) {
      await resumeSelectionMutation();
      return;
    }
    if (refreshWarning) return;
    if (!activeRunDetail || !selectedItem?.asset) return;
    const selectedAsset = selectedItem.asset;
    if (isSelectedAsset) {
      if (advanceTargetPurpose) choosePurpose(advanceTargetPurpose);
      else onContinue("preview");
      return;
    }
    if (!isApprovedItem) return;
    if (!permissions.selectDraft) return;
    const nextIdentityVersion = identityBootstrap.nextIdentityVersion;
    const bootstrapReason = `Establish the selected first portrait as identity version ${nextIdentityVersion} and the next Release primary image`;
    const bootstrapBody = {
      entityVersion: data.project.version,
      runId: activeRunDetail.id,
      itemId: selectedItem.id,
      assetId: selectedAsset.id,
      ...(selectedItem.review?.id
        ? { reviewDecisionId: selectedItem.review.id }
        : {}),
      reason: bootstrapReason,
      confirmation: `BOOTSTRAP IDENTITY ${data.character.id}`,
    };
    const draftSelectionBody = {
      entityVersion: data.project.version,
      purpose: activePurpose,
      runId: activeRunDetail.id,
      itemId: selectedItem.id,
      assetId: selectedAsset.id,
      ...(selectedItem.review?.id
        ? { reviewDecisionId: selectedItem.review.id }
        : {}),
      reason: `Operator selected ${activeConfig.label.toLowerCase()} for the next Character Release`,
    };
    const selectionSignature = bootstrapMode
      ? characterAssetBootstrapRequestKey({
          characterId: data.character.id,
          entityVersion: bootstrapBody.entityVersion,
          runId: bootstrapBody.runId,
          itemId: bootstrapBody.itemId,
          assetId: bootstrapBody.assetId,
          reviewDecisionId: bootstrapBody.reviewDecisionId,
          reason: bootstrapReason,
        })
      : characterAssetDraftSelectionRequestKey({
          characterId: data.character.id,
          body: draftSelectionBody,
        });
    const selectionSnapshot = bootstrapMode
      ? { kind: "bootstrap" as const, body: bootstrapBody }
      : {
          kind: "draft_selection" as const,
          body: draftSelectionBody,
        };
    const claim = await claimDurableMutationIntent({
      scope: `character-asset:selection:${actorId}:${data.character.id}`,
      signature: selectionSignature,
      requestSnapshot: selectionSnapshot,
    });
    const intent = claim.intent;
    if (
      intent.signature !== selectionSignature ||
      ["committed_projection_pending", "reconciliation_required"].includes(
        intent.status,
      )
    ) {
      setSelectionMutationIntent(intent);
      setError(
        intent.status === "committed_projection_pending"
          ? "Another tab already committed an asset selection receipt. Verify it before selecting again."
          : intent.status === "reconciliation_required"
            ? "Another tab has an aged asset-selection receipt. Reconcile it with the server before selecting again."
            : "Another tab already started a different asset selection. Resume its exact locked request first.",
      );
      return;
    }
    setSelectionMutationIntent(intent);
    setBusy("select");
    setError(null);
    let committedIntent: DurableMutationIntent | null = null;
    try {
      await commitProjectMutation({
        action: bootstrapMode
          ? "Identity bootstrap selection"
          : `${activeConfig.label} selection`,
        commit: async () => {
          if (bootstrapMode) {
            const mutation = characterIdentityBootstrapMutation(
              data.character.id,
              data.project.version,
              activeRunDetail.id,
              selectedItem.id,
              selectedAsset.id,
              selectedItem.review?.id,
              bootstrapReason,
              intent.idempotencyKey,
            );
            const result = await adminV2Operation(
              mutation.operationId,
              mutation.options,
            );
            committedIntent = updateDurableMutationIntent(intent, {
              status: "committed_projection_pending",
              committedTargetId: result.referenceSetRevisionId,
            });
            setSelectionMutationIntent(committedIntent);
            setMessage(
              `Identity version ${nextIdentityVersion}, its sealed Reference Set, and the draft primary image were committed.`,
            );
            return result;
          }
          const result = await adminV2Operation(
            "PATCH /api/v2/admin/characters/:id/draft-image",
            {
              path: { id: data.character.id },
              idempotencyKey: intent.idempotencyKey,
              ifMatch: data.project.version,
              body: draftSelectionBody,
            },
          );
          committedIntent = updateDurableMutationIntent(intent, {
            status: "committed_projection_pending",
            committedTargetId: result.selectedAssetId,
          });
          setSelectionMutationIntent(committedIntent);
          setMessage(
            `${activeConfig.label} was committed to the next Character Release draft.`,
          );
          return result;
        },
        afterRefresh: () => {
          setRefreshWarning(null);
          if (activePurpose === "character_cover") {
            choosePurpose("character_hero", {
              identityCommitted: bootstrapMode,
            });
          } else if (activePurpose === "character_hero") {
            choosePurpose("character_chat");
          } else {
            onContinue("preview");
          }
        },
      });
    } catch (cause) {
      if (
        intent &&
        cause instanceof AdminV2RequestError &&
        [400, 401, 403, 404, 409, 422].includes(cause.status)
      ) {
        clearDurableMutationIntent(intent);
        setSelectionMutationIntent(null);
        setError(cause.message);
      } else if (intent) {
        const unknown = updateDurableMutationIntent(intent, {
          status: "outcome_unknown",
        });
        setSelectionMutationIntent(unknown);
        setError(
          "Selection outcome is unknown. Repeat the same selection to resume it with the same idempotency key.",
        );
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : "Character asset could not be selected",
        );
      }
    } finally {
      setBusy(null);
    }
  };

  if (!permissions.read)
    return (
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8">
        <ShieldAlert className="h-6 w-6" />
        <h3 className="mt-4 font-semibold">
          {t("No asset workspace permission")}
        </h3>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
          {t("creative.run.read is required to see character production.")}
        </p>
      </section>
    );
  if (loading)
    return (
      <section
        aria-busy="true"
        className="grid min-h-80 place-items-center rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
        role="status"
      >
        <span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />{" "}
          {t("Loading character assets")}
        </span>
      </section>
    );
  const runIntentNeedsReconciliation = Boolean(
    runCreationIntent &&
    (runCreationIntent.status === "reconciliation_required" ||
      !creativeRunCreateRequestSchema.safeParse(
        runCreationIntent.requestSnapshot,
      ).success),
  );
  const reviewIntentNeedsReconciliation = Boolean(
    reviewMutationIntent &&
    (reviewMutationIntent.status === "reconciliation_required" ||
      !characterAssetReviewIntentSnapshot(
        reviewMutationIntent.requestSnapshot,
      )),
  );
  const selectionIntentNeedsReconciliation = Boolean(
    selectionMutationIntent &&
    (selectionMutationIntent.status === "reconciliation_required" ||
      (!characterAssetSelectionIntentSnapshot(
        selectionMutationIntent.requestSnapshot,
      ) &&
        !characterAssetSelectionRecoveryVerification(
          selectionMutationIntent.requestSnapshot,
        ))),
  );
  const generationActionLabel = runIntentNeedsReconciliation
    ? "Reconcile saved request"
    : runCreationIntent?.status === "outcome_unknown" ||
        runCreationIntent?.status === "submitting"
      ? "Resume generation"
      : runCreationIntent?.status === "committed_projection_pending"
        ? "Verify created Run"
        : unconfirmedOperations.length > 0
          ? "Generation result awaiting confirmation"
          : imageRequestInProgress
          ? "Image request in progress"
          : `Generate 1 ${activeConfig.pluralLabel}`;
  const generationActionText = generationActionLabel.startsWith("Generate ")
    ? t("Generate {count} {assetType}", {
        count: 1,
        assetType: t(activeConfig.pluralLabel),
      })
    : t(generationActionLabel);
  const generationActionDescriptionId = `character-generation-action-${data.character.id}`;
  const generationActionDisabled =
    !canUseGenerationAction ||
    unconfirmedOperations.length > 0 ||
    busy !== null ||
    (!runCreationIntent && !briefs[activePurpose].trim()) ||
    Boolean(selectionMutationIntent);
  const generationActionDescription =
    unconfirmedOperations.length > 0
      ? "The provider result is not confirmed. Check the generation task before starting another image."
      : busy !== null
      ? "Wait for the current image-production action to finish."
      : selectionMutationIntent
          ? "Resolve the saved selection before starting another generation."
          : !permissions.create
            ? "creative.run.create permission is required."
            : !runCreationIntent && !briefs[activePurpose].trim()
              ? "Add a focused generation brief first."
              : bootstrapMode && !bootstrapProfile
                ? "Publish an active text-to-image bootstrap profile first."
                : bootstrapMode && activePurpose !== "character_cover"
                  ? "Commit the first identity portrait before generating the remaining asset pack."
                  : productionBlocked
                    ? "Complete the Character image-readiness actions first."
                    : refreshWarning
                      ? "Refresh the workspace before starting another generation."
                      : !qualifiedRoute && !bootstrapMode
                        ? "Qualify a generation route for this Character first."
                        : "The generation runtime is checked before any Run is created.";

  return (
    <div className="space-y-4 pb-12">
      {error ? (
        <p
          className="rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {t(error)}
        </p>
      ) : null}
      {message ? (
        <p
          className="rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
          role="status"
        >
          {t(message)}
        </p>
      ) : null}
      {!recurringProductionReady ? (
        <section
          aria-labelledby="asset-pack-title"
          className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
        >
          <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
                {t(
                  bootstrapMode
                    ? "First identity portrait"
                    : productionBlocked
                      ? imageProductionRepairable
                        ? "Enable image production"
                        : "Image production setup"
                      : "Ready for ongoing image production",
                )}
              </p>
              <h3 className="mt-1 text-xl font-semibold" id="asset-pack-title">
                {t(
                  bootstrapMode
                    ? "Establish the face customers will recognize"
                    : productionBlocked
                      ? imageProductionRepairable
                        ? "Use the current live portrait for future image generation"
                        : "Finish visual setup before creating more images"
                      : "{name}'s images",
                  { name: subject.name },
                )}
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
                {t(
                  bootstrapMode
                    ? "Generate the first portrait without references, compare the results, then use one as identity version {version}."
                    : productionBlocked
                      ? imageProductionRepairable
                        ? "Seal the existing live portrait as the reusable identity reference. Current live images and releases will not change."
                        : "Complete the current visual setup action once. Existing live images and releases will not change."
                      : "Generate images from the current identity, compare them, and choose which to use in the draft image set.",
                  { version: identityBootstrap.nextIdentityVersion },
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <WorkspaceButton
                disabled={busy !== null}
                onClick={() => void refreshWorkspace()}
              >
                <RefreshCcw className="h-4 w-4" /> {t("Refresh")}
              </WorkspaceButton>
              {bootstrapMode ? (
                <WorkspaceButton
                  aria-describedby={
                    generationActionDisabled
                      ? generationActionDescriptionId
                      : undefined
                  }
                  disabled={generationActionDisabled}
                  onClick={() => void createRun(activePurpose)}
                  tone="primary"
                >
                  <WandSparkles className="h-4 w-4" /> {generationActionText}
                </WorkspaceButton>
              ) : null}
            </div>
          </div>
          {generationActionDisabled ? (
            <p className="sr-only" id={generationActionDescriptionId}>
              {t(generationActionDescription)}
            </p>
          ) : null}
          {bootstrapMode ? (
            <div
              className={cn(
                "mx-4 mb-4 rounded-lg p-3 text-sm sm:mx-5",
                bootstrapProfile
                  ? "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
                  : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
              )}
            >
              <p>
                {bootstrapProfile
                  ? `${bootstrapProfile.label} · ${bootstrapProfile.orientation} · ${t(
                      identityBootstrap.state === "recoverable_empty_history"
                        ? "No reference image is needed. Your selected portrait becomes identity version {version}; earlier candidates remain in history."
                        : "No reference image is needed. Your selected portrait becomes the reference for later images.",
                      { version: identityBootstrap.nextIdentityVersion },
                    )}`
                  : t(
                      "No active text-to-image bootstrap profile is available. Generation remains blocked until one is published.",
                    )}
              </p>
              {bootstrapProfile ? (
                <p className="mt-1 text-xs">
                  {t(
                    "The generation runtime is checked before any Run is created.",
                  )}
                </p>
              ) : null}
            </div>
          ) : !productionOnly &&
            data.project.draftAssetRouteAuthority?.status === "stale" ? (
            <div className="mx-4 mb-4 flex flex-col gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:mx-5 sm:flex-row sm:items-center sm:justify-between">
              <span>
                {t(
                  `The active image route changed. ${data.project.draftAssetRouteAuthority.stalePurposes.length} selected asset${data.project.draftAssetRouteAuthority.stalePurposes.length === 1 ? "" : "s"} remain in history but cannot be published.`,
                )}
              </span>
              <WorkspaceButton
                disabled={!canGenerate || busy !== null}
                onClick={regenerateUnderCurrentRoute}
              >
                {regenerateLabel}
              </WorkspaceButton>
            </div>
          ) : productionBlocked ? (
            <div className="mx-4 mb-4 sm:mx-5">
              <ImageProductionReadinessCard
                blockers={data.visual.readiness.blockers}
                canRepair={
                  data.visual.imageReadiness?.state === "repairable" &&
                  permissions.selectDraft
                }
                descriptionId={readinessDescriptionId}
                onContinue={() => onContinue("visual")}
                onRepair={() => void prepareImageProduction()}
                repairing={busy === "prepare"}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {!productionOnly &&
      recurringProductionReady &&
      data.project.draftAssetRouteAuthority?.status === "stale" ? (
        <div className="flex flex-col gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:flex-row sm:items-center sm:justify-between">
          <span>
            {t(
              `The active image route changed. ${data.project.draftAssetRouteAuthority.stalePurposes.length} selected asset${data.project.draftAssetRouteAuthority.stalePurposes.length === 1 ? "" : "s"} remain in history but cannot be published.`,
            )}
          </span>
          <WorkspaceButton
            disabled={!canGenerate || busy !== null}
            onClick={regenerateUnderCurrentRoute}
          >
            {regenerateLabel}
          </WorkspaceButton>
        </div>
      ) : null}

      <IdentityRail data={data} onRepair={() => onContinue("visual")} />

      {runCreationIntent?.committedTargetId ? (
        <p
          className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm"
          role="status"
        >
          {t("Created Run receipt:")}{" "}
          <span className="font-medium">
            {runCreationIntent.committedTargetId}
          </span>
          {t(
            ". Verify its projection before starting another generation intent.",
          )}
        </p>
      ) : null}
      {!productionOnly && reviewMutationIntent ? (
        <div
          className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <span>
            {reviewIntentNeedsReconciliation
              ? t(
                  "This saved review is aged or no longer matches the active contract. Reconcile its server receipt before another decision.",
                )
              : reviewMutationIntent.status === "committed_projection_pending"
                ? t(
                    "Review receipt is committed; verify the exact decision in the latest Run projection.",
                  )
                : t(
                    "Review submission is ready to resume with the same request key.",
                  )}
          </span>
          <WorkspaceButton
            disabled={!permissions.review || busy !== null}
            onClick={() => void resumeReviewMutation()}
          >
            {reviewIntentNeedsReconciliation
              ? t("Reconcile review")
              : reviewMutationIntent.status === "committed_projection_pending"
                ? t("Verify review")
                : t("Resume review")}
          </WorkspaceButton>
        </div>
      ) : null}
      {selectionMutationIntent ? (
        <div
          className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <span>
            {selectionIntentNeedsReconciliation
              ? t(
                  "This saved selection is aged or no longer matches the active contract. Reconcile its server receipt before another selection.",
                )
              : selectionMutationIntent.status ===
                  "committed_projection_pending"
                ? t(
                    "Selection receipt is committed; verify it against current Character authority.",
                  )
                : t(
                    "Asset selection is ready to resume with the same request key.",
                  )}
          </span>
          <WorkspaceButton
            disabled={!permissions.selectDraft || busy !== null}
            onClick={() => void resumeSelectionMutation()}
          >
            {selectionIntentNeedsReconciliation
              ? t("Reconcile selection")
              : selectionMutationIntent.status ===
                  "committed_projection_pending"
                ? t("Verify selection")
                : t("Resume selection")}
          </WorkspaceButton>
        </div>
      ) : null}
      {refreshWarning ? (
        <p
          className="rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"
          role="status"
        >
          {refreshWarning}
        </p>
      ) : null}
      <div className={characterAssetStudioLayoutClass}>
        <section aria-labelledby="candidate-title" className="min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3 pb-3">
            <div>
              <h3 className="font-semibold" id="candidate-title">
                {productionBlocked
                  ? t("Candidate history is paused")
                  : activeRunDetail?.items.length
                    ? t("{count} recent images", {
                        count: activeRunDetail.items.length,
                      })
                    : existingImages.length
                      ? t("{count} images", { count: existingImages.length })
                      : t("Ready for a first run")}
              </h3>
              <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                {t(activeConfig.label)}
              </p>
            </div>
            {activeRunDetail ? (
              <div className="flex flex-wrap gap-2">
                {activeRunDetail.items.some((item) => !item.asset && unconfirmedOperations.some((operation) => operation.requestId === item.lineage?.requestId))
                  ? <span className="rounded bg-[var(--ad-yellow-bg)] px-2 py-1 text-xs">{t("Generation result awaiting confirmation")}</span>
                  : <StatusBadge value={activeRunDetail.executionOutcome} />}
                <StatusBadge value={activeRunDetail.reviewState} />
              </div>
            ) : null}
          </div>

          {!bootstrapMode &&
          qualifiedRoute &&
          selectedItem &&
          !variationRouteReady ? (
            <div className="mt-3 flex flex-col gap-2 rounded-lg bg-[var(--ad-blue-bg)] p-3 text-xs leading-5 text-[var(--ad-blue-text)] sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold">{t("More like this unavailable")}</p>
                <p className="mt-1">
                  {t(
                    characterSourceVariationBlockerMessage(variationRouteBlocker),
                  )}
                </p>
                <p className="mt-1">
                  {t(characterSourceVariationAvailabilityMessage())}
                </p>
              </div>
              <WorkspaceButton onClick={() => onContinue("visual")}>
                {t("Review generation route")}
              </WorkspaceButton>
            </div>
          ) : null}

          <div className="mt-1">
            {productionBlocked ? (
              <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-[var(--ad-border)] bg-black/[0.02] px-6 py-8 text-center text-[var(--ad-text-muted)]">
                <div>
                  <ShieldAlert className="mx-auto h-6 w-6" />
                  <p className="mt-3 text-sm font-semibold">
                    {t("Image production is waiting for visual setup")}
                  </p>
                  <p className="mt-1 max-w-md text-xs leading-5">
                    {t(
                      "Complete the readiness steps above; candidate generation will appear here when the character is ready.",
                    )}
                  </p>
                </div>
              </div>
            ) : selectedItem?.asset && comparisonItem?.asset ? (
              <CandidateComparisonStage
                activeItem={selectedItem}
                activePurpose={activePurpose}
                comparisonItem={comparisonItem}
                onClose={() => setComparisonItemId(null)}
                onUseComparison={() => {
                  const comparisonIndex =
                    activeRunDetail?.items.findIndex(
                      (item) => item.id === comparisonItem.id,
                    ) ?? -1;
                  if (comparisonIndex >= 0) activateCandidate(comparisonIndex);
                }}
                subjectName={subject.name}
              />
            ) : activeRunDetail?.items.length ? (
              <CandidateBatchGrid
                activeItemId={selectedItem?.id ?? null}
                activePurpose={activePurpose}
                comparisonItemId={comparisonItemId}
                disabled={mutationContextLocked}
                items={activeRunDetail.items}
                onActivate={activateCandidate}
                onCompare={toggleCandidateComparison}
                runId={activeRunDetail.id}
                selectedPackAssetId={selectedPackAssetId}
                subjectName={subject.name}
                unconfirmedOperations={unconfirmedOperations}
              />
            ) : selectedExistingImage ? (
              <div aria-label={t("Character image library")}>
                <div
                  className="overflow-hidden rounded-lg bg-black/[0.04]"
                  style={{ height: "min(500px, 60vh)" }}
                >
                  <AssetImage
                    alt={t("{name} image {number}", {
                      name: subject.name,
                      number: existingImages.indexOf(selectedExistingImage) + 1,
                    })}
                    className="h-full w-full object-contain"
                    src={selectedExistingImage.url}
                  />
                </div>
                <div
                  className="mt-3 flex gap-2 overflow-x-auto pb-1"
                  role="list"
                >
                  {existingImages.map((image, index) => (
                    <div
                      className="w-24 shrink-0"
                      key={image.id}
                      role="listitem"
                    >
                      <button
                        aria-label={t("Open image {number}", {
                          number: index + 1,
                        })}
                        aria-pressed={image.id === selectedExistingImage.id}
                        className={cn(
                          "w-full overflow-hidden rounded-md border bg-black/[0.04] p-0.5 transition focus-visible:outline focus-visible:outline-2",
                          image.id === selectedExistingImage.id
                            ? "border-[var(--ad-ink)] ring-1 ring-[var(--ad-ink)]"
                            : "border-[var(--ad-border)] hover:border-[var(--ad-text-muted)]",
                        )}
                        onClick={() => setSelectedExistingImageId(image.id)}
                        type="button"
                      >
                        <AssetImage
                          alt={t("{name} thumbnail {number}", {
                            name: subject.name,
                            number: index + 1,
                          })}
                          className="aspect-square w-full rounded-[4px] object-cover"
                          src={image.thumbnailUrl}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-[var(--ad-border)] bg-black/[0.02] px-6 text-center text-[var(--ad-text-muted)]">
                <div>
                  <Sparkles className="mx-auto h-7 w-7" />
                  <p className="mt-3 text-sm">
                    {t("Generate an image, then choose whether to use it.")}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        {recurringProductionReady &&
        (productionOnly || workspaceMode === "library") ? (
          <aside
            className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 xl:sticky xl:top-24"
            aria-labelledby="new-image-title"
          >
            {!productionOnly ? (
              <div
                className="flex border-b border-[var(--ad-border)]"
                role="tablist"
                aria-label={t("Image inspector mode")}
              >
                <button
                  aria-selected={false}
                  className="min-h-11 border-b-2 border-transparent px-3 text-sm text-[var(--ad-text-muted)] disabled:opacity-40"
                  disabled={!selectedItem?.asset}
                  onClick={() => setWorkspaceMode("review")}
                  role="tab"
                  type="button"
                >
                  {t("Inspect")}
                </button>
                <button
                  aria-selected="true"
                  className="min-h-11 border-b-2 border-[var(--ad-ink)] px-3 text-sm font-semibold"
                  role="tab"
                  type="button"
                >
                  {t("New image")}
                </button>
              </div>
            ) : null}
            <h3 className="sr-only" id="new-image-title">
              {t("New image")}
            </h3>
            <label className="mt-5 block text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("What should be different this time?")}
              <textarea
                aria-label={`${t(activeConfig.label)} ${t("creative brief")}`}
                className={`${textAreaClass} mt-1 min-h-36`}
                disabled={mutationContextLocked}
                onChange={(event) =>
                  setBriefs((current) => ({
                    ...current,
                    [activePurpose]: event.target.value,
                  }))
                }
                value={briefs[activePurpose]}
              />
            </label>
            <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
              {t("Aspect ratio")}: {orientationForPurpose(activePurpose) ?? t("Default")}
            </p>
            <details className="mt-4 border-t border-[var(--ad-border)] pt-3 text-xs">
              <summary className="cursor-pointer font-semibold">
                {t("Settings")}
              </summary>
              <label className="mt-3 block font-semibold text-[var(--ad-text-muted)]">
                {t("Negative prompt")}
                <textarea
                  aria-label={t("Negative prompt")}
                  className={`${textAreaClass} mt-1 min-h-24`}
                  disabled={mutationContextLocked}
                  onChange={(event) =>
                    setNegativePrompts((current) => ({
                      ...current,
                      [activePurpose]: event.target.value,
                    }))
                  }
                  value={negativePrompts[activePurpose]}
                />
              </label>
              <p className="mt-2 leading-5 text-[var(--ad-text-muted)]">
                {t(
                  "Identity and quality safeguards are automatic. Add only exclusions specific to this image.",
                )}
              </p>
            </details>
            <WorkspaceButton
              aria-describedby={
                generationActionDisabled
                  ? generationActionDescriptionId
                  : undefined
              }
              className="mt-5 w-full justify-center"
              disabled={generationActionDisabled}
              onClick={() => void createRun(activePurpose)}
              tone="primary"
            >
              <WandSparkles className="h-4 w-4" /> {generationActionText}
            </WorkspaceButton>
            {!productionOnly && selectedItem?.asset ? (
              <button
                className="mt-3 min-h-10 w-full text-center text-xs font-semibold text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"
                onClick={() => setWorkspaceMode("review")}
                type="button"
              >
                {t("Cancel")}
              </button>
            ) : null}
          </aside>
        ) : productionOnly &&
          bootstrapMode &&
          !productionBlocked &&
          selectedItem?.asset ? (
          <aside className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 xl:sticky xl:top-24">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">
              {t("First identity portrait")}
            </p>
            <h4 className="mt-1 font-semibold">
              {t("Use this image as the Character identity?")}
            </h4>
            <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
              {t(
                "This choice defines the face used for future image creation. You can create more candidates before choosing.",
              )}
            </p>
            <WorkspaceButton
              className="mt-4 w-full justify-center"
              disabled={!canUseDecisionAction || busy !== null}
              onClick={() => void approveAndContinue()}
              tone="primary"
            >
              {busy === "select" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              {t("Set as identity")}
            </WorkspaceButton>
          </aside>
        ) : !productionBlocked && selectedItem?.asset ? (
          <aside
            className="space-y-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 xl:sticky xl:top-24"
            aria-label={t("Current candidate decision inspector")}
          >
            {recurringProductionReady ? (
              <div
                className="flex border-b border-[var(--ad-border)]"
                role="tablist"
                aria-label={t("Image inspector mode")}
              >
                <button
                  aria-selected="true"
                  className="min-h-11 border-b-2 border-[var(--ad-ink)] px-3 text-sm font-semibold"
                  role="tab"
                  type="button"
                >
                  {t("Inspect")}
                </button>
                <button
                  aria-selected={false}
                  className="min-h-11 border-b-2 border-transparent px-3 text-sm text-[var(--ad-text-muted)]"
                  onClick={() => setWorkspaceMode("library")}
                  role="tab"
                  type="button"
                >
                  {t("New image")}
                </button>
              </div>
            ) : null}
            <p className="text-sm leading-6 text-[var(--ad-text-muted)]">
              {t("Choose the image that fits this Character. Selection updates the draft; publishing updates the live Character.")}
            </p>
            {!permissions.selectDraft ? <p className="text-sm">{t("Character editing permission is required to select an image.")}</p> : null}
          </aside>
        ) : null}
      </div>

      {!productionOnly &&
      selectedItem &&
      !productionBlocked &&
      (!recurringProductionReady || workspaceMode === "review") ? (
        <section
          aria-label={t("Current candidate actions")}
          className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">
              {t("Current decision")}
            </p>
            <p className="mt-1 truncate text-sm font-semibold">
              {selectedItem
                ? t("Candidate {number} · {state}", {
                    number: selectedItem.ordinal + 1,
                    state: t(candidateState(selectedItem, unconfirmedOperations.some((operation) => operation.requestId === selectedItem.lineage?.requestId))),
                  })
                : t("No active candidate")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {comparisonItem ? (
              <WorkspaceButton onClick={() => setComparisonItemId(null)}>
                <X className="h-4 w-4" />
                <span className="sm:hidden">{t("Image")}</span>
                <span className="hidden sm:inline">
                  {t("Back to generated image")}
                </span>
              </WorkspaceButton>
            ) : null}
            <WorkspaceButton
              disabled={
                mutationContextLocked ||
                bootstrapMode ||
                !variationRouteReady ||
                !canGenerate ||
                busy !== null ||
                !selectedItem?.asset ||
                !isApprovedItem
              }
              onClick={() =>
                selectedItem?.asset
                  ? void createRun(activePurpose, [selectedItem.asset.id])
                  : undefined
              }
            >
              <Sparkles className="h-4 w-4" />
              <span className="sm:hidden">{t("Similar")}</span>
              <span className="hidden sm:inline">{t("More like this")}</span>
            </WorkspaceButton>
            {selectedItem?.asset ? (
              <WorkspaceButton disabled={mutationContextLocked || !canUseDecisionAction || busy !== null || Boolean(refreshWarning)}
                onClick={() => void approveAndContinue()} tone="primary">
                {busy === "select" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t(decisionActionLabel)}
              </WorkspaceButton>
            ) : null}
          </div>
        </section>
      ) : null}

      {bootstrapMode ? (
        <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            {t("Adjust the creative brief")}
          </summary>
          <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t(
              "Keep intent human-readable. Identity, references, workflow, and route stay automatic.",
            )}
          </p>
          <textarea
            aria-label={`${t(activeConfig.label)} ${t("creative brief")}`}
            className={`${textAreaClass} mt-3`}
            disabled={mutationContextLocked}
            onChange={(event) =>
              setBriefs((current) => ({
                ...current,
                [activePurpose]: event.target.value,
              }))
            }
            value={briefs[activePurpose]}
          />
        </details>
      ) : null}
      <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          {t("Recent runs and technical lineage")}
        </summary>
        <div className="mt-3 space-y-2">
          {runs.length ? (
            runs.map((run) => (
              <button
                className={cn(
                  "w-full rounded-lg border p-3 text-left text-xs",
                  selectedRunId === run.id
                    ? "border-[var(--ad-ink)] bg-black/[0.03]"
                    : "border-[var(--ad-border)]",
                )}
                disabled={mutationContextLocked}
                key={run.id}
                onClick={() => {
                  runLoader.invalidate();
                  setSelectedRun(null);
                  selectRunId(run.id);
                  if (isCharacterAssetPurpose(run.purpose))
                    setActivePurpose(run.purpose);
                }}
                type="button"
              >
                <span className="flex items-center justify-between gap-3">
                  <strong>
                    {isCharacterAssetPurpose(run.purpose)
                      ? t(purposeConfig[run.purpose].label)
                      : t(run.purpose)}
                    {pinnedRunIds.has(run.id)
                      ? ` · ${t("Selected in draft")}`
                      : ""}
                  </strong>
                  <span>
                    {new Date(run.updatedAt).toLocaleString(
                      adminDateLocale(locale),
                    )}
                  </span>
                </span>
                <span className="mt-1 block break-all text-[var(--ad-text-muted)]">
                  {run.id} · {run.counts.generated}/{run.counts.total}{" "}
                  {t("generated")} · {run.counts.approved} {t("approved")}
                </span>
              </button>
            ))
          ) : (
            <p className="text-xs text-[var(--ad-text-muted)]">
              {t("No production history for this character.")}
            </p>
          )}
        </div>
        {selectedItem ? (
          <dl className="mt-4 grid gap-2 border-t border-[var(--ad-border)] pt-4 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-[var(--ad-text-muted)]">
                {t("Generation profile")}
              </dt>
              <dd className="mt-1 break-all">
                {selectedItem.lineage.generationProfileKey ?? t("Pending")}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--ad-text-muted)]">{t("Workflow")}</dt>
              <dd className="mt-1 break-all">
                {selectedItem.lineage.workflowKey ?? t("Pending")}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--ad-text-muted)]">{t("Request")}</dt>
              <dd className="mt-1 break-all">
                {selectedItem.lineage.requestId ?? t("Pending")}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--ad-text-muted)]">
                {t("Provider request / Comfy prompt")}
              </dt>
              <dd className="mt-1 break-all">
                {selectedItem.lineage.providerRequestId ?? t("Pending")}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--ad-text-muted)]">{t("Asset")}</dt>
              <dd className="mt-1 break-all">
                {selectedItem.asset?.id ?? t("Pending")}
              </dd>
            </div>
          </dl>
        ) : null}
      </details>
    </div>
  );
}
