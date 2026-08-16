// SPEC: Character Asset Studio 的纯判定层 —— 零 React，全部由 CharacterAssetStudio.test.ts 覆盖。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出（同目录已有 character-workspace-format.ts、
//         portfolio-query.ts 等先例）。纯机械搬运，没有任何行为改动。
import {
  CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
  adminMutationRecoveryVerificationSchema,
  characterDraftImageSelectionRequestSchema,
  characterIdentityBootstrapRequestSchema,
  creativeReviewDecisionRequestSchema,
  creativeRunCreateRequestSchema,
  type CharacterWorkspaceDetail,
  type CreativeRun,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import type { DurableMutationIntent } from "@/lib/durable-mutation-intent";

export const characterAssetPurposes = ["character_cover", "character_hero", "character_chat"] as const;
export type CharacterAssetPurpose = typeof characterAssetPurposes[number];
export const characterAssetStudioLayoutClass =
  "grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]";

type CharacterAssetRunChoice = Pick<
  CreativeRun,
  "id" | "purpose" | "lifecycleState" | "executionOutcome" | "reviewState" | "counts"
>;

export function preferredCharacterAssetRunId(input: {
  readonly runs: readonly CharacterAssetRunChoice[];
  readonly purpose: CharacterAssetPurpose;
  readonly pinnedRunId?: string | null;
}) {
  const purposeRuns = input.runs.filter((run) => run.purpose === input.purpose);
  // INVARIANT: 草稿选择是发布候选权威，不是审核焦点权威。新活跃 Run 只要仍有
  // 生成、审核或采用动作，就必须先展示；否则运营会误把旧草稿当成刚生成的候选。
  const actionable = purposeRuns.find((run) =>
    run.id !== input.pinnedRunId &&
    run.lifecycleState === "active" &&
    (
      run.executionOutcome !== "succeeded" ||
      run.reviewState !== "complete" ||
      run.counts.approved > run.counts.placed
    )
  );
  return actionable?.id ??
    input.pinnedRunId ??
    purposeRuns[0]?.id ??
    null;
}

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

export type CharacterAssetProjectMutation = <T>(input: {
  readonly action: string;
  readonly commit: () => Promise<T>;
  readonly afterRefresh?: () => void;
}) => Promise<{ readonly result: T; readonly refreshed: boolean }>;

export const purposeConfig: Record<CharacterAssetPurpose, {
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

export const reviewQualityChecks = [
  ["artifactFree", "No visible artifacts"],
  ["singleSubject", "Exactly one intended subject"],
  ["intentMatch", "Composition matches the customer intent"],
  ["noVisibleText", "No visible text, watermark, or contact sheet"],
] as const;

export type ReviewQuality = Record<(typeof reviewQualityChecks)[number][0], boolean>;
export type ReviewDraft = {
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

export function emptyReviewDraft(bootstrapMode: boolean): ReviewDraft {
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

// SPEC: 「下一张该做的图」只有一个口径 —— 服务端 journey 投影的 assetPack.draft.missingPurposes。
// INTENT: 前端曾用 project.draftAssetPack 自己推一遍顺序，只过滤 routeCurrent，不过滤资产可用性
// （软删 / 归属不对）。资产被软删时服务端说缺 cover、前端把运营带去 hero；同一屏的按钮文案用
// 过滤后的 pack、点击行为用未过滤的 pack，说「下一个资产」却跳到别处。推导留在服务端一份。
// 返回 null = 图池在当前路线下已齐，下一步是 Launch preview。
export function nextIncompleteCharacterAssetPurpose(
  journey: CharacterWorkspaceDetail["journey"],
): CharacterAssetPurpose | null {
  return journey.assetPack.draft.missingPurposes[0] ?? null;
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

export function characterAssetReviewIntentSnapshot(value: unknown) {
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

export function characterAssetSelectionIntentSnapshot(value: unknown) {
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

export function characterAssetSelectionRecoveryVerification(value: unknown) {
  const parsed = adminMutationRecoveryVerificationSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.kind === "character_identity_bootstrap" ||
    parsed.data.kind === "character_draft_image_selection"
    ? parsed.data
    : null;
}

export function characterAssetSelectionIntentCommandType(
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

export function isCharacterAssetPurpose(value: string): value is CharacterAssetPurpose {
  return characterAssetPurposes.includes(value as CharacterAssetPurpose);
}

export function committedCharacterRunProjectionMatches(
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

// SPEC: 已提交的 Run 暂时读不到 ≠ 提交失败。文案必须点明「重试校验即可，不要再发一次
//       create」——否则运营台上的人会去点第二次生成，制造重复 Run。
export function committedRunProjectionUnavailable(detail: string | null) {
  return detail
    ? `The committed Run projection is still unavailable: ${detail}. Verification can be retried without another create request.`
    : "The committed Run projection is still unavailable. Verification can be retried without another create request.";
}

export function candidateState(item: CreativeRunDetail["items"][number]) {
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
  | "failed"
  | "ready";

export function resolveCharacterCandidateVisualState(input: {
  readonly active: boolean;
  readonly comparison: boolean;
  readonly draft: boolean;
  readonly decision: "approved" | "rejected" | null;
  readonly failed?: boolean;
}): CharacterCandidateVisualState {
  if (input.active) return "active";
  if (input.comparison) return "comparison";
  if (input.draft) return "draft";
  if (input.decision === "approved") return "approved";
  if (input.decision === "rejected") return "rejected";
  // INTENT: 失败候选原先落进 "ready" 兜底，缩略图和成功的候选长得一模一样、只是没图。
  if (input.failed) return "failed";
  return "ready";
}

// 与后端 workspace.ts 的生图闸同口径：密封 hash（*_unsealed）是发布级检查，不拦打磨。
export const identityAuthorityBlockerCodes = new Set([
  "visual_identity_missing",
  "visual_anchor_missing",
  "visual_traits_incomplete",
  "reference_set_not_active",
  "reference_assets_unavailable",
]);

export const imageReadinessActionByBlocker: Readonly<Record<string, string>> = {
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
