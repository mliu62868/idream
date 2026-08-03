import { useEffect, useState } from "react";
import {
  clearDurableMutationIntent,
  type DurableMutationIntent,
} from "./durable-mutation-intent";
import { createLatestRequestGate } from "./latest-request";

/**
 * SPEC: 两阶段提交的第二阶段 ——「提交已经发生 → 精确读一份服务端投影确认它是否已反映
 *       该提交 → 未反映则按可恢复 / 不可恢复分流」。
 * INTENT: 这段协议原本只以「一段 90 行闭包的语句顺序」存在于 CharacterAssetStudio 里：
 *         取消语义、在途去重、两道闸门的先后、成功时五处状态的写入时机、失败该进旁注还是
 *         主错误——没有名字，也没法脱离组件测。调用方因此必须自己记住全部顺序。这里给它
 *         一个名字，把顺序变成模块的承诺。
 * INTENT: 它不是 useAuthorityResource 那种「取数」——取数只关心最新一份数据，而这里关心
 *         的是「我刚提交的那一笔，服务端认了没有」。两者的失败语义完全不同：取数失败就是
 *         失败，这里的失败可能只是「还没投影到」，重试即可，绝不能重发提交。
 */

export class SupersededProjectionError extends Error {
  constructor() {
    super("A newer projection request replaced this one.");
    this.name = "SupersededProjectionError";
  }
}

/**
 * SPEC: 「这次读取已被取代」既包括本模块闸门的判定，也包括 AbortController 中止。
 * INTENT: 两者都不是故障——调用方应静默让位给新一轮，而不是把它渲染成错误。
 */
export function isProjectionRequestCancellation(cause: unknown) {
  return cause instanceof SupersededProjectionError ||
    (cause instanceof Error && cause.name === "AbortError");
}

/**
 * SPEC: 只有 committed_projection_pending 的意图才有「等待被投影确认的目标」。
 * INTENT: 其余状态（提交中 / 结果未知 / 待对账）都还没有可校验的目标 id，把它们也当成
 *         「已提交目标」会让失败被错误地降级成旁注。
 */
export function committedProjectionTargetId(
  intent: DurableMutationIntent | null,
) {
  return intent?.status === "committed_projection_pending"
    ? intent.committedTargetId ?? null
    : null;
}

export type CommittedProjectionVerdict =
  /** 这份投影与任何在途提交无关（普通浏览）。 */
  | { readonly kind: "unrelated" }
  /** 服务端投影已反映在途提交；意图会在同一步骤里被释放。 */
  | { readonly kind: "reflected" };

export type CommittedIntentContract<TProjection> = {
  /**
   * 当前在途提交意图；没有则 null。
   * INVARIANT: 每次都重新问，不能缓存——它会在 await 期间被别的标签页或重试流程换掉。
   */
  readonly current: () => DurableMutationIntent | null;
  /** 这份投影是否已反映该提交。 */
  readonly reflects: (
    intent: DurableMutationIntent,
    projection: TProjection,
  ) => boolean;
  /** 投影确实是该提交的目标、内容却对不上时的锁死理由。 */
  readonly mismatchMessage: string;
  /** 意图的持久化副本已清除；调用方据此同步自己那份内存状态。 */
  readonly onReleased: () => void;
};

export type CommittedProjectionLoaderOptions<TProjection> = {
  /**
   * 按 id 精确取一份投影。
   * INVARIANT: 必须是直接取，不能经过列表分页——「已提交的目标掉出最近 N 条之外仍能被
   *            取到」正是本协议存在的理由。
   */
  readonly fetch: (
    targetId: string,
    signal?: AbortSignal,
  ) => Promise<TProjection>;
  /** 该 id 是否仍是调用方想要的目标。取数前后各问一次。 */
  readonly isCurrentTarget: (targetId: string) => boolean;
  readonly committed: CommittedIntentContract<TProjection>;
  /**
   * 唯一的写状态出口。
   * INVARIANT: 所有闸门与校验都通过后恰好调用一次；调用前后没有 await，调用方因此写不出
   *            「只写了一半状态」的中间态。任何一道闸门没过就一次也不调用。
   */
  readonly commit: (
    projection: TProjection,
    verdict: CommittedProjectionVerdict,
  ) => void;
};

export type ProjectionFailureRoute =
  /** 被取代或被中止：静默让位，不写任何出口。 */
  | { readonly kind: "ignored" }
  /** 失败的正是在途提交的目标：这是「还没投影到」，可重试校验，绝不能重发提交。 */
  | { readonly kind: "recoverable"; readonly detail: string | null }
  /** 与在途提交无关的失败：走正常报错出口。 */
  | { readonly kind: "fatal"; readonly detail: string | null };

export type CommittedProjectionLoader<TProjection> = {
  readonly load: (
    targetId: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<TProjection>;
  /** 作废在途结果。切换目标前调用：之后才返回的旧投影不会再写状态。 */
  readonly invalidate: () => void;
  /** 把一次失败分流到「忽略 / 可恢复旁注 / 主错误」三个出口之一。 */
  readonly routeFailure: (
    targetId: string,
    cause: unknown,
  ) => ProjectionFailureRoute;
};

/**
 * SPEC: 配置以 thunk 传入，每次使用都重新读。
 * INTENT: `committed.current()` 与 `commit` 必须看到最新的组件状态，而在途去重表和闸门
 *         必须跨渲染存活——两个要求只能靠「对象建一次、配置每次重读」同时满足。
 */
export function createCommittedProjectionLoader<TProjection>(
  readOptions: () => CommittedProjectionLoaderOptions<TProjection>,
): CommittedProjectionLoader<TProjection> {
  const gate = createLatestRequestGate();
  // INVARIANT: 同一个 targetId 的在途请求只有一个。第二个调用方拿到同一个 Promise，
  //            因此服务端只被问一次，commit 也只会发生一次。
  const inFlight = new Map<string, Promise<TProjection>>();

  const load = async (
    targetId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TProjection> => {
    // INVARIANT: 目标已经不是它了就根本不发请求。这道前置闸门让「精确加载」保持精确。
    if (!readOptions().isCurrentTarget(targetId)) {
      throw new SupersededProjectionError();
    }
    const existing = inFlight.get(targetId);
    if (existing) return existing;
    const request = (async () => {
      const token = gate.begin();
      const projection = await readOptions().fetch(targetId, options.signal);
      const settled = readOptions();
      // INVARIANT: 两道闸门在响应回来之后都要重问一次——被取代的投影不得覆盖更新的结果。
      if (!token.isCurrent() || !settled.isCurrentTarget(targetId)) {
        throw new SupersededProjectionError();
      }
      const intent = settled.committed.current();
      const reflected = intent !== null &&
        settled.committed.reflects(intent, projection);
      // SPEC: 目标对得上、内容对不上 = 服务端认了另一笔东西。这不是「还没投影到」，
      //       所以不能降级成旁注，必须抛出去让调用方锁死。
      if (
        intent !== null &&
        committedProjectionTargetId(intent) === targetId &&
        !reflected
      ) {
        throw new Error(settled.committed.mismatchMessage);
      }
      settled.commit(
        projection,
        reflected ? { kind: "reflected" } : { kind: "unrelated" },
      );
      if (reflected && intent !== null) {
        clearDurableMutationIntent(intent);
        // INVARIANT: await 期间意图可能已被换成另一笔提交；只释放确实被本次投影确认的那一笔。
        const latest = settled.committed.current();
        if (
          latest?.idempotencyKey === intent.idempotencyKey &&
          latest.committedTargetId === intent.committedTargetId
        ) {
          settled.committed.onReleased();
        }
      }
      return projection;
    })();
    inFlight.set(targetId, request);
    try {
      return await request;
    } finally {
      if (inFlight.get(targetId) === request) inFlight.delete(targetId);
    }
  };

  return {
    load,
    invalidate: () => gate.invalidate(),
    routeFailure: (targetId, cause) => {
      if (isProjectionRequestCancellation(cause)) return { kind: "ignored" };
      const detail = cause instanceof Error ? cause.message : null;
      const committedTargetId = committedProjectionTargetId(
        readOptions().committed.current(),
      );
      return committedTargetId === targetId
        ? { kind: "recoverable", detail }
        : { kind: "fatal", detail };
    },
  };
}

/**
 * SPEC: 把 loader 绑到组件生命周期上——对象身份稳定，配置每次渲染刷新。
 * INVARIANT: 这个同步 effect 必须声明在所有取数 effect 之前——effect 按声明顺序执行，
 *            取数时读到的才是本次提交的最新配置。
 */
// INTENT: 配置槽位是闭包变量而不是 ref —— loader 必须在渲染期就有稳定身份（它要进
//         effect 依赖），而 ref 不允许在渲染期读取。
function bindCommittedProjectionLoader<TProjection>(
  initial: CommittedProjectionLoaderOptions<TProjection>,
) {
  let options = initial;
  return {
    loader: createCommittedProjectionLoader<TProjection>(() => options),
    bind: (next: CommittedProjectionLoaderOptions<TProjection>) => {
      options = next;
    },
  };
}

export function useCommittedProjectionLoader<TProjection>(
  options: CommittedProjectionLoaderOptions<TProjection>,
): CommittedProjectionLoader<TProjection> {
  const [bound] = useState(() => bindCommittedProjectionLoader(options));
  useEffect(() => {
    bound.bind(options);
  });
  return bound.loader;
}
