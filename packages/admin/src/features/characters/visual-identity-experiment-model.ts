import {
  creativeRunCreateRequestSchema,
  type CharacterImageSourceAsset,
  type CharacterWorkspaceDetail,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import type { DurableMutationIntent } from "@/lib/durable-mutation-intent";

export type ExperimentMode = "text_to_image" | "image_to_image";
export type SeedStrategy = "random" | "locked" | "reuse_source";

export const RANDOM_SEED_LIMIT = 2_147_483_647;

// INVARIANT: 常量空数组，避免"资源尚未到达"每次渲染都产生新引用而触发下游重算。
export const EMPTY_SOURCE_OPTIONS: SourceOption[] = [];

// SPEC: `label` 已是可直接渲染的文案——上传图用文件名，其余在构造处过 t()。
// INTENT: 同一个字段混着「翻译键」和「用户文件名」时，渲染处没法判断该不该再 t() 一次。
export type SourceOption = {
  readonly id: string;
  readonly label: string;
  readonly url: string | null;
  readonly seed: string | null;
};

export function uploadedSourceOption(asset: CharacterImageSourceAsset): SourceOption {
  return {
    id: asset.id,
    label: asset.filename,
    url: asset.thumbnailUrl ?? asset.url,
    seed: null,
  };
}

export function sourceRoleLabel(
  role: CharacterWorkspaceDetail["visual"]["anchors"][number]["role"],
) {
  if (role === "primary_face") return "Primary portrait";
  if (role === "identity_anchor") return "Identity anchor";
  return "Identity reference";
}

export function randomSeed(previous?: string) {
  const candidate = Math.floor(Math.random() * RANDOM_SEED_LIMIT);
  if (String(candidate) !== previous) return String(candidate);
  return String((candidate + 1) % RANDOM_SEED_LIMIT);
}

// INTENT: Visual Profile 的 defaultSeed 是身份稳定键；运营字段承诺的是数值基准种子。
// 哈希后仍可跨刷新稳定复现，同时不把 `character:…:visual:…` 暴露成“随机种子”。
export function numericComposerSeed(seed: string | null | undefined) {
  if (!seed) return randomSeed();
  const numeric = Number(seed);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return String(numeric);

  let hash = 2_166_136_261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return String((hash >>> 0) % RANDOM_SEED_LIMIT);
}

export function runSettled(run: CreativeRunDetail) {
  return run.items.every(
    (item) =>
      item.executionState === "ready" || item.executionState === "failed",
  );
}

export type ExperimentRequest = ReturnType<typeof creativeRunCreateRequestSchema.parse>;

export function savedExperimentRequest(intent: Pick<DurableMutationIntent, "requestSnapshot">, characterId: string) {
  const parsed = creativeRunCreateRequestSchema.safeParse(intent.requestSnapshot);
  return parsed.success && parsed.data.purpose === "identity_calibration" &&
      parsed.data.targetType === "character" && parsed.data.targetId === characterId
    ? parsed.data : null;
}

export function experimentProjectionMatches(detail: CreativeRunDetail, request: ExperimentRequest) {
  const experiment = detail.reviewContext.experiment;
  const expected = request.identityExperiment;
  return detail.purpose === "identity_calibration" && detail.target.type === "character" &&
    detail.target.id === request.targetId && detail.title === request.title &&
    detail.reviewContext.profile.key === request.profileId &&
    detail.reviewContext.orientation === request.orientation && detail.items.length === request.count &&
    Boolean(experiment && expected && experiment.mode === expected.mode &&
      experiment.positivePrompt === request.brief && experiment.negativePrompt === expected.negativePrompt &&
      experiment.seedStrategy === expected.seedStrategy &&
      experiment.sourceAssetId === (expected.sourceAssetId ?? null) && experiment.strength === expected.strength &&
      (expected.seedStrategy === "random" || experiment.baseSeed === (expected.baseSeed ?? null)));
}

export function itemImage(item: CreativeRunDetail["items"][number] | undefined) {
  return item?.asset?.thumbnailUrl ?? item?.asset?.url ?? null;
}

export function modeLabel(mode: ExperimentMode) {
  return mode === "text_to_image" ? "Text to image" : "Image to image";
}

export function generationModelLabel(modelId: string) {
  if (modelId === "redcraft-krea2-redmix3-fp8") return "RedCraft Krea2";
  if (modelId.startsWith("redcraft")) return "RedCraft / FineView";
  if (modelId.startsWith("redqw21")) return "REDQW21";
  return modelId;
}

export function identityTraitLines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((trait) => trait.trim())
    .filter(Boolean);
}

// SPEC: 状态里存的是提示「代号」，不是译好的句子。
// INTENT: 「本轮已生成」在 run 落终态后要换成「已完成 N 张」，原实现靠 notice.startsWith(中文前缀)
//         判断当前是哪一条——一接 i18n 就会因为 locale 不同而永远匹配不上。
export type ExperimentNotice =
  | "generation_started"
  | "source_restored"
  | "source_uploaded"
  | "continued_from_candidate"
  | "parameters_reused"
  | "identity_activated";

export function experimentNoticeText(
  t: (key: string) => string,
  notice: ExperimentNotice,
) {
  switch (notice) {
    case "generation_started":
      return t(
        "Parameters are frozen and candidates are generating. The current visual identity will not change.",
      );
    case "source_restored":
      return t(
        "Restored this local reference image and set it as the source for this run.",
      );
    case "source_uploaded":
      return t(
        "Local image uploaded and set as this run's source. The official reference set is unchanged.",
      );
    case "continued_from_candidate":
      return t(
        "The selected candidate is now the source for the next image-to-image run. Adjust the prompt before generating.",
      );
    case "parameters_reused":
      return t(
        "Loaded this run's parameter snapshot. Adjust it to create a new run.",
      );
    case "identity_activated":
      return t(
        "Activated a new immutable visual identity and Reference Set. The previous identity is kept as history and live images were not replaced.",
      );
  }
}
