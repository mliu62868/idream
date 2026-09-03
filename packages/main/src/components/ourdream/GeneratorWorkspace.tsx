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
  Pencil,
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
import { generationFailureCopy } from "@/lib/generation-failure-copy";
import {
  parseCharacterDetailResponse,
  parseCharacterLooksResponse,
  parseGenerationConfigResponse,
  parseGenerationJobDetailResponse,
  parseGenerationJobsResponse,
  parseGeneratorCharactersResponse,
  parseMediaEnhancementQuoteResponse,
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
  type AuthorityStatus,
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
import {
  exactGenerationQuoteForCount,
  GenerationRequestError,
  hasUnconfirmedMediaEnhancement,
  listGenerationReceipts,
  readGenerationReceipts,
  requestGenerationReceipt,
  requestMediaEnhancementWithExactQuote,
  type GenerationReceipt,
  type GenerationQuoteAuthority,
} from "@/lib/generation-write-client";
import { publicOptimisticMutationFailure } from "./optimistic-write-state";
import { useReportDialog } from "./ReportDialog";
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
  enhanceEligible?: boolean;
  enhancement?: { sourceMediaId: string; scale: 2 } | null;
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
type GalleryFilters = { q: string; visibility: MediaAssetVisibility | "" };
type GalleryPageRequest = GalleryFilters & { tab: GalleryTab; cursors: Array<string | null> };
type GalleryPage = { items: MediaItem[]; nextCursor?: string | null };
type EnhancementConfirmation = {
  source: MediaItem;
  quote: ReturnType<typeof parseMediaEnhancementQuoteResponse> | null;
  loading: boolean;
  submitting: boolean;
  error: string;
};

const galleryTabs: readonly GalleryTab[] = ["image", "video", "liked"];

function generatorImageEditSources(
  items: readonly MediaItem[],
  selected: MediaItem | null,
) {
  const sources = items.filter(
    (item) => item.type === "image" &&
      !isBuiltInMediaPlaceholderUrl(item.thumbnailUrl ?? item.url),
  );
  // Keep the user's source pinned while Gallery moves between pages or filters.
  return selected && !sources.some((item) => item.id === selected.id)
    ? [selected, ...sources]
    : sources;
}

function generatorImageWorkflowAvailable(
  image: Pick<RuntimeGenerationConfig["image"], "availability" | "models" | "editModels"> | undefined,
  workflow: ImageWorkflow,
) {
  return workflow === "image-edit"
    ? Boolean(image?.editModels.length)
    : image?.availability.state === "available" && image.models.length > 0;
}

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
  scope?: "built_in" | "community" | "user";
  category: string | null;
  label: string;
};

// Saved setups retain their selected ids; reusable fragments retain their
// description. Only fragments belong in the four generation selectors.
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
  automaticLabel = "Auto (identity-aware)",
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
        displayedLabel: automaticLabel,
        requestModelId: undefined,
        selectValue: "",
      };
}

export function generatorVideoModeCopy(characterTitle: string) {
  return {
    promptLabel: "Motion direction",
    promptPlaceholder:
      "Describe movement, camera motion, and pacing for this starting image",
    sourceTitle: "Animate this image",
    sourceDescription: `This exact ${characterTitle} image is the first frame. Video adds motion; it does not replace the outfit, lighting, or location.`,
  } as const;
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
  settleWithoutRequest: () => void,
) {
  if (viewerAuthenticated !== true) return;
  if (!canEditIdentity) {
    settleWithoutRequest();
    return;
  }
  await loadLooks();
}

export function generatorShowsSavedLooksEmpty(
  canEditIdentity: boolean,
  status: AuthorityStatus,
  itemCount: number,
) {
  return canEditIdentity && authorityShowsEmpty(status, itemCount);
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
  const appliedRoutePresetRef = useRef<string | null>(null);
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
  const galleryTabRef = useRef<GalleryTab>("image");
  useEffect(() => { galleryTabRef.current = galleryTab; }, [galleryTab]);
  const [gallerySearch, setGallerySearch] = useState("");
  const [galleryVisibility, setGalleryVisibility] = useState<GalleryFilters["visibility"]>("");
  const [galleryFilters, setGalleryFilters] = useState<GalleryFilters>({ q: "", visibility: "" });
  const galleryFiltersRef = useRef<GalleryFilters>({ q: "", visibility: "" });
  const [view, setView] = useState<WorkspaceView>("create");
  const [status, setStatus] = useState("");
  const { openReport, reportDialog } = useReportDialog(setStatus);
  const [configError, setConfigError] = useState("");
  const [failedMediaIds, setFailedMediaIds] = useState<Set<string>>(() => new Set());
  const [invalidPreviewMediaIds, setInvalidPreviewMediaIds] = useState<Set<string>>(() => new Set());
  const [failedLatestResultIds, setFailedLatestResultIds] = useState<Set<string>>(() => new Set());
  const [invalidLatestResultIds, setInvalidLatestResultIds] = useState<Set<string>>(() => new Set());
  const [presetName, setPresetName] = useState("");
  const [presetSearch, setPresetSearch] = useState("");
  const [presetScope, setPresetScope] = useState<"all" | "built_in" | "community" | "user">("all");
  const [presetFilterCategory, setPresetFilterCategory] = useState("");
  const [editingPreset, setEditingPreset] = useState<UserPreset | null>(null);
  const [presetEditorType, setPresetEditorType] = useState<"setup" | PresetConfig["type"]>("setup");
  const [presetDescription, setPresetDescription] = useState("");
  const [presetCategory, setPresetCategory] = useState("");
  const [presetSaving, setPresetSaving] = useState(false);
  const presetSavingRef = useRef(false);
  const [manageMode, setManageMode] = useState(false);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(() => new Set());
  const [deleteConfirmMediaId, setDeleteConfirmMediaId] = useState<string | null>(null);
  const [bulkDeleteConfirmKey, setBulkDeleteConfirmKey] = useState<string | null>(null);
  const [deleteConfirmPresetId, setDeleteConfirmPresetId] = useState<string | null>(null);
  const [mediaCursorTrail, setMediaCursorTrail] = useState<Array<string | null>>([null]);
  const [imageEditSources, setImageEditSources] = useState<MediaItem[]>([]);
  const [enhancement, setEnhancement] = useState<EnhancementConfirmation | null>(null);
  const enhancementCost = enhancement?.quote ? exactGenerationQuoteForCount(enhancement.quote.quote, 1) : null;
  const enhancementSerialRef = useRef(0);
  const enhancementPendingRef = useRef(false);
  const enhancementQuoteControllerRef = useRef<AbortController | null>(null);
  const enhancementKeysRef = useRef({ scope: "", keys: new Map<string, string>() });
  const [receiptStorageWarning, setReceiptStorageWarning] = useState("");
  const [enhancementReceipts, setEnhancementReceipts] = useState<GenerationReceipt[]>([]);
  const [enhancementCheckKey, setEnhancementCheckKey] = useState<string | null>(null);
  const enhancementCheckRef = useRef<string | null>(null);
  const receiptOwnerScope = config?.viewer.authenticated ? config.viewer.scope : null;
  const generationKeysScopeRef = useRef<string | null>(null);
  const unconfirmedFormRef = useRef(false);
  const enhancementUnconfirmed = Boolean(enhancement && enhancementKeysRef.current.scope === config?.viewer.scope &&
    hasUnconfirmedMediaEnhancement(enhancement.source.id, enhancementKeysRef.current.keys));

  useEffect(() => {
    enhancementCheckRef.current = null;
    setEnhancementCheckKey(null);
    if (!receiptOwnerScope) { setEnhancementReceipts([]); return; }
    setReceiptStorageWarning("");
    if (enhancementKeysRef.current.scope !== receiptOwnerScope) {
      enhancementKeysRef.current = { scope: receiptOwnerScope, keys: new Map() };
    }
    const restore = () => {
      for (const receipt of readGenerationReceipts({ ownerScope: receiptOwnerScope, onWarning: setReceiptStorageWarning })) {
        if (receipt.kind === "media_enhancement" && !enhancementKeysRef.current.keys.has(receipt.record)) {
          enhancementKeysRef.current.keys.set(receipt.record, receipt.key);
        }
      }
      setEnhancementReceipts(listGenerationReceipts(enhancementKeysRef.current.keys));
    };
    restore();
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [receiptOwnerScope]);

  const {
    data: mediaPage,
    status: mediaAuthority,
    setData: setMediaPage,
    reset: resetMedia,
    refresh: refreshMediaPage,
  } = useViewerResource<GalleryPage, GalleryPageRequest, PrivateViewerTicket>({
    request: ({ tab, cursors, q, visibility }) => ({
      path: `/api/v1/media?${tab === "liked" ? "liked=1&types=image,video" : `type=${tab}`}${q ? `&q=${encodeURIComponent(q)}` : ""}${visibility ? `&visibility=${visibility}` : ""}${cursors.at(-1) ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ""}`,
      init: { cache: "no-store", headers: { "x-idream-viewer-scope": viewerScopeRef.current ?? "" } },
    }),
    parse: parseWorkspaceMediaResponse,
    fallbackError: "Gallery could not load.",
    initialData: { items: [], nextCursor: null },
    gate: privateViewerGate,
    // Each gallery tab is its own projection: switching tabs must drop the old
    // one rather than leave it on screen looking like the new tab's contents.
    snapshotKey: ({ tab, q, visibility }) => JSON.stringify([tab, q, visibility]),
    initialSnapshotKey: JSON.stringify(["image", "", ""]),
    onSnapshotChange: () => {
      setSelectedMediaIds(new Set());
      setDeleteConfirmMediaId(null);
      setBulkDeleteConfirmKey(null);
      setMediaCursorTrail([null]);
    },
    onLoaded: (page, request) => {
      setDeleteConfirmMediaId(null);
      setBulkDeleteConfirmKey(null);
      setSelectedMediaIds(new Set());
      setMediaCursorTrail(request.cursors);
      if (request.tab === "image") setImageEditSources(page.items);
    },
  });
  const media = mediaPage.items;
  const setMedia = useCallback((update: React.SetStateAction<MediaItem[]>) => {
    setMediaPage((current) => ({
      ...current,
      items: typeof update === "function" ? update(current.items) : update,
    }));
  }, [setMediaPage]);
  const refreshMedia = useCallback(
    (tab: GalleryTab) => refreshMediaPage({ tab, ...galleryFiltersRef.current, cursors: [null] }),
    [refreshMediaPage],
  );

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
      init: { cache: "no-store", headers: { "x-idream-viewer-scope": viewerScopeRef.current ?? "" } },
    }),
    parse: (raw) => parseUserPresetsResponse(raw).items,
    fallbackError: "Saved presets could not load.",
    initialData: [],
    gate: privateViewerGate,
    onLoaded: () => setDeleteConfirmPresetId(null),
  });

  const [selectedEditSource, setSelectedEditSource] = useState<MediaItem | null>(null);
  const selectedEditSourceRef = useRef<MediaItem | null>(null);
  useEffect(() => { selectedEditSourceRef.current = selectedEditSource; }, [selectedEditSource]);
  const suspendedEditSourceRef = useRef<{ scope: string; source: MediaItem } | null>(null);
  const editSourceMediaId = selectedEditSource?.id ?? "";
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
  const imageEditCandidates = useMemo(
    () => generatorImageEditSources(imageEditSources, selectedEditSource),
    [imageEditSources, selectedEditSource],
  );
  const availableModels = useMemo(
    () => {
      if (mode === "video" && videoModeEnabled) {
        return config?.video.models ?? [];
      }
      if (imageEditMode) {
        return generatorImageEditModelOptions(
          config?.image.editModels ?? [],
          selectedEditSource
            ? (selectedEditSource.imageEditModelIds ?? [])
            : null,
        );
      }
      return config?.image.models ?? [];
    },
    [
      config,
      imageEditMode,
      mode,
      selectedEditSource,
      videoModeEnabled,
    ],
  );
  const modelSelectionProjection = useMemo(
    () =>
      projectGeneratorModelSelection(
        modelSelection,
        availableModels,
        mode === "video" ? "Auto (animate source)" : "Auto (identity-aware)",
      ),
    [availableModels, mode, modelSelection],
  );
  const modeAvailable =
    mode === "image"
      ? generatorImageWorkflowAvailable(config?.image, imageWorkflow)
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
    receiptOwnerScope,
    onReceiptWarning: setReceiptStorageWarning,
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
      if (unconfirmedFormRef.current) return;
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
    hasUnconfirmedVariations,
  } = generationRequest;
  const pendingReceipts = receiptOwnerScope ? [...generationRequest.receipts,
    ...(enhancementKeysRef.current.scope === receiptOwnerScope ? enhancementReceipts : [])] : [];
  const {
    canSubmit,
    hasSubmissionAuthority,
    estimatedCost,
    insufficientBalance,
    maxCount,
    orientations: allowedGeneratorOrientations,
    outputCount,
    quote: generationQuote,
    quoteError: generationQuoteError,
    submitting: pending,
  } = generationRequest.view;
  const modeUnavailableMessage = modeAvailable ? "" : generationModeUnavailableMessage(config, mode);
  const canUsePrompt = Boolean(config?.entitlements.premium_controls);
  const canDescribeMoment = canUsePrompt || characterImageMode;
  const generationBody = {
    mode,
    characterId: freeplay ? undefined : characterId,
    freeplay,
    consistencyMode,
    outputCount: mode === "video" ? 1 : count,
    prompt: (canDescribeMoment || unconfirmedFormRef.current) && prompt ? prompt : undefined,
    negativePrompt: (canUsePrompt || unconfirmedFormRef.current) && negativePrompt ? negativePrompt : undefined,
    remixFeedItemId: remixFeedItemId || undefined,
    controls: {
      orientation,
      model: modelSelection.explicit ? modelSelection.id : undefined,
      // Main pins duration from the same production recipe used for the quote.
      modePresetId: mode === "image" && modePresetId ? modePresetId : undefined,
      backgroundPresetId: mode === "image" && backgroundPresetId ? backgroundPresetId : undefined,
      posePresetId: mode === "image" && posePresetId ? posePresetId : undefined,
      outfitPresetId: mode === "image" && outfitPresetId ? outfitPresetId : undefined,
      lookId: characterImageMode && selectedLookId ? selectedLookId : undefined,
    },
  };
  const formUnconfirmed = imageEditMode && selectedEditSource
    ? generationRequest.isVariationUnconfirmed({ mediaId: selectedEditSource.id, outputCount: count, consistencyMode,
      model: modelSelection.explicit ? modelSelection.id : undefined, quote: generationQuote,
      prompt: prompt.trim(), negativePrompt: negativePrompt.trim() || undefined })
    : generationRequest.isSubmissionUnconfirmed(generationBody);
  useEffect(() => {
    if (!config?.viewer.authenticated) return;
    unconfirmedFormRef.current = formUnconfirmed;
    if (!formUnconfirmed && generationQuote) {
      setCount((current) => countWithinQuote(current, generationQuote));
      setOrientation((current) => orientationWithinQuote(current, generationQuote));
    }
  }, [config?.viewer.authenticated, formUnconfirmed, generationQuote]);
  const formCanSubmit = (canSubmit || (hasSubmissionAuthority && formUnconfirmed)) &&
    (!imageEditMode || prompt.trim().length > 0);
  const anonymousViewer = config?.viewer?.authenticated === false;
  const configAuthorityUnavailable = Boolean(configError && !config);
  const upgradeHref = upgradeHrefForTarget(authReturnTarget);
  const insufficientBalanceHref = anonymousViewer
    ? authHrefForTarget("/signup", authReturnTarget)
    : upgradeHref;
  const selectedCharacter = useMemo(
    () => characters.find((character) => character.id === characterId) ?? null,
    [characterId, characters],
  );
  // SPEC: 只有当这一单真的会带身份参考去生成时，界面才允许说「Identity locked」。
  // INTENT: 判据必须是报价解析出来的实际路线，不是「这个角色有没有 visual profile
  //   行」—— 仍挂在 legacy editorial Release 上的角色两者会分叉：有身份档案，
  //   但生成仍退回纯文生图。报价还没回来时按未锁定处理，不知道就不打包票。
  const identityRoutingLocked = Boolean(generationQuote?.identityLocked);
  const videoModeCopy = generatorVideoModeCopy(
    selectedCharacter?.title ?? "character",
  );
  // 锚点几乎总是同时出现在参考集里（编辑角色的身份修复就是 anchor === reference），
  // 两个数组直接相加会把同一张图数两遍 —— 界面上写的是「N images」，得是真实张数。
  const identityReferenceCount = useMemo(() => {
    const profile = selectedCharacter?.visualProfile;
    const ids = new Set<string>();
    for (const list of [profile?.anchorAssetIds, profile?.referenceAssetIds]) {
      if (!Array.isArray(list)) continue;
      for (const id of list) if (typeof id === "string") ids.add(id);
    }
    return ids.size;
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
  const presetCatalog: PresetConfig[] = [
    ...(config?.presets ?? []),
    ...userPresets.flatMap((preset) => {
      const type = presetFragmentType(preset);
      return type ? [{ id: preset.id, type, label: preset.label, category: preset.category, scope: "user" as const }] : [];
    }),
  ];
  const presetCategories = [...new Set([...presetCatalog, ...userPresets].map((preset) => preset.category).filter((category): category is string => Boolean(category)))].sort();
  const matchesPresetFilter = (preset: { label: string; category: string | null; scope?: string }) =>
    (presetScope === "all" || (preset.scope ?? "built_in") === presetScope) &&
    (!presetFilterCategory || preset.category === presetFilterCategory) &&
    (!presetSearch.trim() || `${preset.label} ${preset.category ?? ""}`.toLocaleLowerCase().includes(presetSearch.trim().toLocaleLowerCase()));
  const visibleUserPresets = userPresets.filter((preset) => matchesPresetFilter({ ...preset, scope: "user" }));
  function presetsOf(type: PresetConfig["type"]) {
    const selected = { mode: modePresetId, background: backgroundPresetId, pose: posePresetId, outfit: outfitPresetId }[type];
    // Browsing another category never silently clears the active selection.
    return presetCatalog.filter((preset) => preset.type === type && (preset.id === selected || matchesPresetFilter(preset)));
  }
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
    presetSavingRef.current = false;
    setPresetSaving(false);
    enhancementSerialRef.current += 1;
    enhancementPendingRef.current = false;
    setEnhancement(null);
    looksRequestSerialRef.current += 1;
    resetJobs();
    resetMedia();
    resetUserPresets();
    setLatestResults([]);
    setIdentityMedia([]);
    setIdentityMediaAuthority(readyAuthorityStatus());
    setSelectedEditSource(null);
    setImageEditSources([]);
    setMediaCursorTrail([null]);
    setSelectedMediaIds(new Set());
    setDeleteConfirmMediaId(null);
    setBulkDeleteConfirmKey(null);
    setDeleteConfirmPresetId(null);
    setLookEditorMediaId(null);
    resetGenerationRequestScope(true);
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
    suspendedEditSourceRef.current = null;
    clearPrivateViewerProjections();
    setEditingPreset(null);
    setPresetName("");
    setPresetSearch("");
    setPresetScope("all");
    setPresetFilterCategory("");
    setPresetEditorType("setup");
    setPresetDescription("");
    setPresetCategory("");
    setGallerySearch("");
    setGalleryVisibility("");
    setGalleryFilters({ q: "", visibility: "" });
    galleryFiltersRef.current = { q: "", visibility: "" };
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
      suspendedEditSourceRef.current = null;
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
    if (viewerAuthenticatedRef.current && viewerScopeRef.current && selectedEditSourceRef.current) {
      // Retain only a suspended draft; private projections stay empty until its owner is confirmed.
      suspendedEditSourceRef.current = {
        scope: viewerScopeRef.current,
        source: selectedEditSourceRef.current,
      };
    }
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
      const confirmedViewerChanged = generationKeysScopeRef.current !== nextScope;
      if (confirmedViewerChanged || !data.viewer.authenticated) {
        resetGenerationRequestScope();
        generationKeysScopeRef.current = nextScope;
        unconfirmedFormRef.current = false;
      }
      if (viewerScopeRef.current !== nextScope) {
        viewerEpochRef.current += 1;
        viewerScopeRef.current = nextScope;
        if (confirmedViewerChanged) resetPrivateViewerData();
        else clearPrivateViewerProjections();
        invalidateViewerRelativeCharacterAuthority(true);
      }
      viewerAuthenticatedRef.current = data.viewer.authenticated;
      if (!data.viewer.authenticated) resetPrivateViewerData();
      const suspendedSource = suspendedEditSourceRef.current;
      suspendedEditSourceRef.current = null;
      if (data.viewer.authenticated && suspendedSource?.scope === nextScope) {
        setSelectedEditSource(suspendedSource.source);
      }
      setConfig({
        ...data,
        viewer: {
          authenticated: data.viewer.authenticated,
          scope: nextScope,
        },
      });
      setConfigError("");
      const nextVideoModeEnabled = data.video.enabled && data.video.models.length > 0;
      if (!nextVideoModeEnabled && !unconfirmedFormRef.current) {
        setMode((current) => (current === "video" ? "image" : current));
      }
      if (!unconfirmedFormRef.current) {
        // Gallery variations use the same explicit model control, but are not
        // the form's active request. Retain it so their receipts still match.
        if (!hasUnconfirmedVariations()) setModelSelection((current) =>
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
      }
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
    clearPrivateViewerProjections,
    failConfigAuthority,
    hasUnconfirmedVariations,
    invalidateViewerRelativeCharacterAuthority,
    resetPrivateViewerData,
    resetGenerationRequestScope,
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
        headers: { "x-idream-viewer-scope": viewerRequest.scope },
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
          loadMedia: () => refreshMedia(galleryTabRef.current),
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
          () => {
            setLooks([]);
            setSelectedLookId("");
            looksCharacterIdRef.current = "";
            setLooksAuthority(readyAuthorityStatus());
          },
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
    if (!formCanSubmit) {
      if (imageEditMode && !selectedEditSource) {
        setStatus("Choose a source image to edit.");
      } else if (imageEditMode && !prompt.trim()) {
        setStatus("Describe the change you want to make.");
      }
      return;
    }
    setStatus("");
    if (imageEditMode && selectedEditSource) {
      await createMediaVariation(selectedEditSource, {
        outputCount: formUnconfirmed ? count : outputCount,
        quote: generationQuote,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim() || undefined,
      });
      return;
    }
    await generationRequest.submit(
      {
        ...generationBody,
        outputCount: formUnconfirmed ? generationBody.outputCount : outputCount,
        controls: { ...generationBody.controls, model: formUnconfirmed ? generationBody.controls.model : modelSelectionProjection.requestModelId },
      },
      generationRequestEffects,
    );
  }

  async function retryJob(jobId: string) {
    await generationRequest.retry(jobId, generationRequestEffects);
  }

  function closeEnhancement() {
    if (enhancementPendingRef.current) return;
    enhancementSerialRef.current += 1;
    enhancementQuoteControllerRef.current?.abort();
    setEnhancement(null);
  }

  async function quoteEnhancement(source: MediaItem) {
    if (enhancementPendingRef.current) return;
    const ticket = beginPrivateViewerRequest();
    if (!ticket) return;
    enhancementQuoteControllerRef.current?.abort();
    enhancementQuoteControllerRef.current = ticket.controller;
    const serial = ++enhancementSerialRef.current;
    const current = () => serial === enhancementSerialRef.current &&
      !ticket.controller.signal.aborted && privateViewerRequestIsCurrent(ticket);
    setEnhancement({ source, quote: null, loading: true, submitting: false, error: "" });
    try {
      const response = await fetch(`/api/v1/media/${encodeURIComponent(source.id)}/enhance/quote`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ scale: 2 }), cache: "no-store", signal: ticket.controller.signal,
      });
      const raw: unknown = await response.json().catch(() => null);
      if (!current()) return;
      if (!response.ok) throw new Error(apiPayloadErrorMessage(raw) ?? "Enhancement price could not load.");
      const result = parseMediaEnhancementQuoteResponse(raw);
      if (result.enhancement.sourceMediaId !== source.id || !exactGenerationQuoteForCount(result.quote, 1)) {
        throw new Error("This enhancement quote does not match the selected image. Check the price again.");
      }
      setEnhancement({ source, quote: result, loading: false, submitting: false, error: "" });
    } catch (error) {
      if (current()) setEnhancement({ source, quote: null, loading: false, submitting: false,
        error: error instanceof Error ? error.message : "Enhancement price could not load." });
    } finally {
      finishPrivateViewerRequest(ticket);
    }
  }

  async function submitEnhancement() {
    if (!enhancement || (!enhancement.quote && !enhancementUnconfirmed) || enhancement.loading || enhancementPendingRef.current) return;
    const ticket = beginPrivateViewerRequest();
    if (!ticket) return;
    const serial = enhancementSerialRef.current;
    const current = () => serial === enhancementSerialRef.current &&
      !ticket.controller.signal.aborted && privateViewerRequestIsCurrent(ticket);
    enhancementPendingRef.current = true;
    setEnhancement({ ...enhancement, submitting: true, error: "" });
    // Keep an ambiguous request's key through a same-viewer reconnect; another viewer gets a fresh map.
    if (enhancementKeysRef.current.scope !== ticket.scope) {
      enhancementKeysRef.current = { scope: ticket.scope, keys: new Map() };
    }
    try {
      const result = await requestMediaEnhancementWithExactQuote({
        mediaId: enhancement.source.id,
        quote: enhancement.quote?.quote ?? null,
        idempotencyKeys: enhancementKeysRef.current.keys,
        isCurrent: current,
        persistence: { ownerScope: ticket.scope, onWarning: setReceiptStorageWarning },
      }, async (url, init) => {
        const response = await fetch(url, { ...init, signal: ticket.controller.signal });
        if (!current()) throw new DOMException("Viewer changed", "AbortError");
        return response;
      });
      if (!current()) return;
      generationRequestEffects.applyJob(result.job);
      generationRequestEffects.revealJobs();
      generationRequestEffects.trackJob(result.job.id);
      generationBalanceChanged();
      generationRequestEffects.refreshBalance();
      setStatus("Enhancement started. Your original image is kept in Gallery.");
      setEnhancement(null);
    } catch (error) {
      if (!current()) return;
      const stillUnconfirmed = hasUnconfirmedMediaEnhancement(enhancement.source.id, enhancementKeysRef.current.keys);
      const needsQuote = !stillUnconfirmed && error instanceof GenerationRequestError && (error.status === 409 || error.status === 402);
      setEnhancement({ ...enhancement, submitting: false,
        quote: needsQuote ? null : enhancement.quote,
        error: needsQuote ? `${error.message} Check the price again before confirming.`
          : "Enhancement could not be confirmed. Retry to check the same request.",
      });
      if (needsQuote) { generationBalanceChanged(); void refreshConfig(); }
      else if (error instanceof GenerationRequestError && error.status === 401) void refreshConfig();
    } finally {
      if (current()) setEnhancementReceipts(listGenerationReceipts(enhancementKeysRef.current.keys));
      if (serial === enhancementSerialRef.current) enhancementPendingRef.current = false;
      finishPrivateViewerRequest(ticket);
    }
  }

  async function recoverEnhancementReceipt(receipt: GenerationReceipt) {
    if (enhancementCheckRef.current) return;
    const ticket = beginPrivateViewerRequest();
    if (!ticket || enhancementKeysRef.current.scope !== ticket.scope) return;
    const current = () => !ticket.controller.signal.aborted && privateViewerRequestIsCurrent(ticket);
    enhancementCheckRef.current = receipt.key;
    setEnhancementCheckKey(receipt.key);
    try {
      const result = await requestGenerationReceipt(receipt, {
        idempotencyKeys: enhancementKeysRef.current.keys, isCurrent: current,
        persistence: { ownerScope: ticket.scope, onWarning: setReceiptStorageWarning },
      }, (url, init) => fetch(url, { ...init, signal: ticket.controller.signal }));
      if (!current()) return;
      generationRequestEffects.applyJob(result.job);
      generationRequestEffects.revealJobs();
      generationRequestEffects.trackJob(result.job.id);
      generationRequestEffects.refreshBalance();
      setStatus("Original enhancement request confirmed. Your original image is kept.");
    } catch (error) {
      if (!current()) return;
      if (error instanceof GenerationRequestError && error.status === 401) generationRequestEffects.refreshBalance();
      setStatus(error instanceof GenerationRequestError && error.status === 401
        ? "Sign in to the same account to check this request. Your pending request is kept."
        : `${error instanceof Error ? error.message : "The request could not be confirmed."} Your original request is kept; check again or contact support.`);
    } finally {
      if (enhancementCheckRef.current === receipt.key) enhancementCheckRef.current = null;
      if (current()) {
        setEnhancementCheckKey(null);
        setEnhancementReceipts(listGenerationReceipts(enhancementKeysRef.current.keys));
      }
      finishPrivateViewerRequest(ticket);
    }
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
      setImageEditSources((current) => current.filter((item) => item.id !== id));
      setSelectedEditSource((current) => current?.id === id ? null : current);
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
    setLookDescription("");
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
      prompt?: string;
      negativePrompt?: string;
    },
  ) {
    if (item.type !== "image") return;
    const originalInput = {
      mediaId: item.id,
      outputCount: options?.outputCount,
      consistencyMode,
      model: modelSelection.explicit ? modelSelection.id : undefined,
      prompt: options?.prompt,
      negativePrompt: options?.negativePrompt,
      quote: options?.quote,
    };
    const unconfirmed = generationRequest.isVariationUnconfirmed(originalInput);
    if (!options?.quote && pendingReceipts.length > 0 && !unconfirmed) {
      editGalleryImage(item);
      setStatus("Your earlier request is still unconfirmed. Describe and confirm this new edit at its current price.");
      return;
    }
    await generationRequest.createVariation(
      {
        ...originalInput,
        model: unconfirmed
          ? originalInput.model : modelSelectionProjection.requestModelId,
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

  function applyGalleryFilters(next: GalleryFilters) {
    galleryFiltersRef.current = next;
    setGalleryFilters(next);
    setManageMode(false);
    setSelectedMediaIds(new Set());
    setDeleteConfirmMediaId(null);
    setBulkDeleteConfirmKey(null);
    void refreshMedia(galleryTab);
  }

  function editGalleryImage(item: MediaItem) {
    setMode("image");
    setImageWorkflow("image-edit");
    setSelectedEditSource(item);
    setModelSelection({ id: "", explicit: false });
    setPrompt("");
    setNegativePrompt("");
    setView("create");
    setStatus("");
  }

  async function saveCurrentPreset() {
    if (presetSavingRef.current) return;
    const label = presetName.trim();
    if (!label) {
      setStatus("Name your preset before saving.");
      return;
    }
    const controls: Record<string, string> = presetEditorType === "setup" ? currentPresetControls({
      backgroundPresetId,
      canUsePrompt,
      modePresetId,
      outfitPresetId,
      posePresetId,
      prompt,
    }) : { [presetEditorType === "mode" ? "style" : presetEditorType]: presetDescription.trim() };
    if (presetEditorType !== "setup" && !presetDescription.trim()) {
      setStatus("Describe this preset before saving.");
      return;
    }
    // An unavailable premium control is not permission to erase the owner's
    // previously saved prompt while they update the name or other fields.
    if (editingPreset && presetEditorType === "setup" && !canUsePrompt) {
      const originalPrompt = presetControlString(editingPreset.controls, "prompt");
      if (originalPrompt) controls.prompt = originalPrompt;
    }
    if (Object.keys(controls).length === 0) {
      setStatus("Pick a mode, background, pose, outfit, or prompt before saving a preset.");
      return;
    }
    const viewer = { epoch: viewerEpochRef.current, scope: viewerScopeRef.current, authenticated: viewerAuthenticatedRef.current };
    const isCurrent = () => viewer.epoch === viewerEpochRef.current && viewer.scope === viewerScopeRef.current && viewer.authenticated === viewerAuthenticatedRef.current;
    if (!viewer.scope || viewer.authenticated === null) {
      setStatus("Reconnect the generator before saving a preset.");
      return;
    }
    const original = editingPreset;
    presetSavingRef.current = true;
    setPresetSaving(true);
    try {
      const response = await fetch(original ? `/api/v1/generation/presets/${encodeURIComponent(original.id)}` : "/api/v1/generation/presets", {
        method: original ? "PATCH" : "POST",
        headers: { "content-type": "application/json", "x-idream-viewer-scope": viewer.scope },
        body: JSON.stringify({ ...(original ? {} : { type: presetEditorType === "setup" ? "mode" : presetEditorType }), label, controls,
          category: presetCategory.trim(), visibility: original?.visibility ?? "private" }),
      });
      const payload = (await response.json()) as ApiPayload<{ preset: UserPreset }>;
      if (!isCurrent()) return;
      if (!response.ok || !payload.ok) {
        if (response.status === 401 && !original && presetEditorType === "setup") {
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
      setEditingPreset(null);
      setPresetEditorType("setup");
      setPresetDescription("");
      setPresetCategory("");
      setDeleteConfirmPresetId(null);
      if (viewerScopeRef.current) {
        clearPresetDraft(viewerScopeRef.current);
      }
      setStatus(`${original ? "Updated" : "Saved"} preset "${label}".`);
      void refreshPresets();
    } catch {
      if (!isCurrent()) return;
      setStatus("Couldn't save preset. Check your connection and try again.");
    } finally {
      if (isCurrent()) {
        presetSavingRef.current = false;
        setPresetSaving(false);
      }
    }
  }

  const applyPreset = useCallback((preset: UserPreset) => {
    const controls = isRecord(preset.controls) ? preset.controls : {};
    const fragmentType = presetFragmentType(preset);
    if (fragmentType) {
      const select = { mode: setModePresetId, background: setBackgroundPresetId, pose: setPosePresetId, outfit: setOutfitPresetId }[fragmentType];
      select(preset.id);
    } else {
      setModePresetId(presetControlString(controls, "modePresetId"));
      setBackgroundPresetId(presetControlString(controls, "backgroundPresetId"));
      setPosePresetId(presetControlString(controls, "posePresetId"));
      setOutfitPresetId(presetControlString(controls, "outfitPresetId"));
      setPrompt(canUsePrompt ? presetControlString(controls, "prompt") : "");
    }
    setMode("image");
    setImageWorkflow("presets");
    setDeleteConfirmPresetId(null);
    setStatus(`Applied preset "${preset.label}".`);
  }, [canUsePrompt]);

  function editPreset(preset: UserPreset) {
    if (presetSavingRef.current) return;
    const type = presetFragmentType(preset);
    setEditingPreset(preset);
    setPresetEditorType(type ?? "setup");
    setPresetName(preset.label);
    setPresetCategory(preset.category ?? "");
    setPresetDescription(type ? Object.values(preset.controls).filter((value): value is string => typeof value === "string").join(", ") : "");
    if (!type) applyPreset(preset);
    setStatus(type ? `Editing preset "${preset.label}".` : `Editing "${preset.label}". Adjust its image controls above, then save changes.`);
  }

  function cancelPresetEdit() {
    if (presetSavingRef.current) return;
    setEditingPreset(null);
    setPresetName("");
    setPresetEditorType("setup");
    setPresetDescription("");
    setPresetCategory("");
    setStatus("");
  }

  useEffect(() => {
    const scope = config?.viewer.scope;
    if (!config?.viewer.authenticated || !scope || presetsAuthority.phase !== "ready") return;
    const presetId = new URLSearchParams(window.location.search).get("presetId");
    if (!presetId) return;
    const routeKey = `${scope}:${presetId}`;
    if (appliedRoutePresetRef.current === routeKey) return;
    // The owned list is the authority: a URL must never load another viewer's
    // preset. Apply only once so a focus refresh does not erase form edits.
    const preset = userPresets.find((candidate) => candidate.id === presetId);
    const timer = window.setTimeout(() => {
      if (viewerScopeRef.current !== scope || viewerAuthenticatedRef.current !== true) return;
      appliedRoutePresetRef.current = routeKey;
      setView("create");
      setImageWorkflow("presets");
      setAdvancedOpen(true);
      if (preset) applyPreset(preset);
      else setStatus("This saved preset is unavailable. Choose one of your presets below.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [applyPreset, config?.viewer.authenticated, config?.viewer.scope, presetsAuthority.phase, userPresets]);

  async function deletePreset(id: string) {
    if (presetSavingRef.current) return;
    if (deleteConfirmPresetId !== id) {
      setDeleteConfirmPresetId(id);
      setStatus("Press Confirm delete preset to delete this preset.");
      return;
    }
    const viewer = beginPrivateViewerRequest();
    if (!viewer) return;
    presetSavingRef.current = true;
    setPresetSaving(true);
    try {
      const response = await fetch(`/api/v1/generation/presets/${encodeURIComponent(id)}`, {
        method: "DELETE", signal: viewer.controller.signal,
        headers: { "x-idream-viewer-scope": viewer.scope },
      });
      if (!privateViewerRequestIsCurrent(viewer)) return;
      if (!response.ok) {
        setDeleteConfirmPresetId(null);
        setStatus("Couldn't delete preset.");
        void refreshPresets();
        return;
      }
      if (editingPreset?.id === id) {
        setEditingPreset(null);
        setPresetName("");
        setPresetDescription("");
        setPresetCategory("");
        setPresetEditorType("setup");
      }
      setStatus("Preset deleted.");
      await refreshPresets();
    } catch {
      if (!privateViewerRequestIsCurrent(viewer)) return;
      setStatus("Couldn't delete preset. Check your connection and try again.");
      void refreshPresets();
    } finally {
      if (privateViewerRequestIsCurrent(viewer)) {
        presetSavingRef.current = false;
        setPresetSaving(false);
      }
      finishPrivateViewerRequest(viewer);
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
      if (action === "delete") {
        setImageEditSources((current) => current.filter((item) => !ids.includes(item.id)));
        setSelectedEditSource((current) => current && ids.includes(current.id) ? null : current);
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
        {/* 切换器必须和面板用同一个断点：面板已从 md 推到 lg，这里若还停在 md，
            768–1023 之间就会「切换器没了、面板也被 view 挡住」，用户够不到
            Jobs / Gallery。 */}
        <div className="mb-4 grid grid-cols-3 gap-2 lg:hidden">
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

        {/* 双栏从 md(768) 推到 lg(1024)：md 起左侧 220px 侧栏就已常驻，再叠一个
            固定 390px 的表单栏，768px 下装不下，整页横向溢出 60px（iPad 竖屏）。
            1024 起才有余量，之前的宽度一律走单栏。 */}
        <div className="grid gap-5 lg:grid-cols-[390px_1fr]">
          <form
            className={`${view === "create" ? "block" : "hidden"} rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-4 lg:block`}
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
                      if (item !== imageWorkflow) {
                        setPrompt("");
                        setNegativePrompt("");
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
                      Pick a Gallery image, then describe the exact change you want.
                    </p>
                  </div>
                  <button
                    className="h-8 rounded-full bg-[rgb(36,36,36)] px-3 text-[11px] font-black text-white"
                    onClick={() => switchGallery("image")}
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
                  <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto p-1">
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
                            setSelectedEditSource(item);
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
                {!configAuthorityUnavailable &&
                charactersAuthority.phase === "loading" &&
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

            {selectedCharacter && characterImageMode && (
              <div className="mt-4">
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Character identity
                </p>
                <div className="mt-2 flex min-h-10 items-center justify-between gap-3 rounded-[10px] bg-black/25 px-3 py-2 text-xs">
                  <span className="inline-flex min-w-0 items-center gap-2 font-bold text-white">
                    <ImageIcon className="h-4 w-4 shrink-0 text-[rgb(255,64,180)]" />
                    <span className="truncate">
                      {identityRoutingLocked
                        ? "Identity locked"
                        : selectedCharacter?.canEditIdentity
                          ? "Set up identity image"
                          : "No locked identity profile"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[rgb(170,170,170)]">
                    {identityRoutingLocked
                      ? "We keep them recognizable"
                      : selectedCharacter?.canEditIdentity
                        ? "No anchor"
                        : "Published character"}
                  </span>
                </div>
                {!identityRoutingLocked && (
                  <div className="mt-2 rounded-[10px] border border-[rgb(255,184,112)]/30 bg-[rgb(36,28,18)] p-3 text-[12px] font-semibold leading-5 text-[rgb(255,184,112)]">
                    {selectedCharacter?.canEditIdentity
                      ? "This legacy character has no confirmed identity image. Set one up before relying on consistent results."
                      : "This published character is not on the identity-locked route yet. Generation can continue, but visual consistency may vary."}
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
                {!anonymousViewer && generatorShowsSavedLooksEmpty(
                  selectedCharacter?.canEditIdentity === true,
                  looksAuthority,
                  looks.length,
                ) ? (
                  <p className="mt-3 text-[12px] font-semibold text-[rgb(114,113,112)]">
                    No saved Looks for this character yet.
                  </p>
                ) : null}
              </div>
            )}

            {mode === "video" && selectedCharacter ? (
              <div
                className="mt-4 flex gap-3 rounded-[10px] border border-white/10 bg-black/25 p-3"
                data-testid="generator-video-source"
              >
                <div className="relative h-24 w-20 shrink-0 overflow-hidden rounded-[8px] bg-[rgb(36,36,36)]">
                  <Image
                    alt={`${selectedCharacter.title} animation source`}
                    className="object-cover object-top"
                    fill
                    sizes="80px"
                    src={selectedCharacter.image}
                    unoptimized={isPrivateMediaUrl(selectedCharacter.image)}
                  />
                </div>
                <div className="min-w-0 py-1">
                  <p className="text-[12px] font-black uppercase text-white">
                    {videoModeCopy.sourceTitle}
                  </p>
                  <p className="mt-1 text-[12px] font-medium leading-5 text-[rgb(170,170,170)]">
                    {videoModeCopy.sourceDescription}
                  </p>
                </div>
              </div>
            ) : null}

            <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                {imageEditMode
                  ? "Edit instructions"
                  : mode === "video"
                  ? videoModeCopy.promptLabel
                  : characterImageMode
                    ? "Describe the moment"
                    : "Scene Prompt"}
                <textarea
                  aria-label={imageEditMode ? "Edit instructions" : "Prompt"}
                  className="mt-2 min-h-24 w-full rounded-[10px] bg-[rgb(36,36,36)] p-4 text-[13px] font-semibold text-white outline-none disabled:text-[rgb(114,113,112)]"
                  disabled={!imageEditMode && !canDescribeMoment}
                  id="generator-prompt"
                  name="prompt"
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={
                    imageEditMode
                      ? "Describe exactly what should change. Everything else stays the same."
                      : canDescribeMoment
                      ? mode === "video"
                        ? videoModeCopy.promptPlaceholder
                        : characterImageMode
                        ? `What is ${selectedCharacter?.title ?? "the character"} doing, where are they, and how does the moment feel?`
                        : "Scene, pose, mood"
                      : "Premium control"
                  }
                  value={prompt}
                />
              </label>

            {!imageEditMode ? (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  Orientation
                  <select
                    className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                    disabled={formUnconfirmed || !modeAvailable || !generationQuote}
                    id="generator-orientation"
                    name="orientation"
                    onChange={(event) => setOrientation(event.target.value)}
                    value={orientation}
                  >
                    {formUnconfirmed && !allowedGeneratorOrientations.includes(orientation) && <option value={orientation}>{orientation}</option>}
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
                      formUnconfirmed || mode === "video" ||
                      !modeAvailable ||
                      !generationQuote
                    }
                    type="number"
                    value={formUnconfirmed ? count : outputCount}
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
                  disabled={formUnconfirmed || !modeAvailable || !generationQuote}
                  type="number"
                  value={formUnconfirmed ? count : outputCount}
                />
              </label>
            )}

            {!characterImageMode && (
              <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                Model
                <select
                  aria-label="Model"
                  className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                  disabled={formUnconfirmed || !modeAvailable}
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
                  value={formUnconfirmed && modelSelection.explicit ? modelSelection.id : modelSelectionProjection.selectValue}
                >
                  <option value="">{modelSelectionProjection.displayedLabel}</option>
                  {formUnconfirmed && modelSelection.explicit && !availableModels.some((item) => item.id === modelSelection.id) && (
                    <option value={modelSelection.id}>Original model selection</option>
                  )}
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
              (presetCatalog.length > 0 || userPresets.length > 0) && (
              <div className="mt-4 grid gap-3">
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">Presets</p>
                <label className="grid gap-1 text-[12px] font-semibold text-[rgb(170,170,170)]">
                  Search presets
                  <input className="h-11 min-w-0 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-base text-white"
                    maxLength={200} onChange={(event) => setPresetSearch(event.target.value)} type="search" value={presetSearch} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1 text-[12px] font-semibold text-[rgb(170,170,170)]">
                    Preset source
                    <select className="h-11 min-w-0 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-base text-white"
                      onChange={(event) => setPresetScope(event.target.value as typeof presetScope)} value={presetScope}>
                      <option value="all">All presets</option><option value="built_in">Built-in</option>
                      <option value="community">Community</option><option value="user">My presets</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-[12px] font-semibold text-[rgb(170,170,170)]">
                    Preset category
                    <select className="h-11 min-w-0 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-base text-white"
                      onChange={(event) => setPresetFilterCategory(event.target.value)} value={presetFilterCategory}>
                      <option value="">All categories</option>
                      {presetCategories.map((category) => <option key={category} value={category}>{category}</option>)}
                    </select>
                  </label>
                </div>
                {!presetCatalog.some(matchesPresetFilter) && visibleUserPresets.length === 0 && (
                  <p className="text-[13px] text-[rgb(170,170,170)]">No presets match these filters.</p>
                )}
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

            {config && mode === "image" && !imageEditMode && (!characterImageMode || advancedOpen) && (
              <div className="mt-4 grid gap-3" data-testid="my-presets">
                <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                  My Presets
                </p>
                <fieldset className="grid min-w-0 gap-2" disabled={presetSaving}>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="grid gap-1 text-[12px] font-semibold text-[rgb(170,170,170)]">
                      Save as
                      <select aria-label="Preset type" className="h-11 min-w-0 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-base text-white disabled:opacity-60"
                        disabled={Boolean(editingPreset) || anonymousViewer || configAuthorityUnavailable}
                        onChange={(event) => setPresetEditorType(event.target.value as typeof presetEditorType)} value={presetEditorType}>
                        <option value="setup">Current setup</option><option value="mode">Style</option>
                        <option value="background">Background</option><option value="pose">Pose</option><option value="outfit">Outfit</option>
                      </select>
                    </label>
                    <label className="grid gap-1 text-[12px] font-semibold text-[rgb(170,170,170)]">
                      Category (optional)
                      <input aria-label="Saved preset category" className="h-11 min-w-0 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-base text-white"
                        maxLength={80} onChange={(event) => setPresetCategory(event.target.value)} value={presetCategory} />
                    </label>
                  </div>
                  {presetEditorType !== "setup" && (
                    <label className="grid gap-1 text-[12px] font-semibold text-[rgb(170,170,170)]">
                      Description
                      <textarea aria-label="Preset description" className="min-h-24 min-w-0 rounded-[10px] bg-[rgb(36,36,36)] px-3 py-2 text-base text-white"
                        maxLength={1500} onChange={(event) => setPresetDescription(event.target.value)}
                        placeholder="Describe the setting, pose, outfit, or visual style to reuse." value={presetDescription} />
                    </label>
                  )}
                  <div className="flex gap-2">
                  <input
                    aria-label="Preset name"
                    className="h-11 min-w-0 flex-1 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-base font-semibold text-white outline-none"
                    id="generator-preset-name"
                    maxLength={80}
                    name="presetName"
                    onChange={(event) => setPresetName(event.target.value)}
                    placeholder="Name this preset"
                    value={presetName}
                  />
                  <button
                    className="h-11 shrink-0 rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)] disabled:bg-[rgb(64,64,64)] disabled:text-[rgb(150,150,150)]"
                    disabled={!presetName.trim() || presetSaving || configAuthorityUnavailable || (presetEditorType !== "setup" && !presetDescription.trim())}
                    onClick={() => void saveCurrentPreset()}
                    type="button"
                  >
                    {presetSaving ? "Saving…" : editingPreset ? "Save changes" : "Save"}
                  </button>
                </div>
                  {editingPreset && <button className="justify-self-start rounded-full px-3 py-2 text-[13px] font-semibold text-white underline underline-offset-4"
                    onClick={cancelPresetEdit} type="button">Cancel editing</button>}
                </fieldset>
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
                ) : visibleUserPresets.length > 0 ? (
                  <ul className="grid gap-2">
                    {visibleUserPresets.map((preset) => {
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
                              disabled={presetSaving}
                              onClick={() => applyPreset(preset)}
                              type="button"
                            >
                              Apply
                            </button>
                            <button aria-label={`Edit preset ${preset.label}`} className="h-8 rounded-full bg-black/40 px-3 text-[11px] font-black text-white"
                              disabled={presetSaving} onClick={() => editPreset(preset)} type="button">Edit</button>
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
                              disabled={presetSaving}
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

            {(!characterImageMode || advancedOpen) && (
              <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                Negative Prompt
                <input
                  className="mt-2 h-11 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none disabled:text-[rgb(114,113,112)]"
                  disabled={!imageEditMode && !canUsePrompt}
                  id="generator-negative-prompt"
                  name="negativePrompt"
                  onChange={(event) => setNegativePrompt(event.target.value)}
                  placeholder={imageEditMode || canUsePrompt ? "Artifacts to avoid" : "Premium control"}
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

            {mode === "video" && !formUnconfirmed && generationQuote?.video && (
              <p className="mt-3 text-[12px] text-white/70" data-testid="generator-video-specifications">
                About {Math.round(generationQuote.video.durationSeconds)} seconds · {generationQuote.video.width}×{generationQuote.video.height} · {generationQuote.video.audio === "generated" ? "Generated audio" : "No audio"}
              </p>
            )}
            {formUnconfirmed && <p className="mt-3 text-[12px] text-white/70">Check the existing request with its original settings and price.</p>}
            {!formUnconfirmed && pendingReceipts.length > 0 && <p className="mt-3 text-[12px] text-white/70">You have an earlier request to check in Jobs. This changed request uses the new price below and may create another job.</p>}
            {receiptOwnerScope && receiptStorageWarning && <p role="status" className="mt-3 text-[12px] text-white/70">{receiptStorageWarning}</p>}
            {insufficientBalance && !formUnconfirmed && (
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
                disabled={!formCanSubmit}
                type="submit"
              >
                <WandSparkles className="h-4 w-4" />
                {pending
                  ? imageEditMode
                    ? "Queuing edit..."
                    : "Queuing..."
                  : formUnconfirmed
                    ? "Check generation request"
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
                          : `${pendingReceipts.length > 0 ? "Generate new" : imageEditMode ? "Create edit" : characterImageMode ? "Generate this moment" : "Generate"} · ${estimatedCost} coins`}
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
                    Continue the moment
                  </h2>
                  <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">
                    Tell us whether the identity feels right, or continue from this image.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {latestResults.map((item, index) => {
                    const source = item.type === "video" ? item.url : (item.thumbnailUrl ?? item.url);
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
                              <div>
                                Preview unavailable
                                {item.type === "video" && failedLatestResultIds.has(item.id) && (
                                  <button className="mt-3 block rounded-full bg-white px-4 py-2 text-[13px] font-bold text-black"
                                    onClick={() => setFailedLatestResultIds((current) => { const next = new Set(current); next.delete(item.id); return next; })}
                                    type="button">Retry preview</button>
                                )}
                              </div>
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
              className={`${view === "jobs" ? "block" : "hidden"} rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-4 lg:block`}
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
                {receiptOwnerScope && pendingReceipts.length > 0 && (
                  <div className="rounded-[10px] border border-white/20 p-4" data-testid="generation-pending-requests">
                    <h3 className="text-[14px] font-bold text-white">Requests to check</h3>
                    <p className="mt-1 text-[12px] text-white/70">Check the original settings and price. This may complete the original submission if it had not reached the server. It does not use your current form.</p>
                    {pendingReceipts.map((receipt) => {
                      const quote = receipt.body.quoteAuthority as GenerationQuoteAuthority;
                      const controls = isRecord(receipt.body.controls) ? receipt.body.controls : {};
                      const orientation = receipt.body.orientation ?? controls.orientation;
                      const busy = generationRequest.recoveringReceiptKeys.has(receipt.key) || enhancementCheckKey === receipt.key;
                      return <div className="mt-3 rounded-lg bg-black/20 p-3" data-pending-request-key={receipt.key} key={receipt.key}>
                        <p className="text-[13px] font-bold text-white">{receipt.kind === "media_enhancement" ? "Enhance 2×" : receipt.kind === "generation_retry" ? "Generation retry" : receipt.kind === "media_variation" ? "Image edit" : receipt.body.mode === "video" ? "Video" : "Image"} · {quote.outputCount} output{quote.outputCount === 1 ? "" : "s"}{orientation ? ` · ${String(orientation)}` : ""} · {quote.costDreamcoins} coins</p>
                        {typeof receipt.body.prompt === "string" && receipt.body.prompt && <p className="mt-1 break-words text-[12px] text-white/70">{receipt.body.prompt.slice(0, 180)}</p>}
                        <p className="mt-1 break-all text-[11px] text-white/50">Request {receipt.key}</p>
                        <button className="mt-2 rounded-full bg-white px-4 py-2 text-[12px] font-bold text-black disabled:opacity-50" disabled={busy} type="button"
                          onClick={() => receipt.kind === "media_enhancement" ? void recoverEnhancementReceipt(receipt) : void generationRequest.recoverReceipt(receipt, generationRequestEffects)}>
                          {busy ? "Checking original request…" : "Check original request"}
                        </button>
                        <Link className="ml-3 text-[12px] text-white underline" href="/helpdesk">Get help</Link>
                      </div>;
                    })}
                  </div>
                )}
                {configAuthorityUnavailable ? (
                  <GeneratorAuthorityNotice
                    hasSnapshot={false}
                    message="Generation jobs are unavailable until the generator reconnects."
                    onRetry={() => void refreshWorkspaceAuthority()}
                  />
                ) : anonymousViewer ? (
                  <GeneratorPrivateDataAuthHint label="your generation jobs" />
                ) : null}
                {!configAuthorityUnavailable &&
                !anonymousViewer &&
                jobsAuthority.phase === "error" ? (
                  <GeneratorAuthorityNotice
                    hasSnapshot={jobsAuthority.hasSnapshot}
                    message={jobsAuthority.error ?? "Jobs could not load."}
                    onRetry={() => void refreshJobs()}
                  />
                ) : null}
                {!configAuthorityUnavailable &&
                !anonymousViewer &&
                jobsAuthority.phase === "loading" &&
                !jobsAuthority.hasSnapshot ? (
                  <div className="rounded-[10px] bg-[rgb(36,36,36)] p-5 text-[13px] font-medium text-[rgb(170,170,170)]">
                    Loading jobs…
                  </div>
                ) : null}
                {!configAuthorityUnavailable &&
                !anonymousViewer &&
                authorityShowsEmpty(jobsAuthority, jobs.length) && (
                  <div className="rounded-[10px] bg-[rgb(36,36,36)] p-5 text-[13px] font-medium text-[rgb(170,170,170)]">
                    No jobs yet.
                  </div>
                )}
                {!configAuthorityUnavailable && jobs.map((job) => (
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
                          {generatorJobStatusLabel(job.mode, job.status, job.errorCode)}
                        </p>
                      </div>
                      <span className="rounded-full bg-black/30 px-3 py-1 text-[11px] font-bold uppercase text-white">
                        {job.errorCode === "provider_outcome_unknown" ? "Needs review" : job.status}
                      </span>
                    </div>
                    {job.errorCode === "provider_outcome_unknown" && (
                      <p className="mt-3 text-[12px] font-medium text-[rgb(170,170,170)]">
                        The result could not be confirmed. Please contact support before trying again.
                        {" "}<Link className="underline" href="/helpdesk">Contact support</Link>
                        <span className="mt-1 block break-all">Request: {job.id}</span>
                      </p>
                    )}
                    {job.status === "failed" && (
                      <div className="mt-3 flex flex-col gap-2">
                        <button
                          className="h-9 w-fit rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)] disabled:bg-[rgb(64,64,64)] disabled:text-[rgb(150,150,150)]"
                          disabled={
                            retryingJobIds.has(job.id) ||
                            (!retryQuotes[job.id] && !generationRequest.isRetryUnconfirmed(job.id)) ||
                            (
                              Boolean(retryQuotes[job.id] && retryQuotes[job.id]!.costDreamcoins >
                              retryQuotes[job.id]!.balance) && !generationRequest.isRetryUnconfirmed(job.id)
                            )
                          }
                          onClick={() => retryJob(job.id)}
                          type="button"
                        >
                          {retryingJobIds.has(job.id)
                            ? "Retrying…"
                            : generationRequest.isRetryUnconfirmed(job.id) ? "Check retry request"
                            : retryQuotes[job.id]
                              ? `Retry · ${retryQuotes[job.id]!.costDreamcoins} coins`
                              : retryQuoteFailures[job.id]
                                ? "Retry price unavailable"
                                : "Checking retry price…"}
                        </button>
                        <p className="text-[12px] font-medium text-[rgb(170,170,170)]">
                          {generationRequest.isRetryUnconfirmed(job.id)
                            ? "Check the existing request before starting another retry."
                            : retryQuoteFailures[job.id]
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
              className={`${view === "gallery" ? "block" : "hidden"} rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-4 lg:block`}
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

              {config?.viewer.authenticated === true && (
                <form
                  aria-label="Gallery filters"
                  className="mb-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    applyGalleryFilters({ q: gallerySearch.trim(), visibility: galleryVisibility });
                  }}
                >
                  <label className="grid min-w-0 flex-[1_1_12rem] gap-1 text-[12px] text-[rgb(170,170,170)]">
                    Search Gallery
                    <input
                      className="h-11 min-w-0 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[16px] text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                      maxLength={200}
                      onChange={(event) => setGallerySearch(event.target.value)}
                      placeholder="Search your images and videos"
                      type="search"
                      value={gallerySearch}
                    />
                  </label>
                  <label className="grid gap-1 text-[12px] text-[rgb(170,170,170)]">
                    Visibility
                    <select
                      className="h-11 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[16px] text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                      onChange={(event) => setGalleryVisibility(event.target.value as GalleryFilters["visibility"])}
                      value={galleryVisibility}
                    >
                      <option value="">All visibility</option>
                      <option value="private">Private</option>
                      <option value="public_pack">Public</option>
                      <option value="unlisted">Unlisted</option>
                    </select>
                  </label>
                  <button className="h-11 rounded-full bg-white px-4 text-[13px] font-bold text-[rgb(13,13,13)]" type="submit">
                    Apply filters
                  </button>
                  {(gallerySearch || galleryVisibility || galleryFilters.q || galleryFilters.visibility) && (
                    <button
                      className="h-11 rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
                      onClick={() => {
                        setGallerySearch("");
                        setGalleryVisibility("");
                        applyGalleryFilters({ q: "", visibility: "" });
                      }}
                      type="button"
                    >
                      Clear filters
                    </button>
                  )}
                </form>
              )}

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
              {configAuthorityUnavailable ? (
                <div className="mb-4">
                  <GeneratorAuthorityNotice
                    hasSnapshot={false}
                    message="Your gallery is unavailable until the generator reconnects."
                    onRetry={() => void refreshWorkspaceAuthority()}
                  />
                </div>
              ) : null}
              {!configAuthorityUnavailable &&
              !anonymousViewer &&
              mediaAuthority.phase === "error" ? (
                <div className="mb-4">
                  <GeneratorAuthorityNotice
                    hasSnapshot={mediaAuthority.hasSnapshot}
                    message={mediaAuthority.error ?? "Gallery could not load."}
                    onRetry={() => void refreshMedia(galleryTab)}
                  />
                </div>
              ) : null}
              {!configAuthorityUnavailable &&
              !anonymousViewer &&
              mediaAuthority.phase === "loading" &&
              !mediaAuthority.hasSnapshot ? (
                <div className="mb-4 rounded-[10px] bg-[rgb(36,36,36)] p-5 text-[13px] font-medium text-[rgb(170,170,170)]">
                  Loading gallery…
                </div>
              ) : null}
              {enhancement && (
                <section aria-label="Enhance image" className="mb-4 grid gap-3 rounded-[12px] border border-white/10 bg-[rgb(28,28,28)] p-4">
                  <div className="flex items-center gap-4">
                    <Image alt="Image to enhance" src={enhancement.source.thumbnailUrl || enhancement.source.url}
                      width={72} height={90} unoptimized className="h-24 w-20 rounded-lg object-contain" />
                    <div>
                      <h3 className="text-[14px] font-black text-white">Enhance image · 2×</h3>
                      <p className="mt-1 text-[12px] text-[rgb(170,170,170)]">Save a sharper, larger copy. Your original stays in Gallery.</p>
                      {enhancement.quote && (
                        <p className="mt-2 text-[13px] font-semibold text-white">
                          {enhancement.quote.enhancement.sourceWidth} × {enhancement.quote.enhancement.sourceHeight}
                          {" → "}{enhancement.quote.enhancement.width} × {enhancement.quote.enhancement.height}
                        </p>
                      )}
                    </div>
                  </div>
                  {enhancement.loading && <p role="status" className="text-[13px] text-white/70">Checking enhancement price…</p>}
                  {enhancement.error && <p role="alert" className="text-[13px] text-[rgb(255,168,206)]">{enhancement.error}</p>}
                  {enhancementUnconfirmed && <p className="text-[13px] text-white/70">Check the existing request before starting another enhancement.</p>}
                  {enhancement.quote && !enhancementCost?.affordable && !enhancementUnconfirmed && (
                    <p className="text-[13px] text-white/70">Need {enhancementCost?.costDreamcoins} coins · you have {enhancement.quote.quote.balance}.</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button type="button" disabled={enhancement.submitting} onClick={closeEnhancement}
                      className="h-9 rounded-full bg-white/10 px-4 text-[12px] font-bold text-white disabled:opacity-50">Cancel enhancement</button>
                    {!enhancement.loading && !enhancement.quote && (
                      <button type="button" onClick={() => void quoteEnhancement(enhancement.source)}
                        className="h-9 rounded-full bg-white/10 px-4 text-[12px] font-bold text-white">Check enhancement price</button>
                    )}
                    {(enhancement.quote || enhancementUnconfirmed) && (
                      <button type="button" disabled={enhancement.submitting || (!enhancementCost?.affordable && !enhancementUnconfirmed)}
                        onClick={() => void submitEnhancement()}
                        className="h-9 rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)] disabled:opacity-50">
                        {enhancement.submitting ? "Starting enhancement…" : enhancementUnconfirmed ? "Check enhancement request" : `Enhance 2× · ${enhancementCost?.costDreamcoins} coins`}
                      </button>
                    )}
                  </div>
                </section>
              )}
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
                {!configAuthorityUnavailable && media.map((item, index) => {
                  const source = item.type === "video" ? item.url : (item.thumbnailUrl ?? item.url);
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
                            {item.type === "video" && failedMediaIds.has(item.id) && (
                              <button className="mt-1 rounded-full bg-white px-4 py-2 text-[13px] font-bold text-black"
                                onClick={() => setFailedMediaIds((current) => { const next = new Set(current); next.delete(item.id); return next; })}
                                type="button">Retry preview</button>
                            )}
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
                            <div className="absolute left-2 top-2 flex gap-2 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                              <IconButton
                                label="Edit image"
                                onClick={() => editGalleryImage(item)}
                              >
                                <Pencil className="h-4 w-4" />
                              </IconButton>
                              {config?.image.enhance?.available && item.enhanceEligible && !isUnavailable && (
                                <IconButton label="Enhance image 2×" disabled={enhancement?.submitting === true}
                                  onClick={() => void quoteEnhancement(item)}>
                                  <WandSparkles className="h-4 w-4" />
                                </IconButton>
                              )}
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
                          <div className={`absolute inset-x-2 ${item.type === "video" ? "top-2" : "bottom-2"} flex justify-end gap-2 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100`}>
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
                            <IconButton
                              label="Report"
                              onClick={() =>
                                openReport({
                                  kind: "record",
                                  targetType: "media",
                                  targetId: item.id,
                                })
                              }
                            >
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
                {!configAuthorityUnavailable &&
                !anonymousViewer &&
                authorityShowsEmpty(mediaAuthority, media.length) && (
                  <div className="col-span-full grid min-h-40 place-items-center rounded-[10px] bg-[rgb(36,36,36)] text-[13px] font-medium text-[rgb(170,170,170)]">
                    <div className="flex items-center gap-2">
                      <ImageIcon className="h-4 w-4" />
                      {galleryFilters.q || galleryFilters.visibility ? "No media match these filters." : "No media yet."}
                    </div>
                  </div>
                )}
              </div>
              {!configAuthorityUnavailable && !anonymousViewer &&
              (mediaPage.nextCursor || mediaCursorTrail.length > 1) && (
                <nav aria-label="Gallery pages" className="mt-4 flex items-center justify-between gap-3">
                  <button
                    className="h-9 rounded-full bg-[rgb(36,36,36)] px-4 text-[12px] font-bold text-white disabled:opacity-40"
                    disabled={mediaAuthority.phase === "loading" || mediaCursorTrail.length <= 1}
                    onClick={() => void refreshMediaPage({ tab: galleryTab, ...galleryFiltersRef.current, cursors: mediaCursorTrail.slice(0, -1) })}
                    type="button"
                  >
                    Previous page
                  </button>
                  <span className="text-[12px] text-[rgb(170,170,170)]">Page {mediaCursorTrail.length}</span>
                  <button
                    className="h-9 rounded-full bg-[rgb(36,36,36)] px-4 text-[12px] font-bold text-white disabled:opacity-40"
                    disabled={mediaAuthority.phase === "loading" || !mediaPage.nextCursor}
                    onClick={() => void refreshMediaPage({ tab: galleryTab, ...galleryFiltersRef.current, cursors: [...mediaCursorTrail, mediaPage.nextCursor ?? null] })}
                    type="button"
                  >
                    Next page
                  </button>
                </nav>
              )}
            </section>
          </div>
        </div>
      </div>
      {reportDialog}
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
        className="h-full w-full object-contain"
        controls
        data-testid={`${testIdPrefix}-media-video`}
        onError={onError}
        playsInline
        poster={item.thumbnailUrl !== item.url && !isBuiltInMediaPlaceholderUrl(item.thumbnailUrl) ? item.thumbnailUrl : undefined}
        preload="none"
      >
        <source onError={onError} src={item.url} type={item.contentType ?? "video/mp4"} />
        Video playback is not supported.
      </video>
    );
  }

  const imageLabel = item.enhancement ? "Enhanced image" : "Image creation";
  const characterName = item.provenance?.sourceCharacterName?.replace(/\s+/g, " ").trim().slice(0, 80);
  return (
    <Image
      alt={characterName ? `${imageLabel} · ${characterName}` : imageLabel}
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

function presetFragmentType(preset: UserPreset): PresetConfig["type"] | null {
  if (preset.type !== "mode" && preset.type !== "background" && preset.type !== "pose" && preset.type !== "outfit") return null;
  return ["modePresetId", "backgroundPresetId", "posePresetId", "outfitPresetId", "prompt"].some((key) => Object.hasOwn(preset.controls, key))
    ? null : preset.type;
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

export function generatorJobStatusLabel(
  mode: GenerationMode,
  status: string,
  errorCode: string | null,
) {
  if (errorCode === "provider_outcome_unknown") return "Result needs review";
  if (!isCatalogMember(GENERATION_JOB_STATUSES, status)) return status;
  if (mode === "video" && status === "queued") {
    return "Waiting for a rendering slot";
  }
  if (mode === "video" && status === "running") {
    return "Rendering source image · you can return later";
  }
  const label = jobStatusLabels[status];
  const reason = generationFailureCopy(errorCode);
  return reason && (status === "blocked" || status === "failed")
    ? `${label}: ${reason}`
    : label;
}
