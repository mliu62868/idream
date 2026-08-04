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
  Settings2,
  Square,
  Trash2,
  WandSparkles,
} from "lucide-react";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { CharacterCardData } from "@/types/ourdream";
import {
  GENERATION_JOB_STATUSES,
  isCatalogMember,
  type GenerationJobStatus,
  type MediaAssetVisibility,
} from "@idream/shared/catalog";
import {
  isBlankImagePreview,
  isBuiltInMediaPlaceholderUrl,
  isPrivateMediaUrl,
} from "@/lib/image-delivery";
import {
  parseCharacterDetailResponse,
  parseCharacterLooksResponse,
  parseGenerationConfigResponse,
  parseGenerationJobDetailResponse,
  parseGenerationJobsResponse,
  parseGeneratorCharactersResponse,
  parseUserPresetsResponse,
  parseWorkspaceMediaResponse,
  type RuntimeGenerationConfig,
  type RuntimeGenerationQuote,
} from "@/lib/public-api-contracts";
import {
  authorityShowsEmpty,
  failedAuthorityStatus,
  initialAuthorityStatus,
  loadingAuthorityStatus,
  readyAuthorityStatus,
} from "./authority-state";
import { useViewerResource } from "@/hooks/useViewerResource";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";
import { LegacyTestAssetBadge } from "./LegacyTestAssetBadge";
import {
  claimDraftTransfer,
  draftTransferPath,
  stashDraftTransfer,
} from "./draft-transfer";
import { isRecord } from "./workspace-helpers";
import {
  countWithinQuote,
  generatorConfigAuthorityState,
  orientationWithinQuote,
  pendingGenerationJobIds,
  projectServerJobArrival,
  type GenerationQuoteRequest,
  type GenerationRequestEffects,
} from "@/lib/generation-request";
import { useGenerationRequest } from "@/hooks/useGenerationRequest";
import { publicOptimisticMutationFailure } from "./optimistic-write-state";
import { canStartAgeGatedLoad } from "@/lib/age-gate";

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
  isSynthetic?: boolean;
  canEditIdentity?: boolean;
  visualProfileId?: string | null;
  imageEditModelIds?: readonly string[];
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

/**
 * Identity a private read was issued under. `epoch` and `scope` are compared
 * again when the response lands, so an answer for the previous signed-in viewer
 * is recognisable as no longer ours.
 */
type PrivateViewerTicket = {
  controller: AbortController;
  epoch: number;
  scope: string;
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

type CharacterLookItem = {
  id: string;
  characterId: string;
  label: string;
  status: string;
  appearanceDelta: Record<string, unknown>;
};

type BulkAction = "delete" | "visibility";
// Media assets, not characters: a shared asset is `public_pack`, never `public`.
type BulkVisibility = MediaAssetVisibility;

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

type GeneratorInitialDataLoaders = {
  loadConfig: () => Promise<boolean | null>;
  loadCharacters: () => Promise<void>;
  loadJobs: () => Promise<void>;
  loadMedia: () => Promise<void>;
  loadPresets: () => Promise<void>;
  loadIdentityMedia: () => Promise<void>;
};

type GeneratorConfigAuthorityRefs = {
  authenticated: { current: boolean | null };
  epoch: { current: number };
  scope: { current: string | null };
};

type GeneratorConfigFailureActions = {
  clearConfig: () => void;
  clearPrivateProjections: () => void;
  showError: (message: string) => void;
};

type GeneratorConfigSuspensionActions = Omit<
  GeneratorConfigFailureActions,
  "showError"
>;

type GeneratorViewerRevalidationGate = {
  current: Promise<void> | null;
};

type GeneratorModelSelection = {
  readonly id: string;
  readonly explicit: boolean;
};

type GeneratorModelOption = {
  readonly id: string;
  readonly label: string;
  readonly orientations?: readonly string[];
  readonly referenceMode?: "source_only" | "identity_source";
};

export function projectGeneratorModelSelection(
  selection: GeneratorModelSelection,
  models: readonly GeneratorModelOption[],
) {
  const selected = selection.explicit
    ? models.find((model) => model.id === selection.id)
    : undefined;
  return selected
    ? {
        displayedLabel: selected.label,
        requestModelId: selected.id,
        selectValue: selected.id,
      }
    : {
        displayedLabel: "Auto (identity-aware)",
        requestModelId: undefined,
        selectValue: "",
      };
}

export function generatorImageEditModelOptions(
  models: readonly GeneratorModelOption[],
  compatibleModelIds: readonly string[] | null,
) {
  if (compatibleModelIds === null) return models;
  const compatible = new Set(compatibleModelIds);
  return models.filter((model) => compatible.has(model.id));
}

export function generatorRouteAfterRemixExit(
  currentUrl: string,
  nextCharacterId?: string | null,
) {
  const url = new URL(currentUrl, "http://localhost");
  url.searchParams.delete("remixFeedItemId");
  if (typeof nextCharacterId === "string" && nextCharacterId) {
    url.searchParams.set("characterId", nextCharacterId);
  } else if (nextCharacterId === null) {
    url.searchParams.delete("characterId");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function invalidateGeneratorConfigAuthority(
  refs: GeneratorConfigAuthorityRefs,
  actions: GeneratorConfigFailureActions,
  message: string,
) {
  suspendGeneratorConfigAuthority(refs, actions);
  actions.showError(message);
}

export function suspendGeneratorConfigAuthority(
  refs: GeneratorConfigAuthorityRefs,
  actions: GeneratorConfigSuspensionActions,
) {
  const previousScope = refs.scope.current;
  refs.epoch.current += 1;
  refs.authenticated.current = null;
  refs.scope.current = null;
  actions.clearConfig();
  actions.clearPrivateProjections();
  return previousScope;
}

export function revalidateGeneratorViewerAuthority(
  gate: GeneratorViewerRevalidationGate,
  actions: {
    refresh: () => Promise<void>;
    suspend: () => void;
  },
) {
  if (gate.current) return gate.current;
  actions.suspend();
  const task = Promise.resolve()
    .then(actions.refresh)
    .finally(() => {
      if (gate.current === task) gate.current = null;
    });
  gate.current = task;
  return task;
}

export function generatorConfigRequestIsCurrent(
  controller: AbortController,
  requestSerial: number,
  currentSerial: number,
) {
  return !controller.signal.aborted && requestSerial === currentSerial;
}

export async function loadGeneratorWorkspaceInitialData(
  ageGateAccepted: boolean,
  loaders: GeneratorInitialDataLoaders,
) {
  if (!canStartAgeGatedLoad(ageGateAccepted)) return;
  const [viewerAuthenticated] = await Promise.all([
    loaders.loadConfig(),
    loaders.loadCharacters(),
  ]);
  if (viewerAuthenticated !== true) return;

  await Promise.all([
    loaders.loadJobs(),
    loaders.loadMedia(),
    loaders.loadPresets(),
    loaders.loadIdentityMedia(),
  ]);
}

export async function loadGeneratorLooksForViewer(
  viewerAuthenticated: boolean | undefined,
  canEditIdentity: boolean,
  loadLooks: () => Promise<void>,
) {
  if (viewerAuthenticated !== true || !canEditIdentity) return;
  await loadLooks();
}

export function removeGeneratorCharacterViewerAuthority(
  characters: readonly CharacterCardData[],
) {
  return characters.map((character) => ({
    ...character,
    canEditIdentity: false,
  }));
}

export function GeneratorWorkspace() {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [config, setConfig] = useState<RuntimeGenerationConfig | null>(null);
  const [characters, setCharacters] = useState<CharacterCardData[]>([]);
  const [charactersAuthority, setCharactersAuthority] = useState(initialAuthorityStatus);
  const [charactersRefreshNonce, setCharactersRefreshNonce] = useState(0);
  const [characterId, setCharacterId] = useState("");
  const [freeplay, setFreeplay] = useState(false);
  const [mode, setMode] = useState<GenerationMode>("image");
  const [imageWorkflow, setImageWorkflow] = useState<ImageWorkflow>("presets");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [orientation, setOrientation] = useState("4:5");
  const [count, setCount] = useState(1);
  const [modelSelection, setModelSelection] = useState({
    id: "",
    explicit: false,
  });
  const [consistencyMode, setConsistencyMode] = useState<ConsistencyMode>("balanced");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modePresetId, setModePresetId] = useState("");
  const [backgroundPresetId, setBackgroundPresetId] = useState("");
  const [posePresetId, setPosePresetId] = useState("");
  const [outfitPresetId, setOutfitPresetId] = useState("");
  const viewerAuthenticatedRef = useRef<boolean | null>(null);
  const viewerScopeRef = useRef<string | null>(null);
  const viewerEpochRef = useRef(0);
  const privateRequestControllersRef = useRef<Set<AbortController>>(new Set());

  // SPEC: a private read is admissible only while the viewer who asked for it is
  // still the signed-in viewer. The ticket carries the identity the request went
  // out under, so a response arriving after a sign-out or an account switch is
  // recognisable as no longer ours.
  const beginPrivateViewerRequest = useCallback(() => {
    const scope = viewerScopeRef.current;
    if (viewerAuthenticatedRef.current !== true || !scope) return null;
    const controller = new AbortController();
    privateRequestControllersRef.current.add(controller);
    return {
      controller,
      epoch: viewerEpochRef.current,
      scope,
    };
  }, []);

  const privateViewerRequestIsCurrent = useCallback(
    (request: { epoch: number; scope: string }) =>
      request.epoch === viewerEpochRef.current &&
      request.scope === viewerScopeRef.current &&
      viewerAuthenticatedRef.current === true,
    [],
  );

  const finishPrivateViewerRequest = useCallback(
    (request: { controller: AbortController }) => {
      privateRequestControllersRef.current.delete(request.controller);
    },
    [],
  );

  const privateViewerGate = useMemo(
    () => ({
      begin: beginPrivateViewerRequest,
      isCurrent: privateViewerRequestIsCurrent,
      finish: finishPrivateViewerRequest,
      signal: (ticket: PrivateViewerTicket) => ticket.controller.signal,
    }),
    [
      beginPrivateViewerRequest,
      finishPrivateViewerRequest,
      privateViewerRequestIsCurrent,
    ],
  );

  const {
    data: jobs,
    status: jobsAuthority,
    setData: setJobs,
    reset: resetJobs,
    refresh: refreshJobs,
  } = useViewerResource<GenerationJob[], void, PrivateViewerTicket>({
    request: () => ({
      path: "/api/v1/generation/jobs?limit=20",
      init: { cache: "no-store" },
    }),
    parse: (raw) => parseGenerationJobsResponse(raw).items,
    fallbackError: "Jobs could not load.",
    initialData: [],
    gate: privateViewerGate,
  });
  const [latestResults, setLatestResults] = useState<MediaItem[]>([]);
  const [identityMedia, setIdentityMedia] = useState<MediaItem[]>([]);
  const [identityMediaAuthority, setIdentityMediaAuthority] = useState(initialAuthorityStatus);
  const [galleryTab, setGalleryTab] = useState<GalleryTab>("image");
  const [view, setView] = useState<WorkspaceView>("create");
  const [status, setStatus] = useState("");
  const [configError, setConfigError] = useState("");
  const [failedMediaIds, setFailedMediaIds] = useState<Set<string>>(() => new Set());
  const [invalidPreviewMediaIds, setInvalidPreviewMediaIds] = useState<Set<string>>(() => new Set());
  const [failedLatestResultIds, setFailedLatestResultIds] = useState<Set<string>>(() => new Set());
  const [invalidLatestResultIds, setInvalidLatestResultIds] = useState<Set<string>>(() => new Set());
  const [presetName, setPresetName] = useState("");
  const [manageMode, setManageMode] = useState(false);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(() => new Set());
  const [deleteConfirmMediaId, setDeleteConfirmMediaId] = useState<string | null>(null);
  const [bulkDeleteConfirmKey, setBulkDeleteConfirmKey] = useState<string | null>(null);
  const [deleteConfirmPresetId, setDeleteConfirmPresetId] = useState<string | null>(null);

  const {
    data: media,
    status: mediaAuthority,
    setData: setMedia,
    reset: resetMedia,
    refresh: refreshMedia,
  } = useViewerResource<MediaItem[], GalleryTab, PrivateViewerTicket>({
    request: (tab) => ({
      path: `/api/v1/media?${tab === "liked" ? "liked=1" : `type=${tab}`}`,
      init: { cache: "no-store" },
    }),
    parse: (raw) => parseWorkspaceMediaResponse(raw).items,
    fallbackError: "Gallery could not load.",
    initialData: [],
    gate: privateViewerGate,
    // Each gallery tab is its own projection: switching tabs must drop the old
    // one rather than leave it on screen looking like the new tab's contents.
    snapshotKey: (tab) => tab,
    initialSnapshotKey: "image",
    onSnapshotChange: () => {
      setSelectedMediaIds(new Set());
      setDeleteConfirmMediaId(null);
      setBulkDeleteConfirmKey(null);
    },
    onLoaded: () => {
      setDeleteConfirmMediaId(null);
      setBulkDeleteConfirmKey(null);
    },
  });

  const {
    data: userPresets,
    status: presetsAuthority,
    reset: resetUserPresets,
    refresh: refreshPresets,
  } = useViewerResource<UserPreset[], void, PrivateViewerTicket>({
    // scope=user yields only the signed-in user's saved presets (built-in
    // background/pose/outfit presets arrive separately via the config endpoint).
    request: () => ({
      path: "/api/v1/generation/presets?scope=user",
      init: { cache: "no-store" },
    }),
    parse: (raw) => parseUserPresetsResponse(raw).items,
    fallbackError: "Saved presets could not load.",
    initialData: [],
    gate: privateViewerGate,
    onLoaded: () => setDeleteConfirmPresetId(null),
  });

  const [editSourceMediaId, setEditSourceMediaId] = useState("");
  const [lookEditorMediaId, setLookEditorMediaId] = useState<string | null>(null);
  const [lookLabel, setLookLabel] = useState("");
  const [lookDescription, setLookDescription] = useState("");
  const [looks, setLooks] = useState<CharacterLookItem[]>([]);
  const [looksAuthority, setLooksAuthority] = useState(initialAuthorityStatus);
  const [selectedLookId, setSelectedLookId] = useState("");
  const [remixFeedItemId, setRemixFeedItemId] = useState("");
  const [authReturnTarget, setAuthReturnTarget] = useState("/generate");
  const workspaceTopRef = useRef<HTMLDivElement>(null);
  const looksCharacterIdRef = useRef("");
  const looksRequestSerialRef = useRef(0);
  const charactersRequestControllerRef = useRef<AbortController | null>(null);
  const charactersRequestSerialRef = useRef(0);
  const configRequestControllerRef = useRef<AbortController | null>(null);
  const configRequestSerialRef = useRef(0);
  const viewerRevalidationGateRef =
    useRef<Promise<void> | null>(null);
  const generationPollInFlightRef = useRef(false);
  const clearRemixIntent = useCallback(
    (nextCharacterId?: string | null) => {
      const currentUrl = new URL(window.location.href);
      const hadRouteIntent =
        Boolean(remixFeedItemId) ||
        currentUrl.searchParams.has("remixFeedItemId");
      setRemixFeedItemId("");
      if (!hadRouteIntent) return;
      setStatus((current) =>
        current.startsWith("Remix ready from Feed") ? "" : current,
      );
      const nextUrl = generatorRouteAfterRemixExit(
        currentUrl.toString(),
        nextCharacterId,
      );
      window.history.replaceState(window.history.state, "", nextUrl);
    },
    [remixFeedItemId],
  );

  const videoModeEnabled =
    config?.video.availability.state === "available" &&
    config.video.models.length > 0;
  const imageEditMode =
    mode === "image" && imageWorkflow === "image-edit";
  const characterImageMode =
    mode === "image" && !freeplay && !imageEditMode;
  const selectedEditSourceForModel = editSourceMediaId
    ? media.find((item) => item.id === editSourceMediaId) ?? null
    : null;
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
  const availableModels = useMemo(
    () => {
      if (mode === "video" && videoModeEnabled) {
        return config?.video.models ?? [];
      }
      if (imageEditMode) {
        return generatorImageEditModelOptions(
          config?.image.editModels ?? [],
          selectedEditSourceForModel
            ? (selectedEditSourceForModel.imageEditModelIds ?? [])
            : null,
        );
      }
      return config?.image.models ?? [];
    },
    [
      config,
      imageEditMode,
      mode,
      selectedEditSourceForModel,
      videoModeEnabled,
    ],
  );
  const modelSelectionProjection = useMemo(
    () => projectGeneratorModelSelection(modelSelection, availableModels),
    [availableModels, modelSelection],
  );
  const modeAvailable =
    mode === "image"
      ? config?.image.availability.state === "available" &&
        config.image.models.length > 0
      : videoModeEnabled;
  // Null while the form does not describe a route the server can price.
  const generationQuoteRequest: GenerationQuoteRequest | null =
    modeAvailable &&
    config?.viewer.authenticated === true &&
    (
      imageEditMode
        ? Boolean(editSourceMediaId)
        : freeplay || Boolean(characterId)
    )
      ? imageEditMode
        ? {
            viewerScope: config.viewer.scope,
            mode,
            consistencyMode,
            model: modelSelectionProjection.requestModelId,
            target: "variation",
            mediaId: editSourceMediaId,
          }
        : {
            viewerScope: config.viewer.scope,
            mode,
            consistencyMode,
            model: modelSelectionProjection.requestModelId,
            target: "generation",
            characterId,
            freeplay,
            lookId:
              characterImageMode && selectedLookId ? selectedLookId : undefined,
          }
      : null;
  const retryQuoteScopeKey =
    config?.viewer.authenticated === true
      ? jobs
          .filter((job) => job.status === "failed")
          .map((job) => job.id)
          .sort()
          .join("|")
      : "";
  const generationRequest = useGenerationRequest({
    quoteRequest: generationQuoteRequest,
    retryQuoteScopeKey,
    view: {
      configAuthority: generatorConfigAuthorityState(config, configError),
      mode,
      count,
      modeAvailable,
      hasTarget: imageEditMode || freeplay || Boolean(characterId),
      editSourceMediaId: imageEditMode
        ? (selectedEditSource?.id ?? null)
        : undefined,
    },
    onQuoteResolved: (quote) => {
      setCount((current) => countWithinQuote(current, quote));
      setOrientation((current) => orientationWithinQuote(current, quote));
    },
  });
  const {
    balanceChanged: generationBalanceChanged,
    resetViewerScope: resetGenerationRequestScope,
    retryQuotes,
    retryQuoteFailures,
    retryingJobIds,
    variationPendingMediaIds: variationPendingIds,
  } = generationRequest;
  const {
    canSubmit,
    estimatedCost,
    insufficientBalance,
    maxCount,
    orientations: allowedGeneratorOrientations,
    outputCount,
    quote: generationQuote,
    quoteError: generationQuoteError,
    submitting: pending,
  } = generationRequest.view;
  const modeUnavailableMessage = generationModeUnavailableMessage(config, mode);
  const galleryTabs = useMemo<GalleryTab[]>(
    () => (videoModeEnabled ? ["image", "video", "liked"] : ["image", "liked"]),
    [videoModeEnabled],
  );
  const canUsePrompt = Boolean(config?.entitlements.premium_controls);
  const canDescribeMoment = canUsePrompt || characterImageMode;
  const anonymousViewer = config?.viewer?.authenticated === false;
  const upgradeHref = upgradeHrefForTarget(authReturnTarget);
  const insufficientBalanceHref = anonymousViewer
    ? authHrefForTarget("/signup", authReturnTarget)
    : upgradeHref;
  const selectedCharacter = useMemo(
    () => characters.find((character) => character.id === characterId) ?? null,
    [characterId, characters],
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
  const selectedMediaConfirmKey = Array.from(selectedMediaIds).sort().join("|");
  const bulkDeleteArmed =
    selectedMediaIds.size > 0 && bulkDeleteConfirmKey === selectedMediaConfirmKey;

  const invalidateLookScope = useCallback(() => {
    looksRequestSerialRef.current += 1;
    looksCharacterIdRef.current = "";
    setLooks([]);
    setSelectedLookId("");
    setLooksAuthority(initialAuthorityStatus());
  }, []);

  const invalidateViewerRelativeCharacterAuthority = useCallback(
    (refresh: boolean) => {
      charactersRequestSerialRef.current += 1;
      charactersRequestControllerRef.current?.abort();
      charactersRequestControllerRef.current = null;
      setCharacters(removeGeneratorCharacterViewerAuthority);
      invalidateLookScope();
      if (refresh) {
        setCharactersRefreshNonce((current) => current + 1);
      }
    },
    [invalidateLookScope],
  );

  const abortPrivateViewerRequests = useCallback(() => {
    for (const controller of privateRequestControllersRef.current) {
      controller.abort();
    }
    privateRequestControllersRef.current.clear();
  }, []);

  const clearPrivateViewerProjections = useCallback(() => {
    abortPrivateViewerRequests();
    looksRequestSerialRef.current += 1;
    resetJobs();
    resetMedia();
    resetUserPresets();
    setLatestResults([]);
    setIdentityMedia([]);
    setIdentityMediaAuthority(readyAuthorityStatus());
    setEditSourceMediaId("");
    setSelectedMediaIds(new Set());
    setDeleteConfirmMediaId(null);
    setBulkDeleteConfirmKey(null);
    setDeleteConfirmPresetId(null);
    setLookEditorMediaId(null);
    resetGenerationRequestScope();
    invalidateLookScope();
    setLooksAuthority(readyAuthorityStatus());
  }, [
    abortPrivateViewerRequests,
    invalidateLookScope,
    resetGenerationRequestScope,
    resetJobs,
    resetMedia,
    resetUserPresets,
  ]);

  const resetPrivateViewerData = useCallback(() => {
    clearPrivateViewerProjections();
    setPresetName("");
    setModePresetId("");
    setBackgroundPresetId("");
    setPosePresetId("");
    setOutfitPresetId("");
    setPrompt("");
    setNegativePrompt("");
  }, [clearPrivateViewerProjections]);

  const showJobsView = useCallback(() => {
    setView("jobs");
    window.setTimeout(() => {
      workspaceTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, []);

  useEffect(() => {
    const viewerScope = config?.viewer.scope;
    if (!viewerScope) return;
    const draft =
      consumePresetDraftTransfer(viewerScope) ??
      readPresetDraft(viewerScope);
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
  }, [config?.viewer.scope]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const timer = window.setTimeout(() => {
      const target = `${window.location.pathname}${window.location.search}`;
      setAuthReturnTarget(target || "/generate");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted]);

  useEffect(
    () => () => {
      charactersRequestControllerRef.current?.abort();
      configRequestControllerRef.current?.abort();
      // The two price reads are aborted by useGenerationRequest's own unmount.
      abortPrivateViewerRequests();
    },
    [abortPrivateViewerRequests],
  );

  const failConfigAuthority = useCallback(
    (message: string) => {
      invalidateGeneratorConfigAuthority(
        {
          authenticated: viewerAuthenticatedRef,
          epoch: viewerEpochRef,
          scope: viewerScopeRef,
        },
        {
          clearConfig: () => setConfig(null),
          clearPrivateProjections: clearPrivateViewerProjections,
          showError: setConfigError,
        },
        message,
      );
      invalidateViewerRelativeCharacterAuthority(false);
    },
    [
      clearPrivateViewerProjections,
      invalidateViewerRelativeCharacterAuthority,
    ],
  );

  const suspendViewerAuthority = useCallback(() => {
    configRequestSerialRef.current += 1;
    configRequestControllerRef.current?.abort();
    configRequestControllerRef.current = null;
    const previousScope = suspendGeneratorConfigAuthority(
      {
        authenticated: viewerAuthenticatedRef,
        epoch: viewerEpochRef,
        scope: viewerScopeRef,
      },
      {
        clearConfig: () => setConfig(null),
        clearPrivateProjections: clearPrivateViewerProjections,
      },
    );
    // Keeping the opaque previous token only for response comparison avoids
    // erasing an in-progress form on a same-viewer focus refresh. It cannot
    // authorize requests while authenticated=null and the epoch has advanced.
    viewerScopeRef.current = previousScope;
    setConfigError("");
    invalidateViewerRelativeCharacterAuthority(false);
  }, [
    clearPrivateViewerProjections,
    invalidateViewerRelativeCharacterAuthority,
  ]);

  const refreshConfig = useCallback(async () => {
    configRequestControllerRef.current?.abort();
    const controller = new AbortController();
    configRequestControllerRef.current = controller;
    const requestSerial = configRequestSerialRef.current + 1;
    configRequestSerialRef.current = requestSerial;
    try {
      const response = await fetch("/api/v1/generation/config", {
        cache: "no-store",
        signal: controller.signal,
      });
      const raw = await response.json().catch(() => null);
      if (
        !generatorConfigRequestIsCurrent(
          controller,
          requestSerial,
          configRequestSerialRef.current,
        )
      ) {
        return null;
      }
      if (!response.ok) {
        failConfigAuthority(
          apiPayloadErrorMessage(raw) ??
            generationConfigErrorMessage(response.status),
        );
        return null;
      }
      const data = parseGenerationConfigResponse(raw);
      const nextScope = data.viewer.scope;
      if (viewerScopeRef.current !== nextScope) {
        viewerEpochRef.current += 1;
        viewerScopeRef.current = nextScope;
        resetPrivateViewerData();
        invalidateViewerRelativeCharacterAuthority(true);
      }
      viewerAuthenticatedRef.current = data.viewer.authenticated;
      if (!data.viewer.authenticated) resetPrivateViewerData();
      setConfig({
        ...data,
        viewer: {
          authenticated: data.viewer.authenticated,
          scope: nextScope,
        },
      });
      setConfigError("");
      const nextVideoModeEnabled = data.video.enabled && data.video.models.length > 0;
      if (!nextVideoModeEnabled) {
        setMode((current) => (current === "video" ? "image" : current));
        setGalleryTab((current) => (current === "video" ? "image" : current));
      }
      setModelSelection((current) =>
        current.explicit &&
        [
          ...data.image.models,
          ...data.image.editModels,
          ...data.video.models,
        ].some((item) => item.id === current.id)
          ? current
          : { id: "", explicit: false },
      );
      setOrientation((current) =>
        data.image.orientations.includes(current)
          ? current
          : (data.image.orientations[0] ?? ""),
      );
      setCount((current) =>
        data.pricing.image.maxCount === null
          ? 1
          : Math.min(current, data.pricing.image.maxCount),
      );
      return data.viewer.authenticated;
    } catch (error) {
      if (
        !generatorConfigRequestIsCurrent(
          controller,
          requestSerial,
          configRequestSerialRef.current,
        ) ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return null;
      }
      failConfigAuthority(
        "Generation controls could not load. Refresh and try again.",
      );
      return null;
    } finally {
      if (
        requestSerial === configRequestSerialRef.current &&
        configRequestControllerRef.current === controller
      ) {
        configRequestControllerRef.current = null;
      }
    }
  }, [
    failConfigAuthority,
    invalidateViewerRelativeCharacterAuthority,
    resetPrivateViewerData,
  ]);

  const refreshBalanceAndQuoteAuthority = useCallback(() => {
    generationBalanceChanged();
    void refreshConfig();
  }, [generationBalanceChanged, refreshConfig]);

  const refreshIdentityMedia = useCallback(async () => {
    const viewerRequest = beginPrivateViewerRequest();
    if (!viewerRequest) return;
    setIdentityMediaAuthority(loadingAuthorityStatus);
    try {
      const response = await fetch("/api/v1/media?type=image&limit=60", {
        cache: "no-store",
        signal: viewerRequest.controller.signal,
      });
      const raw = await response.json().catch(() => null);
      if (!privateViewerRequestIsCurrent(viewerRequest)) return;
      if (!response.ok) {
        throw new Error(
          apiPayloadErrorMessage(raw) ??
            "Identity references could not load.",
        );
      }
      setIdentityMedia(parseWorkspaceMediaResponse(raw).items);
      setIdentityMediaAuthority(readyAuthorityStatus());
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!privateViewerRequestIsCurrent(viewerRequest)) return;
      setIdentityMediaAuthority((current) =>
        failedAuthorityStatus(
          current,
          requestErrorMessage(error, "Identity references could not load."),
        ),
      );
    } finally {
      finishPrivateViewerRequest(viewerRequest);
    }
  }, [
    beginPrivateViewerRequest,
    finishPrivateViewerRequest,
    privateViewerRequestIsCurrent,
  ]);

  const refreshLooks = useCallback(async () => {
    if (config?.viewer.authenticated !== true) {
      if (config?.viewer.authenticated === false) {
        invalidateLookScope();
        setLooksAuthority(readyAuthorityStatus());
      }
      return;
    }
    const requestSerial = looksRequestSerialRef.current + 1;
    looksRequestSerialRef.current = requestSerial;
    if (
      !characterId ||
      freeplay ||
      selectedCharacter?.canEditIdentity !== true
    ) {
      setLooks([]);
      setSelectedLookId("");
      looksCharacterIdRef.current = "";
      setLooksAuthority(readyAuthorityStatus());
      return;
    }
    const viewerRequest = beginPrivateViewerRequest();
    if (!viewerRequest) return;
    const hasMatchingSnapshot = looksCharacterIdRef.current === characterId;
    if (!hasMatchingSnapshot) {
      setLooks([]);
      setSelectedLookId("");
      looksCharacterIdRef.current = characterId;
    }
    setLooksAuthority((current) =>
      loadingAuthorityStatus(
        hasMatchingSnapshot ? current : initialAuthorityStatus(),
      ),
    );
    try {
      const response = await fetch(
        `/api/v1/characters/${encodeURIComponent(characterId)}/looks`,
        {
          cache: "no-store",
          signal: viewerRequest.controller.signal,
        },
      );
      const raw = await response.json().catch(() => null);
      if (
        requestSerial !== looksRequestSerialRef.current ||
        !privateViewerRequestIsCurrent(viewerRequest)
      ) return;
      if (!response.ok) {
        throw new Error(
          apiPayloadErrorMessage(raw) ?? "Saved Looks could not load.",
        );
      }
      const items = parseCharacterLooksResponse(raw).items.filter(
        (look) => look.status === "active",
      );
      setLooks(items);
      setLooksAuthority(readyAuthorityStatus());
      setSelectedLookId((current) =>
        items.some((look) => look.id === current) ? current : "",
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (
        requestSerial !== looksRequestSerialRef.current ||
        !privateViewerRequestIsCurrent(viewerRequest)
      ) return;
      setLooksAuthority((current) =>
        failedAuthorityStatus(
          current,
          requestErrorMessage(error, "Saved Looks could not load."),
        ),
      );
    } finally {
      finishPrivateViewerRequest(viewerRequest);
    }
  }, [
    beginPrivateViewerRequest,
    characterId,
    config?.viewer.authenticated,
    finishPrivateViewerRequest,
    freeplay,
    invalidateLookScope,
    privateViewerRequestIsCurrent,
    selectedCharacter?.canEditIdentity,
  ]);

  const refreshCharacters = useCallback(async () => {
    charactersRequestControllerRef.current?.abort();
    const controller = new AbortController();
    charactersRequestControllerRef.current = controller;
    const requestSerial = charactersRequestSerialRef.current + 1;
    charactersRequestSerialRef.current = requestSerial;
    setCharactersAuthority(loadingAuthorityStatus);
    try {
      const response = await fetch("/api/v1/characters?limit=12", {
        cache: "no-store",
        signal: controller.signal,
      });
      const raw = await response.json().catch(() => null);
      if (
        controller.signal.aborted ||
        requestSerial !== charactersRequestSerialRef.current
      ) {
        return;
      }
      if (!response.ok) {
        throw new Error(
          apiPayloadErrorMessage(raw) ??
            "Character catalog could not load.",
        );
      }
      const searchParams = new URLSearchParams(window.location.search);
      const desired = searchParams.get("characterId");
      const nextRemixFeedItemId = searchParams.get("remixFeedItemId") ?? "";
      // Remix is canonical route intent, not a private viewer projection.
      // Keep it independent from concurrent viewer-scope resets and also clear
      // stale intent when this workspace is reached without the route param.
      setRemixFeedItemId(nextRemixFeedItemId);
      const listedItems = parseGeneratorCharactersResponse(raw).items;
      const desiredListed = Boolean(
        desired && listedItems.some((character) => character.id === desired),
      );
      const desiredCharacter =
        desired && !desiredListed
          ? await fetchCharacterById(desired)
          : null;
      if (
        controller.signal.aborted ||
        requestSerial !== charactersRequestSerialRef.current
      ) {
        return;
      }
      const items = desiredCharacter ? [desiredCharacter, ...listedItems] : listedItems;
      setCharacters(items);
      setCharactersAuthority(readyAuthorityStatus());
      if (items.length === 0) {
        invalidateLookScope();
        setCharacterId("");
        setFreeplay(true);
        return;
      }
      if (desired && !desiredListed && !desiredCharacter) {
        invalidateLookScope();
        setCharacterId("");
        setFreeplay(false);
        setStatus(
          "The requested character is no longer available. Choose another character or Freeplay.",
        );
        return;
      }
      if (nextRemixFeedItemId) {
        setModelSelection({ id: "", explicit: false });
        setStatus((current) => current || "Remix ready from Feed. Adjust details and generate.");
      }
      const preset = desired && items.some((c) => c.id === desired) ? desired : "";
      if (preset) setFreeplay(false);
      setCharacterId((current) => current || preset || items[0]?.id || "");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestSerial !== charactersRequestSerialRef.current) return;
      setCharactersAuthority((current) =>
        failedAuthorityStatus(
          current,
          requestErrorMessage(error, "Character catalog could not load."),
        ),
      );
    } finally {
      if (charactersRequestControllerRef.current === controller) {
        charactersRequestControllerRef.current = null;
      }
    }
  }, [invalidateLookScope]);

  useEffect(() => {
    if (!ageGateAccepted || charactersRefreshNonce === 0) return;
    const timer = window.setTimeout(() => {
      void refreshCharacters();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    ageGateAccepted,
    charactersRefreshNonce,
    refreshCharacters,
  ]);

  const refreshWorkspaceAuthority = useCallback(
    () =>
      loadGeneratorWorkspaceInitialData(
        ageGateAccepted,
        {
          loadConfig: refreshConfig,
          loadCharacters: refreshCharacters,
          loadJobs: refreshJobs,
          loadMedia: () => refreshMedia("image"),
          loadPresets: refreshPresets,
          loadIdentityMedia: refreshIdentityMedia,
        },
      ),
    [
      ageGateAccepted,
      refreshCharacters,
      refreshConfig,
      refreshIdentityMedia,
      refreshJobs,
      refreshMedia,
      refreshPresets,
    ],
  );

  const pollGeneration = useCallback(async (jobId: string) => {
    const viewerRequest = beginPrivateViewerRequest();
    if (!viewerRequest) return;
    try {
      const response = await fetch(`/api/v1/generation/jobs/${jobId}`, {
        cache: "no-store",
        signal: viewerRequest.controller.signal,
      });
      if (!response.ok) return;
      const payload = parseGenerationJobDetailResponse(await response.json());
      if (!privateViewerRequestIsCurrent(viewerRequest)) return;
      const job = payload.job;
      const arrival = projectServerJobArrival(job);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      if (arrival.statusMessage) setStatus(arrival.statusMessage);
      if (arrival.showResults) {
        setLatestResults(payload.assets);
        setGalleryTab(job.mode);
      }
      if (arrival.refreshBalanceAndQuote) refreshBalanceAndQuoteAuthority();
      if (arrival.showResults) void refreshMedia(job.mode);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStatus("Generation status could not refresh. Retrying…");
      }
    } finally {
      finishPrivateViewerRequest(viewerRequest);
    }
  }, [
    beginPrivateViewerRequest,
    finishPrivateViewerRequest,
    privateViewerRequestIsCurrent,
    refreshBalanceAndQuoteAuthority,
    refreshMedia,
    setJobs,
  ]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const timer = window.setTimeout(() => {
      void refreshWorkspaceAuthority();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted, refreshWorkspaceAuthority]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const revalidate = () => {
      if (document.hidden) return;
      void revalidateGeneratorViewerAuthority(
        viewerRevalidationGateRef,
        {
          suspend: suspendViewerAuthority,
          refresh: refreshWorkspaceAuthority,
        },
      );
    };
    window.addEventListener("focus", revalidate);
    window.addEventListener("pageshow", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("pageshow", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [
    ageGateAccepted,
    refreshWorkspaceAuthority,
    suspendViewerAuthority,
  ]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const timer = window.setTimeout(
      () =>
        void loadGeneratorLooksForViewer(
          config?.viewer.authenticated,
          selectedCharacter?.canEditIdentity === true,
          refreshLooks,
        ),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [
    ageGateAccepted,
    config?.viewer.authenticated,
    refreshLooks,
    selectedCharacter?.canEditIdentity,
  ]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const pendingJobIds = pendingGenerationJobIds(jobs);
    if (pendingJobIds.length === 0) return;
    let cancelled = false;
    let timer: number | undefined;
    let failureCount = 0;
    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = window.setTimeout(() => void pollCycle(), delay);
    };
    const pollCycle = async () => {
      if (cancelled) return;
      if (document.hidden || generationPollInFlightRef.current) {
        schedule(1_800);
        return;
      }
      generationPollInFlightRef.current = true;
      try {
        for (const jobId of pendingJobIds) {
          if (cancelled) break;
          await pollGeneration(jobId);
        }
        failureCount = 0;
      } catch {
        failureCount += 1;
      } finally {
        generationPollInFlightRef.current = false;
        schedule(Math.min(14_400, 1_800 * 2 ** failureCount));
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden || cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(1_800);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [ageGateAccepted, jobs, pollGeneration]);

  // What a queued generation does to this surface. The lifecycle rules around
  // it live in @/lib/generation-request; none of them are repeated here.
  const generationRequestEffects: GenerationRequestEffects = {
    applyJob: (job) =>
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]),
    showStatus: setStatus,
    revealJobs: showJobsView,
    refreshBalance: () => {
      void refreshConfig();
    },
    trackJob: (jobId) => {
      void pollGeneration(jobId);
    },
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      if (imageEditMode && !selectedEditSource) {
        setStatus("Choose a source image to edit.");
      }
      return;
    }
    setStatus("");
    if (imageEditMode && selectedEditSource) {
      await createMediaVariation(selectedEditSource, {
        outputCount,
        quote: generationQuote,
      });
      return;
    }
    await generationRequest.submit(
      {
        mode,
        characterId: freeplay ? undefined : characterId,
        freeplay,
        consistencyMode,
        outputCount,
        prompt: canDescribeMoment && prompt ? prompt : undefined,
        negativePrompt: canUsePrompt && negativePrompt ? negativePrompt : undefined,
        remixFeedItemId: remixFeedItemId || undefined,
        controls: {
          orientation,
          model: modelSelectionProjection.requestModelId,
          seconds: mode === "video" ? 4 : undefined,
          modePresetId: mode === "image" && modePresetId ? modePresetId : undefined,
          backgroundPresetId: mode === "image" && backgroundPresetId ? backgroundPresetId : undefined,
          posePresetId: mode === "image" && posePresetId ? posePresetId : undefined,
          outfitPresetId: mode === "image" && outfitPresetId ? outfitPresetId : undefined,
          lookId: characterImageMode && selectedLookId ? selectedLookId : undefined,
        },
      },
      generationRequestEffects,
    );
  }

  async function retryJob(jobId: string) {
    await generationRequest.retry(jobId, generationRequestEffects);
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
    try {
      const response = await fetch(`/api/v1/media/${item.id}/like`, {
        method: nextLiked ? "POST" : "DELETE",
      });
      if (!response.ok) {
        const failure = publicOptimisticMutationFailure("gallery_like");
        setStatus(failure.status);
        if (failure.reloadAuthority) void refreshMedia(galleryTab);
      }
    } catch {
      const failure = publicOptimisticMutationFailure("gallery_like");
      setStatus(failure.status);
      if (failure.reloadAuthority) void refreshMedia(galleryTab);
    }
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

  async function recordIdentityFeedback(
    item: MediaItem,
    feedbackType: "identity_match" | "identity_mismatch",
    sourceSurface: "generator" | "gallery" = "gallery",
  ) {
    const response = await fetch(`/api/v1/media/${item.id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedbackType, sourceSurface }),
    });
    const payload = (await response.json().catch(() => null)) as ApiPayload<unknown> | null;
    if (!response.ok || !payload?.ok) {
      setStatus(payload?.error?.message ?? "Couldn't save identity feedback.");
      return;
    }
    setStatus(
      feedbackType === "identity_match"
        ? "Recorded: looks like the character."
        : "Recorded: identity doesn't match. Try another direction or generate again.",
    );
  }

  function startNewMomentFromResult(item: MediaItem) {
    clearRemixIntent(
      item.characterId ?? (freeplay ? null : characterId || null),
    );
    setModelSelection({ id: "", explicit: false });
    if (item.characterId) {
      invalidateLookScope();
      setCharacterId(item.characterId);
      setFreeplay(false);
    }
    setPrompt("");
    setImageWorkflow("presets");
    setView("create");
    setStatus("Describe the next moment. The character identity stays locked.");
    window.setTimeout(() => {
      workspaceTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function openLookEditor(item: MediaItem) {
    setLookEditorMediaId(item.id);
    setLookLabel("");
    setLookDescription(item.prompt ?? "");
    setStatus("");
  }

  async function saveMediaAsLook() {
    if (!lookEditorMediaId || !lookLabel.trim() || !lookDescription.trim()) {
      setStatus("Name the Look and describe the reusable outfit or styling.");
      return;
    }
    const response = await fetch(`/api/v1/media/${lookEditorMediaId}/save-as-look`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: lookLabel.trim(),
        appearanceDelta: { description: lookDescription.trim() },
      }),
    });
    const payload = (await response.json().catch(() => null)) as ApiPayload<unknown> | null;
    if (!response.ok || !payload?.ok) {
      setStatus(payload?.error?.message ?? "Couldn't save this Look.");
      return;
    }
    setLookEditorMediaId(null);
    setLookLabel("");
    setLookDescription("");
    setStatus("Look saved. You can reuse it for this character.");
    void refreshLooks();
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

  async function createMediaVariation(
    item: MediaItem,
    options?: {
      outputCount?: number;
      quote?: RuntimeGenerationQuote | null;
    },
  ) {
    if (item.type !== "image") return;
    await generationRequest.createVariation(
      {
        mediaId: item.id,
        outputCount: options?.outputCount,
        consistencyMode,
        model: modelSelectionProjection.requestModelId,
        quote: options?.quote,
      },
      generationRequestEffects,
    );
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
          const viewerScope = viewerScopeRef.current;
          if (!viewerScope) {
            setStatus("Viewer authority could not be confirmed. Refresh and try again.");
            return;
          }
          const draft = {
            backgroundPresetId,
            label,
            modePresetId,
            outfitPresetId,
            posePresetId,
            prompt: canUsePrompt ? prompt.trim() : "",
            savedAt: Date.now(),
          };
          savePresetDraft(viewerScope, draft);
          const returnTarget =
            stashDraftTransfer("generatorPreset", {
              payload: draft,
              sourceScope: viewerScope,
            }) ?? draftTransferPath("generatorPreset");
          window.location.assign(authHrefForTarget("/signup", returnTarget));
          return;
        }
        setStatus(payload.error?.message ?? "Couldn't save preset.");
        return;
      }
      setPresetName("");
      setDeleteConfirmPresetId(null);
      if (viewerScopeRef.current) {
        clearPresetDraft(viewerScopeRef.current);
      }
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

        {anonymousViewer && (
          <div
            className="mb-5 flex flex-col gap-4 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-5 sm:flex-row sm:items-center sm:justify-between"
            data-testid="generator-auth-required"
          >
            <div>
              <p className="text-[15px] font-black text-white">
                Sign in to use your private generation workspace
              </p>
              <p className="mt-1 max-w-2xl text-[13px] font-medium leading-5 text-[rgb(170,170,170)]">
                Your jobs, gallery, saved presets, identity references, and reusable Looks
                appear here after you sign in.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Link
                className="inline-flex h-10 items-center justify-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]"
                href={authHrefForTarget("/login", authReturnTarget)}
              >
                Log in
              </Link>
              <Link
                className="inline-flex h-10 items-center justify-center rounded-full bg-[rgb(255,48,170)] px-4 text-[12px] font-black text-white"
                href={authHrefForTarget("/signup", authReturnTarget)}
              >
                Join free
              </Link>
            </div>
          </div>
        )}

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
                    onClick={() => void refreshWorkspaceAuthority()}
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
                {config && !modeAvailable
                  ? "Unavailable"
                  : estimatedCost === null
                    ? "Price unavailable"
                    : `${estimatedCost} coins`}
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
                    setModelSelection({
                      id: "",
                      explicit: false,
                    });
                    setOrientation(config?.image.orientations[0] ?? "");
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
                    setFreeplay(false);
                    setModelSelection({
                      id: "",
                      explicit: false,
                    });
                    setOrientation(firstVideoModel?.orientations?.[0] ?? "");
                    setCount(1);
                  }}
                  type="button"
                >
                  Video
                </button>
              </div>
            )}

            {config && !modeAvailable && modeUnavailableMessage && (
              <div
                className="mt-4 rounded-[10px] border border-[rgb(255,184,112)]/40 bg-[rgb(36,28,18)] px-4 py-3 text-[13px] font-semibold leading-5 text-[rgb(255,184,112)]"
                data-testid="generator-mode-unavailable"
                role="status"
              >
                {modeUnavailableMessage}
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
                      if (imageWorkflow !== item) {
                        setModelSelection({ id: "", explicit: false });
                      }
                      setImageWorkflow(item);
                      setStatus("");
                      if (item === "image-edit") {
                        setGalleryTab("image");
                        void refreshMedia("image");
                      }
                    }}
                    type="button"
                  >
                    {item === "presets" ? "Moment" : "Image Edit"}
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
                {anonymousViewer ? (
                  <GeneratorPrivateDataAuthHint label="your editable images" />
                ) : mediaAuthority.phase === "error" ? (
                  <GeneratorAuthorityNotice
                    hasSnapshot={mediaAuthority.hasSnapshot}
                    message={mediaAuthority.error ?? "Gallery could not load."}
                    onRetry={() => void refreshMedia("image")}
                  />
                ) : null}
                {mediaAuthority.phase === "loading" && !mediaAuthority.hasSnapshot ? (
                  <p className="rounded-[8px] bg-[rgb(36,36,36)] p-3 text-[12px] font-semibold text-[rgb(170,170,170)]">
                    Loading editable images…
                  </p>
                ) : authorityShowsEmpty(mediaAuthority, imageEditCandidates.length) ? (
                  <p className="rounded-[8px] bg-[rgb(36,36,36)] p-3 text-[12px] font-semibold text-[rgb(170,170,170)]">
                    No editable images yet. Generate an image first, then return to Image Edit.
                  </p>
                ) : imageEditCandidates.length > 0 ? (
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
                          onClick={() => {
                            if (item.id !== editSourceMediaId) {
                              setModelSelection({
                                id: "",
                                explicit: false,
                              });
                            }
                            setEditSourceMediaId(item.id);
                          }}
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
                ) : null}
              </div>
            )}

            {!imageEditMode && (
              <>
                <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Character
                  <select
                    aria-label="Character"
                    className="mt-2 h-12 w-full rounded-[10px] bg-[rgb(36,36,36)] px-4 text-[13px] font-semibold text-white outline-none"
                    disabled={
                      freeplay ||
                      !charactersAuthority.hasSnapshot ||
                      characters.length === 0
                    }
                    id="generator-character"
                    name="characterId"
                    onChange={(event) => {
                      const nextCharacterId = event.target.value;
                      if (nextCharacterId === characterId) return;
                      clearRemixIntent(nextCharacterId);
                      setModelSelection({ id: "", explicit: false });
                      invalidateLookScope();
                      setCharacterId(nextCharacterId);
                    }}
                    value={characterId}
                  >
                    {!characterId ? (
                      <option disabled value="">
                        Choose a character
                      </option>
                    ) : null}
                    {characters.map((character) => (
                      <option key={character.id} value={character.id}>
                        {character.title}
                      </option>
                    ))}
                  </select>
                </label>
                {charactersAuthority.phase === "loading" &&
                !charactersAuthority.hasSnapshot ? (
                  <p className="mt-2 text-[12px] font-semibold text-[rgb(170,170,170)]">
                    Loading your characters…
                  </p>
                ) : null}
                {charactersAuthority.phase === "error" ? (
                  <GeneratorAuthorityNotice
                    hasSnapshot={charactersAuthority.hasSnapshot}
                    message={
                      charactersAuthority.error ?? "Character catalog could not load."
                    }
                    onRetry={() => void refreshCharacters()}
                  />
                ) : null}
                {authorityShowsEmpty(charactersAuthority, characters.length) ? (
                  <p className="mt-2 text-[12px] font-semibold text-[rgb(170,170,170)]">
                    No characters yet. Freeplay is available.
                  </p>
                ) : null}

                <label className="mt-3 flex items-center gap-2 text-[13px] font-semibold text-white">
                  <input
                    checked={freeplay}
                    className="h-4 w-4 accent-[rgb(255,64,180)]"
                    id="generator-freeplay"
                    name="freeplay"
                    onChange={(event) => {
                      const nextFreeplay = event.target.checked;
                      if (nextFreeplay) {
                        clearRemixIntent(null);
                        invalidateLookScope();
                      } else {
                        setModelSelection({ id: "", explicit: false });
                      }
                      setFreeplay(nextFreeplay);
                    }}
                    type="checkbox"
                  />
                  Freeplay
                </label>
              </>
            )}

            {characterImageMode && (
              <div className="mt-4">
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Character identity
                </p>
                <div className="mt-2 flex min-h-10 items-center justify-between gap-3 rounded-[10px] bg-black/25 px-3 py-2 text-xs">
                  <span className="inline-flex min-w-0 items-center gap-2 font-bold text-white">
                    <ImageIcon className="h-4 w-4 shrink-0 text-[rgb(255,64,180)]" />
                    <span className="truncate">
                      {selectedCharacter?.visualProfile
                        ? "Identity locked"
                        : selectedCharacter?.canEditIdentity
                          ? "Set up identity image"
                          : "No locked identity profile"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[rgb(170,170,170)]">
                    {selectedCharacter?.visualProfile
                      ? "We keep them recognizable"
                      : selectedCharacter?.canEditIdentity
                        ? "No anchor"
                        : "Published character"}
                  </span>
                </div>
                {!selectedCharacter?.visualProfile && (
                  <div className="mt-2 rounded-[10px] border border-[rgb(255,184,112)]/30 bg-[rgb(36,28,18)] p-3 text-[12px] font-semibold leading-5 text-[rgb(255,184,112)]">
                    {selectedCharacter?.canEditIdentity
                      ? "This legacy character has no confirmed identity image. Set one up before relying on consistent results."
                      : "This published character has no locked identity profile. Generation can continue, but visual consistency may vary."}
                  </div>
                )}
                {anonymousViewer ? (
                  <GeneratorPrivateDataAuthHint label="your saved Looks" />
                ) : null}
                {!anonymousViewer &&
                looksAuthority.phase === "loading" &&
                !looksAuthority.hasSnapshot ? (
                  <p className="mt-3 text-[12px] font-semibold text-[rgb(170,170,170)]">
                    Loading saved Looks…
                  </p>
                ) : null}
                {!anonymousViewer && looksAuthority.phase === "error" ? (
                  <GeneratorAuthorityNotice
                    hasSnapshot={looksAuthority.hasSnapshot}
                    message={looksAuthority.error ?? "Saved Looks could not load."}
                    onRetry={() => void refreshLooks()}
                  />
                ) : null}
                {!anonymousViewer && looks.length > 0 && (
                  <label className="mt-3 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                    Reuse a Look
                    <select
                      aria-label="Character Look"
                      className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                      onChange={(event) => setSelectedLookId(event.target.value)}
                      value={selectedLookId}
                    >
                      <option value="">No saved Look</option>
                      {looks.map((look) => (
                        <option key={look.id} value={look.id}>
                          {look.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {!anonymousViewer && authorityShowsEmpty(looksAuthority, looks.length) ? (
                  <p className="mt-3 text-[12px] font-semibold text-[rgb(114,113,112)]">
                    No saved Looks for this character yet.
                  </p>
                ) : null}
              </div>
            )}

            {!imageEditMode && (
              <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                {characterImageMode ? "Describe the moment" : "Scene Prompt"}
                <textarea
                  aria-label="Prompt"
                  className="mt-2 min-h-24 w-full rounded-[10px] bg-[rgb(36,36,36)] p-4 text-[13px] font-semibold text-white outline-none disabled:text-[rgb(114,113,112)]"
                  disabled={!canDescribeMoment}
                  id="generator-prompt"
                  name="prompt"
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={
                    canDescribeMoment
                      ? characterImageMode
                        ? `What is ${selectedCharacter?.title ?? "the character"} doing, where are they, and how does the moment feel?`
                        : "Scene, pose, mood"
                      : "Premium control"
                  }
                  value={prompt}
                />
              </label>
            )}

            {!imageEditMode ? (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Orientation
                  <select
                    className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                    disabled={!modeAvailable || !generationQuote}
                    id="generator-orientation"
                    name="orientation"
                    onChange={(event) => setOrientation(event.target.value)}
                    value={orientation}
                  >
                    {allowedGeneratorOrientations.map((item) => (
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
                    disabled={
                      mode === "video" ||
                      !modeAvailable ||
                      !generationQuote
                    }
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
                  disabled={!modeAvailable || !generationQuote}
                  type="number"
                  value={outputCount}
                />
              </label>
            )}

            {!characterImageMode && (
              <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                Model
                <select
                  aria-label="Model"
                  className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                  disabled={!modeAvailable}
                  id="generator-model"
                  name="modelId"
                  onChange={(event) => {
                    const nextId = event.target.value;
                    if (!nextId) {
                      setModelSelection({ id: "", explicit: false });
                      return;
                    }
                    const nextModel = availableModels.find((item) => item.id === nextId);
                    setModelSelection({ id: nextId, explicit: true });
                    if (nextModel?.orientations?.[0]) {
                      setOrientation((current) =>
                        nextModel.orientations?.includes(current)
                          ? current
                          : (nextModel.orientations?.[0] ?? current),
                      );
                    }
                  }}
                  value={modelSelectionProjection.selectValue}
                >
                  <option value="">Auto (identity-aware)</option>
                  {availableModels.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {characterImageMode && advancedOpen && (
              <div className="mt-4 rounded-[10px] bg-[rgb(36,36,36)] px-3 py-3">
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Model
                </p>
                <p className="mt-1 text-[13px] font-semibold text-white">
                  Auto (identity-aware)
                </p>
                <p className="mt-1 text-[12px] leading-5 text-[rgb(170,170,170)]">
                  The generation route selects a model that can use this character&apos;s
                  identity references.
                </p>
              </div>
            )}

            {mode === "image" &&
              !imageEditMode &&
              (!characterImageMode || advancedOpen) &&
              (config?.presets?.length ?? 0) > 0 && (
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

            {mode === "image" && !imageEditMode && (!characterImageMode || advancedOpen) && (
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
                {anonymousViewer ? (
                  <GeneratorPrivateDataAuthHint label="your saved presets" />
                ) : null}
                {!anonymousViewer &&
                presetsAuthority.phase === "loading" &&
                !presetsAuthority.hasSnapshot ? (
                  <p className="text-[12px] font-medium text-[rgb(114,113,112)]">
                    Loading saved presets…
                  </p>
                ) : null}
                {!anonymousViewer && presetsAuthority.phase === "error" ? (
                  <GeneratorAuthorityNotice
                    hasSnapshot={presetsAuthority.hasSnapshot}
                    message={presetsAuthority.error ?? "Saved presets could not load."}
                    onRetry={() => void refreshPresets()}
                  />
                ) : null}
                {!anonymousViewer &&
                authorityShowsEmpty(presetsAuthority, userPresets.length) ? (
                  <p className="text-[12px] font-medium text-[rgb(114,113,112)]">
                    Save your current background, pose, outfit, or prompt to reuse later.
                  </p>
                ) : userPresets.length > 0 ? (
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
                ) : null}
              </div>
            )}

            {!imageEditMode && (!characterImageMode || advancedOpen) && (
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
            )}

            {characterImageMode && (
              <div className="mt-4">
                <button
                  aria-expanded={advancedOpen}
                  className="flex h-10 w-full items-center justify-between rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[12px] font-bold text-[rgb(190,190,190)]"
                  data-testid="generator-advanced-toggle"
                  onClick={() => setAdvancedOpen((current) => !current)}
                  type="button"
                >
                  <span className="inline-flex items-center gap-2">
                    <Settings2 className="h-4 w-4" />
                    Advanced settings
                  </span>
                  <span>{advancedOpen ? "Hide" : "Show"}</span>
                </button>
                {advancedOpen && (
                  <div className="mt-2 grid gap-3 rounded-[10px] bg-black/25 p-3" data-testid="generator-advanced-settings">
                    <div>
                      <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                        Identity variation
                      </p>
                      <div className="mt-2 grid grid-cols-3 rounded-full bg-[rgb(36,36,36)] p-1">
                        {(["strict", "balanced", "creative"] as const).map((item) => (
                          <button
                            className={`min-h-9 rounded-full px-2 text-[11px] font-bold ${
                              consistencyMode === item
                                ? "bg-white text-[rgb(13,13,13)]"
                                : "text-[rgb(170,170,170)]"
                            }`}
                            key={item}
                            onClick={() => setConsistencyMode(item)}
                            type="button"
                          >
                            {consistencyModeLabel(item)}
                          </button>
                        ))}
                      </div>
                      <p className="mt-2 text-[11px] font-medium leading-4 text-[rgb(150,150,150)]">
                        {consistencyModeDescription(consistencyMode)}
                      </p>
                    </div>
                    {anonymousViewer ? (
                      <GeneratorPrivateDataAuthHint label="your identity references" />
                    ) : null}
                    {!anonymousViewer && identityMediaAuthority.phase === "error" ? (
                      <GeneratorAuthorityNotice
                        hasSnapshot={identityMediaAuthority.hasSnapshot}
                        message={
                          identityMediaAuthority.error ??
                          "Identity references could not load."
                        }
                        onRetry={() => void refreshIdentityMedia()}
                      />
                    ) : null}
                    {!anonymousViewer &&
                    identityMediaAuthority.phase === "loading" &&
                    !identityMediaAuthority.hasSnapshot ? (
                      <p className="text-[12px] font-semibold text-[rgb(170,170,170)]">
                        Loading identity references…
                      </p>
                    ) : null}
                    {!anonymousViewer && identityTimeline.length > 0 && (
                      <div data-testid="identity-timeline">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                            Identity references
                          </p>
                          <span className="text-[11px] font-semibold text-[rgb(170,170,170)]">
                            {identityReferenceCount} images
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
                                {item.identity?.selectedAsCharacterImage && (
                                  <span className="absolute bottom-1 left-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-black text-white">
                                    Main
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {!anonymousViewer && authorityShowsEmpty(
                      identityMediaAuthority,
                      identityTimeline.length,
                    ) ? (
                      <p className="text-[12px] font-semibold text-[rgb(150,150,150)]">
                        No identity reference history yet.
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            {!imageEditMode && !canUsePrompt && (
              <Link
                className="mt-2 flex items-center justify-between gap-2 rounded-[10px] bg-[rgb(36,36,36)] px-4 py-3 text-[12px] font-semibold text-[rgb(190,190,190)]"
                href={upgradeHref}
              >
                <span>
                  {characterImageMode
                    ? "Model selection and negative prompts are Premium controls."
                    : "Custom freeplay prompts and advanced controls are Premium features."}
                </span>
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
                    : `Need ${estimatedCost ?? "an available price"} coins · you have ${generationQuote?.balance ?? config?.dreamcoins.balance ?? 0}.`}
                </span>
                <span className="rounded-full bg-[rgb(255,48,170)] px-3 py-1 text-[11px] font-black text-white">
                  {anonymousViewer ? "Join Free" : "Get coins"}
                </span>
              </Link>
            )}

            {anonymousViewer ? (
              <Link
                className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[rgb(255,48,170)] px-4 text-center text-[14px] font-black text-white"
                data-testid="generator-insufficient-balance"
                href={authHrefForTarget("/signup", authReturnTarget)}
              >
                <WandSparkles className="h-4 w-4" />
                {remixFeedItemId
                  ? "Join free to get starter coins for this remix."
                  : "Join free to generate"}
              </Link>
            ) : (
              <button
                className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[rgb(255,48,170)] text-[14px] font-black text-white disabled:bg-[rgb(64,64,64)] disabled:text-[rgb(150,150,150)]"
                disabled={!canSubmit}
                type="submit"
              >
                <WandSparkles className="h-4 w-4" />
                {pending
                  ? imageEditMode
                    ? "Queuing edit..."
                    : "Queuing..."
                  : config && !modeAvailable
                    ? `${mode === "image" ? "Image" : "Video"} generation unavailable`
                    : configError
                      ? "Generator unavailable"
                      : imageEditMode && !selectedEditSource
                        ? "Select a source image"
                        : estimatedCost === null
                          ? generationQuoteError
                            ? "Exact price unavailable"
                            : "Checking exact price…"
                          : `${imageEditMode ? "Create edit" : characterImageMode ? "Generate this moment" : "Generate"} · ${estimatedCost} coins`}
              </button>
            )}
            {generationQuoteError && (
              <div
                aria-live="assertive"
                className="mt-4 flex items-center justify-between gap-3 text-[13px] font-medium text-[rgb(255,184,112)]"
                data-testid="generator-quote-error"
                role="alert"
              >
                <span>{generationQuoteError}</span>
                <button
                  className="shrink-0 rounded-full border border-[rgb(255,184,112)]/50 px-3 py-1 text-[11px] font-black"
                  onClick={generationRequest.requestQuoteRetry}
                  type="button"
                >
                  Retry quote
                </button>
              </div>
            )}
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
            {latestResults.length > 0 && (
              <section
                className="rounded-[14px] border border-[rgb(255,48,170)]/30 bg-[rgb(18,18,18)] p-4"
                data-testid="generator-latest-results"
              >
                <div className="mb-4">
                  <p className="text-[12px] font-bold uppercase text-[rgb(255,95,194)]">
                    Latest moment
                  </p>
                  <h2 className="mt-1 text-[18px] font-black text-white">
                    Keep the relationship moving
                  </h2>
                  <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">
                    Tell us whether the identity feels right, or continue from this image.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {latestResults.map((item, index) => {
                    const source = item.thumbnailUrl ?? item.url;
                    const previewUnavailable =
                      failedLatestResultIds.has(item.id) ||
                      invalidLatestResultIds.has(item.id) ||
                      isUnusableImagePreview(item) ||
                      isBuiltInMediaPlaceholderUrl(source);
                    return (
                      <article
                        className="overflow-hidden rounded-[12px] bg-[rgb(36,36,36)]"
                        data-latest-media-id={item.id}
                        key={item.id}
                      >
                        <div className="relative aspect-[4/5] overflow-hidden bg-black/30">
                          {previewUnavailable ? (
                            <div
                              className="grid h-full place-items-center px-4 text-center text-[13px] font-semibold text-[rgb(170,170,170)]"
                              data-testid="latest-result-unavailable"
                            >
                              Preview unavailable
                            </div>
                          ) : (
                            <MediaPreview
                              item={item}
                              loading={index === 0 ? "eager" : "lazy"}
                              onError={() =>
                                setFailedLatestResultIds((current) => new Set(current).add(item.id))
                              }
                              onInvalidPreview={() =>
                                setInvalidLatestResultIds((current) => new Set(current).add(item.id))
                              }
                              source={source}
                              testIdPrefix="latest-result"
                            />
                          )}
                          <LegacyTestAssetBadge isSynthetic={item.isSynthetic} />
                        </div>
                        <div className="grid gap-2 p-3">
                          {item.type === "image" && item.characterId && (
                            <div
                              aria-label="Character identity feedback"
                              className="grid grid-cols-2 gap-2"
                            >
                              <button
                                className="min-h-10 rounded-full bg-white px-3 text-[11px] font-black text-[rgb(13,13,13)]"
                                onClick={() =>
                                  void recordIdentityFeedback(item, "identity_match", "generator")
                                }
                                type="button"
                              >
                                Looks like them
                              </button>
                              <button
                                className="min-h-10 rounded-full bg-black/40 px-3 text-[11px] font-black text-white"
                                onClick={() =>
                                  void recordIdentityFeedback(item, "identity_mismatch", "generator")
                                }
                                type="button"
                              >
                                Doesn&apos;t look like them
                              </button>
                            </div>
                          )}
                          {item.type === "image" && (
                            <button
                              className="min-h-10 rounded-full bg-[rgb(255,48,170)] px-3 text-[11px] font-black text-white"
                              disabled={variationPendingIds.has(item.id)}
                              onClick={() => void createMediaVariation(item)}
                              type="button"
                            >
                              {variationPendingIds.has(item.id)
                                ? "Checking price…"
                                : "More like this"}
                            </button>
                          )}
                          <button
                            className="min-h-10 rounded-full border border-white/15 px-3 text-[11px] font-black text-white"
                            onClick={() => startNewMomentFromResult(item)}
                            type="button"
                          >
                            Create a new moment
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
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
                {anonymousViewer ? (
                  <GeneratorPrivateDataAuthHint label="your generation jobs" />
                ) : null}
                {!anonymousViewer && jobsAuthority.phase === "error" ? (
                  <GeneratorAuthorityNotice
                    hasSnapshot={jobsAuthority.hasSnapshot}
                    message={jobsAuthority.error ?? "Jobs could not load."}
                    onRetry={() => void refreshJobs()}
                  />
                ) : null}
                {!anonymousViewer &&
                jobsAuthority.phase === "loading" &&
                !jobsAuthority.hasSnapshot ? (
                  <div className="rounded-[10px] bg-[rgb(36,36,36)] p-5 text-[13px] font-medium text-[rgb(170,170,170)]">
                    Loading jobs…
                  </div>
                ) : null}
                {!anonymousViewer && authorityShowsEmpty(jobsAuthority, jobs.length) && (
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
                          className="h-9 w-fit rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)] disabled:bg-[rgb(64,64,64)] disabled:text-[rgb(150,150,150)]"
                          disabled={
                            retryingJobIds.has(job.id) ||
                            !retryQuotes[job.id] ||
                            (
                              retryQuotes[job.id]!.costDreamcoins >
                              retryQuotes[job.id]!.balance
                            )
                          }
                          onClick={() => retryJob(job.id)}
                          type="button"
                        >
                          {retryingJobIds.has(job.id)
                            ? "Retrying…"
                            : retryQuotes[job.id]
                              ? `Retry · ${retryQuotes[job.id]!.costDreamcoins} coins`
                              : retryQuoteFailures[job.id]
                                ? "Retry price unavailable"
                                : "Checking retry price…"}
                        </button>
                        <p className="text-[12px] font-medium text-[rgb(170,170,170)]">
                          {retryQuoteFailures[job.id]
                            ? retryQuoteFailures[job.id]
                            : retryQuotes[job.id] &&
                                retryQuotes[job.id]!.costDreamcoins >
                                  retryQuotes[job.id]!.balance
                              ? `Need ${retryQuotes[job.id]!.costDreamcoins} coins · you have ${retryQuotes[job.id]!.balance}.`
                              : retryQuotes[job.id]
                                ? "Provider hiccup — your coins were refunded. The exact retry price is pinned above."
                                : "Loading the exact retry route and price…"}
                        </p>
                        {retryQuoteFailures[job.id] && (
                          <button
                            className="w-fit rounded-full border border-white/20 px-3 py-1 text-[11px] font-black text-white"
                            onClick={generationRequest.requestRetryQuoteRetry}
                            type="button"
                          >
                            Retry price check
                          </button>
                        )}
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
              {anonymousViewer ? (
                <div className="mb-4">
                  <GeneratorPrivateDataAuthHint label="your private gallery" />
                </div>
              ) : null}
              {!anonymousViewer && mediaAuthority.phase === "error" ? (
                <div className="mb-4">
                  <GeneratorAuthorityNotice
                    hasSnapshot={mediaAuthority.hasSnapshot}
                    message={mediaAuthority.error ?? "Gallery could not load."}
                    onRetry={() => void refreshMedia(galleryTab)}
                  />
                </div>
              ) : null}
              {!anonymousViewer &&
              mediaAuthority.phase === "loading" &&
              !mediaAuthority.hasSnapshot ? (
                <div className="mb-4 rounded-[10px] bg-[rgb(36,36,36)] p-5 text-[13px] font-medium text-[rgb(170,170,170)]">
                  Loading gallery…
                </div>
              ) : null}
              {lookEditorMediaId && (
                <div className="mb-4 grid gap-3 rounded-[12px] border border-white/10 bg-[rgb(28,28,28)] p-4">
                  <div>
                    <h3 className="text-[14px] font-black text-white">Save as a reusable Look</h3>
                    <p className="mt-1 text-[12px] text-[rgb(170,170,170)]">
                      Save clothing, hair styling, and accessories—not the character&apos;s face.
                    </p>
                  </div>
                  <input
                    aria-label="Look name"
                    className="h-10 rounded-[8px] border border-white/10 bg-black/30 px-3 text-[13px] text-white outline-none focus:border-white/30"
                    onChange={(event) => setLookLabel(event.target.value)}
                    placeholder="Look name, e.g. Rainy day"
                    value={lookLabel}
                  />
                  <textarea
                    aria-label="Look styling description"
                    className="min-h-20 resize-y rounded-[8px] border border-white/10 bg-black/30 p-3 text-[13px] text-white outline-none focus:border-white/30"
                    onChange={(event) => setLookDescription(event.target.value)}
                    placeholder="Cream trench coat, loosely pinned curls, amber umbrella…"
                    value={lookDescription}
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      className="h-9 rounded-full bg-white/10 px-4 text-[12px] font-bold text-white"
                      onClick={() => setLookEditorMediaId(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="h-9 rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]"
                      onClick={() => void saveMediaAsLook()}
                      type="button"
                    >
                      Save Look
                    </button>
                  </div>
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
                      <LegacyTestAssetBadge isSynthetic={item.isSynthetic} />
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
                              {item.characterId && (
                                <>
                                  <IconButton
                                    label="Looks like character"
                                    onClick={() => void recordIdentityFeedback(item, "identity_match")}
                                  >
                                    <CheckSquare className="h-4 w-4" />
                                  </IconButton>
                                  <IconButton
                                    label="Doesn't match character"
                                    onClick={() => void recordIdentityFeedback(item, "identity_mismatch")}
                                  >
                                    <EyeOff className="h-4 w-4" />
                                  </IconButton>
                                </>
                              )}
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
                                  <IconButton
                                    label="Save as Look"
                                    onClick={() => openLookEditor(item)}
                                  >
                                    <Settings2 className="h-4 w-4" />
                                  </IconButton>
                                </>
                              )}
                              <IconButton
                                label={
                                  variationPendingIds.has(item.id)
                                    ? "Checking variation price"
                                    : "Create variation"
                                }
                                onClick={() => void createMediaVariation(item)}
                                disabled={variationPendingIds.has(item.id)}
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
                {!anonymousViewer && authorityShowsEmpty(mediaAuthority, media.length) && (
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
  testIdPrefix = "gallery",
}: {
  item: MediaItem;
  loading: "eager" | "lazy";
  onError: () => void;
  onInvalidPreview: () => void;
  source: string;
  testIdPrefix?: "gallery" | "latest-result";
}) {
  if (item.type === "video") {
    return (
      <video
        aria-label="Generated video"
        className="h-full w-full object-cover object-top"
        controls
        data-testid={`${testIdPrefix}-media-video`}
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
      data-testid={`${testIdPrefix}-media-image`}
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
  disabled = false,
  label,
  onClick,
}: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="grid h-9 w-9 place-items-center rounded-full bg-black/70 text-white disabled:cursor-wait disabled:text-white/50"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function GeneratorPrivateDataAuthHint({ label }: { label: string }) {
  return (
    <p
      className="rounded-[10px] bg-[rgb(36,36,36)] p-3 text-[12px] font-semibold text-[rgb(170,170,170)]"
      data-testid="generator-private-auth-required"
    >
      Sign in to load {label}.
    </p>
  );
}

function GeneratorAuthorityNotice({
  hasSnapshot,
  message,
  onRetry,
}: {
  hasSnapshot: boolean;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 rounded-[10px] border border-[rgb(255,184,112)]/30 bg-[rgb(36,28,18)] px-3 py-2 text-[12px] font-semibold text-[rgb(255,184,112)]"
      role="alert"
    >
      <span>
        {message}
        {hasSnapshot ? " Showing the last loaded data." : ""}
      </span>
      <button
        className="rounded-full bg-white/10 px-3 py-1 font-black text-white"
        onClick={onRetry}
        type="button"
      >
        Retry
      </button>
    </div>
  );
}

export async function fetchCharacterById(id: string) {
  const response = await fetch(`/api/v1/characters/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      apiPayloadErrorMessage(raw) ?? "Requested character could not load.",
    );
  }
  return parseCharacterDetailResponse(raw).character;
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

const presetDraftTtlMs = 7 * 24 * 60 * 60 * 1_000;

function scopedPresetDraftStorageKey(viewerScope: string) {
  return `${generatorPresetDraftStorageKey}:${viewerScope}`;
}

function savePresetDraft(viewerScope: string, draft: PresetDraft) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      scopedPresetDraftStorageKey(viewerScope),
      JSON.stringify({
        ownerScope: viewerScope,
        expiresAt: Date.now() + presetDraftTtlMs,
        draft,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function clearPresetDraft(viewerScope: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(scopedPresetDraftStorageKey(viewerScope));
  } catch {
    // Browser storage is an optional draft aid.
  }
}

function readPresetDraft(viewerScope: string): PresetDraft | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(
      scopedPresetDraftStorageKey(viewerScope),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.ownerScope !== viewerScope ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= Date.now() ||
      !isRecord(parsed.draft)
    ) {
      clearPresetDraft(viewerScope);
      return null;
    }
    const storedDraft = parsed.draft;
    const draft: PresetDraft = {
      backgroundPresetId: presetControlString(storedDraft, "backgroundPresetId"),
      label: presetControlString(storedDraft, "label"),
      modePresetId: presetControlString(storedDraft, "modePresetId"),
      outfitPresetId: presetControlString(storedDraft, "outfitPresetId"),
      posePresetId: presetControlString(storedDraft, "posePresetId"),
      prompt: presetControlString(storedDraft, "prompt"),
      savedAt:
        typeof storedDraft.savedAt === "number" ? storedDraft.savedAt : 0,
    };
    if (!draft.label) {
      clearPresetDraft(viewerScope);
      return null;
    }
    return draft;
  } catch {
    clearPresetDraft(viewerScope);
    return null;
  }
}

function consumePresetDraftTransfer(targetScope: string): PresetDraft | null {
  const claimed = claimDraftTransfer("generatorPreset", { targetScope });
  if (!claimed || !isRecord(claimed.payload)) return null;
  const draft = claimed.payload;
  const restored: PresetDraft = {
    backgroundPresetId: presetControlString(draft, "backgroundPresetId"),
    label: presetControlString(draft, "label"),
    modePresetId: presetControlString(draft, "modePresetId"),
    outfitPresetId: presetControlString(draft, "outfitPresetId"),
    posePresetId: presetControlString(draft, "posePresetId"),
    prompt: presetControlString(draft, "prompt"),
    savedAt: typeof draft.savedAt === "number" ? draft.savedAt : 0,
  };
  if (!restored.label) return null;
  if (!savePresetDraft(targetScope, restored)) return null;
  clearPresetDraft(claimed.sourceScope);
  return restored;
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

function isUnusableImagePreview(item: MediaItem) {
  if (item.type !== "image") return false;
  if (item.width == null || item.height == null) return false;
  return item.width <= 1 || item.height <= 1;
}

function consistencyModeLabel(mode: ConsistencyMode) {
  if (mode === "strict") return "Closest match";
  if (mode === "creative") return "More expressive";
  return "Natural";
}

function consistencyModeDescription(mode: ConsistencyMode) {
  if (mode === "strict") {
    return "Keeps the result closest to the identity images, with less pose and styling freedom.";
  }
  if (mode === "creative") {
    return "Allows stronger scene and styling changes while preserving the character's core identity.";
  }
  return "Balances a recognizable identity with natural changes in pose, outfit, lighting, and scene.";
}

function generationConfigErrorMessage(status: number) {
  if (status === 401) return "Sign in to use generation controls.";
  if (status === 403) return "Complete age checks before using generation controls.";
  return "Generation controls could not load. Refresh and try again.";
}

function generationModeUnavailableMessage(
  config: RuntimeGenerationConfig | null,
  mode: GenerationMode,
) {
  if (!config) return null;
  const availability =
    mode === "image" ? config.image.availability : config.video.availability;
  if (availability.state === "available") return null;
  if (availability.reason === "entitlement_required") {
    return `${mode === "image" ? "Image" : "Video"} generation is not available for the current plan. Your balance and existing creations remain available.`;
  }
  if (availability.reason === "feature_disabled") {
    return "Video generation is currently disabled. Your existing creations remain available.";
  }
  if (availability.reason === "no_active_recipe") {
    return `${mode === "image" ? "Image" : "Video"} generation is temporarily unavailable because generation recipes are not fully configured. Your balance and existing creations remain available.`;
  }
  return `${mode === "image" ? "Image" : "Video"} generation is temporarily unavailable because no active model is configured. Your balance and existing creations remain available.`;
}

function requestErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function apiPayloadErrorMessage(payload: unknown) {
  if (!isRecord(payload)) return undefined;
  const error = payload.error;
  if (!isRecord(error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

// Exhaustive over the catalog: a new generation status becomes a compile error
// here instead of leaking a raw snake_case value into the jobs list.
const jobStatusLabels: Record<GenerationJobStatus, string> = {
  queued: "Queued",
  moderating_input: "Checking prompt",
  running: "Generating",
  moderating_output: "Checking output",
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

function jobStatusLabel(status: string, errorCode: string | null) {
  if (!isCatalogMember(GENERATION_JOB_STATUSES, status)) return status;
  const label = jobStatusLabels[status];
  return errorCode && (status === "blocked" || status === "failed")
    ? `${label}: ${errorCode}`
    : label;
}
