"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ImageIcon, Loader2, Sparkles, Wand2 } from "lucide-react";
import { CHARACTER_VISIBILITY, isCatalogMember } from "@idream/shared/catalog";
import {
  characterStyleFormOptions,
  genderFormOptions,
} from "@/lib/character-taxonomy";
import { isPrivateMediaUrl } from "@/lib/image-delivery";
import {
  isRenderableMediaSource,
  parseTemplatesResponse,
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
import {
  CREATE_PREVIEW_CANDIDATE_COUNT,
  continueCreatePreviewBatch,
  newCreatePreviewBatch,
  parseCreatePreviewBatch,
  retryCreatePreviewBatch,
  type CreatePreviewBatch,
  type CreatePreviewCandidate,
  type CreatePreviewJobStatus,
} from "./create-preview-flow";

type DraftPayload = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    draft?: { id: string };
    character?: { id: string; name: string; status?: string };
    asset?: { id?: string; url: string; isSynthetic?: boolean };
    previewJob?: { id: string; status: string; errorCode?: string | null };
  };
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

function pickTags(value: unknown): string {
  if (Array.isArray(value)) return value.filter((t) => typeof t === "string").join(",");
  if (typeof value === "string") return value;
  return "";
}

function pickLines(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((line) => typeof line === "string" && line.trim()).join("\n");
  }
  return typeof value === "string" ? value : "";
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

const STEPS = ["Identity", "Appearance", "Personality", "Preview", "Publish"] as const;

export type WizardState = {
  draftId: string;
  previewBatch: CreatePreviewBatch | null;
  confirmedPreviewJobId: string;
  confirmedPreviewUrl: string;
  step: number;
  name: string;
  age: number;
  gender: string;
  style: string;
  appearance: string;
  hair: string;
  body: string;
  description: string;
  relationshipArchetype: string;
  personality: string;
  tone: string;
  backstory: string;
  firstMessage: string;
  exampleDialogue: string;
  tags: string;
  visibility: string;
};

const INITIAL: WizardState = {
  draftId: "",
  previewBatch: null,
  confirmedPreviewJobId: "",
  confirmedPreviewUrl: "",
  step: 0,
  name: "",
  age: 21,
  gender: "female",
  style: "realistic",
  appearance: "",
  hair: "",
  body: "",
  description: "",
  relationshipArchetype: "",
  personality: "",
  tone: "",
  backstory: "",
  firstMessage: "",
  exampleDialogue: "",
  tags: "",
  visibility: "private",
};

export function initialCharacterDraft(): WizardState {
  return { ...INITIAL };
}

export function CreateWorkspace() {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [state, setState] = useState<WizardState>(initialCharacterDraft);
  const [preview, setPreview] = useState(DEFAULT_PREVIEW);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle");
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
  const previewRunRef = useRef(0);
  const previewRunSequenceRef = useRef(0);
  const stateRef = useRef(state);

  const step = state.step;
  const previewCandidates = state.previewBatch?.candidates ?? [];
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

  // Resume a draft after refresh once the viewer-scoped storage key is known.
  useEffect(() => {
    if (!storageKey) return;
    let restored: WizardState | null = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        restored = parseWizardDraft(JSON.parse(raw));
      }
    } catch {
      // ignore malformed storage
    }
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot hydration from browser storage */
    if (restored) {
      setState(restored);
      const restoredCandidate = restored.previewBatch?.candidates.find(
        (candidate) => candidate.previewJobId === restored.confirmedPreviewJobId,
      ) ?? restored.previewBatch?.candidates[0];
      const restoredPreviewUrl = restored.confirmedPreviewUrl || restoredCandidate?.url;
      if (restoredPreviewUrl) {
        setPreview(restoredPreviewUrl);
        setSelectedPreviewJobId(
          restored.confirmedPreviewJobId || restoredCandidate?.previewJobId || "",
        );
      }
      if (restored.previewBatch?.phase === "complete") {
        setPreviewStatus("complete");
      } else if (restored.previewBatch?.phase === "running") {
        setPreviewStatus("generating");
      } else if (restored.previewBatch?.phase === "failed") {
        setPreviewStatus("failed");
        setStatus(restored.previewBatch.errorMessage);
      }
    }
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [storageKey]);

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

  function applyTemplate(template: CreateTemplate) {
    // Selecting a template seeds the draft; the user is then free to edit everything (no runtime link).
    setTemplateId(template.id);
    setState((current) => ({
      ...current,
      previewBatch: null,
      confirmedPreviewJobId: "",
      confirmedPreviewUrl: "",
      gender: template.gender || current.gender,
      style: template.style || current.style,
      appearance: pickString(template.appearance, "prompt", "summary") || current.appearance,
      description:
        pickString(template.advancedDetails, "description") || template.summary || current.description,
      relationshipArchetype:
        pickString(template.advancedDetails, "relationshipArchetype", "relationship") ||
        current.relationshipArchetype,
      personality: pickString(template.advancedDetails, "personality") || current.personality,
      tone: pickString(template.advancedDetails, "tone") || current.tone,
      backstory: pickString(template.advancedDetails, "backstory") || current.backstory,
      firstMessage: pickString(template.advancedDetails, "firstMessage") || current.firstMessage,
      exampleDialogue:
        pickLines(
          isRecord(template.advancedDetails)
            ? template.advancedDetails.exampleDialogue
            : undefined,
        ) || current.exampleDialogue,
      tags: pickTags(template.tags) || current.tags,
    }));
    setPreview(DEFAULT_PREVIEW);
    setPreviewStatus("idle");
    setSelectedPreviewJobId("");
    setStatus(`Started from "${template.name}". Edit any field before publishing.`);
  }

  function setIdentityField<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((current) => ({
      ...current,
      [key]: value,
      previewBatch: null,
      confirmedPreviewJobId: "",
      confirmedPreviewUrl: "",
    }));
    setPreview(DEFAULT_PREVIEW);
    setPreviewStatus("idle");
    setSelectedPreviewJobId("");
  }

  const nameError = state.name.trim().length < 2 ? "Name needs at least 2 characters." : "";
  const ageError = state.age < 18 || state.age > 99 ? "Age must be between 18 and 99." : "";
  const personaError = requiredPersonaMessage(state);

  async function ensureDraft(): Promise<string> {
    if (state.draftId) return state.draftId;
    const created = await requestApi("/api/v1/character-drafts", {
      name: state.name,
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
        style: state.style,
        gender: state.gender,
        appearance: { prompt: state.appearance },
        hair: { prompt: state.hair },
        body: { type: state.body },
        advancedDetails: {
          description: state.description,
          relationshipArchetype: state.relationshipArchetype,
          personality: state.personality,
          tone: state.tone,
          backstory: state.backstory,
          firstMessage: state.firstMessage,
          exampleDialogue: normalizedDialogue(state.exampleDialogue),
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
        description: state.description,
        age: state.age,
      });
      const character = submitted.data?.character;
      if (character?.id) {
        setCreatedCharacterId(character.id);
        setCreatedStatus(character.status ?? "");
      }
      setStatus(
        character
          ? character.status === "pending_review"
            ? `${character.name} submitted for review. Approval starts publication preparation; the character goes live after Release is published.`
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

        <div className="mt-8 grid gap-4 md:grid-cols-[360px_1fr]">
          <div className="relative min-h-[560px] overflow-hidden rounded-[20px] bg-[rgb(18,18,18)]">
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
                    max={99}
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
                <Field label="Hair">
                  <input
                    className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 outline-none"
                    onChange={(event) => setIdentityField("hair", event.target.value)}
                    value={state.hair}
                  />
                </Field>
                <Field label="Body">
                  <input
                    className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 outline-none"
                    onChange={(event) => setIdentityField("body", event.target.value)}
                    value={state.body}
                  />
                </Field>
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-3" data-testid="create-step-personality">
                <div>
                  <h2 className="text-[18px] font-black text-white">Define who they are with you</h2>
                  <p className="mt-1 text-[13px] leading-5 text-[rgb(170,170,170)]">
                    These details become the character&apos;s stable chat persona, not just profile copy.
                  </p>
                </div>
                <Field
                  hint="A one- or two-sentence profile shown to people who meet this character."
                  label="Description"
                >
                  <textarea
                    className="mt-3 min-h-28 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                    onChange={(event) => setIdentityField("description", event.target.value)}
                    placeholder="A perceptive night-shift radio host who makes difficult conversations feel easy."
                    value={state.description}
                  />
                </Field>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field
                    hint="This anchors how the character relates to the user in every conversation."
                    label="Relationship to you"
                  >
                    <input
                      className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 text-white outline-none"
                      onChange={(event) =>
                        setIdentityField("relationshipArchetype", event.target.value)
                      }
                      placeholder="Trusted confidante and longtime friend"
                      value={state.relationshipArchetype}
                    />
                  </Field>
                  <Field label="Voice and tone">
                    <input
                      className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 text-white outline-none"
                      onChange={(event) => setIdentityField("tone", event.target.value)}
                      placeholder="Warm, teasing, concise, emotionally attentive"
                      value={state.tone}
                    />
                  </Field>
                </div>
                <Field label="Personality">
                  <textarea
                    className="mt-3 min-h-24 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                    onChange={(event) => setIdentityField("personality", event.target.value)}
                    placeholder="Patient and observant; asks one thoughtful question at a time; playful without dismissing serious feelings."
                    value={state.personality}
                  />
                </Field>
                <Field label="Backstory">
                  <textarea
                    className="mt-3 min-h-24 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                    onChange={(event) => setIdentityField("backstory", event.target.value)}
                    placeholder="How you met, what they do, and the experiences that shape how they speak and act."
                    value={state.backstory}
                  />
                </Field>
                <Field
                  hint="This is the exact opening line for a new conversation."
                  label="First message"
                >
                  <textarea
                    className="mt-3 min-h-20 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                    onChange={(event) => setIdentityField("firstMessage", event.target.value)}
                    placeholder="There you are. What has been on your mind tonight?"
                    value={state.firstMessage}
                  />
                </Field>
                <Field
                  hint="One example per line. These examples teach rhythm and word choice without being repeated verbatim."
                  label="Example dialogue"
                >
                  <textarea
                    className="mt-3 min-h-28 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                    onChange={(event) => setIdentityField("exampleDialogue", event.target.value)}
                    placeholder={"Tell me the part you keep replaying.\nYou can be honest with me; I can handle the messy version."}
                    value={state.exampleDialogue}
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
                <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                  Generate four identity candidates, then choose the image that should define how {state.name} looks.
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
                        ? "failed"
                        : (state.previewBatch.activeJobStatus ?? "queued")}
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
                      ? "Retry preview candidates"
                      : "Generate preview candidates"}
                </button>
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
                      ? "Public characters are reviewed before appearing in Explore and Community."
                      : state.visibility === "unlisted"
                        ? "Unlisted characters are only reachable by direct link."
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
                  {pending ? "Submitting…" : state.visibility === "public" ? "Submit for review" : "Save character"}
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
    name: draftString(value.name, 120),
    age:
      typeof value.age === "number" &&
      Number.isInteger(value.age) &&
      value.age >= 18 &&
      value.age <= 99
        ? value.age
        : INITIAL.age,
    gender: draftString(value.gender, 80) || INITIAL.gender,
    style: draftString(value.style, 80) || INITIAL.style,
    appearance: draftString(value.appearance, 4000),
    hair: draftString(value.hair, 2000),
    body: draftString(value.body, 2000),
    description: draftString(value.description, 8000),
    relationshipArchetype: draftString(value.relationshipArchetype, 500),
    personality: draftString(value.personality, 4000),
    tone: draftString(value.tone, 2000),
    backstory: draftString(value.backstory, 8000),
    firstMessage: draftString(value.firstMessage, 4000),
    exampleDialogue: draftString(value.exampleDialogue, 12_000),
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

function normalizedDialogue(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function requiredPersonaMessage(state: WizardState) {
  const requirements: ReadonlyArray<[keyof WizardState, string]> = [
    ["description", "Add a short character description before continuing."],
    ["relationshipArchetype", "Define the character's relationship to you before continuing."],
    ["personality", "Describe the character's personality before continuing."],
    ["tone", "Describe the character's voice and tone before continuing."],
    ["backstory", "Add the character's backstory before continuing."],
    ["firstMessage", "Write the character's first message before continuing."],
    ["exampleDialogue", "Add at least one example dialogue line before continuing."],
  ];
  for (const [key, message] of requirements) {
    const value = state[key];
    if (typeof value !== "string" || !value.trim()) return message;
  }
  return "";
}
