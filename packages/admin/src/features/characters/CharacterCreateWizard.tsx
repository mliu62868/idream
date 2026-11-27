"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import {
  characterProjectCreateRequestSchema,
  characterProjectDraftSchema,
  characterProjectProductionReadyDraftSchema,
  type CharacterProjectDraft,
  type CharacterProjectDraftAuthority,
  type CharacterProjectDraftResume,
} from "@idream/shared/admin";
import { renderCharacterSoulMarkdown } from "@idream/shared/chat/persona-render";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ShieldAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { cn } from "@/lib/utils";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import {
  claimDurableMutationIntent,
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  updateDurableMutationIntent,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";
import { reconcileDurableMutationIntent } from "@/lib/durable-mutation-recovery";
import { characterCreateStepFieldErrors } from "./character-form-validation";
import { useUnsavedChanges } from "@/components/admin/ui/useUnsavedChanges";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";
import { CharacterCreatePrefill, CharacterCreateTagPicker } from "./CharacterCreatePrefill";
import {
  fillEmptyDraftFields,
  withVisualDirectionDefaults,
  type CharacterDraftSuggestion,
} from "./character-create-prefill";
import {
  characterCreateStepRequirements,
  characterCreateSteps,
  clearLocalDraft,
  draftFromCreateIntent,
  draftKey,
  firstIncompleteCharacterCreateStep,
  initialDraft,
  isCharacterCreateStepComplete,
  isRecord,
  pinDraftToUrl,
  readLocalDraft,
  requestedTemplate,
  saveLocalDraft,
  tagIdsFromCreateIntent,
} from "./character-create-draft";
import {
  CharacterCreateError,
  PersonaStep,
  SaveIndicator,
  VisualStep,
  type SaveState,
} from "./CharacterCreateWizardFields";

type Draft = CharacterProjectDraft;
type ResumeState =
  "checking" | "restoring" | "restored" | "restore_failed" | "new";

class ReconciledUncommittedCharacter extends Error {}

const steps = characterCreateSteps;
const stepRequirements = characterCreateStepRequirements;

export function CharacterCreateWizard({
  actorId = "anonymous",
  canCreate,
  canResumeDraft = false,
  canTag = false,
}: {
  actorId?: string;
  canCreate: boolean;
  canResumeDraft?: boolean;
  canTag?: boolean;
}) {
  const { t } = useAdminI18n();
  const router = useRouter();
  const createScope = `character-project:create:${actorId}`;
  const [createIntent, setCreateIntent] =
    useState<DurableMutationIntent | null>(null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [quickSaveMissing, setQuickSaveMissing] = useState<string[] | null>(null);
  const [templateRequest, setTemplateRequest] = useState<string | null>(null);
  const [authority, setAuthority] =
    useState<CharacterProjectDraftAuthority | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("Not saved");
  const [lastSavedKey, setLastSavedKey] = useState<string | null>(null);
  const [requestedCharacterId, setRequestedCharacterId] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | AdminV2RequestError | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [resumeState, setResumeState] = useState<ResumeState>("checking");
  const [confirmStartNew, setConfirmStartNew] = useState(false);
  const [discardLocalDraftOpen, setDiscardLocalDraftOpen] = useState(false);
  const [validationAttemptedStep, setValidationAttemptedStep] = useState<
    number | null
  >(null);
  const wizardRef = useRef<HTMLElement | null>(null);
  const authorityRef = useRef<CharacterProjectDraftAuthority | null>(null);
  const resumeTargetRef = useRef<string | null | undefined>(undefined);
  const lastSavedKeyRef = useRef<string | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const userEditedRef = useRef(false);
  const previousStepRef = useRef(step);
  const latestDraftRef = useRef(draft);
  const selectedTagIdsRef = useRef(selectedTagIds);
  const { guard } = useUnsavedChanges(
    !createIntent && (authority
      ? draftKey(draft) !== lastSavedKey
      : saveState === "In memory only"),
  );

  useEffect(() => {
    latestDraftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    selectedTagIdsRef.current = selectedTagIds;
  }, [selectedTagIds]);

  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    wizardRef.current?.querySelector<HTMLElement>("#character-create-current-step")?.focus();
  }, [step]);

  // SPEC: 采用服务端草稿（恢复已提交的创建、或按 URL 打开）后的本地状态只有这一份。
  const adoptServerDraft = useCallback((resumed: CharacterProjectDraftResume) => {
    authorityRef.current = resumed.authority;
    lastSavedKeyRef.current = draftKey(resumed.draft);
    setLastSavedKey(lastSavedKeyRef.current);
    setAuthority(resumed.authority);
    setDraft(resumed.draft);
    setStep(firstIncompleteCharacterCreateStep(resumed.draft));
  }, []);

  const finishDraftRecovery = useCallback((characterId: string) => {
    resumeTargetRef.current = characterId;
    setResumeState("restored");
    setSaveState("Saved");
    if (!pinDraftToUrl(characterId)) {
      setError(
        "The Character was recovered, but this tab URL could not be updated.",
      );
    }
  }, []);

  const persistNow = useCallback(
    async (snapshot: Draft, allowCreate: boolean) => {
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
        (createIntent.status === "reconciliation_required" ||
          (recoveredCreateRequest !== null && !recoveredCreateRequest.success))
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
              receipt.verification.characterId !== receipt.committedTargetId
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
            const resumed = await adminV2Operation(
              "GET /api/v2/admin/characters/:id/project",
              { path: { id: receipt.committedTargetId } },
            );
            adoptServerDraft(resumed);
            clearDurableMutationIntent(committed);
            setCreateIntent(null);
            finishDraftRecovery(resumed.authority.characterId);
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
          const message =
            receipt.state === "failed"
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
          if (!canCreate) throw new Error("Creating characters requires access to all characters. You can still edit your assigned characters.");
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
            const resumed = await adminV2Operation(
              "GET /api/v2/admin/characters/:id/project",
              { path: { id: createIntent.committedTargetId } },
            );
            adoptServerDraft(resumed);
            clearDurableMutationIntent(createIntent);
            setCreateIntent(null);
            finishDraftRecovery(resumed.authority.characterId);
            return;
          }
          // INVARIANT: 标签随创建原子写入；不选标签时请求里没有这个字段，与旧请求逐字节相同。
          const tagIds = selectedTagIdsRef.current;
          const currentRequest = {
            ...snapshot,
            ...(tagIds.length > 0 ? { tagIds } : {}),
            reason: {
              code: "character_wizard_started",
              summary: "Create a server-authoritative Character draft",
            },
            confirmation: "CREATE CHARACTER" as const,
          };
          const recoveredRequest = recoveredCreateRequest;
          if (recoveredRequest && !recoveredRequest.success) {
            throw new Error(
              "The saved Character creation intent is invalid and cannot be replayed.",
            );
          }
          const parsedCurrent = recoveredRequest
            ? null
            : characterProjectCreateRequestSchema.safeParse(currentRequest);
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
              if (recoveredDraft) {
                setDraft(recoveredDraft);
                setSelectedTagIds(tagIdsFromCreateIntent(intent));
                setStep(firstIncompleteCharacterCreateStep(recoveredDraft));
              }
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
          const created = await adminV2Operation(
            "POST /api/v2/admin/characters",
            {
              replayIdempotencyKey: intent.idempotencyKey,
              body,
            },
          );
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
          if (!pinDraftToUrl(created.characterId)) {
            setError(
              "The Character was created, but this tab URL could not be updated.",
            );
          }
        } else {
          const saved = await adminV2Operation(
            "PATCH /api/v2/admin/characters/:id/project",
            {
              path: { id: authorityRef.current.characterId },
              ifMatch: authorityRef.current.projectVersion,
              body: {
                entityVersion: authorityRef.current.projectVersion,
                content: {
                  persona: snapshot.persona,
                  visualDirection: snapshot.visualDirection,
                },
                reason: "Autosave Character creation wizard",
              },
            },
          );
          const next = {
            ...authorityRef.current,
            projectVersion: saved.version,
          };
          authorityRef.current = next;
          setAuthority(next);
        }
        lastSavedKeyRef.current = key;
        setLastSavedKey(key);
        setSaveState("Saved");
      } catch (cause) {
        if (cause instanceof AdminV2RequestError && cause.outcome === "answered" && cause.status === 409)
          setSaveState("Conflict");
        else setSaveState("Failed to save");
        if (
          !authorityRef.current &&
          pendingCreateIntent?.status === "committed_projection_pending"
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
            cause.outcome === "answered" &&
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
            cause.outcome === "answered" &&
            [400, 401, 403, 404, 409, 422].includes(cause.status)
          ) {
            clearDurableMutationIntent(pendingCreateIntent);
            setCreateIntent(null);
          }
          setError(
            cause instanceof AdminV2RequestError ? cause : cause instanceof Error
              ? cause.message
              : "Character draft could not be saved",
          );
        }
        throw cause;
      }
    },
    [adoptServerDraft, canCreate, createIntent, createScope, finishDraftRecovery],
  );

  const persist = useCallback(
    (snapshot: Draft, allowCreate: boolean) => {
      const run = saveQueueRef.current.then(() =>
        persistNow(snapshot, allowCreate),
      );
      saveQueueRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [persistNow],
  );

  const restoreDraft = useCallback(async (characterId: string) => {
    resumeTargetRef.current = characterId;
    setRequestedCharacterId(characterId);
    setResumeState("restoring");
    setSaveState("Saving");
    setError(null);
    try {
      const resumed = await adminV2Operation(
        "GET /api/v2/admin/characters/:id/project",
        {
          path: { id: characterId },
        },
      );
      adoptServerDraft(resumed);
      setResumeState("restored");
      setSaveState("Saved");
    } catch (cause) {
      setResumeState("restore_failed");
      setSaveState("Failed to save");
      setError(
        cause instanceof AdminV2RequestError ? cause : cause instanceof Error
          ? cause.message
          : "Server draft could not be restored",
      );
    }
  }, [adoptServerDraft]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const characterId = new URLSearchParams(window.location.search).get(
        "draft",
      );
      if (characterId && (canCreate || canResumeDraft)) {
        if (!authorityRef.current) void restoreDraft(characterId);
        return;
      }
      if (!canCreate) {
        resumeTargetRef.current = null;
        setResumeState("new");
        return;
      }
      const pendingIntent = readActiveDurableMutationIntent({
        scope: createScope,
      });
      if (!authorityRef.current && !userEditedRef.current) {
        const recoveredDraft =
          draftFromCreateIntent(pendingIntent) ??
          (pendingIntent ? null : readLocalDraft(actorId));
        if (recoveredDraft) {
          setDraft(recoveredDraft);
          setSelectedTagIds(tagIdsFromCreateIntent(pendingIntent));
          setStep(
            pendingIntent
              ? 0
              : firstIncompleteCharacterCreateStep(recoveredDraft),
          );
          setSaveState("Saved locally");
        }
        setCreateIntent(pendingIntent);
      }
      resumeTargetRef.current = null;
      setResumeState("new");
      setTemplateRequest(requestedTemplate());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [actorId, canCreate, canResumeDraft, createScope, restoreDraft]);

  useEffect(() => {
    if (!authority || !characterProjectDraftSchema.safeParse(draft).success) return;
    const timer = window.setTimeout(() => {
      void persist(draft, false).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [authority, draft, persist]);

  useEffect(() => {
    if (authorityRef.current || createIntent || !userEditedRef.current) return;
    // Keep persistence outside the state updater: React may replay an updater.
    const saved = saveLocalDraft(actorId, draft);
    setSaveState(saved ? "Saved locally" : "In memory only");
  }, [actorId, createIntent, draft]);

  if (!canCreate && !(canResumeDraft && resumeState !== "new")) {
    return (
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6 sm:p-8">
        <ShieldAlert className="h-6 w-6 text-[var(--ad-text-muted)]" />
        <h2 className="mt-4 text-lg font-semibold">{t("No permission")}</h2>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
          {t(canResumeDraft ? "Creating characters requires access to all characters. You can still edit your assigned characters." : "Creating or editing characters requires character write permission.")}
        </p>
      </section>
    );
  }

  async function goToStep(targetStep: number) {
    if (["checking", "restoring", "restore_failed"].includes(resumeState)) {
      return;
    }
    if (targetStep <= step && !createIntent) {
      setValidationAttemptedStep(null);
      setStep(targetStep);
      return;
    }
    if (targetStep > step && !createIntent && !isCharacterCreateStepComplete(draft, step)) {
      setValidationAttemptedStep(step);
      window.setTimeout(() => {
        wizardRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus();
      }, 0);
      return;
    }
    // A server draft's fields are the operator's own; only a brand-new draft gets defaults.
    const nextDraft = step === 0 && targetStep > 0 && !createIntent && !authorityRef.current
      ? withVisualDirectionDefaults(draft)
      : draft;
    if (nextDraft !== draft) {
      userEditedRef.current = true;
      setDraft(nextDraft);
    }
    // Navigation to an editable section must remain possible while another
    // section is invalid. Only valid snapshots can be saved to the authority.
    if (!createIntent && !characterProjectDraftSchema.safeParse(nextDraft).success) {
      setValidationAttemptedStep(null);
      setStep(targetStep);
      return;
    }
    try {
      if (authorityRef.current || createIntent) {
        await persist(nextDraft, Boolean(createIntent));
      } else {
        setSaveState(
          saveLocalDraft(actorId, nextDraft) ? "Saved locally" : "In memory only",
        );
      }
      setValidationAttemptedStep(null);
      setStep(targetStep);
    } catch {
      // The persistent state and inline error explain the failure.
    }
  }

  async function finish(targetDraft = draft) {
    if (finishing || ["checking", "restoring", "restore_failed"].includes(resumeState)) {
      return;
    }
    if (
      !createIntent &&
      !characterProjectProductionReadyDraftSchema.safeParse(targetDraft).success
    ) {
      const errors = characterCreateStepFieldErrors(targetDraft, 2);
      const targetStep = Object.keys(errors).some((field) => Object.hasOwn(characterProjectDraftSchema.shape.persona.shape, field)) ? 0 : 1;
      setStep(targetStep);
      setValidationAttemptedStep(targetStep);
      window.setTimeout(() => wizardRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setFinishing(true);
    try {
      await persist(targetDraft, true);
      const destination = authorityRef.current?.deepLink;
      if (destination) {
        clearLocalDraft(actorId);
        router.push(destination);
      } else {
        setFinishing(false);
      }
    } catch {
      setFinishing(false);
      // Keep the fields and the saved request available for recovery.
    }
  }

  const update = <K extends keyof Draft>(
    section: K,
    updateSection: (current: Draft[K]) => Draft[K],
  ) => {
    userEditedRef.current = true;
    setDraft((current) => ({ ...current, [section]: updateSection(current[section]) }));
    setSaveState("Not saved");
    setQuickSaveMissing(null);
  };
  const applySuggestion = (suggestion: CharacterDraftSuggestion) => {
    const result = fillEmptyDraftFields(latestDraftRef.current, suggestion);
    latestDraftRef.current = result.draft;
    userEditedRef.current = true;
    setDraft(result.draft);
    setSaveState("Not saved");
    return result;
  };
  // A template is only a starting point: drop it from the URL once it has been read.
  const consumeTemplateRequest = () => {
    setTemplateRequest(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("template");
    window.history.replaceState(null, "", url.searchParams.size ? `${url.pathname}?${url.searchParams.toString()}` : url.pathname);
  };
  // SPEC: 第 1 步的「保存私有草稿」始终在场。点下时人设齐了就用共享默认值补齐视觉字段；
  //       补齐后仍缺的（通常是固定特征）就地说清楚，而不是让按钮时有时无。
  // INTENT: 固定特征仍放在第 2 步——它是外貌的一部分，和「一句话外貌」「画面氛围」一起填才说得清；
  //         挪进人设步只会让第 1 步混进视觉字段。运营要的是可预判，按钮常驻 + 点击即知缺什么就够了。
  const quickSave = () => {
    if (!isCharacterCreateStepComplete(draft, 0)) {
      setQuickSaveMissing(null);
      setValidationAttemptedStep(0);
      window.setTimeout(() => wizardRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    // A server draft's fields are the operator's own; only a brand-new draft gets defaults.
    const target = authority ? draft : withVisualDirectionDefaults(draft);
    const missing = Object.entries(characterCreateStepFieldErrors(target, 2))
      .filter(([field]) => Object.hasOwn(target.visualDirection, field))
      .map(([, message]) => message);
    if (missing.length > 0) {
      setQuickSaveMissing(missing);
      return;
    }
    setQuickSaveMissing(null);
    if (target !== draft) {
      userEditedRef.current = true;
      setDraft(target);
    }
    void finish(target);
  };
  const currentLabel = steps[step];
  const fieldErrors =
    validationAttemptedStep === step
      ? Object.fromEntries(Object.entries(characterCreateStepFieldErrors(draft, 2))
        .filter(([field]) => Object.hasOwn(step === 0 ? draft.persona : draft.visualDirection, field)))
      : {};
  const currentStepComplete = isCharacterCreateStepComplete(draft, step) && Object.keys(fieldErrors).length === 0;
  const navigationLocked =
    finishing ||
    saveState === "Saving" ||
    ["checking", "restoring", "restore_failed"].includes(resumeState);
  const draftNotResumable = error instanceof AdminV2RequestError &&
    error.status === 409 && isRecord(error.details) &&
    error.details.reason === "draft_not_resumable";

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
    setRequestedCharacterId(null);
    lastSavedKeyRef.current = null;
    setLastSavedKey(null);
    userEditedRef.current = false;
    const pendingIntent = readActiveDurableMutationIntent({
      scope: createScope,
    });
    setAuthority(null);
    setCreateIntent(pendingIntent);
    setDraft(draftFromCreateIntent(pendingIntent) ?? initialDraft);
    setSelectedTagIds(tagIdsFromCreateIntent(pendingIntent));
    setQuickSaveMissing(null);
    if (!pendingIntent) clearLocalDraft(actorId);
    setStep(0);
    setValidationAttemptedStep(null);
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
    <section
      className="mx-auto max-w-4xl"
      data-testid="character-create-wizard"
      ref={wizardRef}
    >
      {guard}
      {discardLocalDraftOpen ? <ConfirmDialog onClose={() => setDiscardLocalDraftOpen(false)} spec={{
        title: t("Discard draft?"), requireReason: false, submitLabel: t("Discard draft"),
        onSubmit: async () => { startNewCharacter(); setDiscardLocalDraftOpen(false); },
      }} /> : null}
      <Link className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium underline underline-offset-4" href="/admin/characters">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" /> {t("Back to characters")}
      </Link>
      <header className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
          {t("Character Studio ·")}{" "}
          {authority ? t("Private server draft") : t("Private draft setup")}
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold">{t("Create Character")}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
              {authority
                ? t(
                    "Changes to this private draft autosave. Nothing goes live until a Release is published.",
                  )
                : t(
                    "Define the Character and their appearance, then save a private draft.",
                  )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SaveIndicator state={authority && saveState === "Saved" && draftKey(draft) !== lastSavedKey ? "Not saved" : saveState} />
            {canCreate && !authority && !createIntent && draftKey(draft) !== draftKey(initialDraft) ? (
              <WorkspaceButton disabled={navigationLocked} onClick={() => setDiscardLocalDraftOpen(true)}>{t("Discard draft")}</WorkspaceButton>
            ) : null}
          </div>
        </div>
        <ol
          className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2"
          aria-label={t("Character creation progress")}
        >
          {steps.map((label, index) => (
            <li
              key={label}
            >
              <button
                aria-current={index === step ? "step" : undefined}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)] disabled:opacity-50",
                  index === step ? "border-[var(--ad-ink)] font-semibold" : "border-[var(--ad-border)] text-[var(--ad-text-muted)] enabled:hover:bg-black/[0.03]",
                )}
                disabled={navigationLocked || Boolean(createIntent)}
                onClick={() => void goToStep(index)}
                type="button"
              >
                <span className="tabular-nums">{index + 1}.</span>
                {t(label)}
                {isCharacterCreateStepComplete(draft, index) ? <Check aria-hidden="true" className="ml-auto h-4 w-4" /> : null}
              </button>
            </li>
          ))}
        </ol>
      </header>

      <div className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-6">
        <h2 className="text-lg font-semibold focus:outline-none" id="character-create-current-step" tabIndex={-1}>{t(currentLabel)}</h2>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
          {authority
            ? t("Private server draft · version {version}", {
                version: authority.projectVersion,
              })
            : t("This draft stays on this browser until you save the character.")}
        </p>
        <fieldset
          className="mt-5"
          disabled={
            ["checking", "restoring"].includes(resumeState) ||
            finishing ||
            Boolean(createIntent)
          }
        >
          {step === 0 && canCreate && !authority && !createIntent && resumeState === "new" ? (
            <CharacterCreatePrefill
              gender={draft.persona.gender}
              initialTemplateId={templateRequest}
              onApply={applySuggestion}
              onInitialTemplateConsumed={consumeTemplateRequest}
              style={draft.visualDirection.style}
            />
          ) : null}
          {step === 0 ? (
            <PersonaStep draft={draft} errors={fieldErrors} update={update} />
          ) : null}
          {step === 1 ? (
            <div className="space-y-4">
              <VisualStep draft={draft} errors={fieldErrors} update={update} />
              <details className="rounded-lg border border-[var(--ad-border)] p-3">
                <summary className="cursor-pointer text-sm font-semibold">{t("Review draft")}</summary>
                <p className="mt-2 text-sm font-semibold">{draft.persona.name}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">{draft.persona.characterPromise}</p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm">{draft.persona.firstMessage}</p>
                <details className="mt-3" data-testid="character-create-soul-preview">
                  <summary className="cursor-pointer text-xs font-semibold">{t("SOUL.md · exact Agent prompt")}</summary>
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-6">
                    {renderCharacterSoulMarkdown(draft.persona)}
                  </pre>
                </details>
              </details>
              {/* SPEC: 标签只随首次创建原子写入。恢复的服务端草稿已是存在的角色，标签整组替换写入且这里
                  没有预载现有标签，在此补写会覆盖原有标签；已存在角色的标签统一在「人设 → 目录设置」管理。 */}
              {canTag && !authority ? <CharacterCreateTagPicker onChange={setSelectedTagIds} selected={selectedTagIds} /> : null}
              {canTag && authority ? (
                <p className="text-xs text-[var(--ad-text-muted)]" data-testid="character-create-tags-elsewhere">
                  {t("This draft already exists. Manage its tags on the Persona tab after saving.")}
                </p>
              ) : null}
            </div>
          ) : null}
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
            : validationAttemptedStep === step
              ? t("Correct the highlighted fields to continue.")
              : t(stepRequirements[step])}
        </p>
        {error ? (
          <div
            className="mt-4 rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
            role="alert"
          >
            <CharacterCreateError error={error} draftNotResumable={draftNotResumable} />
          </div>
        ) : null}
        {/* INTENT: 409 后本页持有的 projectVersion 已过期，之后每次 autosave 都会再撞 409；
            唯一出路是取回服务端最新版本，所以把恢复入口放在冲突旁边，而不是让运营刷新整页。 */}
        {authority && saveState === "Conflict" ? (
          <div className="mt-4 rounded-lg border border-[var(--ad-border)] p-3">
            <p className="text-sm font-semibold">
              {t("This draft was updated elsewhere.")}
            </p>
            <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
              {t("Autosave cannot succeed until you reload the latest version. Reloading replaces the unsaved changes on this page.")}
            </p>
            <div className="mt-3">
              <WorkspaceButton onClick={() => void restoreDraft(authority.characterId)}>
                {t("Reload draft")}
              </WorkspaceButton>
            </div>
          </div>
        ) : null}
        {recoveryNotice ? (
          <p
            className="mt-4 rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
            role="status"
          >
            {recoveryNotice}
          </p>
        ) : null}
        {resumeState === "restore_failed" ? (
          <div className="mt-4 rounded-lg border border-[var(--ad-border)] p-3">
            <p className="text-sm font-semibold">
              {t("The requested server draft was not restored.")}
            </p>
            <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
              {t(
                "Navigation is locked so this page cannot silently create a second Character.",
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {draftNotResumable && requestedCharacterId ? (
                <Link className="inline-flex min-h-11 items-center rounded-md border border-[var(--ad-border)] px-3 text-sm font-medium underline underline-offset-4" href={`/admin/characters/${encodeURIComponent(requestedCharacterId)}?tab=soul`}>
                  {t("Open character settings")}
                </Link>
              ) : <WorkspaceButton
                onClick={() => {
                  const target = resumeTargetRef.current;
                  if (typeof target === "string") void restoreDraft(target);
                }}
              >
                {t("Retry restore")}
              </WorkspaceButton>}
              {canCreate ? !confirmStartNew ? (
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
              ) : null}
            </div>
          </div>
        ) : null}
        {createIntent ? (
          <p
            className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"
            role="status"
          >
            {createIntent.status === "reconciliation_required" ||
            !characterProjectCreateRequestSchema.safeParse(
              createIntent.requestSnapshot,
            ).success
              ? t(
                  "This saved request is aged or no longer matches the active contract. Reconcile its server receipt before editing or creating another Character.",
                )
              : t(
                  "A Character creation request is unresolved. Resume it to reuse the same request key; form fields remain locked until the authority responds.",
                )}
          </p>
        ) : null}
      </div>
        <footer className="sticky bottom-0 z-10 mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 sm:p-4">
          <p className="mb-3 text-xs text-[var(--ad-text-muted)]">
            {t(authority ? "Saved changes stay private until you publish the character." : "Save a private draft and continue to the portrait.")}
          </p>
          {step === 0 && quickSaveMissing ? (
            <div
              className="mb-3 rounded-md bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"
              data-testid="character-create-quick-save-missing"
              id="character-create-quick-save-missing"
              role="alert"
            >
              <p className="font-semibold">{t("Before saving, the visual direction still needs:")}</p>
              <ul className="mt-1 list-disc pl-5">
                {quickSaveMissing.map((message) => <li key={message}>{t(message)}</li>)}
              </ul>
              <button
                className="mt-2 min-h-11 font-medium underline underline-offset-4"
                onClick={() => void goToStep(1)}
                type="button"
              >
                {t("Add it in visual direction")}
              </button>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
          <WorkspaceButton
            disabled={step === 0 || navigationLocked}
            onClick={() => {
              void goToStep(Math.max(0, step - 1));
            }}
          >
            <ArrowLeft className="h-4 w-4" /> {t("Back")}
          </WorkspaceButton>
          {step < steps.length - 1 ? (
            <div className="flex flex-wrap items-center gap-2">
              {step === 0 && !createIntent ? (
                <WorkspaceButton
                  aria-describedby={quickSaveMissing ? "character-create-quick-save-missing" : undefined}
                  disabled={navigationLocked}
                  onClick={quickSave}
                >
                  <Check className="h-4 w-4" /> {t("Save private draft")}
                </WorkspaceButton>
              ) : null}
              <WorkspaceButton
                aria-describedby="character-create-step-requirements"
                disabled={navigationLocked}
                onClick={() => void goToStep(1)}
                tone="primary"
              >
                {createIntent
                  ? createIntent.status === "reconciliation_required" ||
                    !characterProjectCreateRequestSchema.safeParse(
                      createIntent.requestSnapshot,
                    ).success
                    ? t("Reconcile saved request")
                    : t("Resume Character creation")
                  : t("Continue to visual direction")}{" "}
                <ArrowRight className="h-4 w-4" />
              </WorkspaceButton>
            </div>
          ) : (
            <WorkspaceButton
              aria-describedby="character-create-step-requirements"
              disabled={navigationLocked}
              onClick={() => void finish()}
              tone="primary"
            >
              <Check className="h-4 w-4" /> {t(createIntent
                ? createIntent.status === "reconciliation_required" ||
                  !characterProjectCreateRequestSchema.safeParse(createIntent.requestSnapshot).success
                  ? "Reconcile saved request"
                  : "Resume Character creation"
                : "Save private draft")}
            </WorkspaceButton>
          )}
          </div>
        </footer>
    </section>
  );
}
