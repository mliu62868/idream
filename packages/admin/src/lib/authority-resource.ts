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
  /** 本地改写已取到的数据；同时重置轮询节奏，让新一轮从最快档重新开始。 */
  readonly setData: (next: T) => void;
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

  const [state, setState] = useState<AuthorityState<T>>(createAuthorityState<T>);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // INTENT: useState 的惰性初始化保证门控只建一次，又不必在渲染期写 ref。
  const [gate] = useState(createLatestRequestGate);
  const dataRef = useRef<T | null>(null);

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
    async (mode: "foreground" | "background"): Promise<string | null> => {
      const token = gate.begin();
      if (mode === "foreground") {
        setState((current) => authorityRequestStarted(current, key));
      }
      try {
        const data = await load();
        if (!token.isCurrent()) return null;
        dataRef.current = data;
        setState(authorityRequestSucceeded(key, data));
        setRefreshError(null);
        return null;
      } catch (cause) {
        const message = cause instanceof Error
          ? cause.message
          : "The authoritative projection could not be loaded";
        if (!token.isCurrent()) return null;
        if (mode === "foreground") {
          setState((current) => authorityRequestFailed(current, key, message));
        } else {
          setRefreshError(message);
        }
        return message;
      }
    },
    [gate, key, load],
  );

  const foreground = useCallback(async () => {
    cadenceRef.current = { attempt: 0, consecutiveFailures: 0, error: null };
    await run("foreground");
  }, [run]);

  useEffect(() => {
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
  }, [enabled, foreground, gate]);

  const decide = () =>
    pollWhileRef.current?.({ data: dataRef.current, ...cadenceRef.current }) ?? null;

  // SPEC: refreshedAt 进依赖，使循环在每次数据更新后重新武装并重问"还该不该轮询"。
  // INTENT: 这就是"终态 → 又活跃"（比如刚提交一个新 Run）能自动恢复轮询的原因；
  //         节奏计数器在 cadenceRef 里跨武装存活，所以自适应档位不会被重置。
  const pollTask = useCallback<PollingTask>(
    async (context) => {
      const error = await run("background");
      if (context.cancelled) return null;
      const cadence = cadenceRef.current;
      cadence.attempt += 1;
      cadence.consecutiveFailures = error === null ? 0 : cadence.consecutiveFailures + 1;
      cadence.error = error;
      return pollWhileRef.current?.({ data: dataRef.current, ...cadence }) ?? null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, state.refreshedAt],
  );

  const armed = enabled && Boolean(options.pollWhile);
  usePollingTask(armed ? pollTask : null, decide);

  const setData = useCallback((next: T) => {
    dataRef.current = next;
    cadenceRef.current = { attempt: 0, consecutiveFailures: 0, error: null };
    setState(authorityRequestSucceeded(key, next));
  }, [key]);

  return { ...state, refreshError, refresh: foreground, setData };
}
