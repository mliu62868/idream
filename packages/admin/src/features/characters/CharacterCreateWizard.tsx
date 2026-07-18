"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import {
  characterProjectCreateRequestSchema,
  characterProjectCreateResponseSchema,
  characterProjectDraftSchema,
  characterProjectDraftResumeSchema,
  characterProjectProductionReadyDraftSchema,
  characterWorkspaceProjectSchema,
  type CharacterProjectDraft,
  type CharacterProjectDraftAuthority,
} from "@idream/shared/admin";
import { ArrowLeft, ArrowRight, Check, Loader2, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AdminV2RequestError, adminV2Request } from "@/lib/admin-v2-api";
import { cn } from "@/lib/utils";
import { WorkspaceButton, fieldClass, textAreaClass } from "@/features/operations/WorkspaceUi";
import {
  claimDurableMutationIntent,
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  updateDurableMutationIntent,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";
import { reconcileDurableMutationIntent } from "@/lib/durable-mutation-recovery";

type Draft = CharacterProjectDraft;
type SaveState =
  | "Not saved"
  | "Saved locally"
  | "In memory only"
  | "Saving"
  | "Saved"
  | "Conflict"
  | "Failed to save";
type ResumeState =
  | "checking"
  | "restoring"
  | "restored"
  | "restore_failed"
  | "new";

class ReconciledUncommittedCharacter extends Error {}

const steps = ["Positioning", "Persona", "Visual direction", "Commercial intent", "Review"] as const;

const initialDraft: Draft = {
  positioning: {
    audience: "",
    companionNeed: "",
    hypothesis: "",
    differentiation: "",
  },
  persona: {
    name: "",
    age: 18,
    gender: "female",
    relationshipArchetype: "",
    characterPromise: "",
    personality: "",
    tone: "",
    backstory: "",
    firstMessage: "",
    exampleDialogue: [],
  },
  visualDirection: {
    identityAnchor: "",
    stableTraits: [],
    style: "realistic",
    referenceDirection: "",
  },
  commercialIntent: {
    ownerId: null,
    plannedLaunchAt: null,
    targetPlacementKeys: [],
    successCriteria: [],
    productionPackage: "",
    qaPlan: "",
  },
};

const stepRequirements = [
  "Describe the audience, recurring need, hypothesis, and differentiation.",
  "Complete every required persona field and add at least one dialogue example.",
  "Define the identity anchor, stable traits, style, and reference direction.",
  "Add a measurable success criterion, production package, and QA plan.",
  "Review the complete Character before creating its server authority.",
] as const;

export function isCharacterCreateStepComplete(
  draft: Draft,
  step: number,
) {
  if (step === 0) {
    return characterProjectDraftSchema.shape.positioning.safeParse(
      draft.positioning,
    ).success;
  }
  if (step === 1) {
    return characterProjectDraftSchema.shape.persona.safeParse(
      draft.persona,
    ).success;
  }
  if (step === 2) {
    return characterProjectDraftSchema.shape.visualDirection.safeParse(
      draft.visualDirection,
    ).success;
  }
  if (step === 3) {
    return characterProjectDraftSchema.shape.commercialIntent.safeParse(
      draft.commercialIntent,
    ).success;
  }
  return characterProjectProductionReadyDraftSchema.safeParse(draft).success;
}

export function characterAssetsDeepLink(deepLink: string) {
  const [path, query = ""] = deepLink.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("tab", "assets");
  return `${path}?${params.toString()}`;
}

function localDraftStorageKey(actorId: string) {
  return `idream.admin.character-create-draft.v1:${actorId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

function isRecoverableLocalDraft(value: unknown): value is Draft {
  if (!isRecord(value)) return false;
  const positioning = value.positioning;
  const persona = value.persona;
  const visualDirection = value.visualDirection;
  const commercialIntent = value.commercialIntent;
  if (
    !isRecord(positioning) ||
    !isRecord(persona) ||
    !isRecord(visualDirection) ||
    !isRecord(commercialIntent)
  ) return false;
  return [
    positioning.audience,
    positioning.companionNeed,
    positioning.hypothesis,
    positioning.differentiation,
    persona.name,
    persona.relationshipArchetype,
    persona.characterPromise,
    persona.personality,
    persona.tone,
    persona.backstory,
    persona.firstMessage,
    visualDirection.identityAnchor,
    visualDirection.referenceDirection,
    commercialIntent.productionPackage,
    commercialIntent.qaPlan,
  ].every((item) => typeof item === "string") &&
    typeof persona.age === "number" &&
    ["female", "male", "trans"].includes(String(persona.gender)) &&
    ["realistic", "anime", "hybrid", "other"].includes(
      String(visualDirection.style),
    ) &&
    isStringArray(persona.exampleDialogue) &&
    isStringArray(visualDirection.stableTraits) &&
    isStringArray(commercialIntent.targetPlacementKeys) &&
    isStringArray(commercialIntent.successCriteria) &&
    (
      commercialIntent.ownerId === null ||
      typeof commercialIntent.ownerId === "string"
    ) &&
    (
      commercialIntent.plannedLaunchAt === null ||
      typeof commercialIntent.plannedLaunchAt === "string"
    );
}

function readLocalDraft(actorId: string) {
  if (typeof window === "undefined" || requestedDraftTarget()) return null;
  try {
    const raw = window.localStorage.getItem(localDraftStorageKey(actorId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return isRecoverableLocalDraft(value) ? value : null;
  } catch {
    return null;
  }
}

function saveLocalDraft(actorId: string, draft: Draft): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = localDraftStorageKey(actorId);
    const serialized = JSON.stringify(draft);
    window.localStorage.setItem(key, serialized);
    return window.localStorage.getItem(key) === serialized;
  } catch {
    // The in-memory draft remains usable when browser storage is unavailable.
    return false;
  }
}

function clearLocalDraft(actorId: string) {
  try {
    window.localStorage.removeItem(localDraftStorageKey(actorId));
  } catch {
    // Nothing else is required when browser storage is unavailable.
  }
}

function draftKey(value: Draft) {
  return JSON.stringify(value);
}

function requestedDraftTarget() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("draft");
}

function draftFromCreateIntent(
  intent: DurableMutationIntent | null,
): Draft | null {
  const parsed = characterProjectCreateRequestSchema.safeParse(
    intent?.requestSnapshot,
  );
  if (!parsed.success) return null;
  return {
    positioning: parsed.data.positioning,
    persona: parsed.data.persona,
    visualDirection: parsed.data.visualDirection,
    commercialIntent: parsed.data.commercialIntent,
  };
}

export function CharacterCreateWizard({
  actorId = "anonymous",
  canCreate,
}: {
  actorId?: string;
  canCreate: boolean;
}) {
  const { t } = useAdminI18n();
  const router = useRouter();
  const createScope = `character-project:create:${actorId}`;
  const [createIntent, setCreateIntent] =
    useState<DurableMutationIntent | null>(null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [authority, setAuthority] = useState<CharacterProjectDraftAuthority | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("Not saved");
  const [error, setError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] =
    useState<string | null>(null);
  const [resumeState, setResumeState] =
    useState<ResumeState>("checking");
  const [confirmStartNew, setConfirmStartNew] = useState(false);
  const authorityRef = useRef<CharacterProjectDraftAuthority | null>(null);
  const resumeTargetRef = useRef<string | null | undefined>(undefined);
  const lastSavedKeyRef = useRef<string | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const userEditedRef = useRef(false);

  const persistNow = useCallback(async (snapshot: Draft, allowCreate: boolean) => {
    const key = draftKey(snapshot);
    if (lastSavedKeyRef.current === key && authorityRef.current) return;
    setSaveState("Saving");
    setError(null);
    setRecoveryNotice(null);
    const recoveredCreateRequest = createIntent
      ? characterProjectCreateRequestSchema.safeParse(
          createIntent.requestSnapshot,
        )
      : null;
    if (
      !authorityRef.current &&
      createIntent &&
      (
        createIntent.status === "reconciliation_required" ||
        (
          recoveredCreateRequest !== null &&
          !recoveredCreateRequest.success
        )
      )
    ) {
      try {
        const receipt = await reconcileDurableMutationIntent({
          intent: createIntent,
          commandType: "character.project.create",
        });
        if (receipt.state === "committed") {
          if (
            !receipt.committedTargetId ||
            receipt.verification?.kind !== "character_project" ||
            receipt.verification.characterId !==
              receipt.committedTargetId
          ) {
            throw new Error(
              "The committed Character receipt is missing exact projection evidence. This draft remains locked.",
            );
          }
          const committed = updateDurableMutationIntent(createIntent, {
            status: "committed_projection_pending",
            committedTargetId: receipt.committedTargetId,
          });
          setCreateIntent(committed);
          const resumed = await adminV2Request(
            `/api/v2/admin/characters/${encodeURIComponent(receipt.committedTargetId)}/project`,
            { schema: characterProjectDraftResumeSchema },
          );
          authorityRef.current = resumed.authority;
          lastSavedKeyRef.current = draftKey(resumed.draft);
          setAuthority(resumed.authority);
          setDraft(resumed.draft);
          clearDurableMutationIntent(committed);
          setCreateIntent(null);
          resumeTargetRef.current = resumed.authority.characterId;
          setResumeState("restored");
          setSaveState("Saved");
          try {
            const url = new URL(window.location.href);
            url.searchParams.set(
              "draft",
              resumed.authority.characterId,
            );
            window.history.replaceState(
              null,
              "",
              `${url.pathname}?${url.searchParams.toString()}`,
            );
          } catch {
            setError(
              "The Character was recovered, but this tab URL could not be updated.",
            );
          }
          return;
        }
        if (receipt.state === "cancelled") {
          clearDurableMutationIntent(createIntent);
          setCreateIntent(null);
          setSaveState("Not saved");
          const message =
            "The old request had no committed Character. Its key was sealed on the server; review this draft and continue when ready.";
          setRecoveryNotice(message);
          throw new ReconciledUncommittedCharacter(message);
        }
        const message = receipt.state === "failed"
          ? `The saved Character command ${receipt.commandId} is terminally failed. Its key remains locked for operator investigation; do not create a replacement Character.`
          : `The saved Character request is ${receipt.state}. Keep this draft locked and reconcile again after the server reaches a terminal receipt.`;
        setSaveState("Failed to save");
        setError(message);
        return Promise.reject(new Error(message));
      } catch (cause) {
        if (cause instanceof ReconciledUncommittedCharacter) {
          throw cause;
        }
        const message =
          cause instanceof Error
            ? cause.message
            : "The saved Character request could not be reconciled.";
        setSaveState("Failed to save");
        setError(message);
        throw cause;
      }
    }
    let pendingCreateIntent = createIntent;
    try {
      if (!authorityRef.current) {
        if (!allowCreate) return;
        if (resumeTargetRef.current !== null) {
          throw new Error(
            resumeTargetRef.current
              ? "Restore the requested server draft or explicitly start a new Character before continuing."
              : "The draft destination is still being checked. Wait for restore to finish.",
          );
        }
        if (
          createIntent?.status === "committed_projection_pending" &&
          createIntent.committedTargetId
        ) {
          const resumed = await adminV2Request(
            `/api/v2/admin/characters/${encodeURIComponent(createIntent.committedTargetId)}/project`,
            { schema: characterProjectDraftResumeSchema },
          );
          authorityRef.current = resumed.authority;
          lastSavedKeyRef.current = draftKey(resumed.draft);
          setAuthority(resumed.authority);
          setDraft(resumed.draft);
          clearDurableMutationIntent(createIntent);
          setCreateIntent(null);
          resumeTargetRef.current = resumed.authority.characterId;
          setResumeState("restored");
          setSaveState("Saved");
          try {
            const url = new URL(window.location.href);
            url.searchParams.set(
              "draft",
              resumed.authority.characterId,
            );
            window.history.replaceState(
              null,
              "",
              `${url.pathname}?${url.searchParams.toString()}`,
            );
          } catch {
            setError(
              "The Character was recovered, but this tab URL could not be updated.",
            );
          }
          return;
        }
        const currentRequest = {
          ...snapshot,
          reason: {
            code: "character_wizard_started",
            summary: "Create a server-authoritative Character Project draft",
          },
          confirmation: "CREATE CHARACTER",
        };
        const recoveredRequest = recoveredCreateRequest;
        if (recoveredRequest && !recoveredRequest.success) {
          throw new Error(
            "The saved Character creation intent is invalid and cannot be replayed.",
          );
        }
        const parsedCurrent = recoveredRequest
          ? null
          : characterProjectCreateRequestSchema.safeParse(
              currentRequest,
            );
        if (parsedCurrent && !parsedCurrent.success) {
          throw new Error(
            "The Character creation request no longer matches the active contract.",
          );
        }
        const body = recoveredRequest?.success
          ? recoveredRequest.data
          : parsedCurrent?.success
            ? parsedCurrent.data
            : currentRequest;
        const requestSignature = draftKey(body);
        let intent = createIntent;
        if (!intent) {
          const claim = await claimDurableMutationIntent({
            scope: createScope,
            signature: requestSignature,
            requestSnapshot: body,
          });
          intent = claim.intent;
          if (
            intent.signature !== requestSignature ||
            [
              "committed_projection_pending",
              "reconciliation_required",
            ].includes(intent.status)
          ) {
            const recoveredDraft = draftFromCreateIntent(intent);
            if (recoveredDraft) setDraft(recoveredDraft);
            setCreateIntent(intent);
            pendingCreateIntent = null;
            throw new Error(
              intent.status === "committed_projection_pending"
                ? "Another tab already committed a Character receipt. Resume to verify that Character before creating again."
                : intent.status === "reconciliation_required"
                  ? "Another tab has an aged Character receipt. Reconcile it with the server before creating again."
                : "Another tab already started a different Character creation. Its exact draft is locked for safe resume.",
            );
          }
        }
        pendingCreateIntent = intent;
        setCreateIntent(intent);
        const created = await adminV2Request("/api/v2/admin/characters", {
          method: "POST",
          idempotencyKey: intent.idempotencyKey,
          schema: characterProjectCreateResponseSchema,
          body,
        });
        const committed = updateDurableMutationIntent(intent, {
          status: "committed_projection_pending",
          committedTargetId: created.characterId,
        });
        pendingCreateIntent = committed;
        setCreateIntent(committed);
        authorityRef.current = created;
        setAuthority(created);
        clearDurableMutationIntent(committed);
        setCreateIntent(null);
        resumeTargetRef.current = created.characterId;
        setResumeState("restored");
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("draft", created.characterId);
          window.history.replaceState(
            null,
            "",
            `${url.pathname}?${url.searchParams.toString()}`,
          );
        } catch {
          setError(
            "The Character was created, but this tab URL could not be updated.",
          );
        }
      } else {
        const saved = await adminV2Request(`/api/v2/admin/characters/${authorityRef.current.characterId}/project`, {
          method: "PATCH",
          ifMatch: authorityRef.current.projectVersion,
          schema: characterWorkspaceProjectSchema,
          body: {
            entityVersion: authorityRef.current.projectVersion,
            ownerId: snapshot.commercialIntent.ownerId,
            audience: snapshot.positioning.audience,
            companionNeed: snapshot.positioning.companionNeed,
            hypothesis: snapshot.positioning.hypothesis,
            differentiation: snapshot.positioning.differentiation,
            targetPlacementKeys: snapshot.commercialIntent.targetPlacementKeys,
            successCriteria: snapshot.commercialIntent.successCriteria,
            productionPackage: snapshot.commercialIntent.productionPackage,
            qaPlan: snapshot.commercialIntent.qaPlan,
            plannedLaunchAt: snapshot.commercialIntent.plannedLaunchAt,
            content: {
              persona: snapshot.persona,
              visualDirection: snapshot.visualDirection,
            },
            reason: "Autosave Character creation wizard",
          },
        });
        const next = { ...authorityRef.current, projectVersion: saved.version };
        authorityRef.current = next;
        setAuthority(next);
      }
      lastSavedKeyRef.current = key;
      setSaveState("Saved");
    } catch (cause) {
      if (cause instanceof AdminV2RequestError && cause.status === 409) setSaveState("Conflict");
      else setSaveState("Failed to save");
      if (
        !authorityRef.current &&
        pendingCreateIntent?.status ===
          "committed_projection_pending"
      ) {
        setCreateIntent(pendingCreateIntent);
        setError(
          cause instanceof Error
            ? `The Character was committed, but its draft projection is still unavailable: ${cause.message}`
            : "The Character was committed, but its draft projection is still unavailable.",
        );
      } else if (
        !authorityRef.current &&
        pendingCreateIntent &&
        !(
          cause instanceof AdminV2RequestError &&
          [400, 401, 403, 404, 409, 422].includes(cause.status)
        )
      ) {
        const unknown = updateDurableMutationIntent(pendingCreateIntent, {
          status: "outcome_unknown",
        });
        setCreateIntent(unknown);
        setError(
          "Character creation outcome is unknown. Resume the same creation intent; it will reuse the original request key.",
        );
      } else {
        if (
          !authorityRef.current &&
          pendingCreateIntent &&
          cause instanceof AdminV2RequestError &&
          [400, 401, 403, 404, 409, 422].includes(cause.status)
        ) {
          clearDurableMutationIntent(pendingCreateIntent);
          setCreateIntent(null);
        }
        setError(cause instanceof Error ? cause.message : "Character draft could not be saved");
      }
      throw cause;
    }
  }, [createIntent, createScope]);

  const persist = useCallback((snapshot: Draft, allowCreate: boolean) => {
    const run = saveQueueRef.current.then(() => persistNow(snapshot, allowCreate));
    saveQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, [persistNow]);

  const restoreDraft = useCallback(async (characterId: string) => {
    resumeTargetRef.current = characterId;
    setResumeState("restoring");
    setSaveState("Saving");
    setError(null);
    try {
      const resumed = await adminV2Request(`/api/v2/admin/characters/${encodeURIComponent(characterId)}/project`, {
        schema: characterProjectDraftResumeSchema,
      });
      authorityRef.current = resumed.authority;
      lastSavedKeyRef.current = draftKey(resumed.draft);
      setAuthority(resumed.authority);
      setDraft(resumed.draft);
      setResumeState("restored");
      setSaveState("Saved");
    } catch (cause) {
      setResumeState("restore_failed");
      setSaveState("Failed to save");
      setError(cause instanceof Error ? cause.message : "Server draft could not be restored");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const characterId = new URLSearchParams(window.location.search).get("draft");
      if (characterId) {
        if (!authorityRef.current) void restoreDraft(characterId);
        return;
      }
      const pendingIntent = readActiveDurableMutationIntent({
        scope: createScope,
      });
      if (!authorityRef.current && !userEditedRef.current) {
        const recoveredDraft =
          draftFromCreateIntent(pendingIntent) ??
          (pendingIntent ? null : readLocalDraft(actorId));
        if (recoveredDraft) setDraft(recoveredDraft);
        setCreateIntent(pendingIntent);
      }
      resumeTargetRef.current = null;
      setResumeState("new");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [actorId, createScope, restoreDraft]);

  useEffect(() => {
    if (!authority) return;
    const timer = window.setTimeout(() => {
      void persist(draft, false).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [authority, draft, persist]);

  if (!canCreate) {
    return (
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6 sm:p-8">
        <ShieldAlert className="h-6 w-6 text-[var(--ad-text-muted)]" />
        <h2 className="mt-4 text-lg font-semibold">{t("No permission")}</h2>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">{t("Your effective grants do not include character.project.write.")}</p>
      </section>
    );
  }

  async function next() {
    if (["checking", "restoring", "restore_failed"].includes(resumeState)) {
      return;
    }
    if (!createIntent && !isCharacterCreateStepComplete(draft, step)) return;
    try {
      if (authorityRef.current || createIntent) {
        await persist(draft, Boolean(createIntent));
      } else {
        setSaveState(
          saveLocalDraft(actorId, draft)
            ? "Saved locally"
            : "In memory only",
        );
      }
      setStep((current) => Math.min(steps.length - 1, current + 1));
    } catch {
      // The persistent state and inline error explain the failure.
    }
  }

  async function finish() {
    if (["checking", "restoring", "restore_failed"].includes(resumeState)) {
      return;
    }
    if (!createIntent && !isCharacterCreateStepComplete(draft, 4)) return;
    try {
      await persist(draft, true);
      const destination = authorityRef.current?.deepLink;
      if (destination) {
        clearLocalDraft(actorId);
        router.push(characterAssetsDeepLink(destination));
      }
    } catch {
      // Stay on Review so the operator can resolve and retry.
    }
  }

  const update = <K extends keyof Draft>(section: K, value: Draft[K]) => {
    userEditedRef.current = true;
    const nextDraft = { ...draft, [section]: value };
    setDraft(nextDraft);
    if (!authorityRef.current && !createIntent) {
      setSaveState(
        saveLocalDraft(actorId, nextDraft)
          ? "Saved locally"
          : "In memory only",
      );
      return;
    }
    setSaveState("Not saved");
  };
  const currentLabel = steps[step];
  const currentStepComplete = isCharacterCreateStepComplete(draft, step);
  const navigationLocked =
    saveState === "Saving" ||
    ["checking", "restoring", "restore_failed"].includes(resumeState);

  const startNewCharacter = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("draft");
    window.history.replaceState(
      null,
      "",
      url.searchParams.size
        ? `${url.pathname}?${url.searchParams.toString()}`
        : url.pathname,
    );
    authorityRef.current = null;
    resumeTargetRef.current = null;
    lastSavedKeyRef.current = null;
    userEditedRef.current = false;
    const pendingIntent = readActiveDurableMutationIntent({
      scope: createScope,
    });
    setAuthority(null);
    setCreateIntent(pendingIntent);
    setDraft(draftFromCreateIntent(pendingIntent) ?? initialDraft);
    if (!pendingIntent) clearLocalDraft(actorId);
    setStep(0);
    setError(
      pendingIntent
        ? "An unresolved Character creation was restored. Resume it before starting another Character."
        : null,
    );
    setSaveState("Not saved");
    setResumeState("new");
    setConfirmStartNew(false);
  };

  return (
    <section className="mx-auto max-w-4xl" data-testid="character-create-wizard">
      <header className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">

          {t("Character Studio ·")} {authority ? t("Server draft") : t("Recoverable draft")}
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold">{t("Create Character Project")}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
              {authority
                ? t("This server draft autosaves immutable Project and content revisions.")
                : t("Complete the required sections without creating placeholder data. This browser keeps the draft until Review creates the Character authority.")}
            </p>
          </div>
          <SaveIndicator state={saveState} />
        </div>
        <ol className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label={t("Character creation progress")}>
          {steps.map((label, index) => (
            <li aria-current={index === step ? "step" : undefined} className={cn("rounded-md border px-3 py-2 text-xs", index === step ? "border-[var(--ad-ink)] font-semibold" : "border-[var(--ad-border)] text-[var(--ad-text-muted)]")} key={label}>
              <span className="mr-1 tabular-nums">{index + 1}.</span>{label}
            </li>
          ))}
        </ol>
      </header>

      <div className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-6">
        <h2 className="text-lg font-semibold">{currentLabel}</h2>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Project version")} {authority?.projectVersion ?? t("not created")}</p>
        <fieldset
          className="mt-5"
          disabled={
            ["checking", "restoring"].includes(resumeState) ||
            Boolean(createIntent)
          }
        >
          {step === 0 ? <PositioningStep draft={draft} update={update} /> : null}
          {step === 1 ? <PersonaStep draft={draft} update={update} /> : null}
          {step === 2 ? <VisualStep draft={draft} update={update} /> : null}
          {step === 3 ? <CommercialStep draft={draft} update={update} /> : null}
          {step === 4 ? <ReviewStep draft={draft} /> : null}
        </fieldset>
        <p
          className={cn(
            "mt-4 text-xs",
            currentStepComplete
              ? "text-[var(--ad-green-text)]"
              : "text-[var(--ad-text-muted)]",
          )}
          id="character-create-step-requirements"
        >
          {currentStepComplete
            ? t("Required information complete.")
            : stepRequirements[step]}
        </p>
        {error ? <p className="mt-4 rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
        {recoveryNotice ? <p className="mt-4 rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">{recoveryNotice}</p> : null}
        {resumeState === "restore_failed" ? (
          <div className="mt-4 rounded-lg border border-[var(--ad-border)] p-3">
            <p className="text-sm font-semibold">{t("The requested server draft was not restored.")}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t("Navigation is locked so this page cannot silently create a second Character.")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <WorkspaceButton
                onClick={() => {
                  const target = resumeTargetRef.current;
                  if (typeof target === "string") void restoreDraft(target);
                }}
              >

                {t("Retry restore")}
              </WorkspaceButton>
              {!confirmStartNew ? (
                <WorkspaceButton onClick={() => setConfirmStartNew(true)}>

                  {t("Start a new Character instead")}
                </WorkspaceButton>
              ) : (
                <>
                  <WorkspaceButton onClick={() => setConfirmStartNew(false)}>

                    {t("Keep this draft")}
                  </WorkspaceButton>
                  <WorkspaceButton onClick={startNewCharacter} tone="danger">

                    {t("Confirm start new")}
                  </WorkspaceButton>
                </>
              )}
            </div>
          </div>
        ) : null}
        {createIntent ? (
          <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]" role="status">
            {createIntent.status === "reconciliation_required" ||
            !characterProjectCreateRequestSchema.safeParse(
              createIntent.requestSnapshot,
            ).success
              ? t("This saved request is aged or no longer matches the active contract. Reconcile its server receipt before editing or creating another Character.")
              : t("A Character creation request is unresolved. Resume it to reuse the same request key; form fields remain locked until the authority responds.")}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <WorkspaceButton disabled={step === 0 || navigationLocked} onClick={() => setStep((current) => Math.max(0, current - 1))}>
            <ArrowLeft className="h-4 w-4" />  {t("Back")}
          </WorkspaceButton>
          {step < steps.length - 1 ? (
            <WorkspaceButton
              aria-describedby="character-create-step-requirements"
              disabled={
                navigationLocked ||
                (!createIntent && !currentStepComplete)
              }
              onClick={() => void next()}
              tone="primary"
            >
              {createIntent
                ? createIntent.status === "reconciliation_required" ||
                  !characterProjectCreateRequestSchema.safeParse(
                    createIntent.requestSnapshot,
                  ).success
                  ? t("Reconcile saved request")
                  : t("Resume Character creation")
                : step === 0
                  ? t("Continue to persona")
                  : t("Continue")} <ArrowRight className="h-4 w-4" />
            </WorkspaceButton>
          ) : (
            <WorkspaceButton
              aria-describedby="character-create-step-requirements"
              disabled={
                navigationLocked ||
                (!createIntent && !currentStepComplete)
              }
              onClick={() => void finish()}
              tone="primary"
            >
              <Check className="h-4 w-4" />  {t("Save character & open portrait studio")}
            </WorkspaceButton>
          )}
        </div>
      </div>
    </section>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <span className="inline-flex min-h-8 items-center gap-2 rounded-md bg-black/[0.04] px-3 text-xs font-semibold" role="status">
      {state === "Saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : state === "Saved" ? <Check className="h-3.5 w-3.5" /> : null}
      {state}
    </span>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required = true,
  type = "text",
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: "text" | "number" | "datetime-local";
}) {
  return (
    <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <input
        className={`${fieldClass} mt-1`}
        min={type === "number" ? 18 : undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        type={type}
        value={value}
      />
    </label>
  );
}

function Area({
  label,
  value,
  onChange,
  placeholder,
  required = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <textarea
        className={`${textAreaClass} mt-1`}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        value={value}
      />
    </label>
  );
}

function PositioningStep({ draft, update }: StepProps) {
  const { t } = useAdminI18n();
  const set = (field: keyof Draft["positioning"], value: string) => update("positioning", { ...draft.positioning, [field]: value });
  return <Grid><Area label="Audience" onChange={(value) => set("audience", value)} placeholder={t("Adults winding down after high-pressure work")} value={draft.positioning.audience} /><Area label="Companion need" onChange={(value) => set("companionNeed", value)} placeholder={t("A dependable evening ritual that helps them decompress")} value={draft.positioning.companionNeed} /><Area label="Hypothesis" onChange={(value) => set("hypothesis", value)} placeholder={t("Specific evening rituals improve qualified conversations")} value={draft.positioning.hypothesis} /><Area label="Differentiation" onChange={(value) => set("differentiation", value)} placeholder={t("Calm direction without generic affirmation")} value={draft.positioning.differentiation} /></Grid>;
}

type StepProps = { draft: Draft; update: <K extends keyof Draft>(section: K, value: Draft[K]) => void };

function PersonaStep({ draft, update }: StepProps) {
  const { t } = useAdminI18n();
  const set = <K extends keyof Draft["persona"]>(field: K, value: Draft["persona"][K]) => update("persona", { ...draft.persona, [field]: value });
  return <div className="space-y-4"><Grid><Field label="Name" onChange={(value) => set("name", value)} placeholder={t("Mara")} value={draft.persona.name} /><Field label="Age (18+)" onChange={(value) => set("age", Math.max(18, Number(value) || 18))} type="number" value={draft.persona.age} /><label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Gender")}<select className={`${fieldClass} mt-1`} onChange={(event) => set("gender", event.target.value as Draft["persona"]["gender"])} value={draft.persona.gender}><option value="female">{t("Female")}</option><option value="male">{t("Male")}</option><option value="trans">{t("Trans")}</option></select></label><Field label="Relationship archetype" onChange={(value) => set("relationshipArchetype", value)} placeholder={t("Steady confidante")} value={draft.persona.relationshipArchetype} /></Grid><Grid><Area label="Character promise" onChange={(value) => set("characterPromise", value)} placeholder={t("A precise, warm place to put the day down")} value={draft.persona.characterPromise} /><Area label="Personality" onChange={(value) => set("personality", value)} placeholder={t("Observant, measured, gently challenging")} value={draft.persona.personality} /><Area label="Tone" onChange={(value) => set("tone", value)} placeholder={t("Warm, concise, grounded")} value={draft.persona.tone} /><Area label="Backstory" onChange={(value) => set("backstory", value)} placeholder={t("The experiences that shaped this character's point of view")} value={draft.persona.backstory} /><Area label="First message" onChange={(value) => set("firstMessage", value)} placeholder={t("You made it. What do you need to put down tonight?")} value={draft.persona.firstMessage} /><Area label="Example dialogue (one per line)" onChange={(value) => set("exampleDialogue", lines(value))} placeholder={t("Tell me the part you keep replaying.")} value={draft.persona.exampleDialogue.join("\n")} /></Grid></div>;
}

function VisualStep({ draft, update }: StepProps) {
  const { t } = useAdminI18n();
  const set = <K extends keyof Draft["visualDirection"]>(field: K, value: Draft["visualDirection"][K]) => update("visualDirection", { ...draft.visualDirection, [field]: value });
  return <Grid><Area label="Identity anchor" onChange={(value) => set("identityAnchor", value)} placeholder={t("Composed late-night radio host")} value={draft.visualDirection.identityAnchor} /><Area label="Stable traits (one per line)" onChange={(value) => set("stableTraits", lines(value))} placeholder={"Dark wavy hair\nWarm brown eyes"} value={draft.visualDirection.stableTraits.join("\n")} /><label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Visual style")}<select className={`${fieldClass} mt-1`} onChange={(event) => set("style", event.target.value as Draft["visualDirection"]["style"])} value={draft.visualDirection.style}><option value="realistic">{t("Realistic")}</option><option value="anime">{t("Anime")}</option><option value="hybrid">{t("Hybrid")}</option><option value="other">{t("Other")}</option></select></label><Area label="Reference direction" onChange={(value) => set("referenceDirection", value)} placeholder={t("Low-key tungsten portraiture with an intimate editorial crop")} value={draft.visualDirection.referenceDirection} /></Grid>;
}

function CommercialStep({ draft, update }: StepProps) {
  const { t } = useAdminI18n();
  const set = <K extends keyof Draft["commercialIntent"]>(field: K, value: Draft["commercialIntent"][K]) => update("commercialIntent", { ...draft.commercialIntent, [field]: value });
  return <Grid><Field label="Owner ID (optional)" onChange={(value) => set("ownerId", value.trim() || null)} placeholder={t("Assign after creation if needed")} required={false} value={draft.commercialIntent.ownerId ?? ""} /><Field label="Planned launch (optional)" onChange={(value) => set("plannedLaunchAt", value ? new Date(value).toISOString() : null)} required={false} type="datetime-local" value={dateInput(draft.commercialIntent.plannedLaunchAt)} /><Area label="Target placements (optional, one per line)" onChange={(value) => set("targetPlacementKeys", lines(value))} placeholder={"feed_card\nevening_collection"} required={false} value={draft.commercialIntent.targetPlacementKeys.join("\n")} /><Area label="Success criteria (one per line)" onChange={(value) => set("successCriteria", lines(value))} placeholder={t("QCE improves without D7 regression")} value={draft.commercialIntent.successCriteria.join("\n")} /><Area label="Production package" onChange={(value) => set("productionPackage", value)} placeholder={t("Primary portrait, hero, and chat image baseline")} value={draft.commercialIntent.productionPackage} /><Area label="QA plan" onChange={(value) => set("qaPlan", value)} placeholder={t("Mobile and desktop preview plus five-turn conversation review")} value={draft.commercialIntent.qaPlan} /></Grid>;
}

function ReviewStep({ draft }: { draft: Draft }) {
  const sections = [
    {
      title: "Positioning",
      rows: [
        ["Audience", draft.positioning.audience],
        ["Companion need", draft.positioning.companionNeed],
        ["Hypothesis", draft.positioning.hypothesis],
        ["Differentiation", draft.positioning.differentiation],
      ],
    },
    {
      title: "Persona & conversation",
      rows: [
        [
          "Character",
          `${draft.persona.name}, age ${draft.persona.age}, ${draft.persona.gender}`,
        ],
        ["Relationship", draft.persona.relationshipArchetype],
        ["Promise", draft.persona.characterPromise],
        ["Personality", draft.persona.personality],
        ["Tone", draft.persona.tone],
        ["Backstory", draft.persona.backstory],
        ["First message", draft.persona.firstMessage],
        ["Example dialogue", draft.persona.exampleDialogue.join("\n")],
      ],
    },
    {
      title: "Visual identity",
      rows: [
        ["Identity anchor", draft.visualDirection.identityAnchor],
        ["Stable traits", draft.visualDirection.stableTraits.join(" · ")],
        ["Style", draft.visualDirection.style],
        ["Reference direction", draft.visualDirection.referenceDirection],
      ],
    },
    {
      title: "Production & launch",
      rows: [
        ["Owner", draft.commercialIntent.ownerId ?? "Unassigned"],
        [
          "Planned launch",
          draft.commercialIntent.plannedLaunchAt
            ? new Date(draft.commercialIntent.plannedLaunchAt).toLocaleString()
            : "Not scheduled",
        ],
        [
          "Placements",
          draft.commercialIntent.targetPlacementKeys.join(" · ") ||
            "No placements selected",
        ],
        ["Success criteria", draft.commercialIntent.successCriteria.join("\n")],
        ["Production package", draft.commercialIntent.productionPackage],
        ["QA plan", draft.commercialIntent.qaPlan],
      ],
    },
  ];
  return (
    <div className="grid gap-4">
      {sections.map((section) => (
        <section
          className="overflow-hidden rounded-lg border border-[var(--ad-border)]"
          key={section.title}
        >
          <h3 className="border-b border-[var(--ad-border)] bg-black/[0.025] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ad-text-muted)]">
            {section.title}
          </h3>
          <dl className="divide-y divide-[var(--ad-border)]">
            {section.rows.map(([label, value]) => (
              <div
                className="grid gap-1 p-3 sm:grid-cols-[140px_1fr]"
                key={label}
              >
                <dt className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  {label}
                </dt>
                <dd className="whitespace-pre-line text-sm leading-6">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function lines(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function dateInput(value: string | null) {
  return value ? value.slice(0, 16) : "";
}
