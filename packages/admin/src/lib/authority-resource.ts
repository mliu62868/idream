import { useCallback, useEffect, useRef, useState } from "react";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
  type AuthorityState,
} from "./authority-state";
import { createLatestRequestGate } from "./latest-request";

/**
 * SPEC: 一轮轮询结束后由调用方声明"下一轮何时来"。返回毫秒数继续，返回 null 停止。
 * INTENT: 运营台曾有六套手写轮询，间隔各自硬编码在 setTimeout 里（5s 固定无退避 /
 *         4s 成功 8s 失败 / 250ms~5s 五档自适应 …）。把"间隔策略"从控制流降级成一个
 *         返回数字的纯函数后，六种策略共用同一个调度器，策略本身也就可以单测了。
 */
export type PollDecision = number | null;

export type PollingContext = {
  /** 本轮已被取消（组件卸载或依赖变更）。任务据此跳过写状态。 */
  readonly cancelled: boolean;
};

export type PollingTask = (
  context: PollingContext,
) => Promise<PollDecision> | PollDecision;

/**
 * SPEC: 反复执行 task，每轮按其返回值安排下一轮；返回 null 即停止。task 为 null 时不轮询。
 * INVARIANT: cleanup 之后不再安排新的一轮，且飞行中的那一轮会读到 cancelled === true。
 * INTENT: task 必须自己吞掉异常。抛出会终止循环——宁可停下，也不要对着一个必然失败的
 *         请求无限重试。
 */
export function usePollingTask(
  task: PollingTask | null,
  initialDelay: PollDecision | (() => PollDecision) = 0,
): void {
  // INTENT: 首轮延迟走 ref 而不是依赖，有两个原因：CharacterWorkspace 要按 Date.now()
  //         在 effect 执行时才算出延迟；而调用点普遍内联写策略，把它当依赖会让循环
  //         每次渲染都重新武装，定时器永远等不到触发。
  const initialDelayRef = useRef(initialDelay);
  // INVARIANT: 这个同步 effect 必须声明在轮询 effect 之前——effect 按声明顺序执行，
  //            轮询武装时读到的才是本次提交的最新策略。
  useEffect(() => {
    initialDelayRef.current = initialDelay;
  });

  useEffect(() => {
    if (!task) return;
    const context = { cancelled: false };
    let timer = 0;
    const arm = (delay: number) => {
      timer = window.setTimeout(() => {
        void (async () => {
          const next = await task(context);
          if (context.cancelled || next === null) return;
          arm(next);
        })();
      }, delay);
    };
    const first = initialDelayRef.current;
    const firstDelay = typeof first === "function" ? first() : first;
    if (firstDelay === null) return;
    arm(firstDelay);
    return () => {
      context.cancelled = true;
      window.clearTimeout(timer);
    };
  }, [task]);
}

export type AuthorityPollContext<T> = {
  /** 最近一份完好数据；本轮失败时仍是上一份，不会被抹成 null。 */
  readonly data: T | null;
  /** 上一轮的失败原因；成功或尚未开始为 null。 */
  readonly error: string | null;
  /** 本次轮询会话已完成的尝试次数，首次决策时为 0。用于表达"越等越久"。 */
  readonly attempt: number;
  /** 连续失败次数，一次成功即归零。用于表达失败退避。 */
  readonly consecutiveFailures: number;
};

export type AuthorityResourceQuery<T> = {
  /** 取数身份。变化即视为换了一份资源：旧数据立即作废，迟到的旧响应也不会污染新查询。 */
  readonly key: string;
  /** 为 false 时既不取数也不轮询（权限不足或前置条件未满足）。 */
  readonly enabled?: boolean;
  /** 必须 useCallback 稳定；它变化即触发重新取数。 */
  readonly load: () => Promise<T>;
};

export type UseAuthorityResourceOptions<T> = {
  /** 每轮轮询前后都会问一次；返回 null 表示当前数据已到终态，停止轮询。 */
  readonly pollWhile?: (context: AuthorityPollContext<T>) => PollDecision;
};

export type AuthorityResource<T> = AuthorityState<T> & {
  /**
   * 后台轮询的失败原因。与 error 分开：主数据仍是最后一份完好数据，运营台要的是
   * "自动刷新延迟了"的旁注，而不是把整块内容换成报错。
   */
  readonly refreshError: string | null;
  /** 前台刷新，会进入 loading。 */
  readonly refresh: () => Promise<void>;
  /** 提交后的回读；保持当前画面，返回经过门控的投影，失败或被新查询取代时抛出。 */
  readonly readback: () => Promise<T>;
};

/**
 * SPEC: 把 authority-state 的 reducer 包成 hook，并接上声明式轮询。
 * INTENT: 那个 reducer 早就解决了最难的 query-key 变更竞态，但它不是 hook，于是每个
 *         消费者仍要自己写 useState + 挂载仪式 + latest-request 门控。这里收口一次。
 */
export function useAuthorityResource<T>(
  query: AuthorityResourceQuery<T>,
  options: UseAuthorityResourceOptions<T> = {},
): AuthorityResource<T> {
  const { key, enabled = true, load } = query;

  type Snapshot = { key: string; state: AuthorityState<T>; refreshError: string | null };
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    key, state: createAuthorityState<T>(), refreshError: null,
  }));
  // INTENT: useState 的惰性初始化保证门控只建一次，又不必在渲染期写 ref。
  const [gate] = useState(createLatestRequestGate);
  const snapshotRef = useRef(snapshot);
  const commit = useCallback((next: Snapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  // INTENT: 同 initialDelay —— 调用点内联写 pollWhile 是常态，当依赖会让轮询永远重置。
  const pollWhileRef = useRef(options.pollWhile);
  useEffect(() => {
    pollWhileRef.current = options.pollWhile;
  });

  // SPEC: 轮询节奏跨"重新武装"存活。
  // INTENT: 后台轮询成功会改 refreshedAt，从而重新武装循环；若计数器随之清零，
  //         "按尝试次数递增间隔"就永远停在第一档。只有前台取数才重置节奏。
  const cadenceRef = useRef({ attempt: 0, consecutiveFailures: 0, error: null as string | null });

  const run = useCallback(
    async (mode: "foreground" | "background"): Promise<T> => {
      if (snapshotRef.current.key !== key) {
        throw new DOMException("The resource query changed before this read.", "AbortError");
      }
      const token = gate.begin();
      const current = snapshotRef.current;
      if (mode === "foreground") {
        commit({ key, state: authorityRequestStarted(current.state, key), refreshError: null });
      }
      try {
        const data = await load();
        if (!token.isCurrent()) {
          throw new DOMException("A newer authority request replaced this read.", "AbortError");
        }
        commit({ key, state: authorityRequestSucceeded(key, data), refreshError: null });
        return data;
      } catch (cause) {
        const message = cause instanceof Error
          ? cause.message
          : "The authoritative projection could not be loaded";
        if (!token.isCurrent()) throw cause;
        const latest = snapshotRef.current;
        if (mode === "foreground") {
          commit({ key, state: authorityRequestFailed(latest.state, key, message, cause), refreshError: null });
        } else {
          commit({ key, state: latest.key === key ? latest.state : createAuthorityState<T>(), refreshError: message });
        }
        throw cause;
      }
    },
    [commit, gate, key, load],
  );

  const foreground = useCallback(async () => {
    cadenceRef.current = { attempt: 0, consecutiveFailures: 0, error: null };
    // The foreground result is represented by the resource state. Mutation callers use readback.
    await run("foreground").catch(() => undefined);
  }, [run]);

  const readback = useCallback(() => {
    cadenceRef.current = { attempt: 0, consecutiveFailures: 0, error: null };
    return run("background");
  }, [run]);

  useEffect(() => {
    if (snapshotRef.current.key !== key) {
      commit({ key, state: createAuthorityState<T>(), refreshError: null });
      cadenceRef.current = { attempt: 0, consecutiveFailures: 0, error: null };
    }
    if (!enabled) return;
    // SPEC: 首次取数推迟到挂载提交之后。
    // INTENT: 28 个调用点各自手写这段 setTimeout(…, 0) "挂载仪式"。它真正的作用是让
    //         StrictMode 的双次挂载在 cleanup 里把第一次取消掉，只发一个请求。
    //         收进 hook 后调用点不必再写。
    const timer = window.setTimeout(() => void foreground(), 0);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [commit, enabled, foreground, gate, key]);

  const decide = () =>
    pollWhileRef.current?.({
      data: snapshotRef.current.key === key ? snapshotRef.current.state.data : null,
      ...cadenceRef.current,
    }) ?? null;

  // SPEC: refreshedAt 进依赖，使循环在每次数据更新后重新武装并重问"还该不该轮询"。
  // INTENT: 这就是"终态 → 又活跃"（比如刚提交一个新 Run）能自动恢复轮询的原因；
  //         节奏计数器在 cadenceRef 里跨武装存活，所以自适应档位不会被重置。
  const pollTask = useCallback<PollingTask>(
    async (context) => {
      let error: string | null = null;
      try {
        await run("background");
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "The authoritative projection could not be loaded";
      }
      // A newer read of the same resource may supersede this request and still
      // fail. Only session cleanup stops polling; request failures follow its policy.
      if (context.cancelled) return null;
      const cadence = cadenceRef.current;
      cadence.attempt += 1;
      cadence.consecutiveFailures = error === null ? 0 : cadence.consecutiveFailures + 1;
      cadence.error = error;
      return pollWhileRef.current?.({
        data: snapshotRef.current.key === key ? snapshotRef.current.state.data : null,
        ...cadence,
      }) ?? null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, snapshot.state.refreshedAt],
  );

  const armed = enabled && Boolean(options.pollWhile);
  usePollingTask(armed ? pollTask : null, decide);

  // A key change is visible during the first render, before its loading effect runs.
  const visible = snapshot.key === key ? snapshot : { state: createAuthorityState<T>(), refreshError: null };
  return { ...visible.state, refreshError: visible.refreshError, refresh: foreground, readback };
}
