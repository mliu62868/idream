// SPEC: `GenerationModelProfile.runner` 的合法取值全集，与 prisma/schema.prisma
// 的 enum 注释、以及 gen 的 workerAdapterForRecordedProvider 是同一个集合。
// generation-runner-vocabulary.test.ts 断言三者集合相等。
// INTENT: runner 只选 gen 的适配器层，具体后端由 workflow 描述符的 backendKind
// 决定 —— 它是记账字段，不是后端 pin。
// INVARIANT: 这里是词表的家。它此前埋在 1388 行的 admin config service 里，
// 使得 modules/generation 必须反向 import modules/admin 才能守住自己的词表。
export const GENERATION_PROFILE_RUNNERS = [
  "pipeline",
  "mlx",
  "comfyui",
  "external",
] as const;

export type GenerationProfileRunner = (typeof GENERATION_PROFILE_RUNNERS)[number];
