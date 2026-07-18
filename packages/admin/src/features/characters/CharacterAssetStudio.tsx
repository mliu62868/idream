"use client";

import {
  adminMutationRecoveryVerificationSchema,
  characterDraftImageSelectionRequestSchema,
  characterDraftImageSelectionResultSchema,
  characterIdentityBootstrapRequestSchema,
  characterIdentityBootstrapResponseSchema,
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
  ChevronRight,
  ImageIcon,
  Loader2,
  RefreshCcw,
  ShieldAlert,
  Sparkles,
  ThumbsDown,
  WandSparkles,
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
import { useAdminI18n } from "@/components/admin/i18n";

export const characterAssetPurposes = ["character_cover", "character_hero", "character_chat"] as const;
export type CharacterAssetPurpose = typeof characterAssetPurposes[number];
export const characterAssetStudioLayoutClass =
  "grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[250px_minmax(0,1fr)_320px]";

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
    return "More like this is unavailable because the qualified model profile cannot use the selected image as an init image.";
  }
  if (blocker === "workflow_source_image_unsupported") {
    return "More like this is unavailable because the qualified workflow does not accept a source image.";
  }
  if (blocker === "workflow_source_identity_combination_unsupported") {
    return "More like this is unavailable because the qualified workflow cannot combine a source image with the canonical identity references.";
  }
  if (blocker === "reference_capacity_insufficient") {
    return "More like this is unavailable because the qualified workflow has no remaining reference capacity after the canonical identity references.";
  }
  if (blocker === "reference_slot_assignment_unsupported") {
    return "More like this is unavailable because the qualified workflow cannot map the canonical identity and source image into distinct semantic slots.";
  }
  return "More like this needs a current qualified Character identity route.";
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
    pluralLabel: "portraits",
    description: "The face customers recognize across discovery and the character profile.",
    count: 6,
    orientation: "4:5",
  },
  character_hero: {
    label: "Character hero",
    shortLabel: "Hero",
    pluralLabel: "heroes",
    description: "A wider, expressive scene for the top of the character experience.",
    count: 4,
    orientation: "16:9",
  },
  character_chat: {
    label: "Chat moments",
    shortLabel: "Chat",
    pluralLabel: "chat assets",
    description: "Natural, conversational moments for the relationship experience.",
    count: 6,
    orientation: "4:5",
  },
};

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

function runState(run: CreativeRun | undefined, adopted: boolean) {
  if (adopted) return "selected";
  if (!run) return "not started";
  if (run.counts.approved > 0) return "approved";
  if (["pending", "running"].includes(run.executionOutcome)) return "generating";
  if (run.counts.generated > 0) return "review";
  return run.executionOutcome;
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

function AssetImage({ alt, className, src }: { alt: string; className: string; src: string | null | undefined }) {
  if (!src) return (
    <div className={cn("grid place-items-center bg-black/[0.04] text-[var(--ad-text-muted)]", className)}>
      <ImageIcon aria-hidden="true" className="h-6 w-6" />
      <span className="sr-only">No image asset is available</span>
    </div>
  );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
    <img alt={alt} className={className} src={src} />
  );
}

const identityAuthorityBlockerCodes = new Set([
  "visual_identity_missing",
  "visual_anchor_missing",
  "visual_traits_incomplete",
  "visual_identity_unsealed",
  "reference_set_not_active",
  "reference_set_unsealed",
  "reference_assets_unavailable",
]);

export function isCharacterIdentityAuthorityReady(input: {
  readonly hasIdentity: boolean;
  readonly blockerCodes: readonly string[];
}) {
  return input.hasIdentity &&
    !input.blockerCodes.some((code) => identityAuthorityBlockerCodes.has(code));
}

function IdentityRail({
  data,
  onRepair,
}: {
  data: CharacterWorkspaceDetail;
  onRepair: () => void;
}) {
  const identity = data.visual.activeIdentity;
  const identityBootstrap = data.visual.identityBootstrap;
  const bootstrapMode = identityBootstrap.allowed;
  const bootstrapProfile = identityBootstrap.profile;
  const identityEstablished = isCharacterIdentityAuthorityReady({
    hasIdentity: identity !== null,
    blockerCodes: data.visual.readiness.blockers.map((blocker) => blocker.code),
  });
  const subject = resolveCharacterAssetSubject({
    draftName: data.preview.draft?.name,
    draftDescription: data.preview.draft?.description,
    liveName: data.character.name,
    liveDescription: data.character.description,
  });
  const referenceAssets = data.visual.activeReferenceSet?.references.length
    ? data.visual.activeReferenceSet.references
    : [...data.visual.anchors, ...data.visual.references];
  const unavailableReferenceCount = referenceAssets.filter((asset) => !asset.available).length;
  const canonicalImageUrl = referenceAssets.find((asset) => asset.available)?.thumbnailUrl ??
    referenceAssets.find((asset) => asset.available)?.url ??
    data.preview.draft?.imageUrl ??
    data.character.imageUrl;
  const traitEntries = identity
    ? Object.entries(identity.traits)
      .flatMap(([group, values]) => Object.entries(values).map(([key, value]) => ({ group, key, value })))
      .filter((entry) => typeof entry.value === "string" || typeof entry.value === "number")
      .slice(0, 6)
    : [];

  return (
    <aside className="space-y-4 2xl:sticky 2xl:top-5 2xl:self-start" aria-labelledby="identity-lock-title">
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">Canonical identity</p>
            <h3 className="mt-1 font-semibold" id="identity-lock-title">{subject.name}</h3>
          </div>
          <StatusBadge value={identityEstablished && identity ? `locked v${identity.version}` : identity ? "needs repair" : "not locked"} tone={identityEstablished ? "good" : "warn"} />
        </div>
        <AssetImage
          alt={`${subject.name} canonical portrait`}
          className={cn(
            "mt-4 w-full rounded-lg object-cover",
            canonicalImageUrl ? "aspect-[4/5]" : "h-36",
          )}
          src={canonicalImageUrl}
        />
        {identityEstablished && identity ? <p className="mt-4 text-sm leading-6 text-[var(--ad-text)]">{identity.identityPrompt}</p> : <p className="mt-4 text-sm leading-6 text-[var(--ad-text-muted)]">{bootstrapMode && identity ? `Identity v${identity.version} is an unanchored candidate, not customer authority. Generate and review the first portrait here; the selected result will supersede it as version ${identityBootstrap.nextIdentityVersion}.` : bootstrapMode ? `No identity exists yet. Generate and review the first portrait here; the selected result will become identity version ${identityBootstrap.nextIdentityVersion} without changing the live character.` : "Identity authority needs repair before new customer assets can be generated."}</p>}
        {identityEstablished && traitEntries.length ? <dl className="mt-4 space-y-2 border-t border-[var(--ad-border)] pt-4 text-xs">{traitEntries.map((entry) => <div className="grid grid-cols-[74px_1fr] gap-2" key={`${entry.group}-${entry.key}`}><dt className="capitalize text-[var(--ad-text-muted)]">{entry.key.replaceAll("_", " ")}</dt><dd className="line-clamp-2">{String(entry.value)}</dd></div>)}</dl> : null}
      </section>
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">{identityEstablished ? "Identity references" : identity ? "References need repair" : "Bootstrap route"}</h3><span className="text-xs text-[var(--ad-text-muted)]">{identityEstablished ? `${referenceAssets.length} active` : unavailableReferenceCount > 0 ? `${unavailableReferenceCount} unavailable` : "No references yet"}</span></div>
        <div className="mt-3 grid grid-cols-3 gap-2">{referenceAssets.filter((asset) => asset.available).slice(0, 3).map((asset) => <AssetImage alt={`${subject.name} identity reference`} className="aspect-square w-full rounded-md object-cover" key={asset.mediaAssetId} src={asset.thumbnailUrl ?? asset.url} />)}</div>
        <p className="mt-3 text-xs leading-5 text-[var(--ad-text-muted)]">{identityEstablished ? "The sealed Reference Set is applied automatically and pinned into every generated candidate." : bootstrapMode && bootstrapProfile ? `${bootstrapProfile.label} creates the first portrait without pretending an identity reference already exists.` : bootstrapMode ? "No active text-to-image bootstrap profile is available." : unavailableReferenceCount > 0 ? "The Reference Set is only partially available, so generation is blocked until every reference is repaired or removed." : "Open Visual Identity to resolve the existing authority blockers."}</p>
        {!identityEstablished && identity ? <div className="mt-3"><WorkspaceButton onClick={onRepair}>Repair visual authority</WorkspaceButton></div> : null}
      </section>
    </aside>
  );
}

function CustomerPreviews({
  activePurpose,
  candidateImageUrl,
  data,
}: {
  activePurpose: CharacterAssetPurpose;
  candidateImageUrl: string | null;
  data: CharacterWorkspaceDetail;
}) {
  const name = data.preview.draft?.name ?? data.character.name;
  const description = data.preview.draft?.description ?? data.character.description;
  const previewAssets = resolveCharacterCustomerPreviewAssets({
    activePurpose,
    candidateImageUrl,
    draftAssets: {
      character_cover: data.preview.draft?.assetPack?.character_cover?.imageUrl,
      character_hero: data.preview.draft?.assetPack?.character_hero?.imageUrl,
      character_chat: data.preview.draft?.assetPack?.character_chat?.imageUrl,
    },
  });
  const coverImageUrl = previewAssets.character_cover;
  const heroImageUrl = previewAssets.character_hero;
  const chatImageUrl = previewAssets.character_chat;
  return (
    <aside className="space-y-4 2xl:sticky 2xl:top-5 2xl:self-start" aria-labelledby="customer-preview-title">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">Customer surfaces</p>
        <h3 className="mt-1 font-semibold" id="customer-preview-title">See the decision in context</h3>
      </div>
      <section className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[#181816] text-white">
        <AssetImage alt={`${name} discovery card preview`} className="aspect-[4/3] w-full object-cover" src={coverImageUrl} />
        <div className="p-4"><p className="text-[11px] uppercase tracking-[0.14em] text-white/55">Discovery card · portrait slot</p><h4 className="mt-1 text-lg font-semibold">{name}</h4><p className="mt-1 line-clamp-2 text-xs leading-5 text-white/65">{description}</p>{!coverImageUrl ? <p className="mt-3 text-xs font-semibold text-amber-200">Primary portrait not selected</p> : null}</div>
      </section>
      <section className="relative min-h-52 overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[#24231f] text-white">
        <AssetImage alt={`${name} character hero preview`} className="absolute inset-0 h-full w-full object-cover opacity-70" src={heroImageUrl} />
        <div className="absolute inset-x-0 bottom-0 bg-black/70 p-4"><p className="text-[11px] uppercase tracking-[0.14em] text-white/60">Character hero · hero slot</p><h4 className="mt-1 text-xl font-semibold">Meet {name}</h4>{!heroImageUrl ? <p className="mt-2 text-xs font-semibold text-amber-200">Hero image not selected</p> : null}<span className="mt-3 inline-flex min-h-9 items-center rounded-full bg-white px-4 text-xs font-semibold text-black">Start chatting</span></div>
      </section>
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3">
        <div className="flex items-center gap-3 border-b border-[var(--ad-border)] pb-3"><AssetImage alt={`${name} chat avatar preview`} className="h-11 w-11 rounded-full object-cover" src={coverImageUrl} /><div><p className="text-[11px] uppercase tracking-[0.12em] text-[var(--ad-text-muted)]">Chat header · portrait slot</p><p className="font-semibold">{name}</p></div></div>
        <AssetImage alt={`${name} chat moment preview`} className="mt-3 aspect-[4/5] max-h-64 w-full rounded-lg object-cover" src={chatImageUrl} />
        {!chatImageUrl ? <p className="mt-2 text-xs font-semibold text-[var(--ad-yellow-text)]">Chat image not selected</p> : null}
        <div className="mt-3 max-w-[88%] rounded-2xl rounded-tl-sm bg-black/[0.05] px-3 py-2 text-xs leading-5">{String(data.preview.draft?.opening.firstMessage ?? "Opening message unavailable")}</div>
      </section>
      <p className="text-xs leading-5 text-[var(--ad-text-muted)]">The selected candidate is shown only in its intended slot. Every other surface uses its own exact draft slot or shows that the slot is missing. Nothing live changes until a reviewed Release is published.</p>
    </aside>
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
  const { t } = useAdminI18n();
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
    character_cover: `A definitive primary portrait of ${subject.name}. ${subject.description}`,
    character_hero: `A cinematic but natural hero scene for ${subject.name}, preserving the canonical identity and personality.`,
    character_chat: `A warm, candid conversational moment with ${subject.name}, preserving the canonical identity and feeling emotionally present.`,
  }));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"generate" | "review" | "select" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
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
  }, []);
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
  }, [data.character.id, data.project.draftAssetSelections, pinnedRunIds, updateRunCreationIntentState]);

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

  const recentByPurpose = useMemo(() => Object.fromEntries(characterAssetPurposes.map((purpose) => [purpose, runs.find((run) => run.purpose === purpose)])) as Record<CharacterAssetPurpose, CreativeRun | undefined>, [runs]);
  const activeRunDetail = selectedRun?.id === selectedRunId ? selectedRun : null;
  const selectedItem = activeRunDetail?.items[selectedIndex] ?? null;
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
  const selectedImageUrl = selectedItem?.asset?.url ?? selectedItem?.asset?.thumbnailUrl ?? null;
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
  const isApprovedItem = selectedItem?.review?.decision === "approved" && (
    bootstrapMode
      ? selectedItem.review.identityConsistency === "unscored"
      : selectedItem.review.identityConsistency === "passed"
  ) && Boolean(
    selectedItem.review.quality &&
    Object.values(selectedItem.review.quality).every(Boolean),
  );
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
    const count = bootstrapMode
      ? 4
      : referenceAssetIds.length
        ? 4
        : purposeConfig[purpose].count;
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
    const validScore = numericScore !== undefined && Number.isInteger(numericScore) && numericScore >= 0 && numericScore <= 100;
    if (reviewDraft.reason.trim().length < 3 || (decision === "approved" && !validScore)) {
      setError(decision === "approved"
        ? "Approval requires an integer score from 0 to 100 and concrete visible evidence."
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

  if (!permissions.read) return <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8"><ShieldAlert className="h-6 w-6" /><h3 className="mt-4 font-semibold">No asset workspace permission</h3><p className="mt-2 text-sm text-[var(--ad-text-muted)]">creative.run.read is required to see character production.</p></section>;
  if (loading) return <section aria-busy="true" className="grid min-h-80 place-items-center rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading character assets</span></section>;
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
        : `Generate ${bootstrapMode ? 4 : activeConfig.count} ${activeConfig.pluralLabel}`;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-5" aria-labelledby="asset-pack-title">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t(bootstrapMode ? "First identity portrait" : "Character asset pack")}</p><h3 className="mt-1 text-xl font-semibold" id="asset-pack-title">{t(bootstrapMode ? "Establish the face customers will recognize" : "Create the images customers will remember")}</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">{t(bootstrapMode ? `Generate the first portrait without references, review it as the identity definition, then commit it as identity version ${identityBootstrap.nextIdentityVersion}.` : "Generate against the sealed identity reference set, compare real candidates in customer context, then make one clear decision.")}</p></div>
          <div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy !== null} onClick={() => void refreshWorkspace()}><RefreshCcw className="h-4 w-4" /> {t("Refresh")}</WorkspaceButton><WorkspaceButton disabled={!canUseGenerationAction || busy !== null || (!runCreationIntent && !briefs[activePurpose].trim()) || Boolean(reviewMutationIntent || selectionMutationIntent)} onClick={() => void createRun(activePurpose)} tone="primary"><WandSparkles className="h-4 w-4" /> {t(generationActionLabel)}</WorkspaceButton></div>
        </div>
        {bootstrapMode ? <div className={cn("mt-4 rounded-lg p-3 text-sm", bootstrapProfile ? "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]" : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]")}>{bootstrapProfile ? `${bootstrapProfile.label} · ${bootstrapProfile.orientation} · ${t(identityBootstrap.state === "recoverable_empty_history" ? `no reference input. The reviewed result will supersede the unanchored candidate history as identity version ${identityBootstrap.nextIdentityVersion}.` : "no reference input. The reviewed result becomes the reference authority.")}` : t("No active text-to-image bootstrap profile is available. Generation remains blocked until one is published.")}</div> : data.project.draftAssetRouteAuthority?.status === "stale" ? <div className="mt-4 flex flex-col gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:flex-row sm:items-center sm:justify-between"><span>{t(`The qualified route changed. ${data.project.draftAssetRouteAuthority.stalePurposes.length} selected asset${data.project.draftAssetRouteAuthority.stalePurposes.length === 1 ? "" : "s"} remain in history but cannot authorize QA.`)}</span><WorkspaceButton disabled={!canGenerate || busy !== null} onClick={regenerateUnderCurrentRoute}>{t("Regenerate under current route")}</WorkspaceButton></div> : identityBootstrap.state === "blocked_existing_authority" && !data.visual.readiness.ready ? <div className="mt-4 flex flex-col gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:flex-row sm:items-center sm:justify-between"><span>{t(`Existing identity authority needs repair: ${identityBootstrap.blockers.join(", ") || "visual evidence is incomplete"}.`)}</span><WorkspaceButton onClick={() => onContinue("visual")}>{t("Repair visual authority")}</WorkspaceButton></div> : !data.visual.readiness.ready || !qualifiedRoute ? <div className="mt-4 flex flex-col gap-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:flex-row sm:items-center sm:justify-between"><span>{t("Generation needs a sealed identity, active references, and a reference-capable qualified route.")}</span><WorkspaceButton onClick={() => onContinue("visual")}>{t("Complete visual setup")}</WorkspaceButton></div> : null}
        <div className="mt-5 grid gap-2 md:grid-cols-3">{characterAssetPurposes.map((purpose, index) => { const routeCurrent = data.project.draftAssetSelections?.[purpose]?.routeCurrent !== false; const adopted = routeCurrent && Boolean(data.project.draftAssetPack[purpose] ?? (purpose === "character_cover" ? data.project.draftImageAssetId : null)); const state = bootstrapMode && purpose !== "character_cover" ? "locked until identity" : !routeCurrent && data.project.draftAssetPack[purpose] ? "regenerate" : runState(recentByPurpose[purpose], adopted); const purposeLocked = mutationContextLocked || (bootstrapMode && purpose !== "character_cover"); return <button aria-disabled={purposeLocked} aria-pressed={activePurpose === purpose} className={cn("flex min-h-20 items-center gap-3 rounded-lg border p-3 text-left transition focus-visible:outline focus-visible:outline-2", activePurpose === purpose ? "border-[var(--ad-ink)] bg-black/[0.035]" : "border-[var(--ad-border)] hover:border-[var(--ad-text-muted)]", purposeLocked && "cursor-not-allowed opacity-50")} disabled={purposeLocked} key={purpose} onClick={() => choosePurpose(purpose)} type="button"><span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-semibold", ["selected", "approved"].includes(state) ? "border-[var(--ad-green-text)] bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]" : "border-[var(--ad-border)]")}>{["selected", "approved"].includes(state) ? <Check className="h-4 w-4" /> : index + 1}</span><span className="min-w-0 flex-1"><strong className="block text-sm">{t(purposeConfig[purpose].label)}</strong><span className="mt-1 block text-xs capitalize text-[var(--ad-text-muted)]">{t(state)}</span></span><ChevronRight className="h-4 w-4 text-[var(--ad-text-muted)]" /></button>; })}</div>
      </section>

      {error ? <p className="rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
      {runCreationIntent?.committedTargetId ? <p className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm" role="status">Created Run receipt: <span className="font-medium">{runCreationIntent.committedTargetId}</span>. Verify its projection before starting another generation intent.</p> : null}
      {reviewMutationIntent ? <div className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between" role="status"><span>{reviewIntentNeedsReconciliation ? "This saved review is aged or no longer matches the active contract. Reconcile its server receipt before another decision." : reviewMutationIntent.status === "committed_projection_pending" ? "Review receipt is committed; verify the exact decision in the latest Run projection." : "Review submission is ready to resume with the same request key."}</span><WorkspaceButton disabled={!permissions.review || busy !== null} onClick={() => void resumeReviewMutation()}>{reviewIntentNeedsReconciliation ? "Reconcile review" : reviewMutationIntent.status === "committed_projection_pending" ? "Verify review" : "Resume review"}</WorkspaceButton></div> : null}
      {selectionMutationIntent ? <div className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between" role="status"><span>{selectionIntentNeedsReconciliation ? "This saved selection is aged or no longer matches the active contract. Reconcile its server receipt before another selection." : selectionMutationIntent.status === "committed_projection_pending" ? "Selection receipt is committed; verify it against current Character authority." : "Asset selection is ready to resume with the same request key."}</span><WorkspaceButton disabled={!permissions.selectDraft || busy !== null} onClick={() => void resumeSelectionMutation()}>{selectionIntentNeedsReconciliation ? "Reconcile selection" : selectionMutationIntent.status === "committed_projection_pending" ? "Verify selection" : "Resume selection"}</WorkspaceButton></div> : null}
      {refreshWarning ? <p className="rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]" role="status">{refreshWarning}</p> : null}
      {message ? <p className="rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">{message}</p> : null}

      <div className={characterAssetStudioLayoutClass}>
        <div className="order-2 lg:col-start-2 lg:row-start-1 2xl:order-1 2xl:col-start-1"><IdentityRail data={data} onRepair={() => onContinue("visual")} /></div>
        <section className="order-1 min-w-0 space-y-4 lg:col-start-1 lg:row-span-2 lg:row-start-1 2xl:order-2 2xl:col-start-2 2xl:row-span-1" aria-label="Asset candidates and decisions">
          <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="candidate-title">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">{t(activeConfig.label)}</p><h3 className="mt-1 font-semibold" id="candidate-title">{selectedItem ? `${t("Candidate")} ${selectedItem.ordinal + 1}` : t("Ready for a first run")}</h3><p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{selectedItem ? t(candidateState(selectedItem)) : t(activeConfig.description)}</p></div>{activeRunDetail ? <div className="flex flex-wrap gap-2"><StatusBadge value={activeRunDetail.executionOutcome} /><StatusBadge value={activeRunDetail.reviewState} /></div> : null}</div>
            <div className="mt-4 border-y border-[var(--ad-border)] py-3"><div className="flex flex-wrap gap-2"><WorkspaceButton disabled={mutationContextLocked || bootstrapMode || !variationRouteReady || !canGenerate || busy !== null || !selectedItem?.asset || !isApprovedItem} onClick={() => selectedItem?.asset ? void createRun(activePurpose, [selectedItem.asset.id]) : undefined}><Sparkles className="h-4 w-4" /> {t("More like this")}</WorkspaceButton><WorkspaceButton disabled={mutationContextLocked || !canUseDecisionAction || busy !== null || Boolean(refreshWarning)} onClick={() => void approveAndContinue()} tone="primary">{busy === "select" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {t(decisionActionLabel)}</WorkspaceButton></div>{!bootstrapMode && qualifiedRoute && !variationRouteReady ? <div className="mt-2 flex flex-col gap-2 text-xs leading-5 text-[var(--ad-text-muted)] sm:flex-row sm:items-center sm:justify-between"><p>{t(characterSourceVariationBlockerMessage(variationRouteBlocker))}</p><WorkspaceButton onClick={() => onContinue("visual")}>{t("Review generation route")}</WorkspaceButton></div> : null}</div>
            <div className="mt-4 overflow-hidden rounded-lg bg-[#11110f]">
              {selectedItem?.asset ? <AssetImage alt={`${subject.name} ${t(activeConfig.label)} ${t("Candidate")} ${selectedItem.ordinal + 1}`} className="max-h-[68vh] min-h-96 w-full object-contain" src={selectedItem.asset.url} /> : <div className="grid min-h-96 place-items-center px-6 text-center text-white/65"><div><Sparkles className="mx-auto h-7 w-7" /><p className="mt-3 text-sm">{t("Generate a focused batch, then decide from real candidates here.")}</p></div></div>}
            </div>
            {activeRunDetail?.items.length ? <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label={t("Generated candidates")}>{activeRunDetail.items.map((item, index) => <button aria-label={`${t("Select candidate")} ${item.ordinal + 1}`} aria-pressed={selectedIndex === index} className={cn("relative h-20 w-16 shrink-0 overflow-hidden rounded-md border-2", selectedIndex === index ? "border-[var(--ad-ink)]" : "border-transparent opacity-75 hover:opacity-100")} disabled={mutationContextLocked} key={item.id} onClick={() => setSelectedIndex(index)} type="button"><AssetImage alt="" className="h-full w-full object-cover" src={item.asset?.thumbnailUrl ?? item.asset?.url} />{item.review?.decision === "approved" ? <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[var(--ad-green-text)] text-white"><Check className="h-3 w-3" /></span> : null}</button>)}</div> : null}
            {selectedItem?.asset && (!hasDecision || !hasCompleteReviewEvidence) ? (
              <section
                aria-labelledby="character-candidate-review-title"
                className="mt-4 rounded-lg border border-[var(--ad-border)] bg-black/[0.02] p-4"
              >
                <h4 className="text-sm font-semibold" id="character-candidate-review-title">{t("Record the visible review evidence")}</h4>
                <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
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
                <fieldset className="mt-3 grid gap-2 sm:grid-cols-2">
                  <legend className="sr-only">{t("Required visible quality checks")}</legend>
                  {reviewQualityChecks.map(([key, label]) => (
                    <label className="flex min-h-11 items-center gap-3 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-xs" key={key}>
                      <input
                        checked={reviewDraft.quality[key]}
                        onChange={(event) => updateReviewDraft((current) => ({
                          ...current,
                          quality: { ...current.quality, [key]: event.target.checked },
                        }))}
                        type="checkbox"
                      />
                      <span>{t(label)}</span>
                    </label>
                  ))}
                </fieldset>
                <div className="mt-3 grid gap-3 sm:grid-cols-[120px_180px_1fr]">
                  <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Score")}
                    <input
                      className={`${fieldClass} mt-1`}
                      max={100}
                      min={0}
                      onChange={(event) => updateReviewDraft((current) => ({ ...current, score: event.target.value }))}
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
                  <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Evidence and reason")}
                    <textarea
                      className={`${textAreaClass} mt-1`}
                      onChange={(event) => updateReviewDraft((current) => ({ ...current, reason: event.target.value }))}
                      placeholder={t("Describe artifacts, subject count, identity markers, composition, and intended customer context")}
                      value={reviewDraft.reason}
                    />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <WorkspaceButton
                    disabled={
                      mutationContextLocked ||
                      !permissions.review ||
                      busy !== null ||
                      Boolean(refreshWarning) ||
                      !reviewDraft.score.trim() ||
                      reviewDraft.reason.trim().length < 3 ||
                      !Number.isInteger(Number(reviewDraft.score)) ||
                      Number(reviewDraft.score) < 0 ||
                      Number(reviewDraft.score) > 100 ||
                      Object.values(reviewDraft.quality).some((passed) => !passed)
                    }
                    onClick={() => void reviewItem("approved")}
                    tone="primary"
                  >
                    <Check className="h-4 w-4" /> {t(hasDecision ? "Record superseding approval" : "Approve with evidence")}
                  </WorkspaceButton>
                  <WorkspaceButton
                    disabled={mutationContextLocked || !permissions.review || busy !== null || Boolean(refreshWarning) || reviewDraft.reason.trim().length < 3}
                    onClick={() => void reviewItem("rejected")}
                    tone="danger"
                  >
                    <ThumbsDown className="h-4 w-4" /> {t(hasDecision ? "Record superseding rejection" : "Reject with reason")}
                  </WorkspaceButton>
                </div>
              </section>
            ) : selectedItem?.review ? (
              <div className="mt-4 rounded-lg bg-black/[0.035] p-3 text-xs leading-5">
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
                          reviewDraft.reason.trim().length < 3
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
            {!permissions.review || !permissions.selectDraft ? <p className="mt-3 text-xs text-[var(--ad-text-muted)]">{t("Review and project-write grants control approval and primary image selection.")}</p> : null}
          </section>

          <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><summary className="cursor-pointer text-sm font-semibold">{t("Adjust the creative brief")}</summary><p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">{t("Keep intent human-readable. Identity, references, workflow, and route stay automatic.")}</p><textarea aria-label={`${t(activeConfig.label)} ${t("creative brief")}`} className={`${textAreaClass} mt-3`} disabled={mutationContextLocked} onChange={(event) => setBriefs((current) => ({ ...current, [activePurpose]: event.target.value }))} value={briefs[activePurpose]} /></details>
          <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><summary className="cursor-pointer text-sm font-semibold">{t("Recent runs and technical lineage")}</summary><div className="mt-3 space-y-2">{runs.length ? runs.map((run) => <button className={cn("w-full rounded-lg border p-3 text-left text-xs", selectedRunId === run.id ? "border-[var(--ad-ink)] bg-black/[0.03]" : "border-[var(--ad-border)]")} disabled={mutationContextLocked} key={run.id} onClick={() => { runDetailRequestGate.current.invalidate(); setSelectedRun(null); selectRunId(run.id); if (isCharacterAssetPurpose(run.purpose)) setActivePurpose(run.purpose); }} type="button"><span className="flex items-center justify-between gap-3"><strong>{isCharacterAssetPurpose(run.purpose) ? t(purposeConfig[run.purpose].label) : t(run.purpose)}{pinnedRunIds.has(run.id) ? ` · ${t("Selected in draft")}` : ""}</strong><span>{new Date(run.updatedAt).toLocaleString()}</span></span><span className="mt-1 block break-all text-[var(--ad-text-muted)]">{run.id} · {run.counts.generated}/{run.counts.total} {t("generated")} · {run.counts.approved} {t("approved")}</span></button>) : <p className="text-xs text-[var(--ad-text-muted)]">{t("No production history for this character.")}</p>}</div>{selectedItem ? <dl className="mt-4 grid gap-2 border-t border-[var(--ad-border)] pt-4 text-xs sm:grid-cols-2"><div><dt className="text-[var(--ad-text-muted)]">{t("Generation profile")}</dt><dd className="mt-1 break-all">{selectedItem.lineage.generationProfileKey ?? t("Pending")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Workflow")}</dt><dd className="mt-1 break-all">{selectedItem.lineage.workflowKey ?? t("Pending")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Request")}</dt><dd className="mt-1 break-all">{selectedItem.lineage.requestId ?? t("Pending")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Provider request / Comfy prompt")}</dt><dd className="mt-1 break-all">{selectedItem.lineage.providerRequestId ?? t("Pending")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Asset")}</dt><dd className="mt-1 break-all">{selectedItem.asset?.id ?? t("Pending")}</dd></div></dl> : null}</details>
        </section>
        <div className="order-3 lg:col-start-2 2xl:col-start-3 2xl:row-start-1"><CustomerPreviews activePurpose={activePurpose} candidateImageUrl={selectedImageUrl} data={data} /></div>
      </div>
    </div>
  );
}
