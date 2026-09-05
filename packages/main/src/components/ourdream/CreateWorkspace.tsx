"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ImageIcon, Loader2, Sparkles, Wand2 } from "lucide-react";
import { CHARACTER_VISIBILITY, isCatalogMember } from "@idream/shared/catalog";
import { legacySoulDetailsMarkdown } from "@idream/shared/chat/persona";
import { renderCharacterSoulMarkdown } from "@idream/shared/chat/persona-render";
import {
  characterStyleFormOptions,
  genderFormOptions,
} from "@/lib/character-taxonomy";
import { isPrivateMediaUrl } from "@/lib/image-delivery";
import {
  isRenderableMediaSource,
  parseTemplatesResponse,
  parseCharacterVoiceCatalogResponse,
  parseCharacterVoicePreviewResponse,
  type CharacterVoiceCatalog,
  parseViewerAuthorityResponse,
  type PublicCharacterTemplate as CreateTemplate,
} from "@/lib/public-api-contracts";
import { useAgeGateAccess } from "./AgeGateBoundary";
import {
  claimDraftTransfer,
  isAnonymousScope,
  stashDraftTransfer,
} from "./draft-transfer";
import { isRecord } from "./workspace-helpers";
import { CREATE_SOUL_DETAIL_FIELDS } from "./create-soul-catalog";
import {
  CREATE_PREVIEW_CANDIDATE_COUNT,
  continueCreatePreviewBatch,
  newCreatePreviewBatch,
  parseCreatePreviewBatch,
  parseCreatePreviewCandidate,
  retryCreatePreviewBatch,
  type CreatePreviewBatch,
  type CreatePreviewCandidate,
  type CreatePreviewJobStatus,
} from "./create-preview-flow";

type DraftPayload = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    draft?: ServerCharacterDraft | null;
    character?: { id: string; name: string; status?: string };
    asset?: { id?: string; url: string; isSynthetic?: boolean };
    previewJob?: { id: string; status: string; errorCode?: string | null };
  };
};

export type ServerCharacterDraft = {
  id: string;
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

type PreviewStatus = "idle" | "generating" | "complete" | "failed";

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
  previewBatch: CreatePreviewBatch | null;
  restoredPreviewCandidate: CreatePreviewCandidate | null;
  confirmedPreviewJobId: string;
  confirmedPreviewUrl: string;
  step: number;
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
  previewBatch: null,
  restoredPreviewCandidate: null,
  confirmedPreviewJobId: "",
  confirmedPreviewUrl: "",
  step: 0,
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
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [state, setState] = useState<WizardState>(initialCharacterDraft);
  const [preview, setPreview] = useState(DEFAULT_PREVIEW);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle");
  const [restoredPreviewReviewId, setRestoredPreviewReviewId] = useState("");
  const [selectedPreviewJobId, setSelectedPreviewJobId] = useState("");
  const [status, setStatus] = useState("");
  const [createdCharacterId, setCreatedCharacterId] = useState("");
  const [createdStatus, setCreatedStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [viewerScope, setViewerScope] = useState<string | null>(null);
  const storageKey = viewerScope ? draftStorageKeyForScope(viewerScope) : null;
  const [viewerAuthorityState, setViewerAuthorityState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [viewerAuthorityAttempt, setViewerAuthorityAttempt] = useState(0);
  const [templates, setTemplates] = useState<CreateTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templatesState, setTemplatesState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [templatesAttempt, setTemplatesAttempt] = useState(0);
  const [voiceCatalog, setVoiceCatalog] = useState<CharacterVoiceCatalog | null>(null);
  const [voiceCatalogError, setVoiceCatalogError] = useState(false);
  const [voiceCatalogAttempt, setVoiceCatalogAttempt] = useState(0);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState("");
  const [voicePreviewPending, setVoicePreviewPending] = useState(false);
  const [voicePreviewStatus, setVoicePreviewStatus] = useState("");
  const voicePreviewSequence = useRef(0);
  const previewRunRef = useRef(0);
  const previewRunSequenceRef = useRef(0);
  const stateRef = useRef(state);

  const step = state.step;
  const previewCandidates = state.previewBatch?.candidates ??
    (state.restoredPreviewCandidate ? [state.restoredPreviewCandidate] : []);
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
    ) =>
      api(
        path,
        body,
        method,
        () => createDraftTransfer(viewerScope, stateRef.current),
        options,
      ),
    [viewerScope],
  );
  const persistPreviewBatch = useCallback(
    (batch: CreatePreviewBatch) => {
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
    fetch("/api/v1/me", { signal: controller.signal })
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
    const applyRestored = (
      next: WizardState,
      serverAsset?: { id?: string; url: string; isSynthetic?: boolean } | null,
      serverPreviewJob?: { id: string; status: string; errorCode?: string | null } | null,
    ) => {
      restored = next;
      if (serverAsset?.url && next.confirmedPreviewJobId) {
        restored = { ...next, confirmedPreviewUrl: serverAsset.url };
      }
      // The server may have finished a preview before this browser ever saw
      // it. Restore that exact candidate without enqueueing another batch.
      if (!next.previewBatch && serverPreviewJob?.status === "completed" && serverAsset) {
        restored = {
          ...restored,
          restoredPreviewCandidate: parseCreatePreviewCandidate({
            previewJobId: serverPreviewJob.id,
            assetId: serverAsset.id,
            url: serverAsset.url,
            isSynthetic: serverAsset.isSynthetic,
          }),
        };
      }
      // Another device has no batch count or request key. Keep only the known
      // job and check it without inventing a replacement four-image batch.
      setRestoredPreviewReviewId("");
      if (!next.previewBatch && serverPreviewJob?.errorCode === "provider_outcome_unknown") {
        setRestoredPreviewReviewId(serverPreviewJob.id);
        setPreviewStatus("failed");
        setStatus(`The preview result needs review. Contact support with request ${serverPreviewJob.id}.`);
      }
      const applied = restored;
      if (!applied) return;
      setState(applied);
      const restoredCandidate = applied.previewBatch?.candidates.find(
        (candidate) => candidate.previewJobId === applied.confirmedPreviewJobId,
      ) ?? applied.previewBatch?.candidates[0] ?? applied.restoredPreviewCandidate;
      const restoredPreviewUrl = applied.confirmedPreviewUrl || restoredCandidate?.url;
      if (restoredPreviewUrl) {
        setPreview(restoredPreviewUrl);
        setSelectedPreviewJobId(
          applied.confirmedPreviewJobId || restoredCandidate?.previewJobId || "",
        );
      }
      if (applied.previewBatch?.phase === "complete" || restoredPreviewUrl) {
        setPreviewStatus("complete");
      } else if (applied.previewBatch?.phase === "running") {
        setPreviewStatus("generating");
      } else if (applied.previewBatch?.phase === "failed" || serverPreviewJob?.status === "failed") {
        setPreviewStatus("failed");
        setStatus(
          applied.previewBatch?.errorMessage ||
          (serverPreviewJob?.errorCode
            ? `Preview generation failed (${serverPreviewJob.errorCode}). Try again.`
            : "Preview generation failed. Try again."),
        );
      }
    };
    const recoverMissingCandidate = Boolean(restored?.draftId && restored.step === 3 &&
      !restored.previewBatch && !restored.restoredPreviewCandidate && !restored.confirmedPreviewJobId);
    if (restored) {
      queueMicrotask(() => {
        if (controller.signal.aborted || !restored) return;
        applyRestored(restored);
        if (!recoverMissingCandidate) setHydrated(true);
      });
      if (!recoverMissingCandidate) return () => controller.abort();
    }
    if (viewerScope && !isAnonymousScope(viewerScope)) {
      void requestApi(
        "/api/v1/character-drafts/current",
        undefined,
        "GET",
        { signal: controller.signal },
      ).then((payload) => {
        if (controller.signal.aborted || !payload.data?.draft) return;
        const serverState = wizardStateFromServerDraft(payload.data.draft);
        if (serverState) {
          // Recover a lost confirmation without discarding unsaved local traits
          // or attaching a server image to different local inputs.
          if (restored && (restored.draftId !== serverState.draftId || !samePreviewInputs(restored, serverState))) return;
          applyRestored(
            restored ?? serverState,
            payload.data.asset ?? null,
            payload.data.previewJob ?? null,
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
  }, [requestApi, storageKey, viewerScope]);

  useEffect(() => {
    if (!hydrated || !storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // ignore quota/serialization errors
    }
  }, [state, hydrated, storageKey]);

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

  function applyTemplate(template: CreateTemplate) {
    setRestoredPreviewReviewId("");
    // Selecting a template seeds the draft; the user is then free to edit everything (no runtime link).
    setTemplateId(template.id);
    const appearance = isRecord(template.appearance) ? template.appearance : {};
    const face = isRecord(appearance.face) ? appearance.face : appearance;
    setState((current) => ({
      ...current,
      previewBatch: null,
      restoredPreviewCandidate: null,
      confirmedPreviewJobId: "",
      confirmedPreviewUrl: "",
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
    }));
    setPreview(DEFAULT_PREVIEW);
    setPreviewStatus("idle");
    setSelectedPreviewJobId("");
    setStatus(`Started from "${template.name}". Edit any field before publishing.`);
  }

  function setIdentityField<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setRestoredPreviewReviewId("");
    setState((current) => ({
      ...current,
      [key]: value,
      previewBatch: null,
      restoredPreviewCandidate: null,
      confirmedPreviewJobId: "",
      confirmedPreviewUrl: "",
    }));
    setPreview(DEFAULT_PREVIEW);
    setPreviewStatus("idle");
    setSelectedPreviewJobId("");
  }

  function updateGuidedSoul(label: string, value: string) {
    const details = updateSoulDetail(state.detailsMarkdown, label, value);
    if (details.length > 24_000) {
      setStatus("Additional details must be 24,000 characters or fewer.");
      return;
    }
    setIdentityField("detailsMarkdown", details);
  }

  const nameError = state.name.trim().length < 2 ? "Name needs at least 2 characters." : "";
  const ageError = state.age < 18 || state.age > 120 ? "Age must be between 18 and 120." : "";
  const personaError = requiredPersonaMessage(state);

  async function ensureDraft(): Promise<string> {
    if (state.draftId) return state.draftId;
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
    if (step === 0 && (nameError || ageError)) {
      setStatus(nameError || ageError);
      return;
    }
    if (step === 2 && personaError) {
      setStatus(personaError);
      return;
    }
    if (step === 3 && !state.confirmedPreviewJobId) {
      setStatus("Choose and confirm an identity image before publishing.");
      return;
    }
    setPending(true);
    setStatus("");
    try {
      await saveStep(step + 1);
      set("step", Math.min(step + 1, STEPS.length - 1));
    } catch (error) {
      setStatus(messageFrom(error));
    } finally {
      setPending(false);
    }
  }

  function back() {
    setStatus("");
    set("step", Math.max(step - 1, 0));
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
              errorMessage: previewJob?.errorCode
                ? `Preview generation failed (${previewJob.errorCode}). Try again.`
                : undefined,
            };
          },
          persist: persistPreviewBatch,
          isActive: () => previewRunRef.current === runId,
        });
        if (previewRunRef.current !== runId) return;
        if (settled.phase === "complete") {
          const selected = settled.candidates[0];
          if (selected) {
            setPreview(selected.url);
            setSelectedPreviewJobId((current) => current || selected.previewJobId);
          }
          setPreviewStatus("complete");
          return;
        }
        setPreviewStatus("failed");
        setStatus(settled.errorMessage || "Preview generation failed. Try again.");
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
          setState((current) => ({ ...current, restoredPreviewCandidate: candidate }));
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
      const retrying = existingBatch?.phase === "failed";
      const batch = existingBatch?.phase === "failed"
        ? retryCreatePreviewBatch(existingBatch)
        : newCreatePreviewBatch();
      if (!retrying) {
        setPreview(DEFAULT_PREVIEW);
        setSelectedPreviewJobId("");
      }
      setState((current) => ({
        ...current,
        previewBatch: batch,
        restoredPreviewCandidate: null,
        confirmedPreviewJobId: "",
        confirmedPreviewUrl: "",
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
    if (!state.confirmedPreviewJobId) {
      set("step", 3);
      setStatus("Choose and confirm an identity image before publishing.");
      return;
    }
    setPending(true);
    setStatus("");
    setCreatedCharacterId("");
    setCreatedStatus("");
    try {
      const draftId = await ensureDraft();
      await saveStep(STEPS.length);
      await requestApi(`/api/v1/character-drafts/${draftId}/tags`, {
        tags: normalizedTags(state.tags),
      });
      const submitted = await requestApi(`/api/v1/character-drafts/${draftId}/submit`, {
        visibility: state.visibility,
      });
      const character = submitted.data?.character;
      if (character?.id) {
        setCreatedCharacterId(character.id);
        setCreatedStatus(character.status ?? "");
      }
      setStatus(
        character
          ? character.status === "pending_review"
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
          restoredPreviewCandidate: null,
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

  if (!hydrated) {
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
          Create Your Dream AI Character
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
              {index < step ? <Check className="h-3.5 w-3.5" /> : <span>{index + 1}</span>}
              {label}
            </li>
          ))}
        </ol>

        {/* 与 /generate 同一处根因：md(768) 起 220px 侧栏就常驻，再叠一个固定 360px
            的预览栏，iPad 竖屏装不下 —— 整页溢出 141px，且右栏被压到把 select 的
            选中值裁掉（"Female" 显示成 "Femal"）。双栏推到 lg(1024)。 */}
        <div className="mt-8 grid gap-4 lg:grid-cols-[360px_1fr]">
          <div className="relative aspect-[4/5] w-full max-w-[448px] self-start justify-self-center overflow-hidden rounded-[20px] bg-[rgb(18,18,18)]">
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
            {step === 0 && (
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
                <Field label="Name">
                  <input
                    className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                    onChange={(event) => setIdentityField("name", event.target.value)}
                    value={state.name}
                  />
                </Field>
                <Field label="Age" hint={ageError || "18+ only"}>
                  <input
                    className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
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
                <Field label="Appearance">
                  <input
                    className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 outline-none"
                    onChange={(event) => setIdentityField("appearance", event.target.value)}
                    value={state.appearance}
                  />
                </Field>
                {VISUAL_FIELDS.map(({ key, label, suggestions }) => (
                  <Field key={key} label={label} hint="Choose a suggestion or write your own.">
                    <input
                      className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 outline-none"
                      list={`create-${key}-options`}
                      maxLength={key === "hair" || key === "body" ? 2000 : 160}
                      onChange={(event) => setIdentityField(key, event.target.value)}
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
                  </p>
                </div>
                <Field
                  hint="A one- or two-sentence promise that defines what makes this character worth talking to."
                  label="Character promise"
                >
                  <textarea
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
                        className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 outline-none"
                        list={`create-soul-${index}-options`}
                        maxLength={1000}
                        onChange={(event) => updateGuidedSoul(label, event.target.value)}
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
                      id="create-voice-select"
                      onChange={(event) => selectVoice(event.target.value)}
                      value={state.voiceSelection?.voiceId ?? ""}
                    >
                      <option value="">System default</option>
                      {state.voiceSelection && !voiceCatalog?.items.some((voice) => voice.id === state.voiceSelection?.voiceId) && (
                        <option value={state.voiceSelection.voiceId}>Saved voice: {state.voiceSelection.voiceId} (unavailable)</option>
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
                  <p className="mt-2 text-[12px] text-[rgb(170,170,170)]">Choose how this character sounds. Personality and speech style stay in their Soul.</p>
                  {voiceCatalogError && <p className="mt-2 text-[12px]" role="status">Voice choices could not load. <button className="underline" onClick={() => setVoiceCatalogAttempt((attempt) => attempt + 1)} type="button">Retry voices</button></p>}
                  {voicePreviewStatus && <p className="mt-2 text-[12px]" role="status">{voicePreviewStatus}</p>}
                  {voicePreviewUrl && <audio aria-label="Selected voice preview" className="mt-3 w-full" controls src={voicePreviewUrl} />}
                </div>
                <Field
                  hint="This is the exact opening line for a new conversation."
                  label="First message"
                >
                  <textarea
                    className="mt-3 min-h-20 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                    maxLength={4000}
                    onChange={(event) => setIdentityField("firstMessage", event.target.value)}
                    placeholder="There you are. What has been on your mind tonight?"
                    value={state.firstMessage}
                  />
                </Field>
                <Field
                  hint="Guided fields above update this same text. Add background, speech style, custom details, scenarios, or dialogue examples here."
                  label="Additional details (optional)"
                >
                  <textarea
                    className="mt-3 min-h-56 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 font-mono text-[13px] font-medium leading-6 text-white outline-none"
                    maxLength={24000}
                    onChange={(event) => setIdentityField("detailsMarkdown", event.target.value)}
                    placeholder={"## Personality and voice\nWarm, teasing, concise, emotionally attentive.\n\n## Background\nHow you met and what shaped this character."}
                    value={state.detailsMarkdown}
                  />
                </Field>
                <Field label="Tags">
                  <input
                    className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 text-white outline-none"
                    onChange={(event) => set("tags", event.target.value)}
                    value={state.tags}
                  />
                </Field>
              </div>
            )}

            {step === 3 && (
              <div className="grid gap-4" data-testid="create-step-preview">
                <section className="rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white" data-testid="create-soul-preview">
                  <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                    SOUL.md · exact Agent prompt
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
                <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                  {state.restoredPreviewCandidate && !state.previewBatch
                    ? "Your saved preview is ready. Confirm this identity or generate new candidates."
                    : `Generate four identity candidates, then choose the image that should define how ${state.name} looks.`}
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
                      : state.previewBatch.phase === "failed"
                        ? state.previewBatch.failureReason === "outcome_unknown" ? "needs review" : "failed"
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
                    : previewStatus === "failed"
                      ? restoredPreviewReviewId || state.previewBatch?.failureReason === "outcome_unknown" ? "Check preview status" : "Retry preview candidates"
                      : "Generate preview candidates"}
                </button>
                {(restoredPreviewReviewId || state.previewBatch?.failureReason === "outcome_unknown") && (
                  <Link className="text-[13px] text-white underline" href="/helpdesk">Contact support</Link>
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
                {previewStatus === "complete" && previewCandidates.length > 0 && (
                  <div className="grid gap-2 rounded-[12px] bg-black/25 p-3">
                    {state.confirmedPreviewJobId ? (
                      <p className="flex items-center gap-2 text-[13px] font-semibold text-[rgb(120,220,170)]">
                        <Check className="h-4 w-4" />
                        Identity confirmed. Future images will use this character anchor.
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
                  <p className="text-[13px] font-semibold text-[rgb(120,220,170)]">
                    {previewCandidates.some((candidate) => candidate.isSynthetic)
                      ? "Demo samples cannot be confirmed. Connect the real image provider and regenerate."
                      : "Preview ready."}
                  </p>
                )}
                {previewStatus === "failed" && (
                  <p className="text-[13px] font-semibold text-[rgb(255,140,140)]">
                    Preview failed. Your draft is saved; retry before publishing.
                  </p>
                )}
              </div>
            )}

            {step === 4 && (
              <div className="grid gap-4" data-testid="create-step-publish">
                <div className="flex items-center gap-2 rounded-[12px] bg-black/25 p-3 text-[13px] font-semibold text-[rgb(120,220,170)]">
                  <Check className="h-4 w-4" />
                  Identity confirmed. This character is ready to publish.
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
                        {item}
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
                  disabled={pending || Boolean(createdCharacterId) || !state.confirmedPreviewJobId}
                  onClick={() => void submit()}
                  type="button"
                >
                  <Wand2 className="h-4 w-4" />
                  {pending ? "Submitting…" : state.visibility === "private" ? "Save character" : "Save for sharing"}
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
                  disabled={pending || (step === 3 && !state.confirmedPreviewJobId)}
                  onClick={() => void next()}
                  type="button"
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Next
                  <ArrowRight className="h-4 w-4" />
                </button>
              )}
            </div>

            {step === 3 && !state.confirmedPreviewJobId && (
              <p className="mt-3 text-[12px] font-semibold text-[rgb(255,184,112)]">
                Confirm one identity image to unlock Publish. Your draft stays saved until then.
              </p>
            )}

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
            {createdCharacterId && createdStatus !== "pending_review" && (
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
            {createdCharacterId && createdStatus === "pending_review" && (
              <Link
                className="mt-4 inline-flex h-10 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
                href="/custom"
              >
                View in My AI
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: Readonly<{ label: string; hint?: string; children: React.ReactNode }>) {
  return (
    <label className="block rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white">
      <span className="block text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] font-medium text-[rgb(170,170,170)]">{hint}</span>}
    </label>
  );
}

async function api(
  path: string,
  body?: unknown,
  method = "POST",
  createResumeTarget?: () => string | null,
  options?: { idempotencyKey?: string; signal?: AbortSignal },
) {
  const response = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
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
    const resumeTarget = createResumeTarget?.();
    const currentTarget = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const next = encodeURIComponent(resumeTarget ?? (currentTarget || "/create"));
    window.location.href = `/signup?next=${next || "%2Fcreate"}`;
    throw new Error("Sign in to create a character. Redirecting…");
  }
  const payload = (await response.json()) as DraftPayload;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error?.message ?? "Sign in, accept the age gate, then try again.");
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
    previewBatch: parseCreatePreviewBatch(value.previewBatch),
    restoredPreviewCandidate: parseCreatePreviewCandidate(value.restoredPreviewCandidate),
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

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "Sign in, accept the age gate, then try again.";
}

function normalizedTags(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
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

function requiredPersonaMessage(state: WizardState) {
  if (!state.description.trim()) return "Write the character promise before continuing.";
  if (state.description.length > 1_000) return "Character promise must be 1,000 characters or fewer.";
  if (!state.firstMessage.trim()) return "Write the character's first message before continuing.";
  if (state.firstMessage.length > 4_000) return "First message must be 4,000 characters or fewer.";
  if (state.detailsMarkdown.length > 24_000) return "Additional details must be 24,000 characters or fewer.";
  return "";
}
