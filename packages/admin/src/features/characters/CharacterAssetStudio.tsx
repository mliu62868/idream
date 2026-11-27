"use client";

import {
  assignCharacterImageCandidates,
  creativeRunCreateRequestSchema,
  type CharacterImageSourceAsset,
  type CharacterWorkspaceDetail,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { characterImageFillSkipMessage, createOrRecoverCharacterRun, createOrRecoverMissingCharacterImage, defaultCharacterImageBrief } from "./creative-run-creation";
import { useCharacterDraftImageSelection } from "./useCharacterDraftImageSelection";
import {
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";
import {
  committedProjectionTargetId,
  isProjectionRequestCancellation,
  SupersededProjectionError,
  useCommittedProjectionLoader,
} from "@/lib/committed-projection";
import { createLatestRequestGate } from "@/lib/latest-request";
import { characterIdentityBootstrapMutation } from "@/features/image-workflow-transport";
import { useAdminI18n } from "@/components/admin/i18n";
import {
  canChooseCharacterAssetPurpose,
  characterAssetBootstrapRequestKey,
  characterAssetDraftSelectionRequestKey,
  characterAssetRunReceiptMessage,
  characterAssetPurposes,
  characterAssetStudioLayoutClass,
  committedCharacterRunProjectionMatches,
  committedRunProjectionUnavailable,
  isCharacterAssetPurpose,
  nextIncompleteCharacterAssetPurpose,
  preferredCharacterAssetRunId,
  purposeConfig,
  resolveCharacterAssetSubject,
  type CharacterAssetProjectMutation,
  type CharacterAssetPurpose,
} from "./character-asset-studio-authority";
import {
  beginCharacterAssetRunListRead,
  characterAssetRunBlockedMessage,
  characterAssetRunCreationFailure,
  characterAssetRunRequestDraft,
  characterAssetRunRequestSignature,
  characterAssetRunSubmittedMessage,
  characterImageProductionPreparationError,
  confirmCharacterLibraryCandidate,
  mergeCharacterAssetRunPages,
  parseCharacterAssetRunRequest,
  savedAssetRunRequest,
  scopeCharacterAssetRunPages,
  type CharacterAssetRunPages,
} from "./character-asset-studio-requests";
import {
  characterAssetExistingImages,
  characterAssetGenerationAction,
  characterAssetRequestInProgress,
  type CharacterAssetStudioBusy,
} from "./character-asset-studio-view";
import { IdentityRail } from "./CharacterAssetStudioStage";
import { useCharacterAssetRunDeliveryRefresh, useCharacterAssetRunPolling } from "./use-character-asset-run-refresh";
import { CharacterAssetCandidatePanel } from "./CharacterAssetStudioCandidatePanel";
import { BootstrapBriefEditor, CharacterAssetRunHistory } from "./CharacterAssetStudioHistory";
import { CharacterAssetDecisionBar, CharacterAssetInspector } from "./CharacterAssetStudioInspector";
import {
  CharacterAssetStudioAlerts,
  CharacterAssetStudioLoading,
  CharacterAssetStudioNoPermission,
  GenerateMissingImagesBar,
  LibraryCandidateStrip,
  RefreshWarningNotice,
  RunReceiptNotice,
  SelectionIntentNotice,
} from "./CharacterAssetStudioNotices";
import { CharacterAssetRouteStaleNotice, CharacterAssetStudioSetupPanel } from "./CharacterAssetStudioSetupPanel";

export function CharacterAssetStudio({
  actorId = "anonymous",
  data,
  libraryAssets = [],
  permissions,
  onContinue,
  onProjectReload,
  commitProjectMutation,
}: {
  actorId?: string;
  data: CharacterWorkspaceDetail;
  libraryAssets?: readonly CharacterImageSourceAsset[];
  permissions: {
    read: boolean;
    create: boolean;
    selectDraft: boolean;
  };
  onContinue: (tab: "visual" | "release") => void;
  onProjectReload: () => Promise<void>;
  commitProjectMutation: CharacterAssetProjectMutation;
}) {
  const { t, value } = useAdminI18n();
  const subject = resolveCharacterAssetSubject({
    draftName: data.preview.draft?.name,
    draftDescription: data.preview.draft?.description,
    liveName: data.character.name,
    liveDescription: data.character.description,
  });
  const [runPages, setRunPages] = useState<CharacterAssetRunPages>({ purpose: null, history: [], active: [], cursor: null });
  const [loadingHistory, setLoadingHistory] = useState(false);
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
      !data.visual.identityBootstrap.allowed
        ? "library"
        : "review",
  );
  const [runCreationIntent, setRunCreationIntent] =
    useState<DurableMutationIntent | null>(() =>
      readActiveDurableMutationIntent({
        scope: `character-asset:create:${actorId}:${data.character.id}`,
      }),
    );
  const runCreationIntentRef = useRef(runCreationIntent);
  const savedCreateRequest = savedAssetRunRequest(runCreationIntent, data.character.id);
  const [activePurpose, setActivePurpose] = useState<CharacterAssetPurpose>(
    () =>
      savedCreateRequest?.purpose ??
      data.project.draftAssetRouteAuthority?.recoveryPurpose ??
      nextIncompleteCharacterAssetPurpose(data.journey) ??
      "character_chat",
  );
  const runs = useMemo(() => runPages.purpose === activePurpose
    ? [...new Map([...runPages.history, ...runPages.active, ...(selectedRun?.purpose === activePurpose ? [selectedRun] : [])].map((run) => [run.id, run])).values()]
    : [], [activePurpose, runPages, selectedRun]);
  const activeRuns = runPages.purpose === activePurpose ? runPages.active : [];
  const historyCursor = runPages.purpose === activePurpose ? runPages.cursor : null;
  const referenceDirection = data.preview.draft.appearance.referenceDirection;
  // Preserve the author's scene across placements while varying the framing.
  const [briefs, setBriefs] = useState<Record<CharacterAssetPurpose, string>>(
    () => ({
      character_cover: data.visual.identityBootstrap.allowed
        ? `Create the first definitive portrait of ${subject.name} from the approved visual direction. This portrait will define the identity for future images.`
        : defaultCharacterImageBrief("character_cover", subject.name, referenceDirection),
      character_hero: defaultCharacterImageBrief("character_hero", subject.name, referenceDirection),
      character_chat: defaultCharacterImageBrief("character_chat", subject.name, referenceDirection),
      ...(savedCreateRequest ? { [savedCreateRequest.purpose]: savedCreateRequest.brief } : {}),
    }),
  );
  const [negativePrompts, setNegativePrompts] = useState<
    Record<CharacterAssetPurpose, string>
  >(() => ({
    character_cover: "",
    character_hero: "",
    character_chat: "",
    ...(savedCreateRequest ? { [savedCreateRequest.purpose]: savedCreateRequest.negativePrompt ?? "" } : {}),
  }));
  const [batchCount, setBatchCount] = useState<1 | 2 | 4>(() =>
    savedCreateRequest?.runCount ?? 1,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<CharacterAssetStudioBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | { readonly runId: string } | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  // SPEC: 三种列表读取各有一道闸门，只有「整表重读」能作废另外两种。
  // INTENT: 它们曾共用一道闸门：Load more 取消轮询（轮询就此永久停摆），轮询又丢弃在途的
  //         下一页。轮询只写 active，翻页只写 history，两者本来就互不覆盖。
  const runListRequestGate = useRef(createLatestRequestGate());
  const activeRunsRequestGate = useRef(createLatestRequestGate());
  const historyPageRequestGate = useRef(createLatestRequestGate());
  // SPEC: Refresh 自己的列表读取被「项目重载触发的 effect 重读」取代时，由那次重读替它收尾。
  const refreshAttempt = useRef<{ replaced: boolean; awaitingReplacement: boolean } | null>(null);
  const [pendingRegeneratePurpose, setPendingRegeneratePurpose] =
    useState<CharacterAssetPurpose | null>(null);
  const awaitingDeliveryRunIds = useRef(new Set<string>());
  const reloadSelectionProjections = useRef<() => Promise<void>>(async () => undefined);
  const selection = useCharacterDraftImageSelection({
    actorId,
    data,
    canWrite: permissions.selectDraft,
    commitProjectMutation,
    reloadProject: () => reloadSelectionProjections.current(),
    feedback: {
      error: (next) => setError(next),
      message: (next) => setMessage(next),
      warning: (next) => setRefreshWarning(next),
      busy: (next) => setBusy(next ? "select" : null),
    },
  });
  const selectionMutationIntent = selection.intent;
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
      const saved = savedAssetRunRequest(intent, data.character.id);
      if (saved) {
        setBatchCount(saved.runCount ?? 1);
        setActivePurpose(saved.purpose);
        setBriefs((current) => ({ ...current, [saved.purpose]: saved.brief }));
        setNegativePrompts((current) => ({ ...current, [saved.purpose]: saved.negativePrompt ?? "" }));
      }
    },
    [data.character.id, setBatchCount, setBriefs, setNegativePrompts],
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
    if (savedCreateRequest?.purpose === purpose) return savedCreateRequest.orientation;
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
  // null 表示图池已齐，下一步是核对发布。
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
  const existingImages = useMemo(
    () => characterAssetExistingImages(data, activePurpose),
    [activePurpose, data],
  );

  const loadRuns = useCallback(
    async (
      options: {
        readonly signal?: AbortSignal;
        readonly cursor?: string;
        readonly activeOnly?: boolean;
      } = {},
    ) => {
      const { activeOnly = false, cursor } = options;
      const { fullRead, request, activeRequest, pages } = beginCharacterAssetRunListRead({
        gates: {
          runList: runListRequestGate.current,
          activeRuns: activeRunsRequestGate.current,
          historyPage: historyPageRequestGate.current,
        },
        characterId: data.character.id,
        purpose: activePurpose,
        activeOnly,
        cursor,
        signal: options.signal,
      });
      const [history, pending, running] = await pages;
      if (!request.isCurrent()) throw new SupersededProjectionError();
      const { active, historyItems, scoped } = scopeCharacterAssetRunPages({
        history,
        pending,
        running,
        purpose: activePurpose,
      });
      // A page requested during this full read continues the listing it just replaced.
      if (fullRead) historyPageRequestGate.current.invalidate();
      // A poll tick that began after this full read holds the newer active list.
      const activeIsNewest = activeRequest?.isCurrent() === true;
      setRunPages((current) => mergeCharacterAssetRunPages(current, {
        purpose: activePurpose,
        cursor,
        history,
        historyItems,
        active,
        activeIsNewest,
      }));
      const current = selectedRunIdRef.current;
      const committedTargetId = committedProjectionTargetId(
        runCreationIntentRef.current,
      );
      const preserveCurrent = current !== null;
      if (!preserveCurrent) {
        const desiredPurpose = activePurpose;
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
      activePurpose,
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
      // SPEC: 刚生成完的图直接进入可采用状态，不让运营再去 Inspect 里找按钮。
      if (["pending", "running"].includes(detail.executionOutcome)) {
        awaitingDeliveryRunIds.current.add(detail.id);
      } else if (awaitingDeliveryRunIds.current.has(detail.id) && detail.items.some((item) => item.asset)) {
        awaitingDeliveryRunIds.current.delete(detail.id);
        setWorkspaceMode("review");
      }
      // The selected exact Run remains visible independently of the current history page.
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
        const runCount = savedAssetRunRequest(runCreationIntentRef.current, data.character.id)?.runCount;
        setMessage(runCount
          ? t("Started {count} image runs. Each appears in the run history.", { count: runCount })
          : { runId: detail.id });
      }
    },
  });
  const loadRun = runLoader.load;
  const unconfirmedOperations = data.mediaOperations.operations.filter((operation) =>
    operation.modality === "image" && operation.status === "unknown" && operation.requestId,
  );

  useEffect(() => {
    reloadSelectionProjections.current = async () => {
      await Promise.all([onProjectReload(), loadRuns()]);
    };
  });

  useCharacterAssetRunDeliveryRefresh(selectedRun, onProjectReload, setRefreshWarning);

  useEffect(() => {
    if (!permissions.read) return;
    let cancelled = false;
    const controller = new AbortController();
    const gates = [
      runListRequestGate.current,
      activeRunsRequestGate.current,
      historyPageRequestGate.current,
    ];
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        await loadRuns({ signal: controller.signal });
        const attempt = refreshAttempt.current;
        if (attempt) attempt.replaced = true;
        if (attempt?.awaitingReplacement) {
          refreshAttempt.current = null;
          setRefreshWarning(null);
        }
      } catch (cause) {
        if (!cancelled && !isProjectionRequestCancellation(cause)) {
          refreshAttempt.current = null;
          // The click asked to generate from this list; it must not fire on some later read.
          setPendingRegeneratePurpose(null);
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
      for (const gate of gates) gate.invalidate();
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
            setRefreshWarning(committedRunProjectionUnavailable(route.detail, t));
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
  }, [loadRun, runLoader, selectedRun?.id, selectedRunId, t]);

  const selectHistoryRun = (event: MouseEvent<HTMLButtonElement>) => {
    runLoader.invalidate();
    setSelectedRun(null);
    selectRunId(event.currentTarget.value);
  };

  useCharacterAssetRunPolling({ activeRuns, loadRun, loadRuns, selectedRun, setRefreshWarning, t });

  const activeRunDetail =
    selectedRun?.id === selectedRunId ? selectedRun : null;
  // A committed receipt survives intent release; its text follows the current
  // projection of that exact Run, including later polling and terminal results.
  const statusMessage = typeof message === "string"
    ? message
    : activeRunDetail && activeRunDetail.id === message?.runId
      ? characterAssetRunReceiptMessage(activeRunDetail)
      : null;
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
    setWorkspaceMode("review");
  };
  const toggleCandidateComparison = (itemId: string) => {
    if (mutationContextLocked || itemId === selectedItem?.id) return;
    setComparisonItemId((current) => (current === itemId ? null : itemId));
    setWorkspaceMode("review");
  };
  const activeConfig = purposeConfig[activePurpose];
  const imageRequestInProgress = characterAssetRequestInProgress(activeRuns, selectedRun, activePurpose);
  const mutationContextLocked = Boolean(
    runCreationIntent ||
    selectionMutationIntent,
  );
  const canGenerate =
    permissions.create &&
    runPages.purpose === activePurpose &&
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
  // INVARIANT: 服务端的 missingPurposes 还过滤了资产可用性（软删 / 归属），前端不另算一份。
  const missingPurposes = data.journey.assetPack.draft.missingPurposes;
  const [checkedLibrary, setCheckedLibrary] = useState<{
    projectVersion: number;
    candidates: readonly { purpose: CharacterAssetPurpose; asset: CharacterImageSourceAsset }[];
  } | null>(null);
  const confirmedCandidates = checkedLibrary?.projectVersion === data.project.version ? checkedLibrary.candidates : [];
  const candidates = [...confirmedCandidates, ...assignCharacterImageCandidates(
    missingPurposes.filter((purpose) => !confirmedCandidates.some((candidate) => candidate.purpose === purpose)),
    new Set([
      ...characterAssetPurposes.map((purpose) => data.project.draftAssetPack[purpose]),
      ...confirmedCandidates.map((candidate) => candidate.asset.id),
    ]),
    libraryAssets,
  )];
  // Offer the already displayed candidates first. The request merely picks
  // which slots to try. Main revalidates every one before it can enqueue work.
  const generationPurposes = data.journey.assetPack.generateMissingPurposes.filter(
    (purpose) => !candidates.some((candidate) => candidate.purpose === purpose),
  );
  const canGenerateMissing = recurringProductionReady && permissions.create && Boolean(qualifiedRoute) &&
    !mutationContextLocked && unconfirmedOperations.length === 0 && !refreshWarning;
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
    try {
      const committed = await commitProjectMutation({
        action: "Character image-production preparation",
        commit: () =>
          adminV2Operation(
            "POST /api/v2/admin/characters/:id/image-readiness/repair",
            {
              path: { id: data.character.id },
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
      setMessage(
        committed.result.state === "ready"
          ? "The live portrait is now the sealed identity reference. Image production is ready."
          : "The live portrait is now the sealed identity reference. A production administrator still needs to activate a compatible image route.",
      );
    } catch (cause) {
      setError(characterImageProductionPreparationError(cause));
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

  const runRequestDraft = (
    purpose: CharacterAssetPurpose,
    referenceAssetIds: string[] = [],
  ) =>
    characterAssetRunRequestDraft({
      purpose,
      referenceAssetIds,
      subjectName: subject.name,
      characterId: data.character.id,
      profileId: (bootstrapMode ? bootstrapProfile?.profileKey : qualifiedRoute?.generationProfileKey) ?? "",
      bootstrapMode,
      orientation: orientationForPurpose(purpose),
      brief: briefs[purpose],
      negativePrompt: negativePrompts[purpose],
    });
  const parseRunRequest = (snapshot: unknown) =>
    parseCharacterAssetRunRequest(snapshot, data.character.id);
  const runRequestSignature = (body: Parameters<typeof characterAssetRunRequestSignature>[0]) =>
    characterAssetRunRequestSignature(body, data.character.id, subject.name);

  // Each slot keeps its own durable request. Main may return a committed skip instead of a Run.
  const startMissingImageRun = async (purpose: CharacterAssetPurpose) => {
    const scope = `character-asset:create-missing:${actorId}:${data.character.id}:${purpose}`;
    const { result, intent } = await createOrRecoverMissingCharacterImage({
      scope,
      characterId: data.character.id,
      purpose,
      draft: () => runRequestDraft(purpose),
      signature: runRequestSignature,
    });
    if (result.state === "skipped") return { purpose, state: "skipped" as const, skip: result.skip };
    if (result.state !== "committed") return { purpose, state: "not_started" as const };
    awaitingDeliveryRunIds.current.add(result.runId);
    const detail = await adminV2Operation("GET /api/v2/admin/creative/runs/:id", { path: { id: result.runId } });
    if (intent && committedCharacterRunProjectionMatches(intent, detail, data.character.id)) {
      clearDurableMutationIntent(intent);
    }
    return { purpose, state: "started" as const, runId: result.runId };
  };

  const generateMissingImages = async () => {
    setBusy("generate");
    setError(null);
    setMessage(null);
    try {
      const outcomes = await Promise.allSettled(generationPurposes.map(startMissingImageRun));
      const started = outcomes.flatMap((outcome) => outcome.status === "fulfilled" && outcome.value.state === "started" ? [outcome.value] : []);
      const skipped = outcomes.flatMap((outcome) => outcome.status === "fulfilled" && outcome.value.state === "skipped" ? [outcome.value] : []);
      const failed = outcomes.filter((outcome) => outcome.status === "rejected" || outcome.value.state === "not_started").length;
      if (failed > 0) {
        setError(t("{failed} of {total} images could not be started. Try again to resume them; nothing will be generated twice.", { failed, total: outcomes.length }));
      }
      if (started.length > 0) {
        setMessage(t("Generating {count} images. Results will appear here automatically; you can leave this page and come back.", { count: started.length }));
      } else if (skipped.length === 1) {
        setMessage(t(characterImageFillSkipMessage[skipped[0].skip.reason]));
      } else if (skipped.length > 0) {
        setMessage(t("The checked placements already have images, selectable candidates, or pending Runs."));
      }
      const confirmed = await Promise.allSettled(skipped.map((entry) =>
        confirmCharacterLibraryCandidate(entry, libraryAssets, data.character.id)));
      const candidateById = new Map(confirmed.flatMap((item) => item.status === "fulfilled" && item.value
        ? [[item.value.asset.id, item.value] as const] : []));
      if (candidateById.size > 0) {
        const candidates = [...candidateById.values()];
        setCheckedLibrary((current) => ({
          projectVersion: data.project.version,
          candidates: [
            ...candidates,
            ...(current?.projectVersion === data.project.version ? current.candidates.filter((candidate) =>
              !candidateById.has(candidate.asset.id) && !candidates.some(({ purpose }) => purpose === candidate.purpose),
            ) : []),
          ],
        }));
      }
      const current = started.find((run) => run.purpose === activePurpose) ?? started[0];
      if (current?.purpose === activePurpose) {
        runLoader.invalidate();
        selectRunId(current.runId);
        setSelectedRun(null);
        await loadRuns();
      } else if (current) {
        choosePurpose(current.purpose);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The missing images could not be started.");
    } finally {
      setBusy(null);
    }
  };

  const createRun = async (
    purpose: CharacterAssetPurpose,
    referenceAssetIds: string[] = [],
    runCount: 1 | 2 | 4 = 1,
  ) => {
    if (unconfirmedOperations.length > 0) return;
    if (!runCreationIntent && runPages.purpose !== purpose) return;
    if (!runCreationIntent && characterAssetRequestInProgress(activeRuns, selectedRun, purpose)) return;
    const intent = runCreationIntentRef.current;
    const recovered = intent ? creativeRunCreateRequestSchema.safeParse(intent.requestSnapshot) : null;
    const profileId = bootstrapMode
      ? bootstrapProfile?.profileKey
      : qualifiedRoute?.generationProfileKey;
    const orientation = orientationForPurpose(purpose);
    if (!intent && (!profileId || (bootstrapMode && (!orientation || purpose !== "character_cover")))) return;
    const draft = {
      ...runRequestDraft(purpose, referenceAssetIds),
      ...(!bootstrapMode && runCount !== 1 ? { runCount } : {}),
    };
    let committedRun = false;
    setBusy("generate");
    setError(null);
    setMessage(null);
    setRefreshWarning(null);
    refreshAttempt.current = null;
    try {
      const result = await createOrRecoverCharacterRun({
        scope: `character-asset:create:${actorId}:${data.character.id}`,
        characterId: data.character.id,
        ...(recovered?.success && isCharacterAssetPurpose(recovered.data.purpose)
          ? { expectedPurpose: recovered.data.purpose } : {}),
        intent,
        request: draft,
        parseRequest: parseRunRequest,
        signature: runRequestSignature,
        onIntentChange: (next) => {
          updateRunCreationIntentState(next);
          if (next?.status === "committed_projection_pending" && next.committedTargetId) {
            awaitingDeliveryRunIds.current.add(next.committedTargetId);
            // The visible receipt and its exact read target change together, even
            // before the shared creation promise returns to this handler.
            runLoader.invalidate();
            selectRunId(next.committedTargetId);
            setSelectedRun(null);
          }
        },
      });
      if (result.state === "superseded") {
        // Another instance verified and released this intent. Its Run must replace
        // our stale selection before the composer can become available again.
        setRefreshWarning("Refresh the workspace before starting another generation.");
        runLoader.invalidate();
        selectRunId(null);
        setSelectedRun(null);
        await loadRuns();
        if (selectedRunIdRef.current) await loadRun(selectedRunIdRef.current);
        setRefreshWarning(null);
        return;
      }
      if (result.state === "cancelled") {
        setMessage("The old generation request had no committed effect. Its key was sealed, so a new request is safe.");
        return;
      }
      if (result.state === "pending") {
        const receipt = result.receipt;
        setError(receipt.state === "failed"
          ? t("The saved generation command {commandId} is terminally failed. Its key remains locked for operator investigation; do not submit a replacement Run.", { commandId: receipt.commandId ?? "—" })
          : t("The saved generation request is {state}. Keep this workspace locked and reconcile again after the server reaches a terminal receipt.", { state: value(receipt.state) }));
        return;
      }
      if (result.state === "blocked") {
        setError(characterAssetRunBlockedMessage(result.intent.status));
        return;
      }
      committedRun = true;
      const body = result.request;
      if (!isCharacterAssetPurpose(body.purpose)) throw new Error("The saved generation intent does not belong to this Character Asset Studio.");
      setActivePurpose(body.purpose);
      setSelectedIndex(0);
      if (result.source === "submission") {
        setMessage(characterAssetRunSubmittedMessage(body, t));
      }
      if (result.source === "submission") {
        await loadRuns();
      } else {
        await Promise.all([loadRuns(), loadRun(result.runId)]);
        if (result.source === "reconciliation") setMessage("The committed generation receipt was recovered from the server.");
      }
    } catch (cause) {
      const failure = characterAssetRunCreationFailure({
        cause,
        committedRun,
        intentStatus: runCreationIntentRef.current?.status,
        t,
      });
      if (failure?.kind === "warning") setRefreshWarning(failure.message);
      else if (failure) setError(failure.message);
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
    const listLoaded = purpose === activePurpose && runPages.purpose === purpose;
    choosePurpose(purpose);
    if (listLoaded) void createRun(purpose);
    else setPendingRegeneratePurpose(purpose);
  };

  // SPEC: 一次点击只生成一次，且必须等目标用途的列表读回来——「这个用途有没有在跑的请求」
  //       只能由它的列表回答。
  // INTENT: 点击的闭包还停在旧用途上，createRun 的守卫因此直接返回，运营要点第二次。
  //         不写依赖：每次渲染都拿最新闭包重新武装，定时器在命中前总被上一次 cleanup 清掉。
  useEffect(() => {
    if (!pendingRegeneratePurpose) return;
    const timer = window.setTimeout(() => {
      if (activePurpose !== pendingRegeneratePurpose) {
        setPendingRegeneratePurpose(null);
      } else if (runPages.purpose === pendingRegeneratePurpose) {
        setPendingRegeneratePurpose(null);
        if (canGenerate && busy === null) void createRun(pendingRegeneratePurpose);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  });

  const refreshWorkspace = async () => {
    setError(null);
    const attempt = { replaced: false, awaitingReplacement: false };
    refreshAttempt.current = attempt;
    const finishAttempt = () => {
      if (refreshAttempt.current === attempt) refreshAttempt.current = null;
    };
    try {
      const [project, list] = await Promise.allSettled([onProjectReload(), loadRuns()]);
      if (project.status === "rejected") throw project.reason;
      // INTENT: 项目重载一提交就会换掉 loadRuns、触发 effect 重读并作废这里的读取。
      //         这不算失败，但警告要等那次重读真的成功才能清。
      const superseded = list.status === "rejected" && isProjectionRequestCancellation(list.reason);
      if (list.status === "rejected" && !superseded) throw list.reason;
      if (selectedRunIdRef.current) await loadRun(selectedRunIdRef.current);
      if (superseded && !attempt.replaced) {
        attempt.awaitingReplacement = true;
        return;
      }
      finishAttempt();
      setRefreshWarning(null);
    } catch (cause) {
      finishAttempt();
      if (isProjectionRequestCancellation(cause)) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Character assets could not be refreshed",
      );
    }
  };

  const approveAndContinue = async () => {
    if (selectionMutationIntent) {
      await selection.resume();
      return;
    }
    if (refreshWarning) return;
    if (!activeRunDetail || !selectedItem?.asset) return;
    const selectedAsset = selectedItem.asset;
    if (isSelectedAsset) {
      if (advanceTargetPurpose) choosePurpose(advanceTargetPurpose);
      else onContinue("release");
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
    await selection.submit<unknown>({
      signature: bootstrapMode
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
          }),
      snapshot: bootstrapMode
        ? { kind: "bootstrap" as const, body: bootstrapBody }
        : { kind: "draft_selection" as const, body: draftSelectionBody },
      action: bootstrapMode
        ? "Identity bootstrap selection"
        : `${activeConfig.label} selection`,
      request: async (intent) => {
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
          const result = await adminV2Operation(mutation.operationId, mutation.options);
          return {
            result,
            committedTargetId: result.referenceSetRevisionId,
            message: t("Identity version {version}, its sealed Reference Set, and the draft primary image were committed.", { version: nextIdentityVersion }),
          };
        }
        const result = await adminV2Operation(
          "PATCH /api/v2/admin/characters/:id/draft-image",
          {
            path: { id: data.character.id },
            replayIdempotencyKey: intent.idempotencyKey,
            ifMatch: data.project.version,
            body: draftSelectionBody,
          },
        );
        return {
          result,
          committedTargetId: result.selectedAssetId,
          message: `${activeConfig.label} was committed to the next Character Release draft.`,
        };
      },
      afterRefresh: () => {
        if (activePurpose === "character_cover") {
          choosePurpose("character_hero", {
            identityCommitted: bootstrapMode,
          });
        } else if (activePurpose === "character_hero") {
          choosePurpose("character_chat");
        } else {
          onContinue("release");
        }
      },
    });
  };

  if (!permissions.read)
    return <CharacterAssetStudioNoPermission />;
  if (loading)
    return <CharacterAssetStudioLoading />;
  const generationAction = characterAssetGenerationAction({
    activePurpose,
    batchCount,
    bootstrapMode,
    bootstrapProfile,
    brief: briefs[activePurpose],
    busy,
    canCreate: permissions.create,
    canUseGenerationAction,
    characterId: data.character.id,
    imageRequestInProgress,
    productionBlocked,
    qualifiedRoute,
    refreshWarning,
    runCreationIntent,
    selectionMutationIntent,
    t,
    unconfirmedOperations,
  });

  return (
    <div className="space-y-4 pb-12">
      <CharacterAssetStudioAlerts error={error} statusMessage={statusMessage} />
      {!recurringProductionReady ? (
        <CharacterAssetStudioSetupPanel
          bootstrapMode={bootstrapMode}
          busy={busy}
          canGenerate={canGenerate}
          canSelectDraft={permissions.selectDraft}
          data={data}
          generationAction={generationAction}
          imageProductionRepairable={imageProductionRepairable}
          onContinueVisual={() => onContinue("visual")}
          onGenerate={() => void createRun(activePurpose)}
          onPrepare={() => void prepareImageProduction()}
          onRefresh={() => void refreshWorkspace()}
          onRegenerate={regenerateUnderCurrentRoute}
          productionBlocked={productionBlocked}
          readinessDescriptionId={readinessDescriptionId}
          regenerateLabel={regenerateLabel}
          subjectName={subject.name}
        />
      ) : null}

      {recurringProductionReady &&
      data.project.draftAssetRouteAuthority?.status === "stale" ? (
        <CharacterAssetRouteStaleNotice
          className="flex flex-col gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:flex-row sm:items-center sm:justify-between"
          disabled={!canGenerate || busy !== null}
          label={regenerateLabel}
          onRegenerate={regenerateUnderCurrentRoute}
          staleCount={data.project.draftAssetRouteAuthority.stalePurposes.length}
        />
      ) : null}

      <IdentityRail data={data} onRepair={() => onContinue("visual")} />

      {recurringProductionReady && candidates.length > 0 ? (
        <LibraryCandidateStrip
          candidates={candidates}
          disabled={!permissions.selectDraft || busy !== null || mutationContextLocked}
          onSelect={(purpose, asset) => void selection.selectLibraryAsset(purpose, asset, () => {
            const next = missingPurposes.find((missing) => missing !== purpose);
            if (next) choosePurpose(next);
            else onContinue("release");
          })}
        />
      ) : null}

      {canGenerateMissing && generationPurposes.length > 0 ? (
        <GenerateMissingImagesBar
          busy={busy}
          estimates={data.visual.imageGenerationEstimates}
          onGenerate={() => void generateMissingImages()}
          profileKey={runRequestDraft(generationPurposes[0]).profileId}
          purposes={generationPurposes}
        />
      ) : null}

      {runCreationIntent?.committedTargetId ? (
        <RunReceiptNotice runId={runCreationIntent.committedTargetId} />
      ) : null}
      {selectionMutationIntent ? (
        <SelectionIntentNotice
          disabled={!permissions.selectDraft || busy !== null}
          needsReconciliation={selection.needsReconciliation}
          onResume={() => void selection.resume()}
          status={selectionMutationIntent.status}
        />
      ) : null}
      {refreshWarning ? (
        <RefreshWarningNotice
          disabled={busy !== null}
          onRefresh={() => void refreshWorkspace()}
          warning={refreshWarning}
        />
      ) : null}
      <div className={characterAssetStudioLayoutClass}>
        <CharacterAssetCandidatePanel
          activePurpose={activePurpose}
          activeRunDetail={activeRunDetail}
          bootstrapMode={bootstrapMode}
          comparisonItem={comparisonItem}
          comparisonItemId={comparisonItemId}
          existingImages={existingImages}
          mutationContextLocked={mutationContextLocked}
          onActivate={activateCandidate}
          onCloseComparison={() => setComparisonItemId(null)}
          onCompare={toggleCandidateComparison}
          onContinueVisual={() => onContinue("visual")}
          onSelectExistingImage={setSelectedExistingImageId}
          productionBlocked={productionBlocked}
          qualifiedRoute={qualifiedRoute}
          selectedExistingImage={selectedExistingImage}
          selectedItem={selectedItem}
          selectedPackAssetId={selectedPackAssetId}
          subjectName={subject.name}
          unconfirmedOperations={unconfirmedOperations}
          variationRouteBlocker={variationRouteBlocker}
          variationRouteReady={variationRouteReady}
        />
        <CharacterAssetInspector
          activePurpose={activePurpose}
          batchCount={batchCount}
          bootstrapMode={bootstrapMode}
          briefs={briefs}
          busy={busy}
          canSelectDraft={permissions.selectDraft}
          estimates={data.visual.imageGenerationEstimates}
          generationAction={generationAction}
          mutationContextLocked={mutationContextLocked}
          negativePrompts={negativePrompts}
          onGenerate={() => void createRun(activePurpose, [], batchCount)}
          orientation={orientationForPurpose(activePurpose)}
          productionBlocked={productionBlocked}
          profileKey={bootstrapMode ? bootstrapProfile?.profileKey : qualifiedRoute?.generationProfileKey}
          recurringProductionReady={recurringProductionReady}
          selectedItem={selectedItem}
          setBatchCount={setBatchCount}
          setBriefs={setBriefs}
          setNegativePrompts={setNegativePrompts}
          setWorkspaceMode={setWorkspaceMode}
          workspaceMode={workspaceMode}
        />
      </div>

      {selectedItem &&
      !productionBlocked &&
      (!recurringProductionReady || workspaceMode === "review" || selectedItem.asset) ? (
        <CharacterAssetDecisionBar
          bootstrapMode={bootstrapMode}
          busy={busy}
          canGenerate={canGenerate}
          canUseDecisionAction={canUseDecisionAction}
          comparisonItem={comparisonItem}
          decisionActionLabel={decisionActionLabel}
          isApprovedItem={isApprovedItem}
          mutationContextLocked={mutationContextLocked}
          onApprove={() => void approveAndContinue()}
          onCloseComparison={() => setComparisonItemId(null)}
          onGenerateVariation={(assetId) => void createRun(activePurpose, [assetId])}
          refreshWarning={refreshWarning}
          selectedItem={selectedItem}
          unconfirmedOperations={unconfirmedOperations}
          variationRouteReady={variationRouteReady}
        />
      ) : null}

      {bootstrapMode ? (
        <BootstrapBriefEditor
          activePurpose={activePurpose}
          briefs={briefs}
          mutationContextLocked={mutationContextLocked}
          setBriefs={setBriefs}
        />
      ) : null}
      <CharacterAssetRunHistory
        activePurpose={activePurpose}
        bootstrapMode={bootstrapMode}
        bootstrapProfile={bootstrapProfile}
        historyCursor={historyCursor}
        loadingHistory={loadingHistory}
        mutationContextLocked={mutationContextLocked}
        onLoadMore={(cursor) => {
          setLoadingHistory(true);
          void loadRuns({ cursor }).catch((cause: unknown) => {
            if (!isProjectionRequestCancellation(cause)) setError(cause instanceof Error ? cause.message : "Character assets could not be loaded");
          }).finally(() => setLoadingHistory(false));
        }}
        pinnedRunIds={pinnedRunIds}
        qualifiedRoute={qualifiedRoute}
        runs={runs}
        selectHistoryRun={selectHistoryRun}
        selectedItem={selectedItem}
        selectedRunId={selectedRunId}
      />
    </div>
  );
}
