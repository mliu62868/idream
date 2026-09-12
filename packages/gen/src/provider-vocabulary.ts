// SPEC: gen 的适配器词表 —— provider 开关到底有哪几个合法值，以及把一个原始
// 环境变量字符串收窄成词表成员的唯一入口。
//
// INTENT: 这两个词表此前以裸字符串的形式在五处各写了一遍：buildImageModel 的分发、
//   buildVideoModel 的分发、assertProductionProviderReady 里的 `supported` 数组、
//   PRODUCTION_ADAPTERS、以及 pipeline.ts 的 workerAdapterForRecordedProvider 返回值。
//   把它们串起来的本该是类型，但 env.IMAGE_PROVIDER 返回的是 `string` —— 类型系统
//   够不着，于是五份拷贝只能靠人记得同步。
//   现在词表只有一处，`string` 那个洞在 env 的 getter 上就被堵死：分发的 switch 是
//   编译期穷尽的，`supported` 数组直接删掉了（**解析本身就是那次检查**），
//   PRODUCTION_ADAPTERS 里写错一个名字编译不过。
//
// INVARIANT: 解析在 env getter 上发生，也就是第一次读取 provider 开关的时刻 ——
//   比此前晚到 assertProductionProviderReady 才报错更早。这与 VIDEO_TIMEOUT_MS
//   既有的做法一致（见 env.ts：坏的预算必须在 worker 接第一个付费请求前崩掉），
//   也保持了 env.ts 的约定：**import 该模块永不抛错**，只有读取才可能抛。

/** 图/视频生成的适配器。runner 词表（main 侧）经 workerAdapterForRecordedProvider 落到这里。 */
// INTENT: `pipeline`（legacy OpenAI-compatible 网关）已于 2026-09-12 删除 —— 零调用方，
//   且它被保留的唯一理由（10-operations.md 的回滚 runbook）经核实不存在。词表少一项，
//   `GEN_IMAGE_PROVIDER=pipeline` 就在读取 env 的那一刻失败，而不是启动后才发现没有适配器。
export const GEN_ADAPTERS = ["mock", "backend"] as const;
export type GenAdapter = (typeof GEN_ADAPTERS)[number];

/** 生成产物的私有对象存储。 */
export const GEN_BLOB_ADAPTERS = ["mock", "r2", "s3"] as const;
export type GenBlobAdapter = (typeof GEN_BLOB_ADAPTERS)[number];

function isMember<T extends string>(vocabulary: readonly T[], raw: string): raw is T {
  return (vocabulary as readonly string[]).includes(raw);
}

/** `kind` 只进错误消息 —— 图和视频共用同一张适配器词表。 */
export function parseGenAdapter(kind: "image" | "video", raw: string): GenAdapter {
  if (isMember(GEN_ADAPTERS, raw)) return raw;
  throw new Error(`Unsupported ${kind} provider: ${raw}`);
}

export function parseGenBlobAdapter(raw: string): GenBlobAdapter {
  if (isMember(GEN_BLOB_ADAPTERS, raw)) return raw;
  throw new Error(`Unsupported blob provider: ${raw}`);
}

// SPEC: Main runner name -> gen adapter name. Many-to-one by construction.
// NOTE: named for what it does. It does NOT pin a backend — `payload.provider`
// is an accounting field; `descriptor.backendKind` is what selects the backend.
// The old name (`providerAdapterForPinnedAuthority`) claimed an authority it
// never had.
// INVARIANT: the runner names accepted here must stay a superset of the enum on
// GenerationModelProfile.runner (see packages/main/prisma/schema.prisma). `sd_cpp`
// was retired once db/sql/2026-08-03-generation-model-profile-runner-retire-sd-cpp.sql
// rewrote the surviving rows to `comfyui` — the same adapter, so nothing changed
// but the vocabulary. Whatever the runner says, the descriptor decides.
export function workerAdapterForRecordedProvider(provider: string): GenAdapter {
  switch (provider) {
    case "mock":
    case "backend":
      return provider;
    case "comfyui":
      return "backend";
    default:
      // `pipeline`, `mlx` and `external` all resolved to the legacy
      // OpenAI-compatible gateway adapter, deleted 2026-09-12 for having zero
      // callers. They now fail here rather than mapping to an adapter that no
      // longer exists — the same way `sd_cpp` fails.
      throw new Error(`Unsupported pinned generation provider: ${provider}`);
  }
}
