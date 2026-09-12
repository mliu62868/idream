// SPEC: `GenerationModelProfile.runner` 的合法取值全集，与 prisma/schema.prisma
// 的 enum 注释、以及 gen 的 workerAdapterForRecordedProvider 是同一个集合。
// generation-runner-vocabulary.test.ts 断言三者集合相等。
// INTENT: runner 只选 gen 的适配器层，具体后端由 workflow 描述符的 backendKind
// 决定 —— 它是记账字段，不是后端 pin。
// INVARIANT: 这里是词表的家。它此前埋在 1388 行的 admin config service 里，
// 使得 modules/generation 必须反向 import modules/admin 才能守住自己的词表。
// INTENT: `pipeline` / `mlx` / `external` 于 2026-09-12 一并退役。三者都只解析到
//   gen 的 legacy OpenAI-compatible 网关适配器，而那个适配器零调用方、保留理由
//   （10-operations.md 的回滚 runbook）经核实不存在，已删除。退役方式与 `sd_cpp`
//   相同：词表先收敛，库里仅有的一行 `pipeline` 由 db/sql 改写为 `comfyui`。
export const GENERATION_PROFILE_RUNNERS = ["comfyui"] as const;

export type GenerationProfileRunner = (typeof GENERATION_PROFILE_RUNNERS)[number];
