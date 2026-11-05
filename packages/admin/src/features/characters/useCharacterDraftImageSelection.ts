"use client";

// SPEC: 草稿图片选择（PATCH draft-image 与首张身份 bootstrap）的持久意图协议只有这一份：
//       写入前保存 intent/key；未知结果用原 key 恢复；精确投影读回一致才解锁（运营手册 §失败与恢复）。
// INTENT: Studio、槽位选择器和图片库都要改同一个草稿。此前槽位选择器是 CAS 直写，刷新后
//         丢失结果未知的那次写入。协议在这里统一；Character command journal 是另一种协议，不合并（ADR-13）。
import type { CharacterImageSourceAsset, CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
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
import {
  characterAssetDraftSelectionRequestKey,
  characterAssetSelectionIntentCommandType,
  characterAssetSelectionIntentSnapshot,
  characterAssetSelectionRecoveryVerification,
  isCharacterAssetPurpose,
  type CharacterAssetProjectMutation,
  type CharacterAssetPurpose,
} from "./character-asset-studio-authority";

export type DraftImageSelectionFeedback = {
  readonly error: (message: string | null, cause?: unknown) => void;
  readonly message?: (message: string) => void;
  readonly warning?: (message: string | null) => void;
  readonly busy?: (busy: boolean) => void;
};

type Submission<T> = {
  readonly signature: string;
  readonly snapshot: unknown;
  readonly action: string;
  /** Sends the write with the intent's key; `committedTargetId` becomes the receipt. */
  readonly request: (intent: DurableMutationIntent) => Promise<{ readonly result: T; readonly committedTargetId: string; readonly message?: string }>;
  readonly afterRefresh?: () => void;
};

// Every surface on the page shares one intent, so a write started from the library
// locks the Studio and the placement chooser without waiting for a reload.
const subscribers = new Map<string, Set<(intent: DurableMutationIntent | null) => void>>();

function isDefinitiveRejection(cause: unknown): cause is AdminV2RequestError {
  return cause instanceof AdminV2RequestError && cause.outcome === "answered" &&
    [400, 401, 403, 404, 409, 422].includes(cause.status);
}

export function draftImageSelectionFrozen(data: CharacterWorkspaceDetail) {
  // INVARIANT: same freeze the server enforces (candidate-release-guard); predicting it
  // here keeps operators from picking an image only to be refused.
  return data.journey.release.candidateReleaseId !== null ||
    data.releases.some(({ release }) => release.status === "approved");
}

export function useCharacterDraftImageSelection({
  actorId,
  data,
  canWrite,
  commitProjectMutation,
  reloadProject,
  feedback,
}: {
  actorId: string;
  data: CharacterWorkspaceDetail;
  canWrite: boolean;
  commitProjectMutation: CharacterAssetProjectMutation;
  /** Reads every projection the surface shows, so verification sees the same authority. */
  reloadProject?: () => Promise<void>;
  feedback: DraftImageSelectionFeedback;
}) {
  const { t, value } = useAdminI18n();
  const scope = `character-asset:selection:${actorId}:${data.character.id}`;
  const [intent, setIntentState] = useState<DurableMutationIntent | null>(() =>
    readActiveDurableMutationIntent({ scope }));
  const feedbackRef = useRef(feedback);
  const reloadRef = useRef(reloadProject);
  useEffect(() => {
    feedbackRef.current = feedback;
    reloadRef.current = reloadProject;
  });

  useEffect(() => {
    const listeners = subscribers.get(scope) ?? new Set();
    subscribers.set(scope, listeners);
    listeners.add(setIntentState);
    return () => {
      listeners.delete(setIntentState);
      if (listeners.size === 0) subscribers.delete(scope);
    };
  }, [scope]);

  const setIntent = useCallback((next: DurableMutationIntent | null) => {
    setIntentState(next);
    for (const listener of subscribers.get(scope) ?? []) listener(next);
  }, [scope]);

  const snapshot = intent ? characterAssetSelectionIntentSnapshot(intent.requestSnapshot) : null;
  const recoveryVerification = intent ? characterAssetSelectionRecoveryVerification(intent.requestSnapshot) : null;
  const needsReconciliation = Boolean(intent && (
    intent.status === "reconciliation_required" || (!snapshot && !recoveryVerification)
  ));

  useEffect(() => {
    if (!intent || intent.status !== "committed_projection_pending") return;
    if (!snapshot && !recoveryVerification) return;
    const projected = recoveryVerification
      ? recoveryVerification.characterId === data.character.id &&
        (recoveryVerification.kind === "character_identity_bootstrap"
          ? data.visual.activeReferenceSet?.id === recoveryVerification.referenceSetRevisionId &&
            data.visual.activeReferenceSet.references.some(
              (reference) => reference.mediaAssetId === recoveryVerification.anchorAssetId,
            ) &&
            data.project.draftImageAssetId === recoveryVerification.draftImageAssetId &&
            data.project.draftAssetPack.character_cover === recoveryVerification.draftImageAssetId &&
            data.visual.activeIdentity !== null
          : isCharacterAssetPurpose(recoveryVerification.selectedPurpose) &&
            data.project.draftAssetPack[recoveryVerification.selectedPurpose] === recoveryVerification.selectedAssetId &&
            data.project.draftAssetSelections?.[recoveryVerification.selectedPurpose]?.assetId === recoveryVerification.selectedAssetId)
      : snapshot
        ? snapshot.kind === "bootstrap"
          ? data.visual.activeReferenceSet?.id === intent.committedTargetId &&
            data.project.draftAssetPack.character_cover === snapshot.body.assetId &&
            data.visual.activeIdentity !== null
          : (() => {
              const selection = data.project.draftAssetSelections?.[snapshot.body.purpose];
              return (
                data.project.draftAssetPack[snapshot.body.purpose] === snapshot.body.assetId &&
                (selection?.runId ?? null) === (snapshot.body.runId ?? null) &&
                (selection?.itemId ?? null) === (snapshot.body.itemId ?? null) &&
                (selection?.reviewDecisionId ?? null) === (snapshot.body.reviewDecisionId ?? null)
              );
            })()
        : false;
    if (!projected) return;
    const timer = window.setTimeout(() => {
      clearDurableMutationIntent(intent);
      setIntent(null);
      feedbackRef.current.warning?.(null);
      feedbackRef.current.message?.(
        recoveryVerification?.kind === "character_identity_bootstrap" || snapshot?.kind === "bootstrap"
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
    data.visual.activeReferenceSet,
    intent,
    recoveryVerification,
    setIntent,
    snapshot,
  ]);

  const resume = useCallback(async () => {
    const report = feedbackRef.current;
    if (!canWrite || !intent) return;
    const reload = () => reloadRef.current?.() ?? Promise.resolve();
    if (intent.status === "reconciliation_required" || (!snapshot && !recoveryVerification)) {
      report.busy?.(true);
      report.error(null);
      try {
        let commandType = characterAssetSelectionIntentCommandType(intent);
        let receipt: Awaited<ReturnType<typeof reconcileDurableMutationIntent>>;
        try {
          receipt = await reconcileDurableMutationIntent({ intent, commandType, expectedCharacterId: data.character.id });
        } catch (cause) {
          const details = cause instanceof AdminV2RequestError && cause.status === 409 &&
            cause.details && typeof cause.details === "object" && !Array.isArray(cause.details)
            ? (cause.details as Record<string, unknown>)
            : null;
          const existingCommandType = details?.existingCommandType;
          if (existingCommandType !== "character.identity.bootstrap" && existingCommandType !== "character.project.draft_image.select") {
            throw cause;
          }
          commandType = existingCommandType;
          receipt = await reconcileDurableMutationIntent({ intent, commandType, expectedCharacterId: data.character.id });
        }
        if (receipt.state === "committed") {
          const verification = receipt.verification;
          const matchesBootstrap = commandType === "character.identity.bootstrap" &&
            verification?.kind === "character_identity_bootstrap" &&
            verification.characterId === data.character.id &&
            verification.referenceSetRevisionId === receipt.committedTargetId;
          const matchesDraftSelection = commandType === "character.project.draft_image.select" &&
            verification?.kind === "character_draft_image_selection" &&
            verification.characterId === data.character.id &&
            verification.selectedAssetId === receipt.committedTargetId;
          if (!receipt.committedTargetId || (!matchesBootstrap && !matchesDraftSelection)) {
            throw new Error("The committed selection receipt is missing exact Character projection evidence. The workspace remains locked.");
          }
          setIntent(updateDurableMutationIntent(intent, {
            status: "committed_projection_pending",
            committedTargetId: receipt.committedTargetId,
            requestSnapshot: verification,
          }));
          await reload();
          report.message?.("The committed selection receipt was recovered. It remains locked until the exact Character authority is visible.");
          return;
        }
        if (receipt.state === "cancelled") {
          clearDurableMutationIntent(intent);
          setIntent(null);
          report.message?.("The old selection request had no committed effect. Its key was sealed, so a new selection is safe.");
          return;
        }
        report.error(receipt.state === "failed"
          ? t("The saved selection command {commandId} is terminally failed. Its key remains locked for operator investigation; do not submit a replacement selection.", { commandId: receipt.commandId ?? "—" })
          : t("The saved selection request is {state}. Keep this workspace locked and reconcile again after the server reaches a terminal receipt.", { state: value(receipt.state) }));
      } catch (cause) {
        report.error(cause instanceof Error ? cause.message : "The saved selection request could not be reconciled.", cause);
      } finally {
        report.busy?.(false);
      }
      return;
    }
    if (!snapshot) {
      report.busy?.(true);
      report.error(null);
      try {
        await reload();
      } catch (cause) {
        report.warning?.(cause instanceof Error
          ? t("Selection authority is still refreshing: {detail}", { detail: t(cause.message) })
          : "Selection authority is still refreshing.");
      } finally {
        report.busy?.(false);
      }
      return;
    }
    report.busy?.(true);
    report.error(null);
    let currentIntent = intent;
    try {
      if (currentIntent.status === "committed_projection_pending") {
        await reload();
        return;
      }
      await commitProjectMutation({
        action: snapshot.kind === "bootstrap" ? "Identity bootstrap recovery" : "Draft asset selection recovery",
        commit: async () => {
          if (snapshot.kind === "bootstrap") {
            const result = await adminV2Operation("POST /api/v2/admin/characters/:id/identity-bootstrap", {
              path: { id: data.character.id },
              replayIdempotencyKey: currentIntent.idempotencyKey,
              ifMatch: snapshot.body.entityVersion,
              body: snapshot.body,
            });
            currentIntent = updateDurableMutationIntent(currentIntent, {
              status: "committed_projection_pending",
              committedTargetId: result.referenceSetRevisionId,
            });
            setIntent(currentIntent);
            return result;
          }
          const result = await adminV2Operation("PATCH /api/v2/admin/characters/:id/draft-image", {
            path: { id: data.character.id },
            replayIdempotencyKey: currentIntent.idempotencyKey,
            ifMatch: snapshot.body.entityVersion,
            body: snapshot.body,
          });
          currentIntent = updateDurableMutationIntent(currentIntent, {
            status: "committed_projection_pending",
            committedTargetId: result.selectedAssetId,
          });
          setIntent(currentIntent);
          return result;
        },
      });
    } catch (cause) {
      if (currentIntent.status === "committed_projection_pending") {
        report.warning?.(cause instanceof Error
          ? t("Selection was committed, but authority verification is still pending: {detail}", { detail: t(cause.message) })
          : "Selection was committed, but authority verification is still pending.");
      } else if (isDefinitiveRejection(cause)) {
        // A refused replay proves nothing about the earlier attempt: the saved key is
        // the only recovery receipt, and only the server can recover or seal it.
        setIntent(updateDurableMutationIntent(currentIntent, { status: "reconciliation_required" }));
        report.error(cause.message, cause);
      } else {
        setIntent(updateDurableMutationIntent(currentIntent, { status: "outcome_unknown" }));
        report.error("Selection outcome remains unknown. Resume will continue to reuse the same request key.", cause);
      }
    } finally {
      report.busy?.(false);
    }
  }, [canWrite, commitProjectMutation, data.character.id, intent, recoveryVerification, setIntent, snapshot, t, value]);

  async function submit<T>(submission: Submission<T>) {
    const report = feedbackRef.current;
    const claim = await claimDurableMutationIntent({
      scope,
      signature: submission.signature,
      requestSnapshot: submission.snapshot,
    });
    const claimed = claim.intent;
    if (
      claimed.signature !== submission.signature ||
      ["committed_projection_pending", "reconciliation_required"].includes(claimed.status)
    ) {
      setIntent(claimed);
      report.error(
        claimed.status === "committed_projection_pending"
          ? "Another tab already committed an asset selection receipt. Verify it before selecting again."
          : claimed.status === "reconciliation_required"
            ? "Another tab has an aged asset-selection receipt. Reconcile it with the server before selecting again."
            : "Another tab already started a different asset selection. Resume its exact locked request first.",
      );
      return;
    }
    setIntent(claimed);
    report.busy?.(true);
    report.error(null);
    try {
      await commitProjectMutation({
        action: submission.action,
        commit: async () => {
          const committed = await submission.request(claimed);
          setIntent(updateDurableMutationIntent(claimed, {
            status: "committed_projection_pending",
            committedTargetId: committed.committedTargetId,
          }));
          if (committed.message) report.message?.(committed.message);
          return committed.result;
        },
        afterRefresh: () => {
          report.warning?.(null);
          submission.afterRefresh?.();
        },
      });
    } catch (cause) {
      if (isDefinitiveRejection(cause)) {
        // INVARIANT: only a newly claimed intent can be released by a rejection. An
        // existing claim means another attempt already used this key.
        if (claim.created) {
          clearDurableMutationIntent(claimed);
          setIntent(null);
        } else {
          setIntent(updateDurableMutationIntent(claimed, { status: "reconciliation_required" }));
        }
        report.error(cause.message, cause);
      } else {
        setIntent(updateDurableMutationIntent(claimed, { status: "outcome_unknown" }));
        report.error("Selection outcome is unknown. Repeat the same selection to resume it with the same idempotency key.", cause);
      }
    } finally {
      report.busy?.(false);
    }
  }

  // SPEC: 把图片库里已有的一张图放进一个产品槽位，只更新带版本的草稿（ADR-16 §3.2）。
  async function selectLibraryAsset(
    purpose: CharacterAssetPurpose,
    asset: CharacterImageSourceAsset,
    afterRefresh?: () => void,
  ) {
    const authority = asset.qualification?.authority;
    const body = {
      entityVersion: data.project.version,
      purpose,
      assetId: asset.id,
      ...(authority?.runId ? { runId: authority.runId } : {}),
      ...(authority?.itemId ? { itemId: authority.itemId } : {}),
      ...(authority?.reviewDecisionId ? { reviewDecisionId: authority.reviewDecisionId } : {}),
      reason: `Selected from ${data.character.name}'s image library`,
    };
    await submit({
      signature: characterAssetDraftSelectionRequestKey({ characterId: data.character.id, body }),
      snapshot: { kind: "draft_selection" as const, body },
      action: `${purpose} image selection`,
      request: async (claimed) => {
        const result = await adminV2Operation("PATCH /api/v2/admin/characters/:id/draft-image", {
          path: { id: data.character.id },
          replayIdempotencyKey: claimed.idempotencyKey,
          ifMatch: data.project.version,
          body,
        });
        return { result, committedTargetId: result.selectedAssetId };
      },
      afterRefresh,
    });
  }

  return { intent, needsReconciliation, resume, submit, selectLibraryAsset };
}
