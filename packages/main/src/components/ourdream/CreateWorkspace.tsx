"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ImageIcon, Loader2, Sparkles, Wand2 } from "lucide-react";
import { CHARACTER_VISIBILITY, isCatalogMember } from "@idream/shared/catalog";
import { legacySoulDetailsMarkdown, renderCharacterSoulMarkdown } from "@idream/shared/chat/persona-render";
import {
  characterStyleFormOptions,
  genderFormOptions,
} from "@/lib/character-taxonomy";
import { isPrivateMediaUrl } from "@/lib/image-delivery";
import { cn } from "@/lib/utils";
import {
  isRenderableMediaSource,
  parseTemplatesResponse,
  parseCharacterQuickStartResponse,
  parseCharacterVoiceCatalogResponse,
  parseCharacterVoicePreviewResponse,
  type CharacterVoiceCatalog,
  parseTagListResponse,
  type PublicTagList,
  parseViewerAuthorityResponse,
  parseChatSessionCreateResponse,
  type PublicCharacterTemplate as CreateTemplate,
} from "@/lib/public-api-contracts";
import { useAgeGateAccess } from "./AgeGateBoundary";
import {
  claimDraftTransfer,
  isAnonymousScope,
  stashDraftTransfer,
} from "./draft-transfer";
import { isRecord } from "./workspace-helpers";
import { CREATE_SOUL_DETAIL_FIELDS } from "@/lib/create-soul-catalog";
import { unknownOutcomeCopy } from "@/lib/generation-failure-copy";
import {
  CREATE_PREVIEW_CANDIDATE_COUNT,
  continueCreatePreviewBatch,
  newCreatePreviewBatch,
  parseCreatePreviewBatch,
  parseCreatePreviewCandidate,
  retryCreatePreviewBatch,
  resumeCreatePreviewBatch,
  type CreatePreviewBatch,
  type CreatePreviewCandidate,
  type CreatePreviewJobStatus,
} from "./create-preview-flow";

type DraftPayload = {
  ok?: boolean;
  error?: { message?: string; details?: { blocker?: string } };
  data?: {
    draft?: ServerCharacterDraft | null;
    character?: { id: string; name: string; visibility: string; imageUrl?: string | null; published?: boolean; visual?: CharacterEditVisual };
    pendingPublication?: boolean;
    visibilityWarning?: string | null;
    asset?: { id?: string; url: string; isSynthetic?: boolean };
    previewJob?: { id: string; status: string; errorCode?: string | null };
    previewCandidates?: unknown[];
  };
};

export type ServerCharacterDraft = {
  id: string;
  updatedAt: string;
  step: number;
  gender: string | null;
  style: string | null;
  appearance: unknown;
  hair: unknown;
  body: unknown;
  name: string | null;
  advancedDetails: unknown;
  tags: unknown;
  previewJobId: string | null;
};

type PreviewStatus = "idle" | "generating" | "paused" | "complete" | "failed";

// Identity-defining traits of the Character being edited, in the wizard's projection.
type CharacterEditVisual = {
  gender: string | null;
  style: string | null;
  age: number;
  appearance: unknown;
  hair: unknown;
  body: unknown;
};

type CharacterEditTarget = {
  id: string;
  name: string;
  imageUrl: string | null;
  baseline: WizardState;
  // Published characters save edits as a revision for the Release pipeline; look and voice stay fixed.
  published: boolean;
};

const EDIT_IDENTITY_KEYS = ["age", "gender", "style", "appearance", "ethnicity", "skinTone", "eyeColor", "faceShape", "hair", "body"] as const;

/**
 * SPEC: an edit keeps the Character's confirmed identity while these traits are
 * unchanged; changing any of them requires a newly confirmed image (the server
 * enforces the same rule on submit).
 */
export function editKeepsIdentity(state: WizardState, baseline: WizardState) {
  return EDIT_IDENTITY_KEYS.every((key) => state[key] === baseline[key]);
}

// Templates store free-form Json; pull a usable string for the draft's prompt-shaped fields.
function pickString(value: unknown, ...keys: string[]): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of keys) {
      const inner = (value as Record<string, unknown>)[key];
      if (typeof inner === "string" && inner.trim()) return inner;
    }
  }
  return "";
}

function pickVisualText(value: unknown, ...keys: string[]): string {
  const direct = pickString(value, ...keys);
  if (direct || !isRecord(value)) return direct;
  return Object.entries(value)
    .filter(([, trait]) => typeof trait === "string" || typeof trait === "number")
    .map(([key, trait]) => `${key}: ${trait}`)
    .join(", ");
}

/** Historical templates and local drafts are read once into the one current field. */
function templateDetailsMarkdown(value: unknown): string {
  return legacySoulDetailsMarkdown(value);
}

function pickTags(value: unknown): string {
  if (Array.isArray(value)) return value.filter((t) => typeof t === "string").join(",");
  if (typeof value === "string") return value;
  return "";
}

/** 与服务端 MAX_CHARACTER_TAGS 一致（character-draft-write.ts）。 */
const MAX_TAGS = 12;
const MAX_QUICK_START_BRIEF_LENGTH = 500;
const DEFAULT_PREVIEW = "/images/ourdream/character-placeholder.svg";
const STORAGE_KEY_PREFIX = "ourdream.create.draft.v2";

export function draftStorageKeyForScope(viewerScope: string) {
  return `${STORAGE_KEY_PREFIX}:${viewerScope}`;
}

export function viewerScopeFromAuthority(input: {
  userId?: string | null;
  anonymousId?: string | null;
}) {
  if (input.userId) return `user:${input.userId}`;
  if (input.anonymousId) return `anonymous:${input.anonymousId}`;
  return null;
}

const STEPS = ["Identity", "Appearance", "Soul", "Preview", "Publish"] as const;
const VISUAL_FIELDS = [
  { key: "ethnicity", label: "Ethnicity / fantasy race", suggestions: ["East Asian", "South Asian", "Black", "Latina", "Middle Eastern", "White", "Mixed", "Elf", "Vampire"] },
  { key: "skinTone", label: "Skin tone", suggestions: ["Fair", "Light", "Olive", "Tan", "Brown", "Dark"] },
  { key: "eyeColor", label: "Eye color", suggestions: ["Brown", "Hazel", "Green", "Blue", "Gray", "Amber"] },
  { key: "faceShape", label: "Face shape / features", suggestions: ["Oval", "Round", "Heart-shaped", "Angular", "Freckles", "Dimples"] },
  { key: "hair", label: "Hair", suggestions: ["Long dark waves", "Short auburn curls", "Straight blonde hair", "Black braided hair", "Silver bob"] },
  { key: "body", label: "Body", suggestions: ["Slim", "Athletic", "Curvy", "Muscular", "Petite", "Tall"] },
] as const;

export type WizardState = {
  draftId: string;
  draftUpdatedAt: string;
  previewBatch: CreatePreviewBatch | null;
  // Candidates found on the server when this browser has no batch of its own.
  restoredPreviewCandidates: CreatePreviewCandidate[];
  confirmedPreviewJobId: string;
  confirmedPreviewUrl: string;
  step: number;
  // Local authoring intent, restored across reload/sign-in but never saved as
  // character fields or sent to the model without an explicit Prefill action.
  quickStartBrief: string;
  name: string;
  age: number;
  gender: string;
  style: string;
  appearance: string;
  ethnicity: string;
  skinTone: string;
  eyeColor: string;
  faceShape: string;
  hair: string;
  body: string;
  description: string;
  detailsMarkdown: string;
  firstMessage: string;
  tags: string;
  visibility: string;
  voiceSelection: { provider: "pocket_tts"; voiceId: string } | null;
};

const INITIAL: WizardState = {
  draftId: "",
  draftUpdatedAt: "",
  previewBatch: null,
  restoredPreviewCandidates: [],
  confirmedPreviewJobId: "",
  confirmedPreviewUrl: "",
  step: 0,
  quickStartBrief: "",
  name: "",
  age: 21,
  gender: "female",
  style: "realistic",
  appearance: "",
  ethnicity: "",
  skinTone: "",
  eyeColor: "",
  faceShape: "",
  hair: "",
  body: "",
  description: "",
  detailsMarkdown: "",
  firstMessage: "",
  tags: "",
  visibility: "private",
  voiceSelection: null,
};

export function initialCharacterDraft(): WizardState {
  return { ...INITIAL };
}

export function wizardStateFromServerDraft(
  value: ServerCharacterDraft,
): WizardState | null {
  if (!value.id || !isRecord(value.advancedDetails)) return null;
  const details = value.advancedDetails;
  const appearance = isRecord(value.appearance) ? value.appearance : {};
  const face = isRecord(appearance.face) ? appearance.face : appearance;
  const age = typeof details.age === "number" ? details.age : INITIAL.age;
  return parseWizardDraft({
    ...INITIAL,
    draftId: value.id,
    draftUpdatedAt: value.updatedAt,
    step: Math.min(value.step, STEPS.length - 1),
    name: value.name ?? "",
    age,
    gender: value.gender ?? INITIAL.gender,
    style: value.style ?? INITIAL.style,
    appearance: pickString(face, "prompt", "summary"),
    ethnicity: pickString(face, "ethnicity", "race"),
    skinTone: pickString(face, "skinTone"),
    eyeColor: pickString(face, "eyes", "eyeColor"),
    faceShape: pickString(face, "faceShape"),
    hair: pickVisualText(value.hair, "prompt", "summary") || pickVisualText(appearance.hair, "prompt", "summary"),
    body: pickVisualText(value.body, "type", "prompt", "summary") || pickVisualText(appearance.body, "type", "prompt", "summary"),
    description: pickString(details, "description"),
    detailsMarkdown: templateDetailsMarkdown(details),
    firstMessage: pickString(details, "firstMessage"),
    voiceSelection: details.voiceSelection,
    tags: pickTags(value.tags),
    confirmedPreviewJobId: value.previewJobId ?? "",
  });
}

function samePreviewInputs(left: WizardState, right: WizardState) {
  const keys = ["name", "age", "gender", "style", "appearance", "ethnicity", "skinTone", "eyeColor", "faceShape", "hair", "body", "description", "detailsMarkdown", "firstMessage"] as const;
  return keys.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

export function CreateWorkspace() {
  const query = useSearchParams();
  const editCharacterId = query.get("edit")?.trim() ?? "";
  const draftId = query.get("draft")?.trim() ?? "";
  if ((editCharacterId && draftId) || query.getAll("draft").length > 1 || query.getAll("edit").length > 1) {
    return <section className="mx-auto my-16 max-w-xl p-6" role="alert"><h1 className="text-lg font-bold">Choose one draft or character to edit.</h1><Link className="mt-4 inline-block underline" href="/creator-studio">Back to Creator Studio</Link></section>;
  }
  // A query change names a different workspace. Its old callbacks and local
  // keystrokes must not become another draft's state.
  return <CreateWizard key={`${editCharacterId}:${draftId}`} editCharacterId={editCharacterId} draftId={draftId} />;
}

function CreateWizard({ editCharacterId, draftId }: { editCharacterId: string; draftId: string }) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  // CR-06: /create?edit=<characterId> reuses this wizard on an edit draft.
  const [editTarget, setEditTarget] = useState<CharacterEditTarget | null>(null);
  const [editError, setEditError] = useState("");
  const [state, setState] = useState<WizardState>(initialCharacterDraft);
  const [preview, setPreview] = useState(DEFAULT_PREVIEW);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle");
  const [restoredPreviewReviewId, setRestoredPreviewReviewId] = useState("");
  const [selectedPreviewJobId, setSelectedPreviewJobId] = useState("");
  const [status, setStatus] = useState("");
  const [showFieldErrors, setShowFieldErrors] = useState(false);
  const [createdCharacterId, setCreatedCharacterId] = useState("");
  const [createdVisibility, setCreatedVisibility] = useState("");
  const [pending, setPending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const [draftReloadAttempt, setDraftReloadAttempt] = useState(0);
  const [viewerScope, setViewerScope] = useState<string | null>(null);
  const storageKey = viewerScope
    ? `${draftStorageKeyForScope(viewerScope)}${editCharacterId ? `:edit:${editCharacterId}` : draftId ? `:draft:${draftId}` : ""}`
    : null;
  const [viewerAuthorityState, setViewerAuthorityState] = useState<
    "loading" | "ready" | "error" | "changed"
  >("loading");
  const [viewerAuthorityAttempt, setViewerAuthorityAttempt] = useState(0);
  const [templates, setTemplates] = useState<CreateTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templatesState, setTemplatesState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [templatesAttempt, setTemplatesAttempt] = useState(0);
  const [quickStartPending, setQuickStartPending] = useState(false);
  const [quickStartError, setQuickStartError] = useState("");
  const [voiceCatalog, setVoiceCatalog] = useState<CharacterVoiceCatalog | null>(null);
  const [voiceCatalogError, setVoiceCatalogError] = useState(false);
  const [voiceCatalogAttempt, setVoiceCatalogAttempt] = useState(0);
  const [tagCatalog, setTagCatalog] = useState<PublicTagList | null>(null);
  const [tagCatalogError, setTagCatalogError] = useState(false);
  const [tagCatalogAttempt, setTagCatalogAttempt] = useState(0);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState("");
  const [voicePreviewPending, setVoicePreviewPending] = useState(false);
  const [voicePreviewStatus, setVoicePreviewStatus] = useState("");
  const voicePreviewSequence = useRef(0);
  const previewRunRef = useRef(0);
  const previewRunSequenceRef = useRef(0);
  const stateRef = useRef(state);
  const viewerBlockedRef = useRef(false);

  const invalidateViewer = useCallback(() => {
    viewerBlockedRef.current = true;
    previewRunRef.current = 0;
    voicePreviewSequence.current += 1;
    setHydrated(false);
    setViewerAuthorityState("changed");
    setState(initialCharacterDraft());
    setPreview(DEFAULT_PREVIEW);
    setVoicePreviewUrl("");
    setCreatedCharacterId("");
    setPending(false);
  }, []);

  const step = state.step;
  const quickStartBrief = state.quickStartBrief;
  const previewCandidates = state.previewBatch?.candidates ?? state.restoredPreviewCandidates;
  const set = useCallback(
    <K extends keyof WizardState>(key: K, value: WizardState[K]) =>
      setState((current) => ({ ...current, [key]: value })),
    [],
  );
  const requestApi = useCallback(
    (
      path: string,
      body?: unknown,
      method = "POST",
      options?: { idempotencyKey?: string; signal?: AbortSignal },
    ) => {
      if (viewerBlockedRef.current || !viewerScope) {
        return Promise.reject(new Error("Your account changed. Reload to open its private draft."));
      }
      if (draftConflict && method !== "GET") {
        return Promise.reject(new Error("Load the latest saved draft before saving. Your current inputs have been kept."));
      }
      const draftWrite = path.startsWith("/api/v1/character-drafts/") &&
        (method === "PATCH" || path.endsWith("/tags") || path.endsWith("/preview-anchor") || path.endsWith("/submit"));
      const requestBody = draftWrite && isRecord(body) && stateRef.current.draftUpdatedAt
        ? { ...body, expectedUpdatedAt: stateRef.current.draftUpdatedAt }
        : body;
      return api(
        path,
        requestBody,
        method,
        () => createDraftTransfer(viewerScope, stateRef.current),
        { ...options, viewerScope, onViewerChanged: invalidateViewer, onDraftConflict: () => setDraftConflict(true) },
      ).then((payload) => {
        if (viewerBlockedRef.current) throw new Error("Your account changed. Reload to open its private draft.");
        if (method !== "GET" && payload.data?.draft?.updatedAt) {
          const saved = { draftId: payload.data.draft.id, draftUpdatedAt: payload.data.draft.updatedAt };
          // Sequential wizard actions must use the just-committed version even
          // before React has rendered the next step.
          stateRef.current = { ...stateRef.current, ...saved };
          setState((current) => ({ ...current, ...saved }));
        }
        return payload;
      });
    },
    [draftConflict, invalidateViewer, viewerScope],
  );
  const persistPreviewBatch = useCallback(
    (batch: CreatePreviewBatch) => {
      if (viewerBlockedRef.current) return;
      setState((current) => ({ ...current, previewBatch: batch }));
      if (storageKey) {
        persistPreviewBatchForStorage(storageKey, batch, stateRef.current);
      }
      const firstCandidate = batch.candidates[0];
      if (firstCandidate) {
        setSelectedPreviewJobId((current) => current || firstCandidate.previewJobId);
        if (batch.candidates.length === 1) setPreview(firstCandidate.url);
      }
    },
    [storageKey],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(
    () => () => {
      previewRunRef.current = 0;
    },
    [],
  );

  // Resolve a stable viewer identity before touching local storage so drafts never
  // leak from one signed-in account to another on a shared browser.
  useEffect(() => {
    if (!ageGateAccepted) return;
    const controller = new AbortController();
    fetch("/api/v1/me", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Viewer authority unavailable");
        return parseViewerAuthorityResponse(await response.json());
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const userId = payload.user?.id;
        const anonymousId = payload.anonymousId;
        const nextScope = viewerScopeFromAuthority({ userId, anonymousId });
        if (nextScope) {
          if (userId) consumeDraftTransfer(nextScope);
          setViewerScope(nextScope);
          setViewerAuthorityState("ready");
        } else {
          setViewerAuthorityState("error");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setViewerAuthorityState("error");
      });
    return () => controller.abort();
  }, [ageGateAccepted, viewerAuthorityAttempt]);

  useEffect(() => {
    if (!viewerScope) return;
    const controller = new AbortController();
    const checkViewer = async () => {
      try {
        const response = await fetch("/api/v1/me", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const payload = parseViewerAuthorityResponse(await response.json());
        if (!controller.signal.aborted && viewerScopeFromAuthority({
          userId: payload.user?.id, anonymousId: payload.anonymousId,
        }) !== viewerScope) invalidateViewer();
      } catch {
        // Network failure does not prove a switch. Every private request also
        // carries its original viewer scope, checked by Main before side effects.
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void checkViewer(); };
    window.addEventListener("focus", checkViewer);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.removeEventListener("focus", checkViewer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [invalidateViewer, viewerScope]);

  // Local storage keeps unsaved keystrokes. When it is absent, the signed-in
  // user's server draft restores the last durable step across browsers/devices.
  useEffect(() => {
    if (!storageKey) return;
    const controller = new AbortController();
    let restored: WizardState | null = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        restored = parseWizardDraft(JSON.parse(raw));
      }
    } catch {
      // ignore malformed storage
    }
    const reconcileLocalDraft = (local: WizardState | null, server: WizardState) => {
      if (!local) return server;
      if (server.draftUpdatedAt && local.draftUpdatedAt !== server.draftUpdatedAt) {
        // A pre-version browser copy is safe to upgrade only when its saved
        // fields equal the server. Otherwise the user must choose the latest.
        if (!local.draftUpdatedAt && samePreviewInputs(local, server) &&
          local.tags === server.tags && JSON.stringify(local.voiceSelection) === JSON.stringify(server.voiceSelection)) {
          return { ...local, draftUpdatedAt: server.draftUpdatedAt };
        }
        setDraftConflict(true);
        return null;
      }
      return local;
    };
    const applyRestored = (
      next: WizardState,
      serverAsset?: { id?: string; url: string; isSynthetic?: boolean } | null,
      serverPreviewJob?: { id: string; status: string; errorCode?: string | null } | null,
      serverCandidates?: unknown[] | null,
    ) => {
      if (viewerBlockedRef.current) return;
      restored = next.previewBatch
        ? { ...next, previewBatch: resumeCreatePreviewBatch(next.previewBatch) }
        : next;
      if (serverAsset?.url && next.confirmedPreviewJobId) {
        restored = { ...restored, confirmedPreviewUrl: serverAsset.url };
      }
      // The server may have finished previews before this browser ever saw
      // them. Restore every one still valid for these inputs, without
      // enqueueing another batch; a later failed job must not hide them.
      const recovered = (serverCandidates ?? []).flatMap((item) => parseCreatePreviewCandidate(item) ?? []);
      if (!next.previewBatch && recovered.length) {
        restored = { ...restored, restoredPreviewCandidates: recovered };
      }
      // Another device has no batch count or request key. Keep only the known
      // job and check it without inventing a replacement four-image batch.
      setRestoredPreviewReviewId("");
      // A different device has no local batch envelope. Keep observing the
      // exact durable job for every non-terminal state (including ordinary
      // queued/running), rather than offering a fresh four-job submission.
      if (!next.previewBatch && serverPreviewJob &&
        (serverPreviewJob.status === "queued" || serverPreviewJob.status === "running" ||
          serverPreviewJob.errorCode === "provider_outcome_unknown")) {
        setRestoredPreviewReviewId(serverPreviewJob.id);
        setPreviewStatus("paused");
        setStatus(serverPreviewJob.errorCode === "provider_outcome_unknown"
          ? unknownOutcomeCopy(0)
          : `Your saved preview is still processing. Check request ${serverPreviewJob.id} again later.`);
      }
      const applied = restored;
      if (!applied) return;
      setState(applied);
      const restoredCandidate = applied.previewBatch?.candidates.find(
        (candidate) => candidate.previewJobId === applied.confirmedPreviewJobId,
      ) ?? applied.previewBatch?.candidates[0] ?? applied.restoredPreviewCandidates.find(
        (candidate) => candidate.previewJobId === applied.confirmedPreviewJobId,
      ) ?? applied.restoredPreviewCandidates[0];
      const restoredPreviewUrl = applied.confirmedPreviewUrl || restoredCandidate?.url;
      if (restoredPreviewUrl) {
        setPreview(restoredPreviewUrl);
        setSelectedPreviewJobId(
          applied.confirmedPreviewJobId || restoredCandidate?.previewJobId || "",
        );
      }
      if (applied.previewBatch?.phase === "running") {
        setPreviewStatus("generating");
      } else if (applied.previewBatch?.phase === "paused") {
        setPreviewStatus("paused");
        setStatus(applied.previewBatch.errorMessage);
      } else if (applied.previewBatch?.phase === "complete" || (!applied.previewBatch && restoredPreviewUrl)) {
        setPreviewStatus("complete");
      } else if (applied.previewBatch?.phase === "failed" || serverPreviewJob?.status === "failed") {
        setPreviewStatus("failed");
        setStatus(
          applied.previewBatch?.errorMessage || PREVIEW_FAILED_MESSAGE,
        );
      }
    };
    if (draftId) {
      if (!viewerScope || isAnonymousScope(viewerScope)) {
        queueMicrotask(() => { if (!controller.signal.aborted) { setEditError("Sign in to the account that owns this draft."); setHydrated(true); } });
        return () => controller.abort();
      }
      void requestApi(`/api/v1/character-drafts/${encodeURIComponent(draftId)}`, undefined, "GET", { signal: controller.signal })
        .then((payload) => {
          if (controller.signal.aborted) return;
          const serverState = payload.data?.draft ? wizardStateFromServerDraft(payload.data.draft) : null;
          if (!serverState || serverState.draftId !== draftId) throw new Error("This draft is no longer available.");
          const local = restored?.draftId === draftId ? restored : null;
          const reconciled = reconcileLocalDraft(local, serverState);
          applyRestored(reconciled ?? local ?? serverState,
            reconciled ? payload.data?.asset ?? null : null,
            reconciled ? payload.data?.previewJob ?? null : null,
            reconciled ? payload.data?.previewCandidates : null);
        })
        .catch((error) => { if (!controller.signal.aborted) setEditError(messageFrom(error)); })
        .finally(() => { if (!controller.signal.aborted) setHydrated(true); });
      return () => controller.abort();
    }
    if (editCharacterId && viewerScope && !isAnonymousScope(viewerScope)) {
      void requestApi(`/api/v1/characters/${encodeURIComponent(editCharacterId)}/edit-draft`, {}, "POST", { signal: controller.signal })
        .then((payload) => {
          if (controller.signal.aborted) return;
          const serverDraft = payload.data?.draft;
          const character = payload.data?.character;
          const serverState = serverDraft ? wizardStateFromServerDraft(serverDraft) : null;
          const baseline = serverDraft && character?.visual
            ? wizardStateFromServerDraft({
                ...serverDraft,
                gender: character.visual.gender,
                style: character.visual.style,
                appearance: character.visual.appearance,
                hair: character.visual.hair,
                body: character.visual.body,
                advancedDetails: { age: character.visual.age },
              })
            : null;
          if (!serverState || !character || !baseline) throw new Error("This character could not be opened for editing.");
          setEditTarget({ id: character.id, name: character.name, imageUrl: character.imageUrl ?? null, baseline, published: character.published === true });
          const local = restored?.draftId === serverState.draftId ? restored : null;
          const reconciled = reconcileLocalDraft(local, serverState);
          applyRestored(
            { ...(reconciled ?? local ?? serverState), visibility: local?.visibility ?? character.visibility },
            reconciled ? payload.data?.asset ?? null : null,
            reconciled ? payload.data?.previewJob ?? null : null,
            reconciled ? payload.data?.previewCandidates : null,
          );
          if (character.imageUrl && !local?.confirmedPreviewJobId && !serverState.confirmedPreviewJobId) {
            setPreview(character.imageUrl);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setEditError(messageFrom(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setHydrated(true);
        });
      return () => controller.abort();
    }
    const recoverMissingCandidate = Boolean(restored?.draftId && restored.step === 3 &&
      !restored.previewBatch && !restored.restoredPreviewCandidates.length && !restored.confirmedPreviewJobId);
    // A local copy of a server draft is checked once: if the server no longer
    // has it as the current draft (it was saved as a character), start fresh.
    const verifyLocalDraft = Boolean(restored?.draftId && !editCharacterId && viewerScope && !isAnonymousScope(viewerScope));
    if (restored) {
      queueMicrotask(() => {
        if (controller.signal.aborted || !restored) return;
        applyRestored(restored);
        if (!recoverMissingCandidate) setHydrated(true);
      });
      if (!recoverMissingCandidate && !verifyLocalDraft) return () => controller.abort();
    }
    if (viewerScope && !isAnonymousScope(viewerScope)) {
      void requestApi(
        "/api/v1/character-drafts/current",
        undefined,
        "GET",
        { signal: controller.signal },
      ).then((payload) => {
        if (controller.signal.aborted) return;
        // Local restoration already opens the editor while this check runs.
        // A new state object means the user or a completed save has moved on;
        // replaying the restored snapshot would erase input or rewind a step.
        // The next write still checks the current saved revision on the server.
        if (restored && stateRef.current.draftId === restored.draftId && stateRef.current !== restored) return;
        if (!payload.data?.draft) {
          // Only an explicit null means "no current draft"; the local copy is stale.
          if (verifyLocalDraft && payload.data?.draft === null) {
            try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
            setState(initialCharacterDraft());
            setPreview(DEFAULT_PREVIEW);
            setPreviewStatus("idle");
            setSelectedPreviewJobId("");
          }
          return;
        }
        const serverState = wizardStateFromServerDraft(payload.data.draft);
        if (serverState) {
          if (restored?.draftId === serverState.draftId) {
            const reconciled = reconcileLocalDraft(restored, serverState);
            if (!reconciled) return;
            restored = reconciled;
          }
          // Recover a lost confirmation without discarding unsaved local traits
          // or attaching a server image to different local inputs.
          if (restored && (restored.draftId !== serverState.draftId || !samePreviewInputs(restored, serverState))) return;
          applyRestored(
            restored ?? serverState,
            payload.data.asset ?? null,
            payload.data.previewJob ?? null,
            payload.data.previewCandidates,
          );
        }
      }).catch(() => {
        // A durable resume failure must not block starting a fresh local draft.
      }).finally(() => {
        if (!controller.signal.aborted) setHydrated(true);
      });
      return () => controller.abort();
    }
    queueMicrotask(() => {
      if (!controller.signal.aborted) setHydrated(true);
    });
    return () => controller.abort();
  }, [draftId, draftReloadAttempt, editCharacterId, requestApi, storageKey, viewerScope]);

  useEffect(() => {
    if (!hydrated || !storageKey || viewerBlockedRef.current) return;
    // Once saved, the wizard on screen is a receipt; writing it back would make
    // the next visit to Create reopen the character that was just saved.
    if (createdCharacterId) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // ignore quota/serialization errors
    }
  }, [createdCharacterId, state, hydrated, storageKey]);

  // Load admin-curated starting templates (public, active only). Templates are
  // optional, but an unavailable authority is distinct from an intentional empty set.
  useEffect(() => {
    if (!ageGateAccepted) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/v1/character-templates");
        if (!res.ok) throw new Error("Templates unavailable");
        const payload = parseTemplatesResponse(await res.json());
        if (alive) {
          setTemplates(payload.items);
          setTemplatesState("ready");
        }
      } catch {
        if (alive) setTemplatesState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [ageGateAccepted, templatesAttempt]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const controller = new AbortController();
    fetch("/api/v1/character-voices", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Voice catalog unavailable");
        return parseCharacterVoiceCatalogResponse(await response.json());
      })
      .then((catalog) => { if (!controller.signal.aborted) { setVoiceCatalog(catalog); setVoiceCatalogError(false); } })
      .catch(() => { if (!controller.signal.aborted) setVoiceCatalogError(true); });
    return () => controller.abort();
  }, [ageGateAccepted, voiceCatalogAttempt]);

  // SPEC: 标签选择只呈现标签词典里真实存在的标签。
  // INTENT: 这里过去是一个自由文本输入框（placeholder 还举了 "artist, ceramics"
  //   这种词典里没有的例子），用户填什么都收下、都存进草稿，发布时却一条都不写入
  //   —— 填了等于没填。标签是受运营治理的发现维度，创作者可以施加但不能新增，
  //   所以正确的形态是从词典里选，让所选即所得。
  useEffect(() => {
    if (!ageGateAccepted) return;
    const controller = new AbortController();
    fetch("/api/v1/tags", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Tag catalog unavailable");
        return parseTagListResponse(await response.json());
      })
      .then((catalog) => { if (!controller.signal.aborted) { setTagCatalog(catalog); setTagCatalogError(false); } })
      .catch(() => { if (!controller.signal.aborted) setTagCatalogError(true); });
    return () => controller.abort();
  }, [ageGateAccepted, tagCatalogAttempt]);

  const selectedTagSlugs = useMemo(
    () => new Set(normalizedTags(state.tags).map(tagSlugOf).filter(Boolean)),
    [state.tags],
  );
  const toggleTag = useCallback((slug: string) => {
    setState((current) => {
      const slugs = normalizedTags(current.tags).map(tagSlugOf).filter(Boolean);
      const selected = slugs.includes(slug);
      if (!selected && slugs.length >= MAX_TAGS) return current;
      const next = selected ? slugs.filter((item) => item !== slug) : [...slugs, slug];
      return { ...current, tags: next.join(",") };
    });
  }, []);

  useEffect(() => () => { voicePreviewSequence.current += 1; }, [viewerScope]);

  function selectVoice(voiceId: string) {
    voicePreviewSequence.current += 1;
    setVoicePreviewUrl("");
    setVoicePreviewPending(false);
    setVoicePreviewStatus("");
    set("voiceSelection", voiceId ? { provider: "pocket_tts", voiceId } : null);
  }

  async function previewVoice() {
    if (!voiceCatalog?.items.length) return;
    const voiceId = state.voiceSelection?.voiceId ?? voiceCatalog.defaultVoiceId;
    const sequence = ++voicePreviewSequence.current;
    setVoicePreviewUrl("");
    setVoicePreviewPending(true);
    setVoicePreviewStatus("");
    try {
      const payload = await requestApi("/api/v1/character-voices/preview", { provider: voiceCatalog.provider, voiceId });
      const result = parseCharacterVoicePreviewResponse(payload);
      if (sequence !== voicePreviewSequence.current) return;
      if (result.voiceId !== voiceId) throw new Error("The preview did not match the selected voice. Try again.");
      setVoicePreviewUrl(`data:${result.contentType};base64,${result.audioBase64}`);
    } catch (error) {
      if (sequence === voicePreviewSequence.current) setVoicePreviewStatus(messageFrom(error));
    } finally {
      if (sequence === voicePreviewSequence.current) setVoicePreviewPending(false);
    }
  }

  // Templates and Quick Start seed the draft the same way: fields are replaced,
  // any earlier preview is discarded, and the user is then free to edit everything.
  function prefillDraft(fields: (current: WizardState) => Partial<WizardState>, message: string) {
    setRestoredPreviewReviewId("");
    setState((current) => ({
      ...current,
      previewBatch: null,
      restoredPreviewCandidates: [],
      confirmedPreviewJobId: "",
      confirmedPreviewUrl: "",
      ...fields(current),
    }));
    setPreview(DEFAULT_PREVIEW);
    setPreviewStatus("idle");
    setSelectedPreviewJobId("");
    setStatus(message);
  }

  function applyTemplate(template: CreateTemplate) {
    setTemplateId(template.id);
    const appearance = isRecord(template.appearance) ? template.appearance : {};
    const face = isRecord(appearance.face) ? appearance.face : appearance;
    prefillDraft((current) => ({
      gender: template.gender || current.gender,
      style: template.style || current.style,
      appearance: pickString(face, "prompt", "summary") || current.appearance,
      ethnicity: pickString(face, "ethnicity", "race") || current.ethnicity,
      skinTone: pickString(face, "skinTone") || current.skinTone,
      eyeColor: pickString(face, "eyes", "eyeColor") || current.eyeColor,
      faceShape: pickString(face, "faceShape") || current.faceShape,
      hair: pickVisualText(appearance.hair, "prompt", "summary") || current.hair,
      body: pickVisualText(appearance.body, "type", "prompt", "summary") || current.body,
      description:
        pickString(template.advancedDetails, "description") || template.summary || current.description,
      detailsMarkdown:
        templateDetailsMarkdown(template.advancedDetails) || current.detailsMarkdown,
      firstMessage: pickString(template.advancedDetails, "firstMessage") || current.firstMessage,
      tags: pickTags(template.tags) || current.tags,
    }), `Started from "${template.name}". Edit any field before publishing.`);
  }

  async function runQuickStart() {
    const brief = quickStartBrief.trim();
    if (!brief || quickStartPending) return;
    setQuickStartPending(true);
    setQuickStartError("");
    try {
      const draft = parseCharacterQuickStartResponse(
        await requestApi("/api/v1/character-drafts/quick-start", { brief }),
      );
      setTemplateId("");
      prefillDraft((current) => {
        let detailsMarkdown = current.detailsMarkdown;
        if (draft.personality) detailsMarkdown = updateSoulDetail(detailsMarkdown, "Personality", draft.personality);
        if (draft.occupation) detailsMarkdown = updateSoulDetail(detailsMarkdown, "Occupation", draft.occupation);
        if (draft.relationship) detailsMarkdown = updateSoulDetail(detailsMarkdown, "Relationship", draft.relationship);
        return {
          name: draft.name ?? current.name,
          age: draft.age ?? current.age,
          gender: draft.gender ?? current.gender,
          style: draft.style ?? current.style,
          appearance: draft.appearance ?? current.appearance,
          ethnicity: draft.ethnicity ?? current.ethnicity,
          skinTone: draft.skinTone ?? current.skinTone,
          eyeColor: draft.eyeColor ?? current.eyeColor,
          faceShape: draft.faceShape ?? current.faceShape,
          hair: draft.hair ?? current.hair,
          body: draft.body ?? current.body,
          description: draft.description ?? current.description,
          firstMessage: draft.firstMessage ?? current.firstMessage,
          detailsMarkdown,
        };
      }, "Prefilled from your idea. Review and edit each step before publishing.");
    } catch (error) {
      setQuickStartError(messageFrom(error));
    } finally {
      setQuickStartPending(false);
    }
  }

  function setIdentityField<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setRestoredPreviewReviewId("");
    setState((current) => ({
      ...current,
      [key]: value,
      previewBatch: null,
      restoredPreviewCandidates: [],
      confirmedPreviewJobId: "",
      confirmedPreviewUrl: "",
    }));
    setPreview(DEFAULT_PREVIEW);
    setPreviewStatus("idle");
    setSelectedPreviewJobId("");
  }

  // INVARIANT: matches the server's updateDraft identity check — the name, the
  // opening line and Soul text are not in the preview prompt, so editing them
  // keeps the confirmed face instead of forcing a new round of candidates.
  function setSoulField(key: "name" | "firstMessage" | "detailsMarkdown", value: string) {
    setState((current) => ({ ...current, [key]: value }));
  }

  function updateGuidedSoul(label: string, value: string) {
    const details = updateSoulDetail(state.detailsMarkdown, label, value);
    if (details.length > 24_000) {
      setStatus("Additional details must be 24,000 characters or fewer.");
      return;
    }
    setSoulField("detailsMarkdown", details);
  }

  const identityKept = editTarget !== null && (editTarget.published || !state.confirmedPreviewJobId) &&
    editKeepsIdentity(state, editTarget.baseline);
  const identityReady = editTarget?.published ? identityKept : Boolean(state.confirmedPreviewJobId) || identityKept;
  const currentFieldErrors = stepFieldErrors(step, state);
  // Errors appear once Next was refused on this step, then track edits live.
  const shownFieldErrors = new Map(showFieldErrors ? currentFieldErrors : []);

  async function ensureDraft(): Promise<string> {
    if (state.draftId) return state.draftId;
    if (editCharacterId) throw new Error("This character could not be opened for editing. Reload and try again.");
    const created = await requestApi("/api/v1/character-drafts", {
      name: state.name,
      age: state.age,
      style: state.style,
      gender: state.gender,
    });
    const id = created.data?.draft?.id;
    if (!id) throw new Error("Draft failed");
    set("draftId", id);
    return id;
  }

  async function saveStep(nextStep: number) {
    const draftId = await ensureDraft();
    await requestApi(
      `/api/v1/character-drafts/${draftId}`,
      {
        step: Math.min(nextStep, 12),
        name: state.name,
        age: state.age,
        style: state.style,
        gender: state.gender,
        appearance: {
          prompt: state.appearance,
          ...(state.ethnicity ? { ethnicity: state.ethnicity } : {}),
          ...(state.skinTone ? { skinTone: state.skinTone } : {}),
          ...(state.eyeColor ? { eyes: state.eyeColor } : {}),
          ...(state.faceShape ? { faceShape: state.faceShape } : {}),
        },
        hair: { prompt: state.hair },
        body: { type: state.body },
        advancedDetails: {
          description: state.description,
          detailsMarkdown: state.detailsMarkdown,
          firstMessage: state.firstMessage,
          voiceSelection: state.voiceSelection,
        },
        tags: normalizedTags(state.tags),
      },
      "PATCH",
    );
  }

  async function next() {
    if (currentFieldErrors.length) {
      setShowFieldErrors(true);
      setStatus("");
      document.getElementById(currentFieldErrors[0]![0])?.focus();
      return;
    }
    if (step === 3 && !identityReady) {
      setStatus("Choose and confirm an identity image before publishing.");
      return;
    }
    setPending(true);
    setStatus("");
    try {
      await saveStep(step + 1);
      setShowFieldErrors(false);
      set("step", Math.min(step + 1, STEPS.length - 1));
    } catch (error) {
      setStatus(messageFrom(error));
    } finally {
      setPending(false);
    }
  }

  function back() {
    goToStep(Math.max(step - 1, 0));
  }

  function goToStep(target: number) {
    setStatus("");
    setShowFieldErrors(false);
    set("step", target);
  }

  async function startChat() {
    if (!createdCharacterId || pending) return;
    setPending(true);
    try {
      const payload = await requestApi("/api/v1/chat/sessions", { characterId: createdCharacterId });
      window.location.href = `/chat/${parseChatSessionCreateResponse(payload).session.id}`;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start chat. Please try again.");
      setPending(false);
    }
  }

  const runPreviewBatch = useCallback(
    async (draftId: string, initialBatch: CreatePreviewBatch) => {
      if (previewRunRef.current !== 0) return;
      previewRunSequenceRef.current += 1;
      const runId = previewRunSequenceRef.current;
      previewRunRef.current = runId;
      setPending(true);
      setPreviewStatus("generating");
      setStatus("");
      try {
        const settled = await continueCreatePreviewBatch(initialBatch, {
          enqueue: async (_candidateNumber, requestKey, signal) => {
            const queued = await requestApi(
              `/api/v1/character-drafts/${draftId}/preview`,
              {},
              "POST",
              { idempotencyKey: requestKey, signal },
            );
            const previewJob = queued.data?.previewJob;
            if (!previewJob?.id) {
              throw new Error("Preview generation did not return a durable job.");
            }
            return {
              id: previewJob.id,
              status: previewJob.status === "running" ? "running" : "queued",
            };
          },
          read: async (previewJobId, signal) => {
            const payload = await requestApi(
              `/api/v1/character-drafts/${draftId}/preview?previewJobId=${encodeURIComponent(previewJobId)}`,
              undefined,
              "GET",
              { signal },
            );
            const previewJob = payload.data?.previewJob;
            const asset = payload.data?.asset;
            const candidate =
              previewJob?.id === previewJobId && asset?.id && asset.url
                ? {
                    previewJobId,
                    assetId: asset.id,
                    url: asset.url,
                    isSynthetic: asset.isSynthetic === true,
                  }
                : null;
            return {
              id: previewJob?.id ?? "",
              status: normalizePreviewJobStatus(previewJob?.status),
              asset: candidate,
              errorCode: previewJob?.errorCode,
              errorMessage: previewJob?.errorCode ? PREVIEW_FAILED_MESSAGE : undefined,
            };
          },
          persist: (batch) => {
            if (previewRunRef.current === runId) persistPreviewBatch(batch);
          },
          isActive: () => previewRunRef.current === runId,
        });
        if (previewRunRef.current !== runId) return;
        if (settled.phase === "complete") {
          const selected = settled.candidates.find((candidate) =>
            candidate.previewJobId === stateRef.current.confirmedPreviewJobId) ?? settled.candidates[0];
          if (selected) {
            setPreview(selected.url);
            setSelectedPreviewJobId((current) => current || selected.previewJobId);
          }
          setPreviewStatus("complete");
          return;
        }
        setPreviewStatus(settled.phase === "paused" ? "paused" : "failed");
        setStatus(settled.errorMessage || "Preview checking paused. Check the saved request again.");
      } finally {
        if (previewRunRef.current === runId) {
          previewRunRef.current = 0;
          setPending(false);
        }
      }
    },
    [persistPreviewBatch, requestApi],
  );

  async function generatePreview() {
    if (pending) return;
    if (restoredPreviewReviewId) {
      setPending(true);
      try {
        const payload = await requestApi(
          `/api/v1/character-drafts/${state.draftId}/preview?previewJobId=${encodeURIComponent(restoredPreviewReviewId)}`,
          undefined, "GET",
        );
        const job = payload.data?.previewJob;
        if (job?.id !== restoredPreviewReviewId) throw new Error("Preview status did not match the saved job. Try again.");
        const candidate = job.status === "completed" ? parseCreatePreviewCandidate({
          previewJobId: job.id, assetId: payload.data?.asset?.id,
          url: payload.data?.asset?.url, isSynthetic: payload.data?.asset?.isSynthetic,
        }) : null;
        if (candidate) {
          setState((current) => ({
            ...current,
            restoredPreviewCandidates: [
              candidate,
              ...current.restoredPreviewCandidates.filter((item) => item.previewJobId !== candidate.previewJobId),
            ],
          }));
          setPreview(candidate.url);
          setSelectedPreviewJobId(candidate.previewJobId);
          setPreviewStatus("complete");
          setRestoredPreviewReviewId("");
          setStatus("Your saved preview is ready. Confirm this identity to continue.");
        } else if (job.status === "failed") {
          setRestoredPreviewReviewId("");
          setStatus("Preview generation failed. You can retry preview candidates.");
        } else {
          setStatus(`The preview result is not ready. Contact support with request ${job.id} or check again later.`);
        }
      } catch (error) {
        setStatus(messageFrom(error));
      } finally {
        setPending(false);
      }
      return;
    }
    setPending(true);
    setPreviewStatus("generating");
    setStatus("");
    try {
      const draftId = await ensureDraft();
      await saveStep(3);
      const existingBatch = state.previewBatch;
      const retrying = existingBatch?.phase === "failed" || existingBatch?.phase === "paused";
      const batch = retrying
        ? retryCreatePreviewBatch(existingBatch)
        : newCreatePreviewBatch();
      if (!retrying) {
        setPreview(DEFAULT_PREVIEW);
        setSelectedPreviewJobId("");
      }
      setState((current) => ({
        ...current,
        previewBatch: batch,
        restoredPreviewCandidates: [],
        confirmedPreviewJobId: retrying ? current.confirmedPreviewJobId : "",
        confirmedPreviewUrl: retrying ? current.confirmedPreviewUrl : "",
      }));
      persistPreviewBatch(batch);
      await runPreviewBatch(draftId, batch);
    } catch (error) {
      setPreviewStatus("failed");
      setStatus(messageFrom(error));
      setPending(false);
    }
  }

  useEffect(() => {
    const batch = state.previewBatch;
    if (
      !hydrated ||
      !storageKey ||
      !state.draftId ||
      batch?.phase !== "running" ||
      previewRunRef.current !== 0
    ) {
      return;
    }
    void runPreviewBatch(state.draftId, batch);
  }, [hydrated, runPreviewBatch, state.draftId, state.previewBatch, storageKey]);

  function handleCandidateSelect(candidate: CreatePreviewCandidate) {
    setStatus("");
    setPreview(candidate.url);
    setSelectedPreviewJobId(candidate.previewJobId);
    set("confirmedPreviewJobId", "");
    set("confirmedPreviewUrl", "");
  }

  async function confirmPreviewCandidate() {
    const candidate = previewCandidates.find(
      (item) => item.previewJobId === selectedPreviewJobId,
    );
    if (!candidate) {
      setStatus("Choose an identity candidate first.");
      return;
    }
    if (candidate.isSynthetic) {
      setStatus("Demo previews cannot be used as a published character identity.");
      return;
    }
    setPending(true);
    setStatus("");
    try {
      const draftId = await ensureDraft();
      await requestApi(`/api/v1/character-drafts/${draftId}/preview-anchor`, {
        previewJobId: candidate.previewJobId,
      });
      setState((current) => ({
        ...current,
        confirmedPreviewJobId: candidate.previewJobId,
        confirmedPreviewUrl: candidate.url,
      }));
      setStatus("Identity confirmed. This is how the character will look.");
    } catch (error) {
      setStatus(messageFrom(error));
    } finally {
      setPending(false);
    }
  }

  async function submit() {
    // Guard against double-submit: once a character is created, don't reuse the same
    // draft to create a duplicate (the success state already links onward).
    if (pending || createdCharacterId) return;
    if (!identityReady) {
      set("step", 3);
      setStatus("Choose and confirm an identity image before publishing.");
      return;
    }
    setPending(true);
    setStatus("");
    setCreatedCharacterId("");
    setCreatedVisibility("");
    try {
      const draftId = await ensureDraft();
      await saveStep(STEPS.length);
      const submitted = await requestApi(`/api/v1/character-drafts/${draftId}/submit`, {
        visibility: state.visibility,
      });
      const character = submitted.data?.character;
      if (character?.id) {
        setCreatedCharacterId(character.id);
        setCreatedVisibility(character.visibility);
      }
      // A refused visibility change leaves the saved edit in place; say so instead of the success line.
      const visibilityWarning = submitted.data?.visibilityWarning;
      setStatus(
        visibilityWarning
          ? visibilityWarning
          : character && editTarget && submitted.data?.pendingPublication
          // A published Character's text edit becomes a Release revision that operators publish from the
          // Release tab (the production journey flags it). Look and voice are locked, so its images carry over.
          ? `Saved changes to ${character.name}. They go live after our team publishes the new version; until then, chats keep using the current version.`
          : character && editTarget
          ? `Saved changes to ${character.name}. New messages use this version; earlier messages keep the one they were written with.`
          : character
          ? character.visibility !== "private"
            ? `${character.name} is saved and awaiting publication preparation. Sharing starts after publication.`
            : `Saved ${character.name} to My AI.`
          : "Character submitted.",
      );
      try {
        if (storageKey) window.localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    } catch (error) {
      const message = messageFrom(error);
      if (message === "Choose an identity image before publishing this character") {
        setState((current) => ({
          ...current,
          previewBatch: null,
          restoredPreviewCandidates: [],
          confirmedPreviewJobId: "",
          confirmedPreviewUrl: "",
          step: 3,
        }));
        setPreviewStatus("idle");
        setSelectedPreviewJobId("");
      }
      setStatus(message);
    } finally {
      setPending(false);
    }
  }

  if (hydrated && (editCharacterId || draftId) && editError) {
    return (
      <section className="mx-auto my-16 max-w-xl rounded-2xl border border-white/10 bg-[rgb(18,18,18)] p-6 text-center" role="alert" data-testid="edit-unavailable">
        <h1 className="text-lg font-black text-white">{draftId ? "This draft could not be opened" : "This character can't be edited"}</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-300">{editError}</p>
        {draftId && <button type="button" className="mt-4 mr-4 rounded-full bg-white px-5 py-3 font-bold text-black" onClick={() => { setHydrated(false); setEditError(""); setDraftReloadAttempt(attempt => attempt + 1); }}>Retry saved draft</button>}
        <Link href={draftId ? "/creator-studio" : "/custom"} className="mt-4 inline-block rounded-full bg-white px-5 py-3 font-bold text-black">{draftId ? "Back to Creator Studio" : "Back to My AI"}</Link>
      </section>
    );
  }

  if (!hydrated || viewerAuthorityState === "changed") {
    if (viewerAuthorityState === "changed") {
      return (
        <section className="mx-auto my-16 max-w-xl rounded-2xl border border-white/10 bg-[rgb(18,18,18)] p-6 text-center" role="alert" data-testid="create-viewer-changed">
          <h1 className="text-lg font-black text-white">Your account changed</h1>
          <p className="mt-2 text-sm leading-6 text-neutral-300">This draft stays with the original account. Reload to open the current account’s workspace, or sign back in to continue your draft.</p>
          <button type="button" className="mt-4 rounded-full bg-white px-5 py-3 font-bold text-black" onClick={() => window.location.reload()}>Reload workspace</button>
          <Link href="/login?next=%2Fcreate" className="ml-4 inline-block py-3 text-sm text-white underline">Sign in</Link>
        </section>
      );
    }
    if (viewerAuthorityState === "error") {
      return (
        <section
          className="mx-auto my-16 max-w-xl rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-6 text-center"
          data-testid="create-viewer-authority-error"
          role="alert"
        >
          <h1 className="text-lg font-black text-white">
            Your private draft could not be opened
          </h1>
          <p className="mt-2 text-[13px] leading-5 text-[rgb(170,170,170)]">
            We could not confirm which account or private browser draft owns
            this workspace. Retry before entering character details.
          </p>
          <button
            className="mt-4 h-10 rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]"
            onClick={() => {
              setViewerAuthorityState("loading");
              setViewerScope(null);
              setViewerAuthorityAttempt((attempt) => attempt + 1);
            }}
            type="button"
          >
            Retry private draft
          </button>
        </section>
      );
    }
    return (
      <section
        aria-live="polite"
        className="flex min-h-[420px] items-center justify-center px-4 text-[13px] font-semibold text-[rgb(170,170,170)]"
        role="status"
      >
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading your private draft...
      </section>
    );
  }

  return (
    <section className="px-4 pb-12 pt-10 md:px-[60px] md:pb-16">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-center text-[clamp(28px,6vw,52px)] font-black leading-none text-white">
          {editTarget ? `Edit ${editTarget.name}` : "Create Your Dream AI Character"}
        </h1>

        <ol className="mt-8 flex flex-wrap justify-center gap-2" data-testid="create-steps">
          {STEPS.map((label, index) => (
            <li
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-bold uppercase ${
                index === step
                  ? "bg-white text-[rgb(13,13,13)]"
                  : index < step
                    ? "bg-[rgb(36,36,36)] text-[rgb(253,95,194)]"
                    : "bg-[rgb(36,36,36)] text-[rgb(114,113,112)]"
              }`}
              key={label}
            >
              {index < step ? (
                // 已完成的步骤可直接跳回（CR-01），未到的步骤仍须按 Next 逐步校验。
                <button
                  className="flex items-center gap-2 uppercase"
                  disabled={pending}
                  onClick={() => goToStep(index)}
                  type="button"
                >
                  <Check className="h-3.5 w-3.5" />
                  {label}
                </button>
              ) : (
                <>
                  <span>{index + 1}</span>
                  {label}
                </>
              )}
            </li>
          ))}
        </ol>

        {/* 与 /generate 同一处根因：md(768) 起 220px 侧栏就常驻，再叠一个固定 360px
            的预览栏，iPad 竖屏装不下 —— 整页溢出 141px，且右栏被压到把 select 的
            选中值裁掉（"Female" 显示成 "Femal"）。双栏推到 lg(1024)。 */}
        <div className="mt-8 grid gap-4 lg:grid-cols-[360px_1fr]">
          {/* On phones the empty silhouette filled the first screen and pushed the form below
              the fold; show it only once there is a real preview to look at. */}
          <div className={cn("relative aspect-[4/5] w-full max-w-[448px] self-start justify-self-center overflow-hidden rounded-[20px] bg-[rgb(18,18,18)]", preview === DEFAULT_PREVIEW && "hidden lg:block")}>
            <Image
              alt=""
              className="object-cover object-top"
              fill
              loading="eager"
              sizes="360px"
              src={preview}
              unoptimized={isPrivateMediaUrl(preview)}
            />
            <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.82),rgba(0,0,0,.1)_62%,transparent)]" />
            {previewStatus === "generating" && (
              <div className="absolute inset-0 grid place-items-center bg-black/50 text-[13px] font-bold text-white">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Generating preview…
                </span>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 p-5">
              <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
                {state.confirmedPreviewJobId
                  ? "Identity confirmed"
                  : previewCandidates.length > 0
                    ? "Candidate preview"
                    : "Example preview"}
              </p>
              <h2 className="mt-2 text-[26px] font-black leading-7">{state.name}</h2>
              <p className="mt-2 text-[13px] font-medium leading-5 text-[rgb(170,170,170)]">
                {state.description}
              </p>
            </div>
          </div>

          <div className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:p-6">
            {step === 0 && !editCharacterId && (
              <form
                className="mb-4"
                data-testid="create-quick-start"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runQuickStart();
                }}
              >
                <label className="block">
                  <span className="text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                    Quick start from one sentence
                  </span>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-[10px] border border-white/10 bg-[rgb(13,13,13)] px-3 py-2 text-[14px] font-semibold leading-6 text-white outline-none focus:border-[rgb(253,95,194)]"
                      disabled={quickStartPending}
                      maxLength={MAX_QUICK_START_BRIEF_LENGTH}
                      onChange={(event) => set("quickStartBrief", event.target.value.slice(0, MAX_QUICK_START_BRIEF_LENGTH))}
                      placeholder="A sharp-tongued, soft-hearted 24-year-old illustrator who works at a café"
                      value={quickStartBrief}
                    />
                    <button
                      className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)] disabled:opacity-50"
                      disabled={quickStartPending || quickStartBrief.trim().length < 3}
                      type="submit"
                    >
                      {quickStartPending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
                      {quickStartPending ? "Drafting…" : "Prefill"}
                    </button>
                  </div>
                </label>
                <p className="mt-1.5 text-[12px] text-[rgb(170,170,170)]">
                  Fills in the steps below as a starting point. Nothing is created until you save your character.
                </p>
                {quickStartError ? (
                  <p className="mt-1.5 text-[12px] font-semibold text-[rgb(255,140,140)]" role="alert">
                    {quickStartError}
                  </p>
                ) : null}
              </form>
            )}

            {step === 0 && !editCharacterId && (
              <div className="mb-4" data-testid="create-templates">
                <p className="text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                  Start from a template
                </p>
                {templatesState === "loading" ? (
                  <p className="mt-2 text-[12px] text-[rgb(170,170,170)]">
                    Loading curated templates…
                  </p>
                ) : null}
                {templatesState === "error" ? (
                  <div
                    className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-white/10 p-3 text-[12px] text-[rgb(170,170,170)]"
                    role="status"
                  >
                    <span>Curated templates are unavailable. You can still start from scratch.</span>
                    <button
                      className="shrink-0 rounded-full bg-white px-3 py-1.5 font-black text-[rgb(13,13,13)]"
                      onClick={() => {
                        setTemplatesState("loading");
                        setTemplatesAttempt((attempt) => attempt + 1);
                      }}
                      type="button"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
                {templatesState === "ready" && templates.length === 0 ? (
                  <p className="mt-2 text-[12px] text-[rgb(170,170,170)]">
                    No curated templates are published right now. Start from scratch.
                  </p>
                ) : null}
                {templatesState === "ready" && templates.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className={`h-9 rounded-full px-3 text-[12px] font-bold ${
                      templateId === ""
                        ? "bg-white text-[rgb(13,13,13)]"
                        : "bg-[rgb(36,36,36)] text-white"
                    }`}
                    onClick={() => {
                      setTemplateId("");
                      setStatus("");
                    }}
                    type="button"
                  >
                    From scratch
                  </button>
                  {templates.map((template) => (
                    <button
                      className={`h-9 rounded-full px-3 text-[12px] font-bold ${
                        templateId === template.id
                          ? "bg-white text-[rgb(13,13,13)]"
                          : "bg-[rgb(36,36,36)] text-white"
                      }`}
                      key={template.id}
                      onClick={() => applyTemplate(template)}
                      title={template.summary ?? undefined}
                      type="button"
                    >
                      {template.name}
                    </button>
                  ))}
                  </div>
                ) : null}
              </div>
            )}

            {step === 0 && (
              <div className="grid gap-3 md:grid-cols-2" data-testid="create-step-identity">
                <Field error={shownFieldErrors.get("create-field-name")} fieldId="create-field-name" label="Name" required>
                  <input
                    {...fieldControlProps("create-field-name", shownFieldErrors.get("create-field-name"))}
                    className={FIELD_LEAD_INPUT_CLASS}
                    onChange={(event) => setSoulField("name", event.target.value)}
                    maxLength={80}
                    placeholder="Nova Reyes"
                    value={state.name}
                  />
                </Field>
                <Field error={shownFieldErrors.get("create-field-age")} fieldId="create-field-age" hint="18+ only" label="Age" required>
                  <input
                    {...fieldControlProps("create-field-age", shownFieldErrors.get("create-field-age"))}
                    className={FIELD_LEAD_INPUT_CLASS}
                    max={120}
                    min={18}
                    onChange={(event) => setIdentityField("age", Number(event.target.value))}
                    type="number"
                    value={state.age}
                  />
                </Field>
                <Field label="Gender">
                  <select
                    className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                    onChange={(event) => setIdentityField("gender", event.target.value)}
                    value={state.gender}
                  >
                    {genderFormOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Style">
                  <select
                    className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                    onChange={(event) => setIdentityField("style", event.target.value)}
                    value={state.style}
                  >
                    {characterStyleFormOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="md:col-span-2 text-[12px] font-medium text-[rgb(170,170,170)]">
                  Characters must be adults (18+). Content depicting minors or real people is prohibited.
                </p>
              </div>
            )}

            {step === 1 && (
              <div className="grid gap-3 md:grid-cols-3" data-testid="create-step-appearance">
                <Field label="Appearance" hint="A free-text summary of how they look.">
                  <input
                    className={FIELD_TEXT_INPUT_CLASS}
                    onChange={(event) => setIdentityField("appearance", event.target.value)}
                    placeholder="Tall, warm-eyed, always in a worn denim jacket"
                    value={state.appearance}
                  />
                </Field>
                {VISUAL_FIELDS.map(({ key, label, suggestions }) => (
                  <Field key={key} label={label} hint="Choose a suggestion or write your own.">
                    <input
                      className={FIELD_TEXT_INPUT_CLASS}
                      list={`create-${key}-options`}
                      maxLength={key === "hair" || key === "body" ? 2000 : 160}
                      onChange={(event) => setIdentityField(key, event.target.value)}
                      placeholder={suggestions[0] ? `e.g. ${suggestions[0]}` : undefined}
                      value={state[key]}
                    />
                    <datalist id={`create-${key}-options`}>
                      {suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
                    </datalist>
                  </Field>
                ))}
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-3" data-testid="create-step-soul">
                <div>
                  <h2 className="text-[18px] font-black text-white">Define who they are</h2>
                  <p className="mt-1 text-[13px] leading-5 text-[rgb(170,170,170)]">
                    These details become the character&apos;s stable chat persona, not just profile copy.
                    Fields marked <span aria-hidden="true" className="text-[rgb(253,95,194)]">*</span><span className="sr-only">with an asterisk</span> are required.
                  </p>
                </div>
                <Field
                  error={shownFieldErrors.get("create-field-promise")}
                  fieldId="create-field-promise"
                  hint="A one- or two-sentence promise that defines what makes this character worth talking to."
                  label="Character promise"
                  required
                >
                  <textarea
                    {...fieldControlProps("create-field-promise", shownFieldErrors.get("create-field-promise"))}
                    className="mt-3 min-h-28 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                    maxLength={1000}
                    onChange={(event) => setIdentityField("description", event.target.value)}
                    placeholder="A perceptive night-shift radio host who makes difficult conversations feel easy."
                    value={state.description}
                  />
                </Field>
                <div className="grid gap-3 md:grid-cols-2">
                  {CREATE_SOUL_DETAIL_FIELDS.map(({ label, suggestions }, index) => (
                    <Field key={label} label={label} hint="Choose a suggestion or write your own.">
                      <input
                        className={FIELD_TEXT_INPUT_CLASS}
                        list={`create-soul-${index}-options`}
                        maxLength={1000}
                        onChange={(event) => updateGuidedSoul(label, event.target.value)}
                        placeholder={suggestions[0] ? `e.g. ${suggestions[0]}` : undefined}
                        value={readSoulDetail(state.detailsMarkdown, label)}
                      />
                      <datalist id={`create-soul-${index}-options`}>
                        {suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
                      </datalist>
                    </Field>
                  ))}
                </div>
                <div className="rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white">
                  <label className="block text-[12px] font-bold uppercase text-[rgb(170,170,170)]" htmlFor="create-voice-select">Voice</label>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <select
                      className="min-w-48 flex-1 bg-[rgb(36,36,36)] text-[14px] font-semibold leading-6"
                      data-testid="create-voice-select"
                      disabled={Boolean(editTarget?.published)}
                      id="create-voice-select"
                      onChange={(event) => selectVoice(event.target.value)}
                      value={state.voiceSelection?.voiceId ?? ""}
                    >
                      <option value="">System default</option>
                      {state.voiceSelection && !voiceCatalog?.items.some((voice) => voice.id === state.voiceSelection?.voiceId) && (
                        <option value={state.voiceSelection.voiceId}>Previously chosen voice (no longer available)</option>
                      )}
                      {voiceCatalog?.items.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
                    </select>
                    <button
                      className="rounded-full border border-white/20 px-4 py-2 text-[13px] font-bold disabled:opacity-50"
                      data-testid="create-voice-preview"
                      disabled={voicePreviewPending || !voiceCatalog?.items.length || Boolean(state.voiceSelection && !voiceCatalog.items.some((voice) => voice.id === state.voiceSelection?.voiceId))}
                      onClick={() => void previewVoice()}
                      type="button"
                    >
                      {voicePreviewPending ? "Preparing preview…" : "Preview voice"}
                    </button>
                  </div>
                  <p className="mt-2 text-[12px] text-[rgb(170,170,170)]">
                    {editTarget?.published
                      ? "A published character keeps its current voice."
                      : "Choose how this character sounds. Personality and speech style stay in their Soul."}
                  </p>
                  {voiceCatalogError && <p className="mt-2 text-[12px]" role="status">Voice choices could not load. <button className="underline" onClick={() => setVoiceCatalogAttempt((attempt) => attempt + 1)} type="button">Retry voices</button></p>}
                  {voicePreviewStatus && <p className="mt-2 text-[12px]" role="status">{voicePreviewStatus}</p>}
                  {voicePreviewUrl && <audio aria-label="Selected voice preview" className="mt-3 w-full" controls src={voicePreviewUrl} />}
                </div>
                <Field
                  error={shownFieldErrors.get("create-field-first-message")}
                  fieldId="create-field-first-message"
                  hint="This is the exact opening line for a new conversation."
                  label="First message"
                  required
                >
                  <textarea
                    {...fieldControlProps("create-field-first-message", shownFieldErrors.get("create-field-first-message"))}
                    className="mt-3 min-h-20 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                    maxLength={4000}
                    onChange={(event) => setSoulField("firstMessage", event.target.value)}
                    placeholder="There you are. What has been on your mind tonight?"
                    value={state.firstMessage}
                  />
                </Field>
                <Field
                  error={shownFieldErrors.get("create-field-details")}
                  fieldId="create-field-details"
                  hint="Guided fields above update this same text. Add background, speech style, custom details, scenarios, or dialogue examples here."
                  label="Additional details (optional)"
                >
                  <textarea
                    aria-describedby={shownFieldErrors.has("create-field-details") ? fieldErrorId("create-field-details") : undefined}
                    aria-invalid={shownFieldErrors.has("create-field-details") || undefined}
                    id="create-field-details"
                    className="mt-3 min-h-56 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 font-mono text-[13px] font-medium leading-6 text-white outline-none"
                    maxLength={24000}
                    onChange={(event) => setSoulField("detailsMarkdown", event.target.value)}
                    placeholder={"## Personality and voice\nWarm, teasing, concise, emotionally attentive.\n\n## Background\nHow you met and what shaped this character."}
                    value={state.detailsMarkdown}
                  />
                </Field>
                <Field
                  hint={`Pick the tags readers filter by. Up to ${MAX_TAGS}.`}
                  label="Tags"
                >
                  {tagCatalogError ? (
                    <p className="mt-2 text-[12px]" role="status">
                      Tags could not load.{" "}
                      <button className="underline" onClick={() => setTagCatalogAttempt((attempt) => attempt + 1)} type="button">
                        Retry tags
                      </button>
                    </p>
                  ) : !tagCatalog ? (
                    <p className="mt-2 text-[12px] text-[rgb(170,170,170)]" role="status">Loading tags…</p>
                  ) : tagCatalog.items.length === 0 ? (
                    <p className="mt-2 text-[12px] text-[rgb(170,170,170)]">
                      No tags are published yet. Your character stays discoverable by name and search.
                    </p>
                  ) : (
                    <div className="mt-2">
                      <p className="text-[12px] text-[rgb(170,170,170)]" data-testid="create-tag-count">
                        {selectedTagSlugs.size} of {MAX_TAGS} selected
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2" data-testid="create-tag-picker">
                        {tagCatalog.items.map((tag) => {
                          const selected = selectedTagSlugs.has(tag.slug);
                          const atLimit = !selected && selectedTagSlugs.size >= MAX_TAGS;
                          return (
                            <button
                              aria-pressed={selected}
                              className={`rounded-full border px-3 py-1.5 text-[13px] font-semibold leading-5 transition ${
                                selected
                                  ? "border-white bg-white text-black"
                                  : "border-white/15 bg-[rgb(36,36,36)] text-[rgb(214,214,214)] hover:border-white/40"
                              } ${atLimit ? "cursor-not-allowed opacity-40" : ""}`}
                              disabled={atLimit}
                              key={tag.slug}
                              onClick={() => toggleTag(tag.slug)}
                              type="button"
                            >
                              {tag.label}
                              {tag.isSensitive && (
                                <span className={`ml-1.5 text-[11px] font-bold ${selected ? "text-[rgb(120,120,120)]" : "text-[rgb(150,150,150)]"}`}>
                                  18+
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </Field>
              </div>
            )}

            {step === 3 && (
              <div className="grid gap-4" data-testid="create-step-preview">
                <section className="rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white" data-testid="create-soul-preview">
                  <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                    Personality preview · what your character will follow
                  </p>
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 font-mono text-[12px] font-medium leading-6 text-white">
                    {renderCharacterSoulMarkdown({
                      name: state.name,
                      age: state.age,
                      gender: state.gender,
                      characterPromise: state.description,
                      detailsMarkdown: state.detailsMarkdown,
                    })}
                  </pre>
                </section>
                {identityKept && (
                  <p className="text-[13px] font-semibold text-[rgb(120,220,170)]" data-testid="edit-identity-kept">
                    {editTarget?.published
                      ? `Keeping ${state.name}'s current look. Published characters change their Soul and opening here; their look stays fixed.`
                      : `Keeping ${state.name}'s current identity image. Generate new candidates only if you want to change how they look.`}
                  </p>
                )}
                {editTarget && !identityKept && !state.confirmedPreviewJobId && !editTarget.published && (
                  <p className="text-[13px] font-semibold text-[rgb(255,184,112)]">
                    You changed how {state.name} looks. Generate and confirm a new identity image to save.
                  </p>
                )}
                {editTarget?.published ? (
                  !identityKept && (
                    <p className="text-[13px] font-semibold text-[rgb(255,184,112)]" data-testid="edit-published-look-locked">
                      A published character keeps its current look. Undo the appearance changes to save, or duplicate the character to change how it looks.
                    </p>
                  )
                ) : (<>
                <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                  {state.restoredPreviewCandidates.length > 0 && !state.previewBatch
                    ? "Your saved preview is ready. Confirm this identity or generate new candidates."
                    : `Generate up to four free identity previews (0 DreamCoins) and choose the image that should define how ${state.name} looks.`}
                </p>
                {state.previewBatch && (
                  <p
                    aria-live="polite"
                    className="text-[13px] font-semibold text-[rgb(170,170,170)]"
                    data-testid="create-preview-progress"
                    role="status"
                  >
                    Candidate {state.previewBatch.currentCandidateNumber} of{" "}
                    {CREATE_PREVIEW_CANDIDATE_COUNT} ·{" "}
                    {state.previewBatch.phase === "complete"
                      ? "completed"
                      : state.previewBatch.phase === "paused"
                        ? state.previewBatch.failureReason === "outcome_unknown" ? "not confirmed yet" : "checking paused"
                      : state.previewBatch.phase === "failed" ? "failed"
                        : state.previewBatch.activeJobStatus === "running"
                          ? "processing"
                          : "queued"}
                    {" · "}
                    {state.previewBatch.candidates.length} completed
                  </p>
                )}
                <button
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] text-[14px] font-black text-white disabled:opacity-60"
                  disabled={pending}
                  onClick={() => void generatePreview()}
                  type="button"
                >
                  {previewStatus === "generating" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="h-4 w-4" />
                  )}
                  {previewStatus === "complete"
                    ? "Regenerate preview candidates"
                    : previewStatus === "paused" ? "Check preview status"
                    : previewStatus === "failed"
                      ? restoredPreviewReviewId || state.previewBatch?.failureReason === "outcome_unknown" ? "Check preview status" : "Retry preview candidates"
                      : "Generate preview candidates"}
                </button>
                {previewStatus === "generating" && state.previewBatch && (
                  <>
                    <button type="button" className="min-h-11 text-sm text-white underline" onClick={() => {
                      previewRunRef.current = 0;
                      const batch = stateRef.current.previewBatch;
                      if (batch) persistPreviewBatch({ ...batch, phase: "paused", failureReason: "user_paused", errorMessage: "Checking paused. Any queued image keeps running; check its status to continue." });
                      setPending(false);
                      setPreviewStatus("paused");
                      setStatus("Checking paused. You can confirm an available image or check the saved request again.");
                    }}>{previewCandidates.length > 0 ? "Choose a ready image" : "Pause checking"}</button>
                    {previewCandidates.length > 0 && (
                      <p className="text-[13px] leading-6 text-neutral-300">
                        This pauses checking and prevents further image requests. Images already requested will keep generating.
                      </p>
                    )}
                  </>
                )}
                {previewCandidates.length > 0 && (
                  <div className="grid grid-cols-2 gap-3" data-testid="create-preview-candidates">
                    {previewCandidates.map((candidate, index) => {
                      const selected = selectedPreviewJobId === candidate.previewJobId;
                      const confirmed = state.confirmedPreviewJobId === candidate.previewJobId;
                      return (
                        <button
                          aria-pressed={selected}
                          className={`relative aspect-[4/5] overflow-hidden rounded-[14px] border text-left ${
                            selected ? "border-[rgb(253,95,194)]" : "border-white/10"
                          }`}
                          key={candidate.previewJobId}
                          disabled={pending}
                          onClick={() => handleCandidateSelect(candidate)}
                          type="button"
                        >
                          <Image
                            alt={`Identity candidate ${index + 1}`}
                            className="object-cover object-top"
                            fill
                            sizes="180px"
                            src={candidate.url}
                            unoptimized={isPrivateMediaUrl(candidate.url)}
                          />
                          <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-1 text-[11px] font-black text-white">
                            {candidate.isSynthetic
                              ? "Demo sample"
                              : confirmed
                                ? "Identity confirmed"
                                : selected
                                  ? "Selected"
                                  : `Option ${index + 1}`}
                          </span>
                          {selected && (
                            <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-[rgb(253,95,194)] px-2 py-1 text-[11px] font-black text-white">
                              <Check className="h-3 w-3" />
                              {confirmed ? "Confirmed" : "Confirm below"}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {previewStatus !== "generating" && previewCandidates.length > 0 && (
                  <div className="grid gap-2 rounded-[12px] bg-black/25 p-3">
                    {state.confirmedPreviewJobId ? (
                      <p className="flex items-center gap-2 text-[13px] font-semibold text-[rgb(120,220,170)]">
                        <Check className="h-4 w-4" />
                        Identity confirmed. This is now the character&apos;s face.
                      </p>
                    ) : (
                      <p className="text-[13px] font-semibold text-white">
                        Select the face that feels right, then confirm “this is them”.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="inline-flex h-10 items-center gap-2 rounded-full bg-[rgb(253,95,194)] px-4 text-[12px] font-black text-white disabled:opacity-50"
                        data-testid="create-confirm-identity"
                        disabled={
                          !selectedPreviewJobId ||
                          pending ||
                          previewCandidates.some(
                            (candidate) =>
                              candidate.previewJobId === selectedPreviewJobId &&
                              candidate.isSynthetic,
                          )
                        }
                        onClick={() => void confirmPreviewCandidate()}
                        type="button"
                      >
                        <ImageIcon className="h-3.5 w-3.5" />
                        {state.confirmedPreviewJobId === selectedPreviewJobId
                          ? "Identity confirmed"
                          : "Confirm this identity"}
                      </button>
                      <button
                        className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]"
                        disabled={pending}
                        onClick={() => {
                          set("step", 1);
                          setStatus("Adjust appearance traits, then generate a new identity family.");
                        }}
                        type="button"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Edit traits
                      </button>
                    </div>
                  </div>
                )}
                {previewStatus === "complete" && (
                  previewCandidates.some((candidate) => candidate.isSynthetic) ? (
                    <p className="text-[13px] font-semibold text-[rgb(255,184,112)]">
                      These are placeholder samples and can&apos;t be confirmed. Generate again to get real previews.
                    </p>
                  ) : (
                    <p className="text-[13px] font-semibold text-[rgb(120,220,170)]">Preview ready.</p>
                  )
                )}
                {previewStatus === "failed" && (
                  <p className="text-[13px] font-semibold text-[rgb(255,140,140)]">
                    Preview failed. Your draft is saved; retry before saving your character.
                  </p>
                )}
                {previewStatus === "paused" && (
                  <p className="text-[13px] leading-6 text-neutral-300">Checking is paused. This does not cancel queued work or mean generation failed. Check the saved request again, or confirm an available identity.</p>
                )}
                </>)}
              </div>
            )}

            {step === 4 && (
              <div className="grid gap-4" data-testid="create-step-publish">
                <div className="flex items-center gap-2 rounded-[12px] bg-black/25 p-3 text-[13px] font-semibold text-[rgb(120,220,170)]">
                  <Check className="h-4 w-4" />
                  {identityKept
                    ? editTarget?.published
                      ? "Keeping the current look. Changes go live after the new version is published."
                      : "Keeping the current identity image. Changes save as a new version."
                    : "Identity confirmed. This character is ready to save. Choose who can see it below."}
                </div>
                <div>
                  <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">Visibility</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {CHARACTER_VISIBILITY.map((item) => (
                      <button
                        className={`h-10 rounded-full px-4 text-[12px] font-bold ${
                          state.visibility === item
                            ? "bg-white text-[rgb(13,13,13)]"
                            : "bg-[rgb(36,36,36)] text-white"
                        }`}
                        key={item}
                        onClick={() => set("visibility", item)}
                        type="button"
                      >
                        {VISIBILITY_LABELS[item]}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[12px] font-medium text-[rgb(170,170,170)]">
                    {state.visibility === "public"
                      ? "Public characters appear in Explore and Community after publication."
                      : state.visibility === "unlisted"
                        ? "After publication, unlisted characters are reachable by direct link and stay out of Explore."
                        : "Private characters stay in your My AI only."}
                  </p>
                </div>
                <button
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[14px] font-black text-white disabled:opacity-70"
                  data-testid="create-submit"
                  disabled={pending || Boolean(createdCharacterId) || !identityReady}
                  onClick={() => void submit()}
                  type="button"
                >
                  <Wand2 className="h-4 w-4" />
                  {pending ? "Submitting…" : editTarget ? "Save changes" : state.visibility === "private" ? "Save character" : "Save for sharing"}
                </button>
              </div>
            )}

            <div className="mt-6 flex items-center justify-between gap-3">
              <button
                className="inline-flex h-11 items-center gap-2 rounded-full bg-[rgb(36,36,36)] px-5 text-[13px] font-bold text-white disabled:opacity-40"
                disabled={step === 0 || pending}
                onClick={back}
                type="button"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
              {step < STEPS.length - 1 && (
                <button
                  className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)] disabled:cursor-not-allowed disabled:bg-[rgb(55,55,55)] disabled:text-[rgb(114,113,112)]"
                  data-testid="create-next"
                  disabled={pending || draftConflict || (step === 3 && !identityReady)}
                  onClick={() => void next()}
                  type="button"
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Next
                  <ArrowRight className="h-4 w-4" />
                </button>
              )}
            </div>

            {step === 3 && !identityReady && (
              <p className="mt-3 text-[12px] font-semibold text-[rgb(255,184,112)]">
                Confirm one identity image to choose visibility and save your character. Your draft stays saved until then.
              </p>
            )}

            {draftConflict && <div className="mt-4 rounded-[12px] border border-white/15 p-4 text-[13px] leading-6 text-white" data-testid="create-draft-conflict" role="alert">
              <p>This draft changed in another tab. Your current inputs are kept here. Loading the latest saved draft replaces them with the saved version.</p>
              <button className="mt-2 rounded-full bg-white px-4 py-2 font-bold text-black" onClick={() => {
                if (storageKey) { try { window.localStorage.removeItem(storageKey); } catch { setStatus("Could not clear browser storage. Try again."); return; } }
                setHydrated(false); setDraftConflict(false); setStatus(""); setDraftReloadAttempt((attempt) => attempt + 1);
              }} type="button">Load latest saved draft</button>
            </div>}
            {status && (
              <p
                aria-live="polite"
                className="mt-4 text-[13px] font-medium text-[rgb(220,220,220)]"
                data-testid="create-status"
                role="status"
              >
                {status}
              </p>
            )}
            {createdCharacterId && createdVisibility === "private" && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white px-4 text-[13px] font-black text-[rgb(13,13,13)]"
                  href={`/characters/${createdCharacterId}`}
                >
                  <Check className="h-4 w-4" />
                  Open character
                </Link>
                <Link
                  className="inline-flex h-10 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
                  href="/custom"
                >
                  My AI
                </Link>
              </div>
            )}
            {createdCharacterId && createdVisibility !== "private" && (
              <div className="mt-4 flex flex-wrap gap-2">
                {/* 作者本人在公开发布完成前就可以和自己的角色聊天。 */}
                <button
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white px-4 text-[13px] font-black text-[rgb(13,13,13)] disabled:opacity-60"
                  disabled={pending}
                  onClick={() => void startChat()}
                  type="button"
                >
                  Start chatting
                </button>
                <Link
                  className="inline-flex h-10 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
                  href="/custom"
                >
                  View in My AI
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// SPEC: 向导里可输入的字段必须自己看起来像输入框。
// INTENT: 这些卡片原本用 bg-transparent + 无边框 + 无 placeholder，渲染出来是一块空白，
//   用户看到「Choose a suggestion or write your own」却找不到可点的地方。边框沿用 Soul
//   步骤 textarea 已有的样式，不引入第二套视觉。
const FIELD_TEXT_INPUT_CLASS =
  "mt-2 w-full rounded-[10px] border border-white/10 bg-[rgb(13,13,13)] px-3 py-2 text-[14px] font-semibold leading-6 text-white outline-none focus:border-[rgb(253,95,194)]";
const FIELD_LEAD_INPUT_CLASS =
  "mt-2 w-full rounded-[10px] border border-white/10 bg-[rgb(13,13,13)] px-3 py-2 text-[18px] font-bold leading-6 text-white outline-none focus:border-[rgb(253,95,194)]";

// SPEC: required 只画星号（输入框自己带 aria-required）；error 显示在字段内，id 由
//   fieldErrorId(fieldId) 给出，输入框用 aria-describedby 指向它、aria-invalid 标红。
function Field({
  label,
  hint,
  required,
  error,
  fieldId,
  children,
}: Readonly<{ label: string; hint?: string; required?: boolean; error?: string; fieldId?: string; children: React.ReactNode }>) {
  return (
    <label className={`block rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white${error ? " ring-1 ring-[rgb(255,120,120)]" : ""}`}>
      <span className="block text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
        {label}
        {required && <span aria-hidden="true" className="ml-1 text-[rgb(253,95,194)]">*</span>}
      </span>
      {children}
      {error && fieldId && (
        <span className="mt-2 block text-[12px] font-semibold text-[rgb(255,150,150)]" id={fieldErrorId(fieldId)}>
          {error}
        </span>
      )}
      {hint && <span className="mt-1 block text-[11px] font-medium text-[rgb(170,170,170)]">{hint}</span>}
    </label>
  );
}

function fieldErrorId(fieldId: string) {
  return `${fieldId}-error`;
}

// Props for the control inside a Field: required state and, once shown, its error.
function fieldControlProps(fieldId: string, error: string | undefined) {
  return {
    id: fieldId,
    "aria-required": true,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? fieldErrorId(fieldId) : undefined,
  } as const;
}

// INTENT: 不附 errorCode —— 它是内部枚举不是可查的单号，客服拿它什么也查不到。
const PREVIEW_FAILED_MESSAGE = "Preview generation failed. Try again.";

const VISIBILITY_LABELS: Record<string, string> = {
  private: "Private",
  unlisted: "Link only",
  public: "Public",
};

async function api(
  path: string,
  body?: unknown,
  method = "POST",
  createResumeTarget?: () => string | null,
  options?: { idempotencyKey?: string; signal?: AbortSignal; viewerScope?: string; onViewerChanged?: () => void; onDraftConflict?: () => void },
) {
  const response = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options?.viewerScope ? { "x-idream-viewer-scope": options.viewerScope } : {}),
      ...(options?.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : {}),
    },
    signal: options?.signal,
    // GET/HEAD cannot carry a body — only serialize for write methods.
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
  // Logged-out users can't create drafts; send them to sign up instead of
  // dead-ending on a 401 (mirrors CharacterDetailClient.startChat).
  if (response.status === 401) {
    if (options?.viewerScope?.startsWith("user:")) {
      options.onViewerChanged?.();
      throw new Error("Your session ended. Sign in to the original account to continue your draft.");
    }
    const resumeTarget = createResumeTarget?.();
    const currentTarget = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const next = encodeURIComponent(resumeTarget ?? (currentTarget || "/create"));
    window.location.href = `/signup?next=${next || "%2Fcreate"}`;
    throw new Error("Sign in to create a character. Redirecting…");
  }
  // Outage pages come back as HTML; never show the JSON parser's complaint.
  const payload = ((await response.json().catch(() => null)) ?? {}) as DraftPayload;
  if (response.status === 409 && payload.error?.message?.startsWith("Your account changed")) {
    options?.onViewerChanged?.();
  }
  if (response.status === 409 && payload.error?.details?.blocker === "version_mismatch") {
    options?.onDraftConflict?.();
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error?.message ?? GENERIC_FAILURE_MESSAGE);
  }
  return payload;
}

function persistPreviewBatchForStorage(
  storageKey: string,
  batch: CreatePreviewBatch,
  fallbackDraft: WizardState,
) {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const stored = raw ? parseWizardDraft(JSON.parse(raw)) : null;
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ ...(stored ?? fallbackDraft), previewBatch: batch }),
    );
  } catch {
    // The in-memory flow remains usable when browser storage is unavailable.
  }
}

function normalizePreviewJobStatus(value: unknown): CreatePreviewJobStatus {
  if (value === "running" || value === "completed" || value === "failed") {
    return value;
  }
  return "queued";
}

function createDraftTransfer(viewerScope: string | null, draft: WizardState) {
  if (!viewerScope || !isAnonymousScope(viewerScope)) return null;
  try {
    // Park the latest edits under the anonymous key too, so a visitor who never
    // finishes signing in still finds the draft when they come back.
    window.localStorage.setItem(
      draftStorageKeyForScope(viewerScope),
      JSON.stringify(draft),
    );
  } catch {
    // Local storage is an optional aid; the transfer envelope is what matters.
  }
  return stashDraftTransfer("create", { payload: draft, sourceScope: viewerScope });
}

function consumeDraftTransfer(targetScope: string) {
  const claimed = claimDraftTransfer("create", { targetScope });
  if (!claimed) return false;
  const restored = parseWizardDraft(claimed.payload);
  if (!restored) return false;
  try {
    // The wizard hydrates from local storage once the viewer scope flips, so the
    // handoff only completes if this write lands.
    window.localStorage.setItem(
      draftStorageKeyForScope(targetScope),
      JSON.stringify(restored),
    );
    window.localStorage.removeItem(draftStorageKeyForScope(claimed.sourceScope));
    return true;
  } catch {
    return false;
  }
}

export function parseWizardDraft(value: unknown): WizardState | null {
  if (!isRecord(value)) return null;
  const restored: WizardState = {
    draftId: draftString(value.draftId, 200),
    draftUpdatedAt: typeof value.draftUpdatedAt === "string" && Number.isFinite(Date.parse(value.draftUpdatedAt)) ? new Date(value.draftUpdatedAt).toISOString() : "",
    previewBatch: parseCreatePreviewBatch(value.previewBatch),
    restoredPreviewCandidates: Array.isArray(value.restoredPreviewCandidates)
      ? value.restoredPreviewCandidates.flatMap((item) => parseCreatePreviewCandidate(item) ?? [])
      : [],
    confirmedPreviewJobId: draftString(
      value.confirmedPreviewJobId,
      200,
    ),
    confirmedPreviewUrl:
      typeof value.confirmedPreviewUrl === "string" &&
      isRenderableMediaSource(value.confirmedPreviewUrl)
        ? value.confirmedPreviewUrl
        : "",
    step:
      typeof value.step === "number" &&
      Number.isInteger(value.step) &&
      value.step >= 0 &&
      value.step < STEPS.length
        ? value.step
        : INITIAL.step,
    quickStartBrief: draftString(value.quickStartBrief, MAX_QUICK_START_BRIEF_LENGTH),
    name: draftString(value.name, 80),
    age:
      typeof value.age === "number" &&
      Number.isInteger(value.age) &&
      value.age >= 18 &&
      value.age <= 120
        ? value.age
        : INITIAL.age,
    gender: draftString(value.gender, 80) || INITIAL.gender,
    style: draftString(value.style, 80) || INITIAL.style,
    appearance: draftString(value.appearance, 4000),
    ethnicity: draftString(value.ethnicity, 160),
    skinTone: draftString(value.skinTone, 160),
    eyeColor: draftString(value.eyeColor, 160),
    faceShape: draftString(value.faceShape, 160),
    hair: draftString(value.hair, 2000),
    body: draftString(value.body, 2000),
    description: draftString(value.description, 1_000),
    detailsMarkdown:
      draftString(value.detailsMarkdown, 24_000) || templateDetailsMarkdown(value),
    firstMessage: draftString(value.firstMessage, 4000),
    voiceSelection: isRecord(value.voiceSelection) && value.voiceSelection.provider === "pocket_tts" && typeof value.voiceSelection.voiceId === "string" && value.voiceSelection.voiceId.trim()
      ? { provider: "pocket_tts", voiceId: draftString(value.voiceSelection.voiceId.trim(), 160) }
      : null,
    tags: draftString(value.tags, 2000),
    visibility: isCatalogMember(CHARACTER_VISIBILITY, value.visibility)
      ? value.visibility
      : INITIAL.visibility,
  };
  if (restored.step > 3 && !restored.confirmedPreviewJobId) {
    restored.step = 3;
  }
  return restored;
}

function draftString(value: unknown, maximumLength: number) {
  return typeof value === "string"
    ? value.slice(0, maximumLength)
    : "";
}

// 401 is handled before this in api(); anyone reaching the fallback is already signed in.
const GENERIC_FAILURE_MESSAGE = "Something went wrong. Check your connection and try again.";

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : GENERIC_FAILURE_MESSAGE;
}

function normalizedTags(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}

/** 与服务端 slugify 同一套规则；草稿里可能留有旧的自由文本，按同样规则比对才能对上。 */
function tagSlugOf(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Guided authoring edits the one Soul Markdown authority; it never creates a
// parallel set of runtime personality fields that could disagree with that text.
function soulDetailSection(markdown: string, label: string) {
  const headings = [...markdown.matchAll(/^## ([^\n]+)\n?/gm)];
  const index = headings.findIndex((heading) => heading[1]?.trim() === label);
  if (index < 0) return null;
  const heading = headings[index]!;
  return { start: heading.index, contentStart: heading.index + heading[0].length, end: headings[index + 1]?.index ?? markdown.length };
}

function readSoulDetail(markdown: string, label: string) {
  const section = soulDetailSection(markdown, label);
  // Keep spaces while typing; trimming every keystroke joins separate words.
  return section ? markdown.slice(section.contentStart, section.end).replace(/^[\r\n]+|[\r\n]+$/g, "") : "";
}

function updateSoulDetail(markdown: string, label: string, value: string) {
  const section = soulDetailSection(markdown, label);
  const replacement = value ? `## ${label}\n${value}` : "";
  if (!section) return [markdown.trimEnd(), replacement].filter(Boolean).join("\n\n");
  return [markdown.slice(0, section.start).trimEnd(), replacement, markdown.slice(section.end).trimStart()].filter(Boolean).join("\n\n");
}

// SPEC: 每一步的字段错误一次全部算出，键是字段的 DOM id（按页面顺序），
//   提交失败时全部显示并聚焦第一个。
function stepFieldErrors(step: number, state: WizardState): Array<[string, string]> {
  const errors: Array<[string, string | false]> = step === 0
    ? [
        ["create-field-name", state.name.trim().length < 2 && "Name needs at least 2 characters."],
        ["create-field-age", (state.age < 18 || state.age > 120) && "Age must be between 18 and 120."],
      ]
    : step === 2
      ? [
          ["create-field-promise", !state.description.trim()
            ? "Write the character promise."
            : state.description.length > 1_000 && "Character promise must be 1,000 characters or fewer."],
          ["create-field-first-message", !state.firstMessage.trim()
            ? "Write the character's first message."
            : state.firstMessage.length > 4_000 && "First message must be 4,000 characters or fewer."],
          ["create-field-details", state.detailsMarkdown.length > 24_000 && "Additional details must be 24,000 characters or fewer."],
        ]
      : [];
  return errors.flatMap(([id, message]) => message ? [[id, message] as [string, string]] : []);
}
