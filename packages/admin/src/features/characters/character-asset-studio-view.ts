// SPEC: Character Asset Studio 的纯视图推导 —— 只读入参，不发请求、不持有状态。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出，纯机械搬运，没有任何行为改动。
import {
  creativeRunCreateRequestSchema,
  type CharacterWorkspaceDetail,
  type CreativeRun,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import type { AdminI18nContextValue } from "@/components/admin/i18n";
import type { DurableMutationIntent } from "@/lib/durable-mutation-intent";
import { purposeConfig, type CharacterAssetPurpose } from "./character-asset-studio-authority";

export type CharacterAssetStudioBusy = "generate" | "select" | "prepare" | null;

export type CharacterAssetExistingImage = {
  readonly id: string;
  readonly url: string;
  readonly thumbnailUrl: string;
};

export function characterAssetExistingImages(
  data: CharacterWorkspaceDetail,
  activePurpose: CharacterAssetPurpose,
) {
  const images: CharacterAssetExistingImage[] = [];
  const seen = new Set<string>();
  const add = (
    id: string,
    url: string | null | undefined,
    thumbnailUrl: string | null | undefined = url,
  ) => {
    const displayUrl = url ?? thumbnailUrl;
    if (!displayUrl || seen.has(displayUrl)) return;
    seen.add(displayUrl);
    images.push({
      id,
      url: displayUrl,
      thumbnailUrl: thumbnailUrl ?? displayUrl,
    });
  };
  const references = [
    ...(data.visual.activeReferenceSet?.references ?? []),
    ...data.visual.anchors,
    ...data.visual.references,
    ...(data.visual.videoSources ?? []),
  ];
  const preferredAssetId =
    data.project.draftAssetPack[activePurpose] ??
    (activePurpose === "character_cover"
      ? data.project.draftImageAssetId
      : null);
  const preferred = references.find(
    (reference) =>
      reference.mediaAssetId === preferredAssetId && reference.available,
  );
  if (preferred)
    add(preferred.mediaAssetId, preferred.url, preferred.thumbnailUrl);
  add(`${data.character.id}:primary`, data.character.imageUrl);
  add(`${data.character.id}:draft`, data.preview.draft?.imageUrl);
  for (const reference of references) {
    if (!reference.available) continue;
    add(reference.mediaAssetId, reference.url, reference.thumbnailUrl);
  }
  return images;
}

// A purpose is busy while any of its Runs is pending or running; the exact
// selected projection wins over its (possibly older) list entry.
export function characterAssetRequestInProgress(
  activeRuns: readonly CreativeRun[],
  selectedRun: CreativeRunDetail | null,
  purpose: CharacterAssetPurpose,
) {
  return activeRuns.some((run) => run.purpose === purpose && ["pending", "running"].includes(
    selectedRun?.id === run.id ? selectedRun.executionOutcome : run.executionOutcome,
  )) || (selectedRun?.purpose === purpose && ["pending", "running"].includes(selectedRun.executionOutcome));
}

export type CharacterAssetGenerationAction = {
  readonly text: string;
  readonly disabled: boolean;
  readonly description: string;
  readonly descriptionId: string;
};

// SPEC: 生成按钮的文案、禁用态与禁用原因读同一组输入，三处按钮共用这一份。
export function characterAssetGenerationAction(input: {
  readonly activePurpose: CharacterAssetPurpose;
  readonly batchCount: 1 | 2 | 4;
  readonly bootstrapMode: boolean;
  readonly bootstrapProfile: CharacterWorkspaceDetail["visual"]["identityBootstrap"]["profile"];
  readonly brief: string;
  readonly busy: CharacterAssetStudioBusy;
  readonly canCreate: boolean;
  readonly canUseGenerationAction: boolean;
  readonly characterId: string;
  readonly imageRequestInProgress: boolean;
  readonly productionBlocked: boolean;
  readonly qualifiedRoute: CharacterWorkspaceDetail["visual"]["routeQualifications"][number] | null;
  readonly refreshWarning: string | null;
  readonly runCreationIntent: DurableMutationIntent | null;
  readonly selectionMutationIntent: DurableMutationIntent | null;
  readonly t: AdminI18nContextValue["t"];
  readonly unconfirmedOperations: readonly unknown[];
}): CharacterAssetGenerationAction {
  const {
    activePurpose,
    batchCount,
    bootstrapMode,
    bootstrapProfile,
    brief,
    busy,
    canUseGenerationAction,
    imageRequestInProgress,
    productionBlocked,
    qualifiedRoute,
    refreshWarning,
    runCreationIntent,
    selectionMutationIntent,
    t,
    unconfirmedOperations,
  } = input;
  const activeConfig = purposeConfig[activePurpose];
  const runIntentNeedsReconciliation = Boolean(
    runCreationIntent &&
    (runCreationIntent.status === "reconciliation_required" ||
      !creativeRunCreateRequestSchema.safeParse(
        runCreationIntent.requestSnapshot,
      ).success),
  );
  const generationActionLabel = runIntentNeedsReconciliation
    ? "Reconcile saved request"
    : runCreationIntent?.status === "outcome_unknown" ||
        runCreationIntent?.status === "submitting"
      ? "Resume generation"
      : runCreationIntent?.status === "committed_projection_pending"
        ? "Verify created Run"
        : unconfirmedOperations.length > 0
          ? "Generation result awaiting confirmation"
          : imageRequestInProgress
          ? "Image request in progress"
          : null;
  const generationActionText = generationActionLabel
    ? t(generationActionLabel)
    : !bootstrapMode && batchCount > 1
      ? t("Generate {count} images", { count: batchCount })
      : t("Generate {count} {assetType}", { count: 1, assetType: t(activeConfig.pluralLabel) });
  const generationActionDescriptionId = `character-generation-action-${input.characterId}`;
  const generationActionDisabled =
    !canUseGenerationAction ||
    unconfirmedOperations.length > 0 ||
    busy !== null ||
    (!runCreationIntent && !brief.trim()) ||
    Boolean(selectionMutationIntent);
  const generationActionDescription =
    unconfirmedOperations.length > 0
      ? "The provider result is not confirmed. Check the generation task before starting another image."
      : busy !== null
      ? "Wait for the current image-production action to finish."
      : selectionMutationIntent
          ? "Resolve the saved selection before starting another generation."
          : !input.canCreate
            ? "creative.run.create permission is required."
            : !runCreationIntent && !brief.trim()
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
                        : "The generation runtime is checked before any Run is created.";
  return {
    text: generationActionText,
    disabled: generationActionDisabled,
    description: generationActionDescription,
    descriptionId: generationActionDescriptionId,
  };
}
