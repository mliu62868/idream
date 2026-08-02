"use client";

import {
  CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
  adminMutationRecoveryVerificationSchema,
  characterDraftImageSelectionRequestSchema,
  characterDraftImageSelectionResultSchema,
  characterIdentityBootstrapRequestSchema,
  characterIdentityBootstrapResponseSchema,
  characterImageReadinessRepairResponseSchema,
  creativeReviewDecisionRequestSchema,
  creativeReviewDecisionResultSchema,
  creativeRunCreateRequestSchema,
  creativeRunCreateResultSchema,
  creativeRunDetailSchema,
  creativeRunListResponseSchema,
  type CharacterWorkspaceDetail,
  type CreativeRun,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import {
  Check,
  ImageIcon,
  Loader2,
  Pin,
  RefreshCcw,
  ShieldAlert,
  Sparkles,
  ThumbsDown,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import {
  AdminV2RequestError,
  adminV2Request,
} from "@/lib/admin-v2-api";
import {
  claimDurableMutationIntent,
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  updateDurableMutationIntent,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";
import { reconcileDurableMutationIntent } from "@/lib/durable-mutation-recovery";
import { createLatestRequestGate } from "@/lib/latest-request";
import { cn } from "@/lib/utils";
import { characterIdentityBootstrapMutation } from "@/features/image-workflow-transport";
import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";

export const characterAssetPurposes = ["character_cover", "character_hero", "character_chat"] as const;
export type CharacterAssetPurpose = typeof characterAssetPurposes[number];
export const characterAssetStudioLayoutClass =
  "grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]";

export type CharacterSourceVariationBlocker =
  | "no_qualified_route"
  | "profile_init_image_unsupported"
  | "workflow_source_image_unsupported"
  | "workflow_source_identity_combination_unsupported"
  | "reference_capacity_insufficient"
  | "reference_slot_assignment_unsupported";

export function characterSourceVariationBlockerMessage(
  blocker: CharacterSourceVariationBlocker,
) {
  if (blocker === "profile_init_image_unsupported") {
    return "More like this is unavailable because the active model profile cannot use the selected image as an init image.";
  }
  if (blocker === "workflow_source_image_unsupported") {
    return "More like this is unavailable because the active workflow does not accept a source image.";
  }
  if (blocker === "workflow_source_identity_combination_unsupported") {
    return "More like this is unavailable because the active workflow cannot combine a source image with the canonical identity references.";
  }
  if (blocker === "reference_capacity_insufficient") {
    return "More like this is unavailable because the active workflow has no remaining reference capacity after the canonical identity references.";
  }
  if (blocker === "reference_slot_assignment_unsupported") {
    return "More like this is unavailable because the active workflow cannot map the canonical identity and source image into distinct semantic slots.";
  }
  return "More like this needs a compatible active Character identity route.";
}

export function canOfferCharacterAssetTerminalRejection(input: {
  readonly lifecycleState: string;
  readonly decision: string | null;
  readonly hasCompleteEvidence: boolean;
  readonly isDraftAuthority: boolean;
}) {
  return ["active", "closed"].includes(input.lifecycleState) &&
    input.decision === "approved" &&
    input.hasCompleteEvidence &&
    !input.isDraftAuthority;
}

type CharacterAssetProjectMutation = <T>(input: {
  readonly action: string;
  readonly commit: () => Promise<T>;
  readonly afterRefresh?: () => void;
}) => Promise<{ readonly result: T; readonly refreshed: boolean }>;

const purposeConfig: Record<CharacterAssetPurpose, {
  label: string;
  shortLabel: string;
  pluralLabel: string;
  description: string;
  count: number;
  orientation: "4:5" | "16:9";
}> = {
  character_cover: {
    label: "Primary portrait",
    shortLabel: "Portrait",
    pluralLabel: "portrait",
    description: "The face customers recognize across discovery and the character profile.",
    count: 1,
    orientation: "4:5",
  },
  character_hero: {
    label: "Character hero",
    shortLabel: "Hero",
    pluralLabel: "hero image",
    description: "A wider, expressive scene for the top of the character experience.",
    count: 1,
    orientation: "16:9",
  },
  character_chat: {
    label: "Chat moments",
    shortLabel: "Chat",
    pluralLabel: "chat image",
    description: "Natural, conversational moments for the relationship experience.",
    count: 1,
    orientation: "4:5",
  },
};

// SPEC: 用途名对外只有这一份权威，工作台概览列缺失项时必须复用，别再写第二套映射。
export function characterAssetPurposeLabel(purpose: string) {
  return purposeConfig[purpose as CharacterAssetPurpose]?.label ?? purpose;
}

const reviewQualityChecks = [
  ["artifactFree", "No visible artifacts"],
  ["singleSubject", "Exactly one intended subject"],
  ["intentMatch", "Composition matches the customer intent"],
  ["noVisibleText", "No visible text, watermark, or contact sheet"],
] as const;

export type ReviewQuality = Record<(typeof reviewQualityChecks)[number][0], boolean>;
type ReviewDraft = {
  reason: string;
  score: string;
  identity: "passed" | "failed" | "unscored";
  quality: ReviewQuality;
};

export function resolveCharacterAssetReviewEvidence(input: {
  readonly decision: "approved" | "rejected";
  readonly draft: {
    readonly identityConsistency: "passed" | "failed" | "unscored";
    readonly score?: number;
    readonly quality: Readonly<ReviewQuality>;
  };
  readonly previous?: {
    readonly decision: "approved" | "rejected";
    readonly identityConsistency: "passed" | "failed" | "unscored";
    readonly score: number | null;
    readonly quality: Readonly<ReviewQuality> | null;
  } | null;
}) {
  const preserveApprovedEvidence =
    input.decision === "rejected" &&
    input.previous?.decision === "approved" &&
    input.previous.quality !== null;
  return {
    identityConsistency: preserveApprovedEvidence
      ? input.previous.identityConsistency
      : input.draft.identityConsistency,
    score: preserveApprovedEvidence
      ? input.previous.score ?? undefined
      : input.draft.score,
    quality: preserveApprovedEvidence
      ? input.previous.quality
      : input.draft.quality,
  };
}

function emptyReviewDraft(bootstrapMode: boolean): ReviewDraft {
  return {
    reason: "",
    score: "",
    identity: bootstrapMode ? "unscored" : "passed",
    quality: {
      artifactFree: false,
      singleSubject: false,
      intentMatch: false,
      noVisibleText: false,
    },
  };
}

export function resolveCharacterAssetSubject(input: {
  draftName?: string | null;
  draftDescription?: string | null;
  liveName: string;
  liveDescription: string;
}) {
  return {
    name: input.draftName?.trim() || input.liveName,
    description: input.draftDescription?.trim() || input.liveDescription,
  };
}

export function nextCharacterAssetPurpose(purpose: CharacterAssetPurpose) {
  const index = characterAssetPurposes.indexOf(purpose);
  return characterAssetPurposes[Math.min(index + 1, characterAssetPurposes.length - 1)];
}

export function firstIncompleteCharacterAssetPurpose(
  draftAssetPack: Partial<Record<CharacterAssetPurpose, unknown>>,
  identityExists: boolean,
): CharacterAssetPurpose {
  if (!identityExists) return "character_cover";
  return characterAssetPurposes.find((purpose) => !draftAssetPack[purpose]) ?? "character_chat";
}

export function characterAssetPackUnderCurrentRoute(
  draftAssetPack: Partial<Record<CharacterAssetPurpose, unknown>>,
  selections: Partial<Record<CharacterAssetPurpose, {
    readonly routeCurrent?: boolean;
  }>> | undefined,
) {
  return Object.fromEntries(characterAssetPurposes.flatMap((purpose) =>
    draftAssetPack[purpose] && selections?.[purpose]?.routeCurrent !== false
      ? [[purpose, draftAssetPack[purpose]]]
      : []
  )) as Partial<Record<CharacterAssetPurpose, unknown>>;
}

export function resolveCharacterCustomerPreviewAssets(input: {
  readonly draftAssets: Partial<Record<CharacterAssetPurpose, string | null | undefined>>;
  readonly activePurpose: CharacterAssetPurpose;
  readonly candidateImageUrl: string | null;
}) {
  return Object.fromEntries(characterAssetPurposes.map((purpose) => [
    purpose,
    purpose === input.activePurpose && input.candidateImageUrl
      ? input.candidateImageUrl
      : input.draftAssets[purpose] ?? null,
  ])) as Record<CharacterAssetPurpose, string | null>;
}

export function characterAssetRunRequestKey(input: {
  readonly characterId: string;
  readonly title: string;
  readonly purpose: CharacterAssetPurpose;
  readonly profileId: string;
  readonly referenceAssetIds: readonly string[];
  readonly bootstrapIdentity: boolean;
  readonly orientation: string;
  readonly count: number;
  readonly brief: string;
}) {
  return JSON.stringify({
    characterId: input.characterId,
    title: input.title.trim(),
    purpose: input.purpose,
    profileId: input.profileId,
    referenceAssetIds: [...input.referenceAssetIds],
    bootstrapIdentity: input.bootstrapIdentity,
    orientation: input.orientation,
    count: input.count,
    brief: input.brief.trim(),
  });
}

export function characterAssetReviewRequestKey(input: {
  readonly runId: string;
  readonly itemId: string;
  readonly body: {
    readonly entityVersion: number;
    readonly supersedesDecisionId?: string;
    readonly decision: "approved" | "rejected";
    readonly identityConsistency: "passed" | "failed" | "unscored";
    readonly score?: number;
    readonly quality: Readonly<ReviewQuality>;
    readonly reason: string;
  };
}) {
  return JSON.stringify({
    runId: input.runId,
    itemId: input.itemId,
    body: {
      entityVersion: input.body.entityVersion,
      ...(input.body.supersedesDecisionId !== undefined
        ? { supersedesDecisionId: input.body.supersedesDecisionId }
        : {}),
      decision: input.body.decision,
      identityConsistency: input.body.identityConsistency,
      ...(input.body.score !== undefined ? { score: input.body.score } : {}),
      quality: {
        artifactFree: input.body.quality.artifactFree,
        singleSubject: input.body.quality.singleSubject,
        intentMatch: input.body.quality.intentMatch,
        noVisibleText: input.body.quality.noVisibleText,
      },
      reason: input.body.reason.trim(),
    },
  });
}

export function characterAssetBootstrapRequestKey(input: {
  readonly characterId: string;
  readonly entityVersion: number;
  readonly runId: string;
  readonly itemId: string;
  readonly assetId: string;
  readonly reviewDecisionId: string;
  readonly reason: string;
}) {
  return JSON.stringify({
    characterId: input.characterId,
    entityVersion: input.entityVersion,
    runId: input.runId,
    itemId: input.itemId,
    assetId: input.assetId,
    reviewDecisionId: input.reviewDecisionId,
    reason: input.reason.trim(),
  });
}

export function characterAssetDraftSelectionRequestKey(input: {
  readonly characterId: string;
  readonly body: {
    readonly entityVersion: number;
    readonly purpose: CharacterAssetPurpose;
    readonly runId: string;
    readonly itemId: string;
    readonly assetId: string;
    readonly reviewDecisionId: string;
    readonly reason: string;
  };
}) {
  return JSON.stringify({
    characterId: input.characterId,
    body: {
      entityVersion: input.body.entityVersion,
      purpose: input.body.purpose,
      runId: input.body.runId,
      itemId: input.body.itemId,
      assetId: input.body.assetId,
      reviewDecisionId: input.body.reviewDecisionId,
      reason: input.body.reason.trim(),
    },
  });
}

function characterAssetReviewIntentSnapshot(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.runId !== "string" ||
    typeof snapshot.itemId !== "string"
  ) {
    return null;
  }
  const body = creativeReviewDecisionRequestSchema.safeParse(
    snapshot.body,
  );
  return body.success
    ? {
        runId: snapshot.runId,
        itemId: snapshot.itemId,
        body: body.data,
      }
    : null;
}

function characterAssetSelectionIntentSnapshot(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.kind === "bootstrap") {
    const body = characterIdentityBootstrapRequestSchema.safeParse(
      snapshot.body,
    );
    return body.success
      ? { kind: "bootstrap" as const, body: body.data }
      : null;
  }
  if (snapshot.kind === "draft_selection") {
    const body = characterDraftImageSelectionRequestSchema.safeParse(
      snapshot.body,
    );
    return body.success
      ? { kind: "draft_selection" as const, body: body.data }
      : null;
  }
  return null;
}

function characterAssetSelectionRecoveryVerification(value: unknown) {
  const parsed = adminMutationRecoveryVerificationSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.kind === "character_identity_bootstrap" ||
    parsed.data.kind === "character_draft_image_selection"
    ? parsed.data
    : null;
}

function characterAssetSelectionIntentCommandType(
  intent: DurableMutationIntent,
) {
  if (
    intent.requestSnapshot &&
    typeof intent.requestSnapshot === "object" &&
    !Array.isArray(intent.requestSnapshot)
  ) {
    const kind = (
      intent.requestSnapshot as Record<string, unknown>
    ).kind;
    if (kind === "bootstrap") {
      return "character.identity.bootstrap" as const;
    }
    if (kind === "draft_selection") {
      return "character.project.draft_image.select" as const;
    }
  }
  try {
    const signature = JSON.parse(intent.signature) as unknown;
    if (
      signature &&
      typeof signature === "object" &&
      !Array.isArray(signature) &&
      Object.hasOwn(signature, "body")
    ) {
      return "character.project.draft_image.select" as const;
    }
  } catch {
    // A pre-kind bootstrap signature stored its fields at the top level.
  }
  return "character.identity.bootstrap" as const;
}

export function canChooseCharacterAssetPurpose(
  purpose: CharacterAssetPurpose,
  bootstrapMode: boolean,
  identityCommitted = false,
) {
  return !bootstrapMode || identityCommitted || purpose === "character_cover";
}

function isCharacterAssetPurpose(value: string): value is CharacterAssetPurpose {
  return characterAssetPurposes.includes(value as CharacterAssetPurpose);
}

function committedCharacterRunProjectionMatches(
  intent: DurableMutationIntent,
  detail: CreativeRunDetail,
  characterId: string,
) {
  if (
    intent.status !== "committed_projection_pending" ||
    !intent.committedTargetId ||
    detail.id !== intent.committedTargetId
  ) {
    return false;
  }
  const request = creativeRunCreateRequestSchema.safeParse(
    intent.requestSnapshot,
  );
  return request.success &&
    request.data.targetType === "character" &&
    request.data.targetId === characterId &&
    isCharacterAssetPurpose(request.data.purpose) &&
    detail.purpose === request.data.purpose &&
    detail.target.type === "character" &&
    detail.target.id === characterId;
}

class SupersededAssetProjectionError extends Error {
  constructor() {
    super("A newer Character Asset Studio projection request replaced this one.");
    this.name = "SupersededAssetProjectionError";
  }
}

function isProjectionRequestCancellation(cause: unknown) {
  return cause instanceof SupersededAssetProjectionError ||
    (cause instanceof Error && cause.name === "AbortError");
}

function candidateState(item: CreativeRunDetail["items"][number]) {
  if (item.review?.decision === "approved" && item.review.identityConsistency === "passed") return "Approved identity";
  if (item.review?.decision === "approved" && item.review.identityConsistency === "unscored") return "Approved first identity";
  if (item.review?.decision === "rejected") return "Rejected";
  if (item.asset) return "Ready to decide";
  return {
    dispatching: "Preparing generation",
    provider_queued: "Waiting for generation capacity",
    generating: "Generating image",
    finalizing: "Saving generated image",
    ready: "Ready to decide",
    failed: "Generation failed",
  }[item.executionState];
}

export type CharacterCandidateVisualState =
  | "active"
  | "comparison"
  | "draft"
  | "approved"
  | "rejected"
  | "ready";

export function resolveCharacterCandidateVisualState(input: {
  readonly active: boolean;
  readonly comparison: boolean;
  readonly draft: boolean;
  readonly decision: "approved" | "rejected" | null;
}): CharacterCandidateVisualState {
  if (input.active) return "active";
  if (input.comparison) return "comparison";
  if (input.draft) return "draft";
  if (input.decision === "approved") return "approved";
  if (input.decision === "rejected") return "rejected";
  return "ready";
}

function AssetImage({ alt, className, src }: { alt: string; className: string; src: string | null | undefined }) {
  const { t } = useAdminI18n();
  if (!src) return (
    <div className={cn("grid place-items-center bg-black/[0.04] text-[var(--ad-text-muted)]", className)}>
      <ImageIcon aria-hidden="true" className="h-6 w-6" />
      <span className="sr-only">{t("No image asset is available")}</span>
    </div>
  );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
    <img alt={alt} className={className} src={src} />
  );
}

// 与后端 workspace.ts 的生图闸同口径：密封 hash（*_unsealed）是发布级检查，不拦打磨。
const identityAuthorityBlockerCodes = new Set([
  "visual_identity_missing",
  "visual_anchor_missing",
  "visual_traits_incomplete",
  "reference_set_not_active",
  "reference_assets_unavailable",
]);

const imageReadinessActionByBlocker: Readonly<Record<string, string>> = {
  visual_identity_missing:
    "Attach or create the portrait that defines this character",
  visual_anchor_missing:
    "Attach or create the portrait that defines this character",
  visual_traits_incomplete:
    "Complete the stable visual traits for this character",
  visual_identity_unsealed:
    "Create a current, sealed visual identity version",
  reference_set_not_active:
    "Publish the approved identity references",
  reference_set_unsealed:
    "Publish a current, sealed identity reference set",
  reference_assets_unavailable:
    "Replace unavailable identity reference images",
  generation_route_unqualified:
    "Activate a compatible platform image route",
  generation_route_stale:
    "Refresh the active platform image route",
};

export function characterAssetReadinessAction(blockerCode: string) {
  return imageReadinessActionByBlocker[blockerCode] ??
    "Review the character's visual setup evidence";
}

export function characterAssetReadinessSummary(
  blockerCodes: readonly string[],
) {
  const steps = [...new Set(blockerCodes.map(characterAssetReadinessAction))];
  return {
    title: steps.length > 0
      ? "Finish visual setup before generating"
      : "Image production is ready",
    steps,
  };
}

export function isCharacterIdentityAuthorityReady(input: {
  readonly hasIdentity: boolean;
  readonly blockerCodes: readonly string[];
}) {
  return input.hasIdentity &&
    !input.blockerCodes.some((code) => identityAuthorityBlockerCodes.has(code));
}

export function isCharacterAssetApprovalActionable(input: {
  readonly bootstrapIdentity: boolean;
  readonly decision: string | null;
  readonly identityConsistency: string | null;
  readonly score: number | null;
  readonly quality: {
    readonly artifactFree: boolean;
    readonly singleSubject: boolean;
    readonly intentMatch: boolean;
    readonly noVisibleText: boolean;
  } | null;
}) {
  if (input.decision !== "approved") return false;
  if (
    input.identityConsistency !==
      (input.bootstrapIdentity ? "unscored" : "passed")
  ) return false;
  if (!input.quality || Object.values(input.quality).some((passed) => !passed)) {
    return false;
  }
  return input.bootstrapIdentity ||
    (
      typeof input.score === "number" &&
      input.score >= CHARACTER_IDENTITY_APPROVAL_MIN_SCORE
    );
}

function ImageProductionReadinessCard({
  blockers,
  canRepair,
  descriptionId,
  onContinue,
  onRepair,
  repairing,
}: {
  blockers: CharacterWorkspaceDetail["visual"]["readiness"]["blockers"];
  canRepair: boolean;
  descriptionId: string;
  onContinue: () => void;
  onRepair: () => void;
  repairing: boolean;
}) {
  const { t } = useAdminI18n();
  const summary = characterAssetReadinessSummary(
    blockers.map((blocker) => blocker.code),
  );
  return (
    <section
      className="mt-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
      aria-labelledby={`${descriptionId}-title`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="text-sm font-semibold" id={`${descriptionId}-title`}>
            {t(canRepair
              ? "Enable image production with the current portrait"
              : summary.title)}
          </h4>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]" id={descriptionId}>
            {t(canRepair
              ? "The current live portrait will become the sealed identity reference for future images. Existing live images and releases will not change."
              : summary.steps[0] ?? "Complete the current visual setup before generating an image.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canRepair ? (
            <WorkspaceButton
              aria-describedby={descriptionId}
              disabled={repairing}
              onClick={onRepair}
              tone="primary"
            >
              {repairing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}

              {t("Use existing portrait")}
            </WorkspaceButton>
          ) : (
            <WorkspaceButton
              aria-describedby={descriptionId}
              onClick={onContinue}
            >

              {t("Open visual setup")}
            </WorkspaceButton>
          )}
        </div>
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-semibold text-[var(--ad-text-muted)]">

          {t("Technical diagnostics")}
        </summary>
        <ul className="mt-2 space-y-1">
          {blockers.map((blocker) => (
            <li key={blocker.code}>
              {blocker.code}: {t(blocker.message)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function IdentityRail({
  data,
  onRepair,
}: {
  data: CharacterWorkspaceDetail;
  onRepair: () => void;
}) {
  const { t } = useAdminI18n();
  const identity = data.visual.activeIdentity;
  const identityBootstrap = data.visual.identityBootstrap;
  const bootstrapMode = identityBootstrap.allowed;
  const bootstrapProfile = identityBootstrap.profile;
  const identityEstablished = isCharacterIdentityAuthorityReady({
    hasIdentity: identity !== null,
    blockerCodes: data.visual.readiness.blockers.map((blocker) => blocker.code),
  });
  const referenceAssets = data.visual.activeReferenceSet?.references.length
    ? data.visual.activeReferenceSet.references
    : [...data.visual.anchors, ...data.visual.references];
  const availableReferenceCount = referenceAssets.filter((asset) => asset.available).length;
  const qualifiedRoute = data.visual.routeQualifications.find(
    (route) => route.result === "qualified" && !route.stale,
  );

  return (
    <aside
      aria-labelledby="identity-lock-title"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--ad-border)] pb-3 text-xs text-[var(--ad-text-muted)]"
    >
      <h3 className="sr-only" id="identity-lock-title">{t("Visual identity authority")}</h3>
      <span>{t("Visual identity")} <strong className="font-semibold text-[var(--ad-ink)]">{identity ? `v${identity.version}` : t("Pending")}</strong></span>
      <span aria-hidden="true">·</span>
      <span>{t("References")} <strong className="font-semibold text-[var(--ad-ink)]">{identityEstablished ? availableReferenceCount : t("Pending")}</strong></span>
      <span aria-hidden="true">·</span>
      <span className="max-w-56 truncate"><strong className="font-semibold text-[var(--ad-ink)]">{bootstrapMode ? bootstrapProfile?.label ?? t("Unavailable") : qualifiedRoute?.generationProfileKey ?? t("Unavailable")}</strong></span>
      {!identityEstablished && identity ? (
        <button className="font-semibold text-[var(--ad-ink)] underline" onClick={onRepair} type="button">{t("Repair visual authority")}</button>
      ) : null}
    </aside>
  );
}

function CandidateBatchGrid({
  activeItemId,
  activePurpose,
  comparisonItemId,
  disabled,
  items,
  onActivate,
  onCompare,
  selectedPackAssetId,
  subjectName,
}: {
  activeItemId: string | null;
  activePurpose: CharacterAssetPurpose;
  comparisonItemId: string | null;
  disabled: boolean;
  items: CreativeRunDetail["items"];
  onActivate: (index: number) => void;
  onCompare: (itemId: string) => void;
  selectedPackAssetId: string | null | undefined;
  subjectName: string;
}) {
  const { t } = useAdminI18n();
  const activeItem = items.find((item) => item.id === activeItemId) ?? items[0] ?? null;
  const activeIndex = activeItem
    ? items.findIndex((item) => item.id === activeItem.id)
    : -1;
  const activeIsDraft = Boolean(
    activeItem?.asset?.id && activeItem.asset.id === selectedPackAssetId,
  );
  return (
    <div aria-label={t("Generated candidates")}>
      <div className="overflow-hidden rounded-lg bg-black/[0.04]" style={{ height: "min(500px, 60vh)" }}>
        <AssetImage
          alt={activeItem
            ? t("{name} {purpose} candidate {number}", {
                name: subjectName,
                purpose: t(purposeConfig[activePurpose].label),
                number: activeItem.ordinal + 1,
              })
            : t("No image asset is available")}
          className="h-full w-full object-contain"
          src={activeItem?.asset?.url ?? activeItem?.asset?.thumbnailUrl}
        />
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="list">
        {items.map((item, index) => {
          const active = item.id === activeItem?.id;
          const comparison = item.id === comparisonItemId;
          const draft = Boolean(item.asset?.id && item.asset.id === selectedPackAssetId);
          const visualState = resolveCharacterCandidateVisualState({
            active,
            comparison,
            draft,
            decision: item.review?.decision ?? null,
          });
          return (
            <article
              className="group relative w-24 shrink-0"
              data-candidate-state={visualState}
              key={item.id}
              role="listitem"
            >
              <button
                aria-label={t("View candidate {number}", { number: item.ordinal + 1 })}
                aria-pressed={active}
                className={cn(
                  "block w-full overflow-hidden rounded-md border bg-black/[0.04] p-0.5 transition focus-visible:outline focus-visible:outline-2",
                  active
                    ? "border-[var(--ad-ink)] ring-1 ring-[var(--ad-ink)]"
                    : comparison
                      ? "border-[var(--ad-blue-text)]"
                      : draft
                        ? "border-[var(--ad-green-text)]"
                        : "border-[var(--ad-border)] hover:border-[var(--ad-text-muted)]",
                  item.review?.decision === "rejected" && "opacity-60",
                )}
                disabled={disabled}
                onClick={() => onActivate(index)}
                type="button"
              >
                <AssetImage
                  alt={t("{name} {purpose} candidate {number}", {
                    name: subjectName,
                    purpose: t(purposeConfig[activePurpose].label),
                    number: item.ordinal + 1,
                  })}
                  className="aspect-square w-full rounded-[4px] object-cover"
                  src={item.asset?.thumbnailUrl ?? item.asset?.url}
                />
              </button>
              {!active && item.asset ? (
                <button
                  aria-label={comparison
                    ? t("Remove candidate {number} from comparison", { number: item.ordinal + 1 })
                    : t("Compare candidate {number} with current candidate", { number: item.ordinal + 1 })}
                  aria-pressed={comparison}
                  className="absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md border border-white/70 bg-white/95 opacity-0 transition group-hover:opacity-100 focus:opacity-100 focus-visible:outline focus-visible:outline-2"
                  disabled={disabled}
                  onClick={() => onCompare(item.id)}
                  type="button"
                >
                  {comparison ? <X aria-hidden="true" className="h-3.5 w-3.5" /> : <Pin aria-hidden="true" className="h-3.5 w-3.5" />}
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
      {activeItem ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ad-border)] pt-3 text-xs">
          <p>
            <strong>{t("Candidate {number}", { number: activeItem.ordinal + 1 })}</strong>
            <span className="ml-2 text-[var(--ad-text-muted)]">{t(candidateState(activeItem))}</span>
          </p>
          <p className="text-[var(--ad-text-muted)]">
            {activeIsDraft ? t("Selected in draft") : t(purposeConfig[activePurpose].label)}
            {activeIndex >= 0 ? ` · ${activeIndex + 1}/${items.length}` : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function CandidateComparisonStage({
  activeItem,
  activePurpose,
  comparisonItem,
  onClose,
  onUseComparison,
  subjectName,
}: {
  activeItem: CreativeRunDetail["items"][number];
  activePurpose: CharacterAssetPurpose;
  comparisonItem: CreativeRunDetail["items"][number];
  onClose: () => void;
  onUseComparison: () => void;
  subjectName: string;
}) {
  const { t } = useAdminI18n();
  const imageClass = cn(
    "w-full bg-black/[0.04] object-cover",
    activePurpose === "character_hero"
      ? "aspect-video"
      : "aspect-[4/5]",
  );
  return (
    <section aria-labelledby="candidate-comparison-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-blue-text)]">
            {t("Two-candidate comparison")}
          </p>
          <h4 className="mt-1 font-semibold" id="candidate-comparison-title">
            {t("Compare the current decision without changing authority")}
          </h4>
        </div>
        <WorkspaceButton className="min-h-9" onClick={onClose}>
          <X aria-hidden="true" className="h-4 w-4" />
          {t("Back to generated image")}
        </WorkspaceButton>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <figure className="overflow-hidden rounded-lg border border-[var(--ad-ink)] bg-[var(--ad-surface)]">
          <AssetImage
            alt={t("{name} current candidate {number}", {
              name: subjectName,
              number: activeItem.ordinal + 1,
            })}
            className={imageClass}
            src={activeItem.asset?.url ?? activeItem.asset?.thumbnailUrl}
          />
          <figcaption className="flex items-center justify-between gap-2 px-3 py-3 text-sm">
            <span>
              <strong>{t("Current candidate")}</strong>
              <span className="ml-2 text-[var(--ad-text-muted)]">
                {String(activeItem.ordinal + 1).padStart(2, "0")}
              </span>
            </span>
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--ad-ink)]" />
          </figcaption>
        </figure>
        <figure className="overflow-hidden rounded-lg border border-[var(--ad-blue-text)] bg-[var(--ad-surface)]">
          <AssetImage
            alt={t("{name} comparison candidate {number}", {
              name: subjectName,
              number: comparisonItem.ordinal + 1,
            })}
            className={imageClass}
            src={comparisonItem.asset?.url ?? comparisonItem.asset?.thumbnailUrl}
          />
          <figcaption className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="text-sm">
              <strong>{t("Comparison candidate")}</strong>
              <span className="ml-2 text-[var(--ad-text-muted)]">
                {String(comparisonItem.ordinal + 1).padStart(2, "0")}
              </span>
            </span>
            <WorkspaceButton className="min-h-9" onClick={onUseComparison}>
              {t("Make current")}
            </WorkspaceButton>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

export function CharacterAssetStudio({
  actorId = "anonymous",
  data,
  permissions,
  onContinue,
  onProjectReload,
  commitProjectMutation,
}: {
  actorId?: string;
  data: CharacterWorkspaceDetail;
  permissions: { read: boolean; create: boolean; review: boolean; selectDraft: boolean };
  onContinue: (tab: "visual" | "preview") => void;
  onProjectReload: () => Promise<void>;
  commitProjectMutation: CharacterAssetProjectMutation;
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
  const [selectedRun, setSelectedRun] = useState<CreativeRunDetail | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedExistingImageId, setSelectedExistingImageId] = useState<string | null>(null);
  const [comparisonItemId, setComparisonItemId] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<"library" | "review">(
    () => data.visual.identityBootstrap.allowed ? "review" : "library",
  );
  const [activePurpose, setActivePurpose] = useState<CharacterAssetPurpose>(() =>
    data.project.draftAssetRouteAuthority?.recoveryPurpose ??
    firstIncompleteCharacterAssetPurpose(
      characterAssetPackUnderCurrentRoute(
        data.project.draftAssetPack,
        data.project.draftAssetSelections,
      ),
      Boolean(data.visual.activeIdentity),
    ),
  );
  const [briefs, setBriefs] = useState<Record<CharacterAssetPurpose, string>>(() => ({
    character_cover: t("Create a definitive primary portrait of {name}, preserving the locked identity and personality.", { name: subject.name }),
    character_hero: t("Create a cinematic but natural hero scene for {name}, preserving the locked identity and personality.", { name: subject.name }),
    character_chat: t("Create a warm, candid conversational moment with {name}, preserving the locked identity and emotional presence.", { name: subject.name }),
  }));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<
    "generate" | "review" | "select" | "prepare" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const readinessRepairKeys = useRef<Record<string, string>>({});
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
  const [runCreationIntent, setRunCreationIntent] =
    useState<DurableMutationIntent | null>(() =>
      readActiveDurableMutationIntent({
        scope: `character-asset:create:${actorId}:${data.character.id}`,
      })
    );
  const runCreationIntentRef = useRef(runCreationIntent);
  const [reviewMutationIntent, setReviewMutationIntent] =
    useState<DurableMutationIntent | null>(() =>
      readActiveDurableMutationIntent({
        scope: `character-asset:review:${actorId}:${data.character.id}`,
      })
    );
  const [selectionMutationIntent, setSelectionMutationIntent] =
    useState<DurableMutationIntent | null>(() =>
      readActiveDurableMutationIntent({
        scope: `character-asset:selection:${actorId}:${data.character.id}`,
      })
    );
  const runListRequestGate = useRef(createLatestRequestGate());
  const runDetailRequestGate = useRef(createLatestRequestGate());
  const runDetailInFlight = useRef(
    new Map<string, Promise<CreativeRunDetail>>(),
  );
  const selectRunId = useCallback((runId: string | null) => {
    selectedRunIdRef.current = runId;
    setSelectedRunId(runId);
    setComparisonItemId(null);
  }, [setComparisonItemId]);
  const updateRunCreationIntentState = useCallback(
    (intent: DurableMutationIntent | null) => {
      runCreationIntentRef.current = intent;
      setRunCreationIntent(intent);
    },
    [],
  );
  const identityBootstrap = data.visual.identityBootstrap;
  const bootstrapMode = identityBootstrap.allowed;
  const qualifiedRoute = data.visual.routeQualifications.find((route) => route.result === "qualified" && !route.stale) ?? null;
  const bootstrapProfile = identityBootstrap.profile;
  const variationRouteReady =
    qualifiedRoute?.sourceVariationAuthority?.ready === true;
  const variationRouteBlocker =
    qualifiedRoute?.sourceVariationAuthority?.blocker ?? "no_qualified_route";
  const currentDraftAssetPack = useMemo(() => characterAssetPackUnderCurrentRoute(
    data.project.draftAssetPack,
    data.project.draftAssetSelections,
  ), [data.project.draftAssetPack, data.project.draftAssetSelections]);
  const pinnedRunIds = useMemo(() => new Set(
    Object.values(data.project.draftAssetSelections ?? {})
      .flatMap((selection) => selection?.runId ? [selection.runId] : []),
  ), [data.project.draftAssetSelections]);
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
      images.push({ id, url: displayUrl, thumbnailUrl: thumbnailUrl ?? displayUrl });
    };
    const references = [
      ...(data.visual.activeReferenceSet?.references ?? []),
      ...data.visual.anchors,
      ...data.visual.references,
      ...(data.visual.videoSources ?? []),
    ];
    const preferredAssetId = data.project.draftAssetPack[activePurpose] ?? (
      activePurpose === "character_cover" ? data.project.draftImageAssetId : null
    );
    const preferred = references.find(
      (reference) => reference.mediaAssetId === preferredAssetId && reference.available,
    );
    if (preferred) add(preferred.mediaAssetId, preferred.url, preferred.thumbnailUrl);
    add(`${data.character.id}:primary`, data.character.imageUrl);
    add(`${data.character.id}:draft`, data.preview.draft?.imageUrl);
    for (const reference of references) {
      if (!reference.available) continue;
      add(reference.mediaAssetId, reference.url, reference.thumbnailUrl);
    }
    return images;
  }, [activePurpose, data]);

  const loadRuns = useCallback(async (options: {
    readonly signal?: AbortSignal;
    readonly preserveSelectedRunId?: string;
  } = {}) => {
    const request = runListRequestGate.current.begin();
    const query = new URLSearchParams({
      limit: "20",
      targetType: "character",
      targetId: data.character.id,
      sort: "updated_desc",
    });
    const response = await adminV2Request(`/api/v2/admin/creative/runs?${query}`, {
      schema: creativeRunListResponseSchema,
      signal: options.signal,
    });
    const scoped = [...response.items].filter((run) => isCharacterAssetPurpose(run.purpose));
    if (!request.isCurrent()) throw new SupersededAssetProjectionError();
    setRuns(scoped);
    const current = selectedRunIdRef.current;
    const committedTargetId =
      runCreationIntentRef.current?.status ===
          "committed_projection_pending"
        ? runCreationIntentRef.current.committedTargetId
        : null;
    const preserveCurrent = Boolean(
      current &&
      (
        scoped.some((run) => run.id === current) ||
        current === options.preserveSelectedRunId ||
        current === committedTargetId
      ),
    );
    if (!preserveCurrent) {
      const desiredPurpose = firstIncompleteCharacterAssetPurpose(
        currentDraftAssetPack,
        Boolean(data.visual.activeIdentity),
      );
      const selectedRunForPurpose =
        data.project.draftAssetSelections?.[desiredPurpose]?.runId;
      selectRunId(
        committedTargetId ??
          selectedRunForPurpose ??
          scoped.find((run) => run.purpose === desiredPurpose)?.id ??
          null,
      );
    }
    return scoped;
  }, [currentDraftAssetPack, data.character.id, data.project.draftAssetSelections, data.visual.activeIdentity, selectRunId]);

  const loadRun = useCallback(async (
    runId: string,
    options: { readonly signal?: AbortSignal } = {},
  ) => {
    if (selectedRunIdRef.current !== runId) {
      throw new SupersededAssetProjectionError();
    }
    const existing = runDetailInFlight.current.get(runId);
    if (existing) return existing;
    const requestPromise = (async () => {
      const request = runDetailRequestGate.current.begin();
      const detail = await adminV2Request(
        `/api/v2/admin/creative/runs/${runId}`,
        {
          schema: creativeRunDetailSchema,
          signal: options.signal,
        },
      );
      if (
        !request.isCurrent() ||
        selectedRunIdRef.current !== runId
      ) {
        throw new SupersededAssetProjectionError();
      }
      const committedIntent = runCreationIntentRef.current;
      if (
        committedIntent?.status ===
            "committed_projection_pending" &&
        committedIntent.committedTargetId === runId &&
        !committedCharacterRunProjectionMatches(
          committedIntent,
          detail,
          data.character.id,
        )
      ) {
        throw new Error(
          "The committed Run projection does not match this Character and image purpose. The workspace remains locked.",
        );
      }
      setSelectedRun(detail);
      if (pinnedRunIds.has(detail.id)) {
        setRuns((current) =>
          current.some((run) => run.id === detail.id)
            ? current
            : [detail, ...current]
        );
      }
      setSelectedIndex((current) => {
        if (isCharacterAssetPurpose(detail.purpose)) {
          const selectedItemId =
            data.project.draftAssetSelections?.[detail.purpose]
              ?.itemId;
          const selectedItemIndex = detail.items.findIndex(
            (item) => item.id === selectedItemId,
          );
          if (selectedItemIndex >= 0) return selectedItemIndex;
        }
        return Math.min(
          current,
          Math.max(detail.items.length - 1, 0),
        );
      });
      if (isCharacterAssetPurpose(detail.purpose)) {
        setActivePurpose(detail.purpose);
      }
      if (
        committedIntent &&
        committedCharacterRunProjectionMatches(
          committedIntent,
          detail,
          data.character.id,
        )
      ) {
        clearDurableMutationIntent(committedIntent);
        if (
          runCreationIntentRef.current?.idempotencyKey ===
            committedIntent.idempotencyKey &&
          runCreationIntentRef.current.committedTargetId ===
            committedIntent.committedTargetId
        ) {
          updateRunCreationIntentState(null);
        }
        setRefreshWarning(null);
        setMessage(
          "The committed generation receipt is visible in this exact Run. Review can continue.",
        );
      }
      return detail;
    })();
    runDetailInFlight.current.set(runId, requestPromise);
    try {
      return await requestPromise;
    } finally {
      if (runDetailInFlight.current.get(runId) === requestPromise) {
        runDetailInFlight.current.delete(runId);
      }
    }
  }, [data.character.id, data.project.draftAssetSelections, pinnedRunIds, setActivePurpose, setSelectedRun, updateRunCreationIntentState]);

  useEffect(() => {
    if (!permissions.read) return;
    let cancelled = false;
    const controller = new AbortController();
    const gate = runListRequestGate.current;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try { await loadRuns({ signal: controller.signal }); }
      catch (cause) {
        if (!cancelled && !isProjectionRequestCancellation(cause)) {
          setError(cause instanceof Error ? cause.message : "Character assets could not be loaded");
        }
      }
      finally { if (!cancelled) setLoading(false); }
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
    const gate = runDetailRequestGate.current;
    const timer = window.setTimeout(() => {
      void loadRun(selectedRunId, { signal: controller.signal }).catch((cause: unknown) => {
        if (!isProjectionRequestCancellation(cause)) {
          const committedTargetId =
            runCreationIntentRef.current?.status ===
                "committed_projection_pending"
              ? runCreationIntentRef.current.committedTargetId
              : null;
          if (committedTargetId === selectedRunId) {
            setRefreshWarning(
              cause instanceof Error
                ? `The committed Run projection is still unavailable: ${cause.message}. Verification can be retried without another create request.`
                : "The committed Run projection is still unavailable. Verification can be retried without another create request.",
            );
          } else {
            setError(
              cause instanceof Error
                ? cause.message
                : "Creative Run could not be loaded",
            );
          }
        }
      });
    }, 0);
    return () => {
      if (selectedRunIdRef.current === selectedRunId) {
        gate.invalidate();
      }
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadRun, selectedRun?.id, selectedRunId]);

  const pollingRunId = selectedRun?.id ?? null;
  const shouldPollSelectedRun =
    selectedRun !== null &&
    ["pending", "running"].includes(selectedRun.executionOutcome);
  useEffect(() => {
    if (!pollingRunId || !shouldPollSelectedRun) return;
    let cancelled = false;
    let timer: number | null = null;
    const schedule = (delay: number) => {
      timer = window.setTimeout(async () => {
        let nextDelay = 4_000;
        try {
          await Promise.all([loadRun(pollingRunId), loadRuns()]);
          if (!cancelled) setRefreshWarning(null);
        } catch (cause) {
          if (isProjectionRequestCancellation(cause)) return;
          nextDelay = 8_000;
          if (!cancelled) {
            setRefreshWarning(
              cause instanceof Error
                ? `Automatic refresh was delayed: ${cause.message}. Retrying in the background; Refresh is also available.`
                : "Automatic refresh was delayed. Retrying in the background; Refresh is also available.",
            );
          }
        }
        if (!cancelled) schedule(nextDelay);
      }, delay);
    };
    schedule(4_000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadRun, loadRuns, pollingRunId, shouldPollSelectedRun]);

  const activeRunDetail = selectedRun?.id === selectedRunId ? selectedRun : null;
  const selectedExistingImage = existingImages.find(
    (image) => image.id === selectedExistingImageId,
  ) ?? existingImages[0] ?? null;
  const selectedItem = activeRunDetail?.items[selectedIndex] ?? null;
  const comparisonItem = comparisonItemId
    ? activeRunDetail?.items.find((item) => item.id === comparisonItemId) ?? null
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
    setComparisonItemId((current) => current === itemId ? null : itemId);
    setWorkspaceMode("review");
  };
  const reviewDraft = selectedItem
    ? reviewDrafts[selectedItem.id] ?? emptyReviewDraft(bootstrapMode)
    : emptyReviewDraft(bootstrapMode);
  const updateReviewDraft = (update: (current: ReviewDraft) => ReviewDraft) => {
    if (!selectedItem) return;
    setReviewDrafts((current) => ({
      ...current,
      [selectedItem.id]: update(current[selectedItem.id] ?? emptyReviewDraft(bootstrapMode)),
    }));
  };
  const activeConfig = purposeConfig[activePurpose];
  const mutationContextLocked = Boolean(
    runCreationIntent ||
    reviewMutationIntent ||
    selectionMutationIntent,
  );
  const canGenerate = permissions.create && (
    bootstrapMode
      ? Boolean(bootstrapProfile) && activePurpose === "character_cover"
      : Boolean(qualifiedRoute) && data.visual.readiness.ready
  ) && !refreshWarning;
  const productionBlocked =
    !bootstrapMode && !data.visual.readiness.ready;
  const imageProductionRepairable =
    productionBlocked &&
    data.visual.imageReadiness?.state === "repairable" &&
    Boolean(data.visual.imageReadiness.repair);
  const recurringProductionReady = !bootstrapMode && !productionBlocked;
  const readinessDescriptionId =
    `character-image-readiness-${data.character.id}`;
  const canUseGenerationAction = runCreationIntent
    ? permissions.create
    : canGenerate;
  const selectedPackAssetId = data.project.draftAssetPack[activePurpose] ??
    (activePurpose === "character_cover" ? data.project.draftImageAssetId ?? undefined : undefined);
  const selectedPackReviewDecisionId = data.project.draftAssetSelections?.[activePurpose]?.reviewDecisionId;
  const selectedPackRouteCurrent =
    data.project.draftAssetSelections?.[activePurpose]?.routeCurrent !== false;
  const isSelectedAsset = Boolean(
    selectedItem?.asset &&
    selectedItem.review &&
    selectedPackRouteCurrent &&
    selectedPackAssetId === selectedItem.asset.id &&
    selectedPackReviewDecisionId === selectedItem.review.id,
  );
  const hasDecision = Boolean(selectedItem?.review);
  const hasCompleteReviewEvidence = Boolean(selectedItem?.review?.quality);
  const isDraftAuthorityAsset = Boolean(
    selectedItem?.asset &&
    selectedPackAssetId === selectedItem.asset.id,
  );
  const canRecordTerminalRejection = Boolean(
    activeRunDetail &&
    canOfferCharacterAssetTerminalRejection({
      lifecycleState: activeRunDetail.lifecycleState,
      decision: selectedItem?.review?.decision ?? null,
      hasCompleteEvidence: hasCompleteReviewEvidence,
      isDraftAuthority: isDraftAuthorityAsset,
    }),
  );
  const isApprovedItem = isCharacterAssetApprovalActionable({
    bootstrapIdentity: bootstrapMode,
    decision: selectedItem?.review?.decision ?? null,
    identityConsistency: selectedItem?.review?.identityConsistency ?? null,
    score: selectedItem?.review?.score ?? null,
    quality: selectedItem?.review?.quality ?? null,
  });
  const decisionActionLabel = isSelectedAsset
    ? firstIncompleteCharacterAssetPurpose(currentDraftAssetPack, true) === activePurpose
      ? "Selected · preview"
      : "Selected · next asset"
    : selectedItem?.review?.decision === "rejected"
      ? "Rejected"
      : !isApprovedItem
        ? "Review candidate first"
        : bootstrapMode
          ? "Set as identity anchor"
      : activePurpose === "character_cover"
        ? "Select primary · next asset"
        : activePurpose === "character_hero"
          ? "Select hero · next asset"
          : "Select chat asset · preview";
  const canUseDecisionAction = Boolean(selectedItem?.asset) && (
    isSelectedAsset || (isApprovedItem && permissions.selectDraft)
  );
  // 审图门槛只留真实判断：分数 + 质量勾选。理由不再拦人——这是单人自用后台，
  // 「看一眼觉得行就能过」，写给没人读的审计日志的理由只是打断心流。
  const approvalEvidenceReady =
    reviewDraft.score.trim().length > 0 &&
    Number.isInteger(Number(reviewDraft.score)) &&
    Number(reviewDraft.score) >= (
      bootstrapMode ? 0 : CHARACTER_IDENTITY_APPROVAL_MIN_SCORE
    ) &&
    Number(reviewDraft.score) <= 100 &&
    Object.values(reviewDraft.quality).every(Boolean);
  // 拒绝一张图通常就是「不好看，重生成」，不必先写一段理由。
  const rejectionEvidenceReady = true;

  const prepareImageProduction = async () => {
    const readiness = data.visual.imageReadiness;
    if (
      !readiness ||
      readiness.state !== "repairable" ||
      !readiness.repair
    ) return;
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
        commit: () => adminV2Request(
          `/api/v2/admin/characters/${data.character.id}/image-readiness/repair`,
          {
            method: "POST",
            idempotencyKey,
            ifMatch: data.project.version,
            schema: characterImageReadinessRepairResponseSchema,
            body: {
              entityVersion: data.project.version,
              expectedReadinessFingerprint: readiness.fingerprint,
              reason:
                "Adopt the exact live editorial portrait as future image-generation identity authority",
              confirmation:
                `PREPARE IMAGE PRODUCTION ${data.character.id}`,
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
    if (!canChooseCharacterAssetPurpose(
      purpose,
      bootstrapMode,
      options.identityCommitted,
    )) return;
    runDetailRequestGate.current.invalidate();
    setActivePurpose(purpose);
    setMessage(null);
    const selectedRunForPurpose = data.project.draftAssetSelections?.[purpose]?.runId;
    const existing = runs.find((run) => run.id === selectedRunForPurpose) ??
      runs.find((run) => run.purpose === purpose);
    const nextRunId = selectedRunForPurpose ?? existing?.id ?? null;
    selectRunId(nextRunId);
    if (!nextRunId || nextRunId !== selectedRun?.id) setSelectedRun(null);
    setSelectedIndex(0);
    if (!bootstrapMode) setWorkspaceMode("library");
  };

  const createRun = async (purpose: CharacterAssetPurpose, referenceAssetIds: string[] = []) => {
    if (
      runCreationIntent?.status === "committed_projection_pending" &&
      runCreationIntent.committedTargetId
    ) {
      const committedTargetId =
        runCreationIntent.committedTargetId;
      setBusy("generate");
      setError(null);
      try {
        runDetailRequestGate.current.invalidate();
        selectRunId(committedTargetId);
        setSelectedRun(null);
        await Promise.all([
          loadRuns({
            preserveSelectedRunId: committedTargetId,
          }),
          loadRun(committedTargetId),
        ]);
      } catch (cause) {
        if (!isProjectionRequestCancellation(cause)) {
          setRefreshWarning(
            cause instanceof Error
              ? `The committed Run projection is still unavailable: ${cause.message}. Verification can be retried without another create request.`
              : "The committed Run projection is still unavailable. Verification can be retried without another create request.",
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
      (
        runCreationIntent.status === "reconciliation_required" ||
        (recovered !== null && !recovered.success)
      )
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
            receipt.verification.runId !==
              receipt.committedTargetId
          ) {
            throw new Error(
              "The committed Run receipt is missing exact projection evidence. The workspace remains locked.",
            );
          }
          const trustedRequest =
            creativeRunCreateRequestSchema.safeParse(
              receipt.verification.requestSnapshot,
            );
          if (
            !trustedRequest.success ||
            trustedRequest.data.targetType !== "character" ||
            trustedRequest.data.targetId !== data.character.id ||
            !isCharacterAssetPurpose(
              trustedRequest.data.purpose,
            )
          ) {
            throw new Error(
              "The committed Run receipt does not contain the exact Character image request. The workspace remains locked.",
            );
          }
          const committed = updateDurableMutationIntent(
            runCreationIntent,
            {
              status: "committed_projection_pending",
              committedTargetId: receipt.committedTargetId,
              requestSnapshot: trustedRequest.data,
            },
          );
          updateRunCreationIntentState(committed);
          runDetailRequestGate.current.invalidate();
          selectRunId(receipt.committedTargetId);
          setSelectedRun(null);
          await Promise.all([
            loadRuns({
              preserveSelectedRunId:
                receipt.committedTargetId,
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
        setError(receipt.state === "failed"
          ? `The saved generation command ${receipt.commandId} is terminally failed. Its key remains locked for operator investigation; do not submit a replacement Run.`
          : `The saved generation request is ${receipt.state}. Keep this workspace locked and reconcile again after the server reaches a terminal receipt.`);
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
    const orientation = bootstrapMode
      ? bootstrapProfile?.orientation
      : purposeConfig[purpose].orientation;
    if (
      !recovered?.success &&
      (
        !profileId ||
        !orientation ||
        (bootstrapMode && purpose !== "character_cover")
      )
    ) return;
    const count = 1;
    const brief = briefs[purpose].trim();
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
          consistencyMode: "strict" as const,
          priority: "normal" as const,
          reason: bootstrapMode
            ? "Create the reviewed first identity anchor"
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
        [
          "committed_projection_pending",
          "reconciliation_required",
        ].includes(intent.status)
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
    setBusy("generate"); setError(null); setMessage(null); setRefreshWarning(null);
    let result: {
      readonly batch: { readonly id: string };
      readonly replayed: boolean;
    };
    try {
      result = await adminV2Request("/api/v2/admin/creative/runs", {
        method: "POST",
        idempotencyKey: intent.idempotencyKey,
        schema: creativeRunCreateResultSchema,
        body,
      });
    } catch (cause) {
      if (
        cause instanceof AdminV2RequestError &&
        [400, 401, 403, 404, 409, 422].includes(cause.status)
      ) {
        clearDurableMutationIntent(intent);
        updateRunCreationIntentState(null);
        setError(cause.message);
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
    setMessage(body.bootstrapIdentity
      ? "First-portrait generation was committed. Results will appear here automatically."
      : body.referenceAssetIds.length
        ? "Variation run was committed from this candidate."
        : "Generation was committed. Results will appear here automatically.");
    try {
      runDetailRequestGate.current.invalidate();
      selectRunId(result.batch.id);
      setSelectedRun(null);
      await loadRuns({
        preserveSelectedRunId: result.batch.id,
      });
    } catch (refreshCause) {
      if (!isProjectionRequestCancellation(refreshCause)) {
        setRefreshWarning(refreshCause instanceof Error
          ? `The Run was created, but the latest projection could not be refreshed: ${refreshCause.message}. Choose Verify created Run to retry safely.`
          : "The Run was created, but the latest projection could not be refreshed. Choose Verify created Run to retry safely.");
      }
    } finally {
      setBusy(null);
    }
  };

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
      setError(cause instanceof Error ? cause.message : "Character assets could not be refreshed");
    }
  };

  const verifyReviewIntentProjection = async (
    intent: DurableMutationIntent,
    snapshot: {
      readonly runId: string;
      readonly itemId: string;
    },
  ) => {
    runDetailRequestGate.current.invalidate();
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
            receipt.verification?.kind !==
              "creative_review_decision" ||
            receipt.verification.decisionId !==
              receipt.committedTargetId
          ) {
            throw new Error(
              "The committed review receipt is missing exact projection evidence. The workspace remains locked.",
            );
          }
          const committed = updateDurableMutationIntent(
            reviewMutationIntent,
            {
              status: "committed_projection_pending",
              committedTargetId: receipt.committedTargetId,
              requestSnapshot:
                receipt.verification.requestSnapshot,
            },
          );
          setReviewMutationIntent(committed);
          selectRunId(receipt.verification.runId);
          await verifyReviewIntentProjection(
            committed,
            receipt.verification,
          );
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
        setError(receipt.state === "failed"
          ? `The saved review command ${receipt.commandId} is terminally failed. Its key remains locked for operator investigation; do not submit a replacement decision.`
          : `The saved review request is ${receipt.state}. Keep this workspace locked and reconcile again after the server reaches a terminal receipt.`);
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
      if (
        reviewMutationIntent.status ===
        "committed_projection_pending"
      ) {
        await verifyReviewIntentProjection(
          reviewMutationIntent,
          snapshot,
        );
        return;
      }
      const result = await adminV2Request(
        `/api/v2/admin/creative/runs/${snapshot.runId}/items/${snapshot.itemId}/decisions`,
        {
          method: "POST",
          idempotencyKey: reviewMutationIntent.idempotencyKey,
          schema: creativeReviewDecisionResultSchema,
          body: snapshot.body,
        },
      );
      const committed = updateDurableMutationIntent(
        reviewMutationIntent,
        {
          status: "committed_projection_pending",
          committedTargetId: result.decisionId,
        },
      );
      currentIntent = committed;
      setReviewMutationIntent(committed);
      await verifyReviewIntentProjection(committed, snapshot);
    } catch (cause) {
      if (
        currentIntent.status ===
        "committed_projection_pending"
      ) {
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
        const unknown = updateDurableMutationIntent(
          currentIntent,
          { status: "outcome_unknown" },
        );
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
      selectionMutationIntent.status !==
        "committed_projection_pending"
    ) {
      return;
    }
    const snapshot = characterAssetSelectionIntentSnapshot(
      selectionMutationIntent.requestSnapshot,
    );
    const recoveryVerification =
      characterAssetSelectionRecoveryVerification(
        selectionMutationIntent.requestSnapshot,
      );
    if (!snapshot && !recoveryVerification) return;
    const projected = recoveryVerification
      ? recoveryVerification.characterId === data.character.id &&
        (
          recoveryVerification.kind ===
            "character_identity_bootstrap"
            ? (
                data.visual.activeReferenceSet?.id ===
                  recoveryVerification.referenceSetRevisionId &&
                data.visual.activeReferenceSet.references.some(
                  (reference) =>
                    reference.mediaAssetId ===
                    recoveryVerification.anchorAssetId,
                ) &&
                data.project.draftImageAssetId ===
                  recoveryVerification.draftImageAssetId &&
                data.project.draftAssetPack.character_cover ===
                  recoveryVerification.draftImageAssetId &&
                data.visual.activeIdentity !== null
              )
            : (
                isCharacterAssetPurpose(
                  recoveryVerification.selectedPurpose,
                ) &&
                data.project.draftAssetPack[
                  recoveryVerification.selectedPurpose
                ] === recoveryVerification.selectedAssetId &&
                data.project.draftAssetSelections?.[
                  recoveryVerification.selectedPurpose
                ]?.assetId === recoveryVerification.selectedAssetId
              )
        )
      : snapshot
        ? snapshot.kind === "bootstrap"
          ? (
              data.visual.activeReferenceSet?.id ===
                selectionMutationIntent.committedTargetId &&
              data.project.draftAssetPack.character_cover ===
                snapshot.body.assetId &&
              data.visual.activeIdentity !== null
            )
          : (() => {
              const selection =
                data.project.draftAssetSelections?.[
                  snapshot.body.purpose
                ];
              return (
                data.project.draftAssetPack[snapshot.body.purpose] ===
                  snapshot.body.assetId &&
                selection?.runId === snapshot.body.runId &&
                selection.itemId === snapshot.body.itemId &&
                selection.reviewDecisionId ===
                  snapshot.body.reviewDecisionId
              );
            })()
        : false;
    if (!projected) return;
    const timer = window.setTimeout(() => {
      clearDurableMutationIntent(selectionMutationIntent);
      setSelectionMutationIntent(null);
      setRefreshWarning(null);
      setMessage(
        recoveryVerification?.kind ===
          "character_identity_bootstrap" ||
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
    const recoveryVerification =
      characterAssetSelectionRecoveryVerification(
        selectionMutationIntent.requestSnapshot,
      );
    if (
      selectionMutationIntent.status ===
        "reconciliation_required" ||
      (!snapshot && !recoveryVerification)
    ) {
      setBusy("select");
      setError(null);
      setMessage(null);
      try {
        let commandType =
          characterAssetSelectionIntentCommandType(
            selectionMutationIntent,
          );
        let receipt: Awaited<
          ReturnType<typeof reconcileDurableMutationIntent>
        >;
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
              ? cause.details as Record<string, unknown>
              : null;
          const existingCommandType =
            details?.existingCommandType;
          if (
            existingCommandType !==
              "character.identity.bootstrap" &&
            existingCommandType !==
              "character.project.draft_image.select"
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
            verification?.kind ===
              "character_identity_bootstrap" &&
            verification.characterId === data.character.id &&
            verification.referenceSetRevisionId ===
              receipt.committedTargetId;
          const matchesDraftSelection =
            commandType ===
              "character.project.draft_image.select" &&
            verification?.kind ===
              "character_draft_image_selection" &&
            verification.characterId === data.character.id &&
            verification.selectedAssetId ===
              receipt.committedTargetId;
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
        setError(receipt.state === "failed"
          ? `The saved selection command ${receipt.commandId} is terminally failed. Its key remains locked for operator investigation; do not submit a replacement selection.`
          : `The saved selection request is ${receipt.state}. Keep this workspace locked and reconcile again after the server reaches a terminal receipt.`);
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
      if (
        currentIntent.status === "committed_projection_pending"
      ) {
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
            const result = await adminV2Request(
              `/api/v2/admin/characters/${data.character.id}/identity-bootstrap`,
              {
                method: "POST",
                idempotencyKey: currentIntent.idempotencyKey,
                ifMatch: snapshot.body.entityVersion,
                schema: characterIdentityBootstrapResponseSchema,
                body: snapshot.body,
              },
            );
            currentIntent = updateDurableMutationIntent(
              currentIntent,
              {
                status: "committed_projection_pending",
                committedTargetId: result.referenceSetRevisionId,
              },
            );
            setSelectionMutationIntent(currentIntent);
            return result;
          }
          const result = await adminV2Request(
            `/api/v2/admin/characters/${data.character.id}/draft-image`,
            {
              method: "PATCH",
              idempotencyKey: currentIntent.idempotencyKey,
              ifMatch: snapshot.body.entityVersion,
              schema: characterDraftImageSelectionResultSchema,
              body: snapshot.body,
            },
          );
          currentIntent = updateDurableMutationIntent(
            currentIntent,
            {
              status: "committed_projection_pending",
              committedTargetId: result.selectedAssetId,
            },
          );
          setSelectionMutationIntent(currentIntent);
          return result;
        },
      });
    } catch (cause) {
      if (
        currentIntent.status === "committed_projection_pending"
      ) {
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

  const reviewItem = async (decision: "approved" | "rejected") => {
    if (reviewMutationIntent) {
      await resumeReviewMutation();
      return null;
    }
    if (refreshWarning) return null;
    if (!activeRunDetail || !selectedItem) return null;
    const numericScore = reviewDraft.score.trim() ? Number(reviewDraft.score) : undefined;
    const validScore =
      numericScore !== undefined &&
      Number.isInteger(numericScore) &&
      numericScore >= (
        bootstrapMode ? 0 : CHARACTER_IDENTITY_APPROVAL_MIN_SCORE
      ) &&
      numericScore <= 100;
    if (decision === "approved" && !validScore) {
      setError(decision === "approved"
        ? bootstrapMode
          ? "Approval requires an integer score from 0 to 100 and concrete visible evidence."
          : `Approval requires an identity match score from ${CHARACTER_IDENTITY_APPROVAL_MIN_SCORE} to 100 and concrete visible evidence.`
        : "Rejection requires a concrete visible reason.");
      return null;
    }
    if (decision === "approved" && reviewDraft.identity !== (bootstrapMode ? "unscored" : "passed")) {
      setError(bootstrapMode
        ? "The first portrait defines identity and must remain unscored for identity consistency."
        : "A customer-facing approval requires identity consistency to pass.");
      return null;
    }
    if (decision === "approved" && Object.values(reviewDraft.quality).some((passed) => !passed)) {
      setError("Every required visible quality check must pass before approval.");
      return null;
    }
    const submittedEvidence = resolveCharacterAssetReviewEvidence({
      decision,
      draft: {
        identityConsistency: reviewDraft.identity,
        score: numericScore,
        quality: reviewDraft.quality,
      },
      previous: selectedItem.review,
    });
    const body = {
      entityVersion: activeRunDetail.version,
      ...(selectedItem.review ? { supersedesDecisionId: selectedItem.review.id } : {}),
      decision,
      identityConsistency: submittedEvidence.identityConsistency,
      ...(submittedEvidence.score !== undefined ? { score: submittedEvidence.score } : {}),
      quality: submittedEvidence.quality,
      reason: reviewDraft.reason.trim(),
    };
    const requestSignature = characterAssetReviewRequestKey({
      runId: activeRunDetail.id,
      itemId: selectedItem.id,
      body,
    });
    const reviewSnapshot = {
      runId: activeRunDetail.id,
      itemId: selectedItem.id,
      body,
    };
    const claim = await claimDurableMutationIntent({
      scope: `character-asset:review:${actorId}:${data.character.id}`,
      signature: requestSignature,
      requestSnapshot: reviewSnapshot,
    });
    const intent = claim.intent;
    if (
      intent.signature !== requestSignature ||
      [
        "committed_projection_pending",
        "reconciliation_required",
      ].includes(intent.status)
    ) {
      setReviewMutationIntent(intent);
      setError(
        intent.status === "committed_projection_pending"
          ? "Another tab already committed a review receipt. Verify that exact decision before reviewing again."
          : intent.status === "reconciliation_required"
            ? "Another tab has an aged review receipt. Reconcile it with the server before reviewing again."
          : "Another tab already started a different review decision. Resume its exact locked request first.",
      );
      return null;
    }
    setReviewMutationIntent(intent);
    setBusy("review"); setError(null); setMessage(null); setRefreshWarning(null);
    let committed: DurableMutationIntent;
    try {
      const result = await adminV2Request(`/api/v2/admin/creative/runs/${activeRunDetail.id}/items/${selectedItem.id}/decisions`, {
        method: "POST",
        idempotencyKey: intent.idempotencyKey,
        schema: creativeReviewDecisionResultSchema,
        body,
      });
      committed = updateDurableMutationIntent(intent, {
        status: "committed_projection_pending",
        committedTargetId: result.decisionId,
      });
      setReviewMutationIntent(committed);
      setMessage(decision === "approved"
        ? "Review decision was committed."
        : "Rejection was committed. Choose another result or generate a new Run.");
      try {
        return await verifyReviewIntentProjection(
          committed,
          reviewSnapshot,
        );
      } catch (refreshCause) {
        if (isProjectionRequestCancellation(refreshCause)) return null;
        setRefreshWarning(refreshCause instanceof Error
          ? `The decision was committed, but the latest projection could not be refreshed: ${refreshCause.message}. The same command can be retried safely.`
          : "The decision was committed, but the latest projection could not be refreshed. The same command can be retried safely.");
        return null;
      }
    } catch (cause) {
      if (
        cause instanceof AdminV2RequestError &&
        [400, 401, 403, 404, 409, 422].includes(cause.status)
      ) {
        clearDurableMutationIntent(intent);
        setReviewMutationIntent(null);
        setError(cause.message);
      } else {
        const unknown = updateDurableMutationIntent(intent, {
          status: "outcome_unknown",
        });
        setReviewMutationIntent(unknown);
        setError(
          "Review outcome is unknown. Submit the same decision again to resume it without creating a duplicate decision.",
        );
      }
      return null;
    }
    finally { setBusy(null); }
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
      const nextPurpose = firstIncompleteCharacterAssetPurpose(data.project.draftAssetPack, true);
      if (nextPurpose !== activePurpose) choosePurpose(nextPurpose);
      else onContinue("preview");
      return;
    }
    if (!isApprovedItem) return;
    if (!permissions.selectDraft) return;
    const nextIdentityVersion = identityBootstrap.nextIdentityVersion;
    const bootstrapReason = `Establish the reviewed first portrait as identity version ${nextIdentityVersion} and the next Release primary image`;
    const bootstrapBody = {
      entityVersion: data.project.version,
      runId: activeRunDetail.id,
      itemId: selectedItem.id,
      assetId: selectedAsset.id,
      reviewDecisionId: selectedItem.review?.id ?? "",
      reason: bootstrapReason,
      confirmation: `BOOTSTRAP IDENTITY ${data.character.id}`,
    };
    const draftSelectionBody = {
      entityVersion: data.project.version,
      purpose: activePurpose,
      runId: activeRunDetail.id,
      itemId: selectedItem.id,
      assetId: selectedAsset.id,
      reviewDecisionId: selectedItem.review?.id ?? "",
      reason: `Approved ${activeConfig.label.toLowerCase()} selected for the next Character Release`,
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
      [
        "committed_projection_pending",
        "reconciliation_required",
      ].includes(intent.status)
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
    setBusy("select"); setError(null);
    let committedIntent: DurableMutationIntent | null = null;
    try {
      await commitProjectMutation({
        action: bootstrapMode ? "Identity bootstrap selection" : `${activeConfig.label} selection`,
        commit: async () => {
          if (bootstrapMode) {
            const mutation = characterIdentityBootstrapMutation(
              data.character.id,
              data.project.version,
              activeRunDetail.id,
              selectedItem.id,
              selectedAsset.id,
              selectedItem.review?.id ?? "",
              bootstrapReason,
              intent.idempotencyKey,
            );
            const result = await adminV2Request(mutation.path, {
              ...mutation.options,
              schema: characterIdentityBootstrapResponseSchema,
            });
            committedIntent = updateDurableMutationIntent(intent, {
              status: "committed_projection_pending",
              committedTargetId: result.referenceSetRevisionId,
            });
            setSelectionMutationIntent(committedIntent);
            setMessage(`Identity version ${nextIdentityVersion}, its sealed Reference Set, and the draft primary image were committed.`);
            return result;
          }
          const result = await adminV2Request(`/api/v2/admin/characters/${data.character.id}/draft-image`, {
            method: "PATCH",
            idempotencyKey: intent.idempotencyKey,
            ifMatch: data.project.version,
            schema: characterDraftImageSelectionResultSchema,
            body: draftSelectionBody,
          });
          committedIntent = updateDurableMutationIntent(intent, {
            status: "committed_projection_pending",
            committedTargetId: result.selectedAssetId,
          });
          setSelectionMutationIntent(committedIntent);
          setMessage(`${activeConfig.label} was committed to the next Character Release draft.`);
          return result;
        },
        afterRefresh: () => {
          setRefreshWarning(null);
          if (activePurpose === "character_cover") {
            choosePurpose("character_hero", { identityCommitted: bootstrapMode });
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
        setError(cause instanceof Error ? cause.message : "Character asset could not be selected");
      }
    } finally {
      setBusy(null);
    }
  };

  if (!permissions.read) return <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8"><ShieldAlert className="h-6 w-6" /><h3 className="mt-4 font-semibold">{t("No asset workspace permission")}</h3><p className="mt-2 text-sm text-[var(--ad-text-muted)]">{t("creative.run.read is required to see character production.")}</p></section>;
  if (loading) return <section aria-busy="true" className="grid min-h-80 place-items-center rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />  {t("Loading character assets")}</span></section>;
  const runIntentNeedsReconciliation = Boolean(
    runCreationIntent &&
    (
      runCreationIntent.status === "reconciliation_required" ||
      !creativeRunCreateRequestSchema.safeParse(
        runCreationIntent.requestSnapshot,
      ).success
    ),
  );
  const reviewIntentNeedsReconciliation = Boolean(
    reviewMutationIntent &&
    (
      reviewMutationIntent.status === "reconciliation_required" ||
      !characterAssetReviewIntentSnapshot(
        reviewMutationIntent.requestSnapshot,
      )
    ),
  );
  const selectionIntentNeedsReconciliation = Boolean(
    selectionMutationIntent &&
    (
      selectionMutationIntent.status ===
        "reconciliation_required" ||
      (
        !characterAssetSelectionIntentSnapshot(
          selectionMutationIntent.requestSnapshot,
        ) &&
        !characterAssetSelectionRecoveryVerification(
          selectionMutationIntent.requestSnapshot,
        )
      )
    ),
  );
  const generationActionLabel =
    runIntentNeedsReconciliation
      ? "Reconcile saved request"
      : runCreationIntent?.status === "outcome_unknown" ||
      runCreationIntent?.status === "submitting"
      ? "Resume generation"
      : runCreationIntent?.status === "committed_projection_pending"
        ? "Verify created Run"
        : `Generate 1 ${activeConfig.pluralLabel}`;
  const generationActionText =
    generationActionLabel.startsWith("Generate ")
      ? t("Generate {count} {assetType}", {
          count: 1,
          assetType: t(activeConfig.pluralLabel),
        })
      : t(generationActionLabel);
  const generationActionDescriptionId =
    `character-generation-action-${data.character.id}`;
  const generationActionDisabled =
    !canUseGenerationAction ||
    busy !== null ||
    (!runCreationIntent && !briefs[activePurpose].trim()) ||
    Boolean(reviewMutationIntent || selectionMutationIntent);
  const generationActionDescription = busy !== null
    ? "Wait for the current image-production action to finish."
    : reviewMutationIntent
      ? "Resolve the saved review before starting another generation."
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
                      : "The generation action is available.";

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
      {!recurringProductionReady ? <section
        aria-labelledby="asset-pack-title"
        className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
      >
        <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
              {t(bootstrapMode
                ? "First identity portrait"
                : productionBlocked
                  ? imageProductionRepairable
                    ? "Enable image production"
                    : "Image production setup"
                  : "Ready for ongoing image production")}
            </p>
            <h3 className="mt-1 text-xl font-semibold" id="asset-pack-title">
              {t(bootstrapMode
                ? "Establish the face customers will recognize"
                : productionBlocked
                  ? imageProductionRepairable
                    ? "Use the current live portrait for future image generation"
                    : "Finish visual setup before creating more images"
                  : "{name}'s images", { name: subject.name })}
            </h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
              {t(bootstrapMode
                ? `Generate the first portrait without references, review it as the identity definition, then commit it as identity version ${identityBootstrap.nextIdentityVersion}.`
                : productionBlocked
                  ? imageProductionRepairable
                    ? "Seal the existing live portrait as the reusable identity reference. Current live images and releases will not change."
                    : "Complete the current visual setup action once. Existing live images and releases will not change."
                  : "Create one image from the locked identity, review it, then decide whether it belongs in the draft asset pack.")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <WorkspaceButton disabled={busy !== null} onClick={() => void refreshWorkspace()}>
              <RefreshCcw className="h-4 w-4" /> {t("Refresh")}
            </WorkspaceButton>
            {bootstrapMode ? (
              <WorkspaceButton
                aria-describedby={generationActionDisabled ? generationActionDescriptionId : undefined}
                disabled={generationActionDisabled}
                onClick={() => void createRun(activePurpose)}
                tone="primary"
              >
                <WandSparkles className="h-4 w-4" /> {generationActionText}
              </WorkspaceButton>
            ) : null}
          </div>
        </div>
        <p className="sr-only" id={generationActionDescriptionId}>
          {t(generationActionDescription)}
        </p>
        {bootstrapMode ? (
          <div className={cn(
            "mx-4 mb-4 rounded-lg p-3 text-sm sm:mx-5",
            bootstrapProfile
              ? "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
              : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
          )}>
            {bootstrapProfile
              ? `${bootstrapProfile.label} · ${bootstrapProfile.orientation} · ${t(
                  identityBootstrap.state === "recoverable_empty_history"
                    ? `no reference input. The reviewed result will supersede the unanchored candidate history as identity version ${identityBootstrap.nextIdentityVersion}.`
                    : "no reference input. The reviewed result becomes the reference authority.",
                )}`
              : t("No active text-to-image bootstrap profile is available. Generation remains blocked until one is published.")}
          </div>
        ) : data.project.draftAssetRouteAuthority?.status === "stale" ? (
          <div className="mx-4 mb-4 flex flex-col gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:mx-5 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {t(`The active image route changed. ${data.project.draftAssetRouteAuthority.stalePurposes.length} selected asset${data.project.draftAssetRouteAuthority.stalePurposes.length === 1 ? "" : "s"} remain in history but cannot authorize QA.`)}
            </span>
            <WorkspaceButton disabled={!canGenerate || busy !== null} onClick={regenerateUnderCurrentRoute}>
              {t("Regenerate under current route")}
            </WorkspaceButton>
          </div>
        ) : productionBlocked ? (
          <div className="mx-4 mb-4 sm:mx-5">
            <ImageProductionReadinessCard
              blockers={data.visual.readiness.blockers}
              canRepair={data.visual.imageReadiness?.state === "repairable" && permissions.selectDraft}
              descriptionId={readinessDescriptionId}
              onContinue={() => onContinue("visual")}
              onRepair={() => void prepareImageProduction()}
              repairing={busy === "prepare"}
            />
          </div>
        ) : null}
      </section> : null}

      {recurringProductionReady && data.project.draftAssetRouteAuthority?.status === "stale" ? (
        <div className="flex flex-col gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:flex-row sm:items-center sm:justify-between">
          <span>
            {t(`The active image route changed. ${data.project.draftAssetRouteAuthority.stalePurposes.length} selected asset${data.project.draftAssetRouteAuthority.stalePurposes.length === 1 ? "" : "s"} remain in history but cannot authorize QA.`)}
          </span>
          <WorkspaceButton disabled={!canGenerate || busy !== null} onClick={regenerateUnderCurrentRoute}>
            {t("Regenerate under current route")}
          </WorkspaceButton>
        </div>
      ) : null}

      <IdentityRail data={data} onRepair={() => onContinue("visual")} />

      {runCreationIntent?.committedTargetId ? <p className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm" role="status">{t("Created Run receipt:")} <span className="font-medium">{runCreationIntent.committedTargetId}</span>{t(". Verify its projection before starting another generation intent.")}</p> : null}
      {reviewMutationIntent ? <div className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between" role="status"><span>{reviewIntentNeedsReconciliation ? t("This saved review is aged or no longer matches the active contract. Reconcile its server receipt before another decision.") : reviewMutationIntent.status === "committed_projection_pending" ? t("Review receipt is committed; verify the exact decision in the latest Run projection.") : t("Review submission is ready to resume with the same request key.")}</span><WorkspaceButton disabled={!permissions.review || busy !== null} onClick={() => void resumeReviewMutation()}>{reviewIntentNeedsReconciliation ? t("Reconcile review") : reviewMutationIntent.status === "committed_projection_pending" ? t("Verify review") : t("Resume review")}</WorkspaceButton></div> : null}
      {selectionMutationIntent ? <div className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between" role="status"><span>{selectionIntentNeedsReconciliation ? t("This saved selection is aged or no longer matches the active contract. Reconcile its server receipt before another selection.") : selectionMutationIntent.status === "committed_projection_pending" ? t("Selection receipt is committed; verify it against current Character authority.") : t("Asset selection is ready to resume with the same request key.")}</span><WorkspaceButton disabled={!permissions.selectDraft || busy !== null} onClick={() => void resumeSelectionMutation()}>{selectionIntentNeedsReconciliation ? t("Reconcile selection") : selectionMutationIntent.status === "committed_projection_pending" ? t("Verify selection") : t("Resume selection")}</WorkspaceButton></div> : null}
      {refreshWarning ? <p className="rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]" role="status">{refreshWarning}</p> : null}
      <div className={characterAssetStudioLayoutClass}>
        <section
          aria-labelledby="candidate-title"
          className="min-w-0"
        >
          <div className="flex flex-wrap items-end justify-between gap-3 pb-3">
            <div>
              <h3 className="font-semibold" id="candidate-title">
                {productionBlocked
                  ? t("Candidate history is paused")
                  : activeRunDetail?.items.length
                  ? t("{count} recent images", { count: activeRunDetail.items.length })
                  : existingImages.length
                    ? t("{count} images", { count: existingImages.length })
                  : t("Ready for a first run")}
              </h3>
              <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t(activeConfig.label)}</p>
            </div>
            {activeRunDetail ? (
              <div className="flex flex-wrap gap-2">
                <StatusBadge value={activeRunDetail.executionOutcome} />
                <StatusBadge value={activeRunDetail.reviewState} />
              </div>
            ) : null}
          </div>

          {!bootstrapMode && qualifiedRoute && selectedItem && !variationRouteReady ? (
            <div className="mt-3 flex flex-col gap-2 rounded-lg bg-[var(--ad-blue-bg)] p-3 text-xs leading-5 text-[var(--ad-blue-text)] sm:flex-row sm:items-center sm:justify-between">
              <p>{t(characterSourceVariationBlockerMessage(variationRouteBlocker))}</p>
              <WorkspaceButton onClick={() => onContinue("visual")}>{t("Review generation route")}</WorkspaceButton>
            </div>
          ) : null}

          <div className="mt-1">
            {productionBlocked ? (
              <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-[var(--ad-border)] bg-black/[0.02] px-6 py-8 text-center text-[var(--ad-text-muted)]">
                <div>
                  <ShieldAlert className="mx-auto h-6 w-6" />
                  <p className="mt-3 text-sm font-semibold">{t("Image production is waiting for visual setup")}</p>
                  <p className="mt-1 max-w-md text-xs leading-5">{t("Complete the readiness steps above; candidate generation will appear here when the character is ready.")}</p>
                </div>
              </div>
            ) : selectedItem?.asset && comparisonItem?.asset ? (
              <CandidateComparisonStage
                activeItem={selectedItem}
                activePurpose={activePurpose}
                comparisonItem={comparisonItem}
                onClose={() => setComparisonItemId(null)}
                onUseComparison={() => {
                  const comparisonIndex = activeRunDetail?.items.findIndex(
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
                selectedPackAssetId={selectedPackAssetId}
                subjectName={subject.name}
              />
            ) : selectedExistingImage ? (
              <div aria-label={t("Character image library")}>
                <div className="overflow-hidden rounded-lg bg-black/[0.04]" style={{ height: "min(500px, 60vh)" }}>
                  <AssetImage
                    alt={t("{name} image {number}", {
                      name: subject.name,
                      number: existingImages.indexOf(selectedExistingImage) + 1,
                    })}
                    className="h-full w-full object-contain"
                    src={selectedExistingImage.url}
                  />
                </div>
                <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="list">
                  {existingImages.map((image, index) => (
                    <div className="w-24 shrink-0" key={image.id} role="listitem">
                      <button
                        aria-label={t("Open image {number}", { number: index + 1 })}
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
                          alt={t("{name} thumbnail {number}", { name: subject.name, number: index + 1 })}
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
                  <p className="mt-3 text-sm">{t("Generate one image, then review it here.")}</p>
                </div>
              </div>
            )}
          </div>
        </section>

        {recurringProductionReady && workspaceMode === "library" ? (
          <aside className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 xl:sticky xl:top-4" aria-labelledby="new-image-title">
            <div className="flex border-b border-[var(--ad-border)]" role="tablist" aria-label={t("Image inspector mode")}>
              <button
                aria-selected={false}
                className="min-h-11 border-b-2 border-transparent px-3 text-sm text-[var(--ad-text-muted)] disabled:opacity-40"
                disabled={!selectedItem?.asset}
                onClick={() => setWorkspaceMode("review")}
                role="tab"
                type="button"
              >{t("Inspect")}</button>
              <button aria-selected="true" className="min-h-11 border-b-2 border-[var(--ad-ink)] px-3 text-sm font-semibold" role="tab" type="button">{t("New image")}</button>
            </div>
            <h3 className="sr-only" id="new-image-title">{t("New image")}</h3>
            <label className="mt-5 block text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("What should be different this time?")}
              <textarea
                aria-label={`${t(activeConfig.label)} ${t("creative brief")}`}
                className={`${textAreaClass} mt-1 min-h-36`}
                disabled={mutationContextLocked}
                onChange={(event) => setBriefs((current) => ({
                  ...current,
                  [activePurpose]: event.target.value,
                }))}
                value={briefs[activePurpose]}
              />
            </label>
            <details className="mt-4 border-t border-[var(--ad-border)] pt-3 text-xs">
              <summary className="cursor-pointer font-semibold">{t("Settings")}</summary>
              <label className="mt-3 block font-semibold text-[var(--ad-text-muted)]">
                {t("Image purpose")}
                <select
                  className={`${fieldClass} mt-1`}
                  disabled={mutationContextLocked}
                  onChange={(event) => choosePurpose(event.target.value as CharacterAssetPurpose)}
                  value={activePurpose}
                >
                  {characterAssetPurposes.map((purpose) => (
                    <option key={purpose} value={purpose}>{t(purposeConfig[purpose].label)}</option>
                  ))}
                </select>
              </label>
            </details>
            <WorkspaceButton
              aria-describedby={generationActionDisabled ? generationActionDescriptionId : undefined}
              className="mt-5 w-full justify-center"
              disabled={generationActionDisabled}
              onClick={() => void createRun(activePurpose)}
              tone="primary"
            >
              <WandSparkles className="h-4 w-4" /> {generationActionText}
            </WorkspaceButton>
            {selectedItem?.asset ? (
              <button className="mt-3 min-h-10 w-full text-center text-xs font-semibold text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]" onClick={() => setWorkspaceMode("review")} type="button">{t("Cancel")}</button>
            ) : null}
          </aside>
        ) : !productionBlocked && selectedItem?.asset ? (
          <aside className="space-y-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 xl:sticky xl:top-4" aria-label={t("Current candidate decision inspector")}>
            {recurringProductionReady ? (
              <div className="flex border-b border-[var(--ad-border)]" role="tablist" aria-label={t("Image inspector mode")}>
                <button aria-selected="true" className="min-h-11 border-b-2 border-[var(--ad-ink)] px-3 text-sm font-semibold" role="tab" type="button">{t("Inspect")}</button>
                <button
                  aria-selected={false}
                  className="min-h-11 border-b-2 border-transparent px-3 text-sm text-[var(--ad-text-muted)]"
                  onClick={() => setWorkspaceMode("library")}
                  role="tab"
                  type="button"
                >{t("New image")}</button>
              </div>
            ) : null}
            <section
              aria-label={t("Record the visible review evidence")}
              className={recurringProductionReady ? "pt-1" : "border-t border-[var(--ad-border)] pt-4"}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">
                    {t("Review evidence")}
                  </p>
                  <h4 className="mt-1 text-sm font-semibold" id="character-candidate-review-title">
                    {t("Candidate {number}", { number: selectedItem.ordinal + 1 })}
                  </h4>
                </div>
                {selectedItem.review ? (
                  <StatusBadge
                    tone={selectedItem.review.decision === "approved" ? "good" : "bad"}
                    value={selectedItem.review.decision}
                  />
                ) : (
                  <StatusBadge tone="warn" value="pending" />
                )}
              </div>
              {(!hasDecision || !hasCompleteReviewEvidence) ? (
                <>
                  <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
                    {t(hasDecision
                      ? "The earlier immutable decision is preserved, but it is missing required visible evidence. Record a superseding review to make this candidate actionable."
                      : bootstrapMode
                        ? "This portrait defines identity, so identity consistency is intentionally unscored. Judge artifacts, subject count, composition, and customer intent."
                        : "Score the artifact and state identity consistency separately. A composition rejection does not automatically mean identity failed.")}
                  </p>
                  {hasDecision && selectedItem.review ? (
                    <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">
                      {t("Earlier decision")}: {t(selectedItem.review.decision)} · {t(selectedItem.review.identityConsistency)} · {selectedItem.review.reason}
                    </p>
                  ) : null}
                  <fieldset className="mt-3 space-y-2">
                    <legend className="sr-only">{t("Required visible quality checks")}</legend>
                    {reviewQualityChecks.map(([key, label]) => (
                      <label className="flex min-h-10 items-center gap-3 rounded-md border border-[var(--ad-border)] px-3 text-xs" key={key}>
                        <input
                          checked={reviewDraft.quality[key]}
                          onChange={(event) => updateReviewDraft((current) => ({
                            ...current,
                            quality: {
                              ...current.quality,
                              [key]: event.target.checked,
                            },
                          }))}
                          type="checkbox"
                        />
                        <span>{t(label)}</span>
                      </label>
                    ))}
                  </fieldset>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                      {bootstrapMode
                        ? t("Quality score")
                        : t("Identity match score ({minimum}–100 required)", {
                            minimum: CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
                          })}
                      <input
                        className={`${fieldClass} mt-1`}
                        max={100}
                        min={bootstrapMode
                          ? 0
                          : CHARACTER_IDENTITY_APPROVAL_MIN_SCORE}
                        onChange={(event) => updateReviewDraft((current) => ({
                          ...current,
                          score: event.target.value,
                        }))}
                        placeholder="0–100"
                        step={1}
                        type="number"
                        value={reviewDraft.score}
                      />
                    </label>
                    <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                      {t("Identity consistency")}
                      <select
                        className={`${fieldClass} mt-1`}
                        disabled={bootstrapMode}
                        onChange={(event) => updateReviewDraft((current) => ({
                          ...current,
                          identity: event.target.value as ReviewDraft["identity"],
                        }))}
                        value={reviewDraft.identity}
                      >
                        {bootstrapMode ? (
                          <option value="unscored">{t("Unscored · defines identity")}</option>
                        ) : (
                          <>
                            <option value="passed">{t("Passed")}</option>
                            <option value="failed">{t("Failed")}</option>
                            <option value="unscored">{t("Unscored")}</option>
                          </>
                        )}
                      </select>
                    </label>
                  </div>
                  <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Evidence and reason")}
                    <textarea
                      className={`${textAreaClass} mt-1`}
                      onChange={(event) => updateReviewDraft((current) => ({
                        ...current,
                        reason: event.target.value,
                      }))}
                      placeholder={t("Describe artifacts, subject count, identity markers, composition, and intended customer context")}
                      value={reviewDraft.reason}
                    />
                  </label>
                  <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
                    {t("Review actions apply only to the current candidate and stay separate from draft adoption.")}
                  </p>
                </>
              ) : selectedItem.review ? (
                <div className="mt-3 rounded-lg bg-black/[0.035] p-3 text-xs leading-5">
                  <strong className="capitalize">{t(selectedItem.review.decision)}</strong> · {t("identity")} {t(selectedItem.review.identityConsistency)}
                  {selectedItem.review.score !== null ? ` · ${selectedItem.review.score}/100` : ""}
                  <br />
                  <span className="text-[var(--ad-text-muted)]">{selectedItem.review.reason}</span>
                  {selectedItem.review.supersedesDecisionId ? <><br /><span className="break-all text-[var(--ad-text-muted)]">{t("Supersedes")} {selectedItem.review.supersedesDecisionId}</span></> : null}
                  {canRecordTerminalRejection ? (
                    <div className="mt-4 border-t border-[var(--ad-border)] pt-4">
                      <h4 className="text-sm font-semibold">{t("Terminal disposition")}</h4>
                      <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                        {t("If this approved candidate will not be used, record a superseding rejection so its Run can close with an explicit outcome. The original score, identity result, and visible-quality evidence stay preserved.")}
                      </p>
                      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                        {t("Withdrawal reason")}
                        <textarea
                          className={`${textAreaClass} mt-1`}
                          onChange={(event) => updateReviewDraft((current) => ({
                            ...current,
                            reason: event.target.value,
                          }))}
                          placeholder={t("Explain why this approved candidate will not be used")}
                          value={reviewDraft.reason}
                        />
                      </label>
                      <div className="mt-3">
                        <WorkspaceButton
                          disabled={
                            mutationContextLocked ||
                            !permissions.review ||
                            busy !== null ||
                            Boolean(refreshWarning) ||
                            !rejectionEvidenceReady
                          }
                          onClick={() => void reviewItem("rejected")}
                          tone="danger"
                        >
                          <ThumbsDown className="h-4 w-4" /> {t("Record superseding rejection")}
                        </WorkspaceButton>
                      </div>
                    </div>
                  ) : selectedItem.review.decision === "approved" && isDraftAuthorityAsset ? (
                    <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">
                      {t("This candidate is selected by the Character draft. Select a replacement in this slot before recording a superseding rejection.")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {!permissions.review || !permissions.selectDraft ? (
                <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
                  {t("Review and project-write grants control approval and primary image selection.")}
                </p>
              ) : null}
            </section>
          </aside>
        ) : null}
      </div>

      {selectedItem && !productionBlocked && (!recurringProductionReady || workspaceMode === "review") ? (
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
                  state: t(candidateState(selectedItem)),
                })
              : t("No active candidate")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {comparisonItem ? (
            <WorkspaceButton onClick={() => setComparisonItemId(null)}>
              <X className="h-4 w-4" />
              <span className="sm:hidden">{t("Image")}</span>
              <span className="hidden sm:inline">{t("Back to generated image")}</span>
            </WorkspaceButton>
          ) : null}
          <WorkspaceButton
            disabled={mutationContextLocked || bootstrapMode || !variationRouteReady || !canGenerate || busy !== null || !selectedItem?.asset || !isApprovedItem}
            onClick={() => selectedItem?.asset
              ? void createRun(activePurpose, [selectedItem.asset.id])
              : undefined}
          >
            <Sparkles className="h-4 w-4" />
            <span className="sm:hidden">{t("Similar")}</span>
            <span className="hidden sm:inline">{t("More like this")}</span>
          </WorkspaceButton>
          {selectedItem?.asset && (!hasDecision || !hasCompleteReviewEvidence) ? (
            <>
              <WorkspaceButton
                disabled={
                  mutationContextLocked ||
                  !permissions.review ||
                  busy !== null ||
                  Boolean(refreshWarning) ||
                  !rejectionEvidenceReady
                }
                onClick={() => void reviewItem("rejected")}
                tone="danger"
              >
                <ThumbsDown className="h-4 w-4" />
                <span className="sm:hidden">{t("Reject")}</span>
                <span className="hidden sm:inline">{t(hasDecision ? "Record superseding rejection" : "Reject current")}</span>
              </WorkspaceButton>
              <WorkspaceButton
                disabled={
                  mutationContextLocked ||
                  !permissions.review ||
                  busy !== null ||
                  Boolean(refreshWarning) ||
                  !approvalEvidenceReady
                }
                onClick={() => void reviewItem("approved")}
                tone="primary"
              >
                {busy === "review"
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Check className="h-4 w-4" />}
                <span className="sm:hidden">{t("Approve")}</span>
                <span className="hidden sm:inline">{t(hasDecision ? "Record superseding approval" : "Approve current candidate")}</span>
              </WorkspaceButton>
            </>
          ) : selectedItem?.review?.decision === "approved" ? (
            <WorkspaceButton
              disabled={mutationContextLocked || !canUseDecisionAction || busy !== null || Boolean(refreshWarning)}
              onClick={() => void approveAndContinue()}
              tone="primary"
            >
              {busy === "select"
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Check className="h-4 w-4" />}
              {t(decisionActionLabel)}
            </WorkspaceButton>
          ) : selectedItem?.review?.decision === "rejected" ? (
            <StatusBadge tone="bad" value="rejected" />
          ) : null}
        </div>
        </section>
      ) : null}

      {bootstrapMode ? <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <summary className="cursor-pointer text-sm font-semibold">{t("Adjust the creative brief")}</summary>
        <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">{t("Keep intent human-readable. Identity, references, workflow, and route stay automatic.")}</p>
        <textarea
          aria-label={`${t(activeConfig.label)} ${t("creative brief")}`}
          className={`${textAreaClass} mt-3`}
          disabled={mutationContextLocked}
          onChange={(event) => setBriefs((current) => ({
            ...current,
            [activePurpose]: event.target.value,
          }))}
          value={briefs[activePurpose]}
        />
      </details> : null}
      <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <summary className="cursor-pointer text-sm font-semibold">{t("Recent runs and technical lineage")}</summary>
        <div className="mt-3 space-y-2">
          {runs.length ? runs.map((run) => (
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
                runDetailRequestGate.current.invalidate();
                setSelectedRun(null);
                selectRunId(run.id);
                if (isCharacterAssetPurpose(run.purpose)) setActivePurpose(run.purpose);
              }}
              type="button"
            >
              <span className="flex items-center justify-between gap-3">
                <strong>{isCharacterAssetPurpose(run.purpose) ? t(purposeConfig[run.purpose].label) : t(run.purpose)}{pinnedRunIds.has(run.id) ? ` · ${t("Selected in draft")}` : ""}</strong>
                <span>{new Date(run.updatedAt).toLocaleString(adminDateLocale(locale))}</span>
              </span>
              <span className="mt-1 block break-all text-[var(--ad-text-muted)]">
                {run.id} · {run.counts.generated}/{run.counts.total} {t("generated")} · {run.counts.approved} {t("approved")}
              </span>
            </button>
          )) : <p className="text-xs text-[var(--ad-text-muted)]">{t("No production history for this character.")}</p>}
        </div>
        {selectedItem ? (
          <dl className="mt-4 grid gap-2 border-t border-[var(--ad-border)] pt-4 text-xs sm:grid-cols-2">
            <div><dt className="text-[var(--ad-text-muted)]">{t("Generation profile")}</dt><dd className="mt-1 break-all">{selectedItem.lineage.generationProfileKey ?? t("Pending")}</dd></div>
            <div><dt className="text-[var(--ad-text-muted)]">{t("Workflow")}</dt><dd className="mt-1 break-all">{selectedItem.lineage.workflowKey ?? t("Pending")}</dd></div>
            <div><dt className="text-[var(--ad-text-muted)]">{t("Request")}</dt><dd className="mt-1 break-all">{selectedItem.lineage.requestId ?? t("Pending")}</dd></div>
            <div><dt className="text-[var(--ad-text-muted)]">{t("Provider request / Comfy prompt")}</dt><dd className="mt-1 break-all">{selectedItem.lineage.providerRequestId ?? t("Pending")}</dd></div>
            <div><dt className="text-[var(--ad-text-muted)]">{t("Asset")}</dt><dd className="mt-1 break-all">{selectedItem.asset?.id ?? t("Pending")}</dd></div>
          </dl>
        ) : null}
      </details>
    </div>
  );
}
